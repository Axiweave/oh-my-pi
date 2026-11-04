# Research: Spawn More Than One Session From One Request

## R1. Where the one-session limit lives

- **Finding**: Four parts enforce it today.
  1. `spawn-kickoff.md`: "Turn it into exactly one `spawn_session` call."
  2. `InteractiveMode` closes the window at every `tool_execution_end` of `spawn_session` (`interactive-mode.ts:3106`).
  3. `#handleSpawnRequest` refuses a second call in the same run through `#spawnRunUsed` and closes the window (`interactive-mode.ts:8740-8743`).
  4. `spawn-session.md`: "Call exactly once: the tool goes away after the first call."
- **Decision**: Remove all four. The window stays open for the whole spawn run and closes at `agent_end` (R2).

## R2. When the window closes

- **Decision**: Close the window at `agent_end` and nowhere else. Apply `spawnWindowShouldClose` only to the messages after the last `/spawn` kickoff in `event.messages` (`findLastIndex(isSpawnKickoff) + 1`). Before the kickoff of the open window has started (`#spawnKickoffSeen`, set on the kickoff's `message_start`), keep the window open in two cases:
  - The kickoff send is still in progress (`#spawnKickoffSending`). The flag is set in `#beginSpawnWindow` and cleared after the `followUp`/`prompt` call in `handleSpawnCommand` returns or fails.
  - The kickoff is still queued: `[...agent.peekSteeringQueue(), ...agent.peekFollowUpQueue()].some(isSpawnKickoff)` (`agent.ts:1551`).

  In all other cases where the kickoff has not started, close the window.
- **Rationale**:
  - With no close at each call, the model can call `spawn_session` once for each task.
  - The slice fixes the reported stale-window bug (FR-015). Before the slice, an earlier `spawn_session` or an unrelated `ask` in the same run kept the window open after a kickoff that made no call.
  - The kickoff flag covers a follow-up that arrives after the loop polled its queue. The run then ends without the kickoff, and the kickoff starts a new run. Without the flag, that first `agent_end` closes the window before the kickoff runs.
  - The queue check covers a kickoff that never runs. An aborted run dequeues no follow-up (`agent.ts:1045`), and `clearFollowUpQueue`/`clearAllQueues` (`agent.ts:1478, 1493`) can drop it. Without the check, `#spawnKickoffSeen` stays `false`. The window then never closes, every later `/spawn` is refused, and `spawn_session` and `ask` stay on. Steering is part of the check because `moveFollowUpsToSteering` can move the kickoff there.
  - The send flag covers the gap before the kickoff reaches the queue. `handleSpawnCommand` opens the window, awaits `#beginSpawnWindow` (`setActiveToolsByName`), and only then calls `followUp`. A run that ends during that await would see no started kickoff and no queued kickoff. Without the flag, it would close the window, and the kickoff would then run without `spawn_session`. Spec 019 R5 closed this same gap for speckit starts.
  - [INFERENCE] The queued kickoff is the same message object that later reaches `message_start`, so `isSpawnKickoff` matches it in the queue. A T006 test checks this with a real `followUp` call.
  - The existing "keep open after a cancelled `ask`" rule stays. In the reply run, no kickoff is present, so the check covers the whole run, as today.
- **Consequence**: A second `/spawn` typed while the spawn run is still in progress is refused until that run ends (FR-014). Today the second `/spawn` can go in after the first spawn call. One `/spawn` now covers this need.
- **Alternative considered**: Close at the final assistant message of the spawn turn, with a small state machine (waiting, tracking, awaiting reply). Rejected. It needs about 30 lines and three states to keep the cancelled-`ask` rule. It only helps a user who queues a second `/spawn` behind the first one.

## R3. Order of the spawn calls

- **Decision**: Set `concurrency = "exclusive"` on `SpawnSessionTool`. The agent loop then runs parallel `spawn_session` calls in one message one after another (`agent-loop.ts:3858-3884`).
- **Rationale**: Confirm dialogs cannot overlap. Two `git worktree add` runs on one repository at the same time can fail on its lock files. The request order stays the spawn order.
- **Alternative considered**: A promise chain in `#handleSpawnRequest`. Rejected, because the tool flag already exists for this purpose.

## R4. The overview dialog for two or more tasks

- **Decision**: Add `mode: "plan"` to `spawn_session`, with a `tasks` field: an array of one line for each task. With `spawn.confirm` on and two or more tasks, the kickoff tells the model to call `spawn_session` with `plan` first, before any worktree tool runs.
  - Approved: the `plan` call returns "Approved: spawn the <N> tasks." The next N spawn calls skip their dialogs, where N is the task count.
  - Declined: the `plan` call returns "Overview declined: spawn nothing." This text differs from the "Spawn declined" result of a dialog for one task, after which the model goes on with the next task. Every later spawn call in this window fails with "The user declined this /spawn." The model makes no worktree and reports one line.
  - `spawn.confirm` off: a `plan` call creates nothing and returns "spawn.confirm is off: no overview. Spawn each task." The kickoff does not mention `plan` in this case.
- **Rationale**: The overview must show before the model runs the worktree tool, and the model runs that tool through `bash`. So the overview must be a call that the model makes, not a step inside one batch spawn call. A mode on the existing tool needs no new tool registration. A new tool needs about six registration points (`HIDDEN_TOOL_NAMES`, `HIDDEN_TOOLS`, `isToolAllowed`, the `sdk.ts` registration and filter, `#withoutIdleLoopTool`).
- **Alternatives considered**:
  - A batch `spawn_session` call with a list of tasks. Rejected, because the `ww` setups must run before the spawns but after the overview.
  - The `ask` tool for the overview. Rejected, because `ask` can be off, and an overview with a fixed yes/no belongs to `spawn.confirm`.
  - A separate `spawn_plan` tool. Rejected because of the registration cost above.
- **Ceiling**: After approval, a spawn call beyond N shows its normal dialog. A wrong count from the model therefore asks again and never spawns without approval.

## R5. Unique built-in worktree branches

- **Finding**: `defaultSessionWorktreeBranch()` gives `wt/<yyyymmdd-hhmmss>`, with one-second resolution. Two `new_worktree` spawns with no branch in the same second get the same branch, and the second spawn fails.
- **Decision**: Keep today's default name for the first spawn that uses it. Add a field `#spawnBranches: Set<string>`, which `#beginSpawnWindow` clears. In `#spawnSibling`, when the default name is already in the set, use `${name}-${suffix}`. `suffix` is the `randomSiblingSuffix()` that also names the zmx session. Add each default branch that a spawn uses to the set. `/wt` keeps its default.
- **Rationale**: A single-task request, and the first task of a request, get the same branch name as today (SC-005). Only a same-second collision inside one window gets the suffix. The suffix reuses a value that the spawn already makes.
- **Alternative considered**: Add the suffix to every default branch. Rejected, because it changes the result for single-task requests, which breaks SC-005.

## R6. Tool worktrees for each task

- **Decision**: This is a prompt change only. The kickoff tells the model to handle tasks one at a time, in request order. For each task, the model runs that task's worktree tool and then spawns that task. A tool failure skips only that task. Each task gets its own branch name, and two tasks never get the same picked name. A setup that the request gives to all tasks applies to each task separately.
- **Rationale**: The rules from spec 018 stay the same for each task. Setup and spawn for one task, followed by the next task, keep each failure local and make the report simple.

## R7. Summaries for each task

- **Finding**: Each `handoff_summary` call already runs `generateHandoffDocument(text)`, with `text` as the focus.
- **Decision**: This is a prompt change only. For each `handoff_summary` task, `text` names that task's focus. No code change.

## R8. Tests

- **Decision**: Update `test/spawn-command.test.ts`:
  - Two parallel calls in one run create two sessions, in order.
  - The window stays open after a spawn and closes at `agent_end`. The next `/spawn` is accepted after that (SC-006).
  - An `ask` before the kickoff in the same run does not keep the window open.
  - An `agent_end` before the kickoff started does not close the window while the kickoff is still queued. Send it through a real `session.followUp` during a run.
  - An `agent_end` before the kickoff started closes the window after the queue is cleared (`agent.clearFollowUpQueue()`). After that, a new `/spawn` is accepted.
  - An approved plan skips N dialogs, and the dialog shows again for call N+1. A declined plan returns "Overview declined: spawn nothing." and refuses later spawns.
  - Two `new_worktree` spawns with no branch in one window get different branches. The first one gets today's `wt/<yyyymmdd-hhmmss>` name, with no suffix.
- Remove the two tests that pin the old one-call limit ("refuse the rest", "still creates its one session").
- The `spawnWindowShouldClose` property test in `sibling-spawn.test.ts` changes with the function: only the last `ask`/`spawn_session` call decides (implement-time fix, see T004).
- The kickoff and tool prompt changes get real-model smoke runs (quickstart). No test pins prompt text.
