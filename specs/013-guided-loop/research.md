# Research: Guided Loop Setup

All paths are relative to `packages/coding-agent/` unless they start with `packages/`. Line numbers are from the tree at the start of this plan.

## R1. The kickoff and the interview copy `/guided-goal`

- **Decision:** `handleGuidedLoopCommand(rest, input, displayText)` in `src/modes/interactive-mode.ts` copies `handleGuidedGoalCommand` (`:7372-7441`). It renders a new prompt `src/prompts/loop/guided-loop-interview.md` and sends it as a hidden developer message. It uses `session.prompt(kickoff, { synthetic: true, images, displayText, userInitiated: true })`, or `session.followUp(...)` when a turn runs or on `AgentBusyError`.
- **Rationale:** FR-002. The transcript shows the typed `/guided-loop …` line (`displayText`), and the agent asks its questions as normal replies. The kickoff path is proven, including the "queue behind a running turn" case.
- **Alternatives considered:** A modal question flow. `/guided-goal` moved away from it (CHANGELOG line 2133), so it is rejected.

## R2. A hidden `loop` tool, bridged by a handler slot

- **Decision:** Add a hidden tool `loop` in `src/tools/loop.ts`, with the description in `src/prompts/tools/loop.md`. The tool does not touch loop state. It calls a handler that InteractiveMode installs on the session for the life of the interview, like `PlanProposalHandler`:
  - The type is `LoopStartHandler = (request: { op: "start"; args: string } | { op: "cancel" }) => Promise<"started" | "declined" | "cancelled">`.
  - The slot is `ToolSession.peekLoopStartHandler?()` / `setLoopStartHandler?(handler | null)`, next to `peekPlanProposalHandler` (`src/tools/index.ts:505-507`).
  - The `AgentSession` slot wraps the handler in `waitForUser`, as `setPlanProposalHandler` does (`src/session/agent-session.ts:3233-3237`). The IDE then sees the dialog as a user wait.
  - The slot is wired in `src/sdk.ts` next to `:2509-2510`.
- **Gate:** `isToolAllowed` (`src/tools/index.ts:735`) gets `if (name === "loop") return !restrictToolNames && session.peekLoopStartHandler?.() !== undefined;`. The handler is the only interview state that the tool layer sees. A tool-set rebuild after the interview drops the tool by itself (FR-006a).
- **Registration:** Add `loop` to `HIDDEN_TOOL_NAMES` (`src/tools/builtin-names.ts:36`) and `HIDDEN_TOOLS` (`src/tools/index.ts:591`). Pre-register it in the tool registry next to the `goal` code at `src/sdk.ts:3594-3601`, so that `setActiveToolsByName` can find it. Keep it out of the first active set with the `goal` filter (`src/sdk.ts:4211`).
- **Rationale:** FR-006 and FR-006a. A session event (the `goal` pattern) cannot return "declined" to the agent. A handler slot can, and the slot already exists for plan proposals.
- **Alternatives considered:**
  - The tool calls `context.ui.confirm` itself. It then still needs a way to reach the loop methods in InteractiveMode, so it needs the slot anyway.
  - Gate the tool on a new session getter. The handler slot already carries the same state.

## R3. Tool input and the round-trip check

- **Decision:** The tool schema is `op: "start" | "cancel"`, `prompt?: string`, `limit?: string` (a count such as `10`, or a duration such as `2h`), `every?: string` (a duration), `while?: string`, `until?: string` (shell commands). For `start`, the tool:
  1. Builds `args` = `[limit] [every <every>] [--while|--until '<cmd>'] <prompt>`, and quotes the command in POSIX single quotes (`'` → `'\''`).
  2. Runs `parseLoopArgs(args)`. It rejects the call when the result is an error, or when the parsed parts differ from the input: the prompt text, the presence of a limit, an interval, and a condition. The error goes back to the agent, and the dialog does not open.
  3. Rejects `while` and `until` together, and rejects a missing or blank `prompt`.
- **Rationale:** FR-006 and SC-004. `parseLoopArgs` reads a prompt that starts with a number, with `--`, or with `every 5m` as a limit, a flag, or an interval (research by the scout, `src/modes/loop-limit.ts:67-169`). The round trip finds each of these cases, so the line in the dialog always gives back the same setup when the user types it again. Newlines in the prompt are safe: `parseLoopArgs` and `parseSlashCommand` keep interior newlines.
- **Alternatives considered:** One `args` string from the agent. It needs less schema, but the agent then writes the `/loop` grammar by hand. A wrong first word becomes a silent limit, and the user sees a line that does not mean what the agent intended.

## R4. What the handler does

- **Decision:** `start` (in InteractiveMode):
  1. `confirmed = await this.showHookConfirm("Start this loop?", message, { initialIndex: 1, signal })`. If not confirmed, return `"declined"`. The interview stays active.
     - `message` is `/loop ${args}`. When loop mode is on or paused, a second line says `This replaces the current loop (<bounds>).`. `<bounds>` uses the same `describeLoopLimitRuntime`, `describeLoopInterval`, and `describeLoopCondition` parts as the `/loop` autocomplete text (`src/slash-commands/builtin-modes.ts:613-617`), or `no limit` when there are none.
     - `initialIndex: 1` selects **No** first, so a stray Enter declines. `signal` is the tool's abort signal. The tool passes it in the request as `{ op: "start", args, signal }`. An abort closes the dialog, and the dialog then returns false (`extension-ui-controller.ts:1195-1202`, `:1495-1506`). The dialog fails closed, so SC-003 holds.
  2. Call `#endGuidedLoopInterview()` (R6).
  3. Call `this.showStatus("/loop " + args)`. The transcript keeps the line (US2/AC1).
  4. Call `const prompt = await this.handleLoopCommand(args)`. It turns loop mode on, or replaces a paused loop, with the same rules and messages as a typed `/loop` (FR-007, FR-011a).
  5. Call `this.setLoopPrompt(prompt)` and then `void this.session.followUp(prompt)`. The prompt runs as a user message after the tool turn ends, in the same way that a typed `/loop … prompt` runs its first prompt as a manual run: it does not use a count iteration and does not check the condition first.
  6. Return `"started"`.
- `cancel`: call `#endGuidedLoopInterview()` and return `"cancelled"`.
- **Rationale:** FR-005, FR-006, and FR-007. Step 4 is the same entry that a typed `/loop <args>` uses, so the tool never writes loop fields itself. `handleLoopCommand` and `setLoopPrompt` already have all the replace and enable rules. The tool runs during a turn, so `onInputCallback` is not set (`src/modes/interactive-mode.ts:3092-3103`). A queued follow-up is the existing way to submit a user message after the current turn. The dialog shows only an `args` line that passed the round trip of R3, so the line that the user copies gives the running setup (SC-004).
- **Known ceiling:** `setLoopPrompt` records the run start at the time of the tool call. The first run starts after the agent ends its tool turn, a few seconds later. The second run of an interval loop can come a few seconds early. The tool result tells the agent to end its turn with no more text, which keeps the gap short. Mark this with a `ponytail:` comment.
- **Alternatives considered:** Only set `loopPrompt` and let `getUserInput` arm the run. With an interval, the first run then waits a full interval. Without an interval, it goes through the automatic path, which uses a count iteration and checks the condition before the first run. Both differ from a typed `/loop` (FR-007).

## R5. Interview answers must not revive the old loop

- **Decision:**
  - `handleGuidedLoopCommand` calls `pauseLoop()` when loop mode is on and not paused.
  - `setLoopPrompt` returns at once while `#guidedLoopInterviewActive` is true.
  - `handleLoopCommand` calls `#endGuidedLoopInterview()` first. A `/loop` that the user types during the interview takes manual control and ends the interview.
- **Rationale:** FR-011a and US3/AC4. All four callers of `setLoopPrompt` pass through it (`src/modes/controllers/input-controller.ts:1256`, `:1325`, `:1377`, `:1402-1404`), so one guard covers them all. `pauseLoop` clears `loopPrompt`, so `#scheduleLoopAutoSubmit` arms nothing during the interview.
- **Alternatives considered:** Guard each caller in input-controller. That needs four guards and misses future callers.

## R6. Interview lifecycle

- **Decision:** One private flag, `#guidedLoopInterviewActive`, with two helpers:
  - `#beginGuidedLoopInterview()` sets the flag and `interviewActive`, installs the handler, and adds `loop` to the active tools with `setActiveToolsByName`.
  - `#endGuidedLoopInterview()` does nothing when the flag is false. Otherwise it clears the flag and `interviewActive`, clears the handler, and removes `loop` from the active tools.
- The interview ends at these points:
  - The handler returns `started` or `cancelled`.
  - An `agent_end` has an assistant tool call that is not `loop`. This copies `src/modes/interactive-mode.ts:5615-5617`, with an exception for `loop` (FR-010).
  - The session switches (next to `:5816`).
  - The kickoff fails (the `catch` block of the handler).
  - The user types `/loop` (R5).
- **Rationale:** FR-006a and FR-010. `/guided-goal` never restores its tool after an abandoned interview (scout §1). The guided loop must not copy that leak, because its tool can start a loop.
- **Decline in chat:** The kickoff prompt tells the agent to call `loop` with `op: "cancel"` when the user declines or asks to stop. That call ends the interview cleanly (US3/AC1).

## R7. Refusals and blocking (FR-011, FR-012)

- **Decision:**
  - `/guided-loop` refuses under speckit-auto mode with `#warnSpeckitAutoBlocks()`, as `/loop` does (`:3460`).
  - It refuses during a guided-goal interview with "Finish the guided goal interview first.".
  - `/guided-goal` refuses during a guided-loop interview with "Finish the guided loop interview first.".
  - `#speckitAutoBlocker` (`:3674-3680`) returns `"loop"` while a guided-loop interview runs. `#turnOnSpeckitAuto` then shows "Finish the guided loop interview first.".
  - The autocomplete text under speckit-auto mode is "Guided loop: blocked by speckit-auto mode".
- **Spec note:** The spec edge case "Speckit-auto mode, plan mode, goal mode, or vibe mode is on. OMP refuses with the same message that `/loop` shows today" does not match the code. `/loop` refuses only under speckit-auto mode (`:3460`). The plan follows FR-011: refuse only where `/loop` refuses, plus a guided-goal interview. `/speckit.analyze` should change that edge case to match.

## R8. Short replies during the interview (FR-009)

- **Decision:** In `src/modes/controllers/input-controller.ts:1110`, the guard becomes `(text === "." && !this.ctx.isGuidedLoopInterviewActive()) || (text === "c" && !this.ctx.isGuidedGoalInterviewActive() && !this.ctx.isGuidedLoopInterviewActive())`.
- **Rationale:** FR-009 makes both `c` and `.` answers in a guided-loop interview. SC-005 keeps the guided-goal behavior the same, so `.` stays a continue shortcut there.
- **Other site:** `input-controller.ts:1593` also reads `.` and `c` as continue shortcuts, but only in `#submitToFocusedSession`, which sends text to a focused subagent view. The interview runs in the main session, so that site needs no change.
- **Check:** With a paused loop during the interview, a bare `.` reaches the agent as an answer, and no run of the old loop starts.

## R9. IDE `needs-input` (FR-013)

- **Decision:** Rename the public `goalInterviewActive` to `interviewActive` in all of its readers and writers. These are `src/modes/interactive-mode.ts`, `src/modes/types.ts:652-653`, `event-controller.ts:1480` and `:2976`, `extension-ui-controller.ts:1574`, and `session-focus-controller.ts:254`. The guided loop sets and clears it in R6.
- **Rationale:** One flag means "a guided interview waits for an answer". A second flag would need a second check in each IDE reader. This is a clean rename with no alias, as the repo rules require.

## R10. Tests (property style)

- **Tool round trip (`test/tools/loop-tool.test.ts`):** Use a seeded generator of setups. It draws the limit as nothing, a count, or a duration. It draws `every` as nothing or a duration. It draws a condition as nothing, `while`, or `until`, with commands that hold quotes and spaces. It draws prompts that hold newlines, that start with a number, with `--`, or with `every 5m`, and plain ones.
  - Property 1: the tool calls the handler exactly when the args round-trip. Then `parseLoopArgs(args)` gives back the same prompt, limit, interval, and condition.
  - Property 2: a hazard prompt with no matching field is rejected.
  - Also check: without a handler the tool returns the "no confirmation" text, and the tool maps `declined` and `cancelled` to their texts.
- **Lifecycle (`test/guided-loop.test.ts`, modeled on `test/goals/guided-goal.test.ts`):**
  - The kickoff delivery and the refusals.
  - Yes turns loop mode on with the parsed setup and queues one follow-up with the prompt.
  - No leaves the loop state unchanged.
  - A paused loop stays paused, and its setup does not change, when the interview ends without yes.
  - `setLoopPrompt` is a no-op during the interview.
  - Each end point removes `loop` from the active tools and clears the handler.
  - An `agent_end` with only a `loop` call keeps the interview active.
- **Existing tests to update:** `test/input-controller-keybindings.test.ts` (`c` and `.` during a loop interview). `test/interactive-mode-speckit-auto.test.ts:1102-1105` (the refusal list). The tests that read `goalInterviewActive` (rename).
