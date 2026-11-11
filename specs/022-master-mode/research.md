# Research: Master Mode

All items below are resolved. Line numbers come from the tree at the start of this plan. Each one was read in the code before it was written down. The research notes that came before this plan were partly stale, so they were not used as proof.

The goal (spec Clarifications): a central orchestrator that never blocks on delegated work. `ask` can still wait for the user. The main agent stays free to talk to the user and to react to results. Refusing foreground work and file-change tools serves this goal. It is not a security boundary.

## R1: Where the guard lives and how it knows the session is the main agent

**Decision**: Add `#masterModeState?: { enabled: boolean }` to `AgentSession`, with `getMasterModeState()` and `setMasterModeState()` (beside `#vibeModeState` at `session/agent-session.ts:1085` and `getVibeModeState` at `:8082`). In `AgentSession.#beforeToolCall` (`:6068`), add this at the top, before `markLoopToolCall`:

```ts
if (this.#masterModeState?.enabled) {
	const reason = masterRefusal(ctx.tool.name, ctx.args);
	if (reason) return { block: true, reason };
}
```

`masterRefusal(toolName, args)` is a pure function in the new file `session/master-mode.ts`. It returns a refusal text, or `undefined` when the call is allowed.

**Rationale**:
- The hook is the one place that sees every loop tool call. `Agent.beforeToolCall` is set to `#beforeToolCall` at `:2875`. In `agent-loop.ts` (`prepareToolCallDispatch`, `:3074-3169`), a result with `block: true` stores `blockReason` (`:3151`). The loop then returns an error tool result with the reason, and `execute` does not run. So a refused call has no effect (FR-003).
- Running first means a refused call never reaches the TTSR or the extension handlers. It also never leaves a `markLoopToolCall` marker behind.
- "Main agent only" (FR-009) needs no depth check. `AgentSession` has no `taskDepth` field. Only `InteractiveMode` sets the state. A subagent session is built by `createAgentSession` with no state, so the guard is off for it. A background `bash` job is a shell process, not a tool call, so the guard does not see it.
- A pure function lets the table test call the real guard with no session (R11).

**Alternatives considered**:
- A tool wrapper per tool. Rejected: about 15 edits, and a new tool would be unguarded by default. The hook refuses by default.
- An extension (`tool_call` handler). Rejected: extensions are optional, can be disabled with `--no-extensions`, and run after the TTSR step.
- A check on `ctx.tool.name === "task"` to find subagents. Rejected: the main agent has no `yield` tool and no such marker. The state alone is enough.

## R2: The allowlist, the `write` check, and the paths that skip the loop

**Decision**: The allowlist is fixed by tool name. There is no setting.

| Tool | Rule |
|---|---|
| `task` | Allowed. The foreground case is refused inside `TaskTool` (R3). |
| `bash` | Allowed only when `args.async === true` and `args.name` is empty or blank. |
| `read`, `grep`, `glob`, `find` | Allowed (user decision: not only internal URLs). |
| `todo`, `ask` | Allowed. |
| `goal`, `loop` | Allowed. These are hidden tools that goal mode and the guided loop add. Without them FR-018 would fail. They are in `HIDDEN_TOOL_NAMES` (`tools/builtin-names.ts:36`). |
| `write` | Allowed only for the internal targets below. |
| Everything else | Refused. This covers `edit`, `ast_edit`, `ast_grep`, `eval`, `web_search`, `browser`, `computer`, `wait`, `lsp`, `debug`, `ida`, `github`, `checkpoint`, `rewind`, `new_context`, `context_notes`, the memory tools, `think`, every MCP tool (`mcp__*`, see `isMCPToolName` in `builtin-names.ts`), and every extension tool. A tool that omp does not know is also refused. |

**The `write` check.** It is synchronous and uses the same router calls that `WriteTool.execute` uses (`tools/write.ts:912-1000`, the `touchesNoFiles` test at `:938`):

1. `path = recoverConflictUriPrefix(router.peelWriteSelector(unwrapHashlineHeaderPath(rawPath), "write")).path`. A throw means refuse. (`unwrapHashlineHeaderPath` is in `tools/plan-mode-guard.ts:55`. `recoverConflictUriPrefix` is in `tools/conflict-detect.ts:396`.)
2. `target = InternalUrlRouter.instance().writeTarget(path)` (`internal-urls/router.ts:392`). A path with no target is a project file: refuse.
3. Allow only when `target.spec.write.scope` is `"coordination"` (`agent://`), `"reply"` (`out://`), or `"sandbox"` (`local://`), or when `spec.write.cancels?.(target.url)` is true (`proc://<id>/kill`). The scope type is in `pi-tui/src/tools/url-scheme-host.ts:16`. The policy type is in `internal-urls/types.ts:70-100`.
4. Refuse the rest: plain paths, `xd://` (scope `device`), `proc://<id>/stdin` (scope `workspace`), `cfg://`, `conflict://`, `ssh://`, and `vault://`.

**Why `xd://` must be refused.** `write xd://<tool>` calls `dispatchXdevTool` (`tools/xdev.ts:433`). That function runs the inner tool with `executable.execute` directly. The loop-level `beforeToolCall` sees only the outer `write` call. If the guard allowed `xd://`, the main agent could run `edit` through it. The `write` check closes this. `read xd://` stays allowed because `read` changes nothing.

A bare absolute path inside the local sandbox directory is refused. Only the `local://` URL is allowed. This avoids `targetsLocalSandbox` (`plan-mode-guard.ts:80`), which needs a `ToolSession`.

**The `bash` check.** `BashTool.execute` (`tools/bash.ts:1071`) treats a call as async only when `rawAsync === true` (`:1112`). A non-blank `name` starts a service, ignores `async`, and may wait on `ready` (`:1114-1121`). So the guard requires `async === true` and a blank `name`. When `async.enabled` is off, `BashTool` itself throws `Async bash execution is disabled. Enable async.enabled to use async mode.` (`:1126-1128`). The guard needs no check for it, because the toggle already refuses entry when the setting is off (R7), and a call after a later change fails in the tool with a clear message.

**`wait`.** Refused by name (`tools/wait.ts:96`). The refusal says that results arrive by themselves. Vibe has its own blocking tool, `vibe_wait`, but vibe tools do not exist outside vibe mode, and a name that is not on the allowlist is refused anyway.

**Paths that skip the loop hook**, with the plan for each:

| Path | Plan |
|---|---|
| `write xd://<tool>` | Closed by the `write` check. |
| `eval` code that calls tools through a bridge | The `eval` tool is refused, so the bridge never starts. |
| Speculative `task` launch (`speculation.stream.open` launches before `beforeToolCall`) | Closed in `#startSpeculative` (R3). Speculative `read` and similar tools change nothing. |
| A provider that runs tools on its side (for example the Cursor exec handlers) | Accepted limit. Master mode is not a security boundary. |
| A user's own `!` or `$` command | Not a main-agent call. Not guarded. |

**Alternatives considered**:
- Refuse `write` fully. Rejected: FR-004 and FR-005 need messages to workers (`agent://`) and job stops (`proc://<id>/kill`).
- Allow `local://` through the generic sandbox helper. Rejected for the same reason as `targetsLocalSandbox` above.
- Allow a named bash service. Rejected: a named call with `ready` can wait for a port or a log line, so it can block. YAGNI.

## R3: A foreground `task` is refused inside `TaskTool`

**Decision**: There is no per-call `blocking` flag on `task`. The spec and the earlier proposal assumed one, and that is wrong. `blocking` is a field of the agent definition (`task/agents.ts:30`). No bundled agent sets it. A `task` call runs in the foreground in three cases (`task/index.ts:1160-1184`):

1. `async.enabled` is off.
2. The session has no `asyncJobManager`.
3. An item's agent type has `blocking: true` (`itemBlocking`, `:1160`).

The guard function cannot see the agent types. So `TaskTool.#dispatch` refuses the call itself. Right after it computes `itemBlocking` and `manager` (`:1160-1167`), it does this:

```ts
if (this.session.getMasterModeState?.()?.enabled && (!manager || itemBlocking.some(Boolean))) {
	return createTaskModeError(MASTER_TASK_REFUSAL);
}
```

`createTaskModeError` is at `task/index.ts:231`. The refusal comes before any run starts. `execute` discards the launch session in its `finally` (`:1084`), so nothing is left over.

`#startSpeculative` (`:1003`) adds one line after it computes `detached`: `if (!detached && this.session.getMasterModeState?.()?.enabled) return undefined;`. A speculative run starts while the arguments still stream, before `beforeToolCall`. Without this line a foreground run could start early. The speculation host allows the launch when there are no lifecycle handlers and the approval mode is automatic (`speculation/host.ts:216-246`).

This needs `getMasterModeState?: () => MasterModeState | undefined` on `ToolSession` (`tools/index.ts:464`, beside `getPlanModeState?`), wired in `sdk.ts:2721` as `() => session?.getMasterModeState()`. A subagent session has no such state, so its own nested `task` calls are not refused (FR-009).

**Rationale**: One refusal point in the tool that owns the fact. The state is read from the session, not copied.

**Alternatives considered**:
- Add a per-call `blocking` flag to the `task` schema. Rejected: it is a new tool feature, and the spec does not ask for it.
- Force `blocking: false` for every item in master mode. Rejected: the agent definition wins today, and a silent change would hide a foreground run from the model.
- Check in the guard with a lookup of the agent registry. Rejected: this duplicates `#resolveSpawnPreflight` (`:1045`).

## R4: Guard only. No tool-set swap

**Decision**: Master mode does not change the active tool set. `setActiveToolsByName` is not called on enter or exit.

**Rationale**:
- Goal mode and loop mode add and restore tools from their own snapshots (`#goalModePreviousTools`, the `goal` tool re-add at about `interactive-mode.ts:7080`, the `loop` tool add and remove). A master snapshot would clash with them when the modes exit in a different order than they entered. FR-018 requires that master runs together with goal and loop.
- FR-015 and SC-005 hold without work: the tool set never changes, so "the tools the agent had before" are always the tools it has.
- The guard is the enforcement either way. A tool swap would only hide tools from the model.

**Cost**: The model still sees tools that the guard refuses. The per-turn message (R5) lists the allowed tools, and each refusal names the allowed way. This differs from the earlier proposal and from the assignment text "enter/exit restores tool set". The test checks that enter and exit leave the active tool names unchanged (R11).

**Alternatives considered**: Swap to an allowlist set on enter and restore on exit, as `/spawn` does. Rejected for the clash above.

## R5: The per-turn instruction

**Decision**: A new prompt file `prompts/system/master-mode-active.md`, built from `prompts/system/orchestrate-notice.md` and the vibe pattern (`prompts/system/vibe-mode-active.md`).

- Add `#buildMasterModeMessage()` beside `#buildVibeModeMessage` (`session/agent-session.ts:8433`). It returns a hidden custom message of type `master-mode-context` (`display: false`), or `null` when the mode is off.
- Push it in the prompt flow right after the vibe push (`:9403-9406`).
- Skip it in the transcript: `:4702` already skips the vibe type when it saves custom messages. Add the master type to that condition. The message is rebuilt only while the mode is on, so it never returns from saved history.
- On exit, `setMasterModeState(undefined)` removes earlier copies from `agent.state.messages`, the steering and follow-up queues, and `#pendingNextTurnMessages`, as `setVibeModeState` does (`:8086-8110`).

The constant `MASTER_MODE_CONTEXT_MESSAGE_TYPE` lives in `session/master-mode.ts`. The vibe constant lives in `pi-tui/src/chat/messages.ts:30`, but the master type needs no TUI rendering, because the message is hidden.

**Content**, about 150 words, in this order:
1. Master mode is on. You are a coordinator. You never wait for a worker, a background job, or a foreground command (`ask` may wait for the user). You do not change files.
2. Tools you can use: `task`, `bash` with `async: true`, `read`, `grep`, `glob`, `find`, `todo`, `ask`, and `write` to `agent://`, `out://`, `local://`, and `proc://<id>/kill`.
3. Plan the work. Give independent parts to subagents in one `task` call.
4. After you start work, end your turn. Results arrive by themselves. React to each one.
5. Use background `bash` for checks only (tests, builds, `git status`). Give every change to a subagent.
6. Report to the user.

It drops the "trivial inline edit" rule of `orchestrate-notice.md`, because the main agent cannot edit.

**Mid-stream entry.** A `sendMasterModeContext` (like `sendVibeModeContext` at `:8276`) is not added. When the user turns the mode on during a turn, the guard applies from the next tool call, and each refusal explains the rule. The full message starts with the next prompt. This keeps the change small. Ponytail: add the steer if the first refusals confuse the model in practice.

**Result-triggered turns.** A turn that starts from an `async-result` follow-up does not build a new message. The message from the last prompt turn is still in the context, so the model keeps the rules.

**Alternatives considered**: Add the rules to the system prompt. Rejected: the system prompt is cached, and a mode change would break the cache. The hidden message is the existing pattern.

## R6: Persistence and resume

**Decision**: A dedicated custom entry, not a `mode_change` entry.

- `MASTER_MODE_ENTRY = "master-mode"`. On each change, `InteractiveMode.#saveMasterModeState()` calls `this.sessionManager.appendCustomEntry(MASTER_MODE_ENTRY, { enabled })` (`session/session-manager.ts:3747`, as `#saveSpeckitAutoState` at `interactive-mode.ts:3991` does).
- `restoreMasterMode()` reads the latest entry of the branch (`getBranch().findLast(...)`, the pattern of `restoreSpeckitAuto` at `:4064`). If `enabled`, it calls `session.setMasterModeState({ enabled: true })`, sets `masterModeEnabled`, and updates the status.
- `#reconcileModeFromSession` (`:7020`) calls `restoreMasterMode()` next to `restoreSpeckitAuto()` (`:7054`). `init` runs this before any turn, so a resumed session refuses a direct edit in its first turn (SC-006).
- `#clearTransientModeState` (`:6934`) resets the memory state without a new entry, as `#resetSpeckitAuto` does.
- Custom entries do not enter the model context.

**Rationale**: `mode_change` is one slot. Goal mode writes `appendModeChange("goal" | "goal_paused" | "none")` (`agent-session.ts:2901-2903`), and many other sites write `"none"`. Master runs together with goal and loop (FR-018), so a `mode_change` entry would be overwritten, and a goal exit would clear master mode on resume. The spec says "saved with the session", which a custom entry satisfies.

**Result**: A branch carries its own state. After `/new` the mode is off, and `/resume` takes the mode of the target branch. This matches vibe, goal, and speckit-auto. `--master` therefore applies per process start (see R8).

**Alternatives considered**: `mode_change` with a new `"master"` value. Rejected for the overwrite above.

## R7: Mutual exclusion, entry checks, and reset loops

**Decision**: Reuse each mode's existing refusal.

**Entering master** (`handleMasterModeCommand`, modeled on `handleVibeModeCommand` at `interactive-mode.ts:8342`), in this order:
1. `if (this.#warnSpeckitAutoBlocks()) return;` (`:7462`). Text: `Turn off speckit-auto mode first (/speckit-auto-mode).`
2. If plan mode is on or paused: `this.#warnPlanModeBlocks()` (`:7455`). Texts: `Exit plan mode first.` and `Plan mode is paused — run /plan again to fully exit.`
3. If vibe mode is on or `#vibeModeEntry` is set: `showWarning("Exit vibe mode first.")`.
4. If `!cfgAsyncEnabled.get(this.session.settings)` or `session.asyncJobManager` is missing: refuse and name the setting. Text: `Master mode needs background work. Enable async.enabled.` (FR-016.) `cfgAsyncEnabled` is in `tools/settings.ts:1018`.
5. Goal mode and loop mode do not block (FR-018).

**Entering the other modes while master is on.** Add `Exit master mode first.` to each refusal site:
- `handlePlanModeCommand` (`:8260`) and `#enterPlanMode` guards (`:7185-7197`).
- `handleVibeModeCommand` (`:8342`) and `#enterVibeMode` (`:8460`).
- `#speckitAutoBlocker` (`:4151`): add `"master"` to the return union. `#turnOnSpeckitAuto` (`:4187`) already prints `Exit ${blocker} mode first.`, so no new text is needed there.
- `#applySpeckitAutoDefault(startupBlocker?: "goal" | "plan", …)` (`:4165`): widen the type to `"goal" | "plan" | "master"` for `--master` (R8).
- The extension mode-control API `#planSessionModeTransition` (`:4984`): an `enter` for `plan` or `vibe` returns `conflict("master")`.

Goal mode and loop mode need no change.

**Reset loops.** `#loopIteration` has two guards (`:3735`, `:3767`) that turn a reset loop off under vibe, because a reset switches sessions through `handleClearCommand`. A reset would drop master mode too (R6). Extend both: under master, `Exit master mode before using reset loops. Loop mode disabled.`

**Not changed**: `#vibeSessionTransitionBlocked` (`:11010`) is specific to vibe workers. Master mode does not block session switches. `SessionModeState` and `SessionModeRequest` (the extension API) get no `master` value (non-goal: no spec requirement).

## R8: The `--master` flag and the non-interactive modes

**Decision**:

- `Args.master?: boolean`. The parse branch is `else if (arg === "--master") result.master = true;` beside `--wait-async` (`cli/args.ts:370`). Add `"--master"` to `VALUELESS_FLAGS` (`cli/flag-tables.ts:327`) and a `master: Flags.boolean(...)` help entry in `commands/launch-help.ts` (beside `wait-async`, `:99`).
- `validateMasterLaunch(args, interactive)` in `cli/args.ts`, called in `main.ts` beside `validateGoalLaunch` (`:1990`). In print, `--mode`, RPC, or ACP mode it throws `CliUsageError("--master requires an interactive terminal (not --print or --mode).")`. This is the text pattern of `--goal` (`args.ts:137-141`) and `--restore`.
- `runInteractiveMode` (`main.ts:683`) gets `startupMaster: boolean`. It calls `await mode.startMasterAtStartup(startsPlanYolo)` right after `mode.init` and its dialogs, and before `startGoalAtStartup` (`:845`), the restore (`:853`), the `/spawn` start text (`:871`), and the initial messages (`:886-906`). So master mode is on when the first start prompt runs (US4/AC1, AC2).
- `startMasterAtStartup(planYolo)` does nothing if the mode is already on (a resumed master session). Otherwise it uses the same entry checks as the toggle (R7). If an entry check refuses, it shows the reason and returns. The session starts without master mode (US4/AC3). `--plan-yolo` starts plan mode, so the method refuses with `Exit plan mode first.` semantics: `Master mode stays off: --plan-yolo starts plan mode.`
- `startupBlocker` for `init` becomes `"goal"` if `--goal`, else `"plan"` if `--plan-yolo`, else `"master"` if `--master`. The speckit-auto startup default then stays off, and `--master` wins over a default.
- `--master` with `--goal` is allowed (FR-018). Master mode starts first, then the goal start prompt runs under it.
- `--master` with a resumed session: the saved state is restored by `init`. If the branch is in plan mode, the entry refusal shows.

**Non-interactive modes: an error, not a warning.** Reasons:
- Print mode ends the run when the turn ends and cancels the background jobs it started. Only `--wait-async` keeps the process alive for them (`modes/print-mode.ts:485`). A master turn ends right after it dispatches work, so print mode would stop the work it just started.
- RPC and ACP clients drive their own turns. They have no toggle, no status label, and no way to see a refusal as a mode message. The saved entry is restored by `InteractiveMode`, so a resumed master session also runs without the guard in these modes. This is an accepted limit.
- Silently ignoring the flag would run the session without the rule that the user asked for. An exit code 2 is the safe result, and it matches `--goal`.

**Alternatives considered**: Set the state directly in print mode with `--wait-async`. Rejected as scope: no requirement asks for it, and RPC and ACP would need a separate answer.

## R9: The status line

**Decision**: Show `Master` beside the main mode, as `Prewalk` does (`pi-tui/src/status-line/segments.ts:707-721`). The `mode` segment shows one exclusive mode (plan, goal, vibe, speckit-auto, loop), and master runs together with goal and loop, so master cannot be an exclusive case.

- `SegmentContext.masterMode: { enabled: boolean } | null` in `types.ts` (beside `prewalk` at `:111`).
- `StatusLineComponent`: field `#masterModeStatus`, `setMasterModeStatus(status)` (as `setVibeModeStatus` at `component.ts:1205`), and `masterMode: this.#masterModeStatus` in the context (beside `:2646`). The field is at `:755` for vibe.
- `modeSegment.render` and `describe` append `Master` after the main mode, or show it alone when no other mode shows. The icon is `theme.icon.agents` (the one that vibe uses), so no new theme symbol is needed.
- `InteractiveMode.#updateMasterModeStatus()` (as `#updateVibeModeStatus` at `:6631`) calls `statusLine.setMasterModeStatus`, `ui.requestRender()`, and `#notifyModeChanged()`.

**Alternatives considered**: A new standalone segment. Rejected: it needs an entry in every preset (`presets.ts`), or users would not see it.

## R10: The honest limit, and the rejected alternatives

**Decision**: Master mode enforces two things: no direct file-change tool and no foreground or blocking work in the main agent. Background `bash` (`async: true`) stays allowed, and a background shell command can change files. "Give every change to a subagent" is a prompt rule. The per-turn message says it (R5).

The guard cannot tell a check command from a change command. `git status` and `sed -i` are both strings.

**Rejected alternatives**:
1. **Block `bash` entirely.** The main agent could not run a test or a build without a subagent, and every check would cost a subagent. The user kept background `bash`.
2. **Route every check through a subagent** (the strict variant). This is the same cost. The user declined it.
3. **Parse the command** and allow only a list of read-only commands. Rejected: a shell command cannot be judged safely by text, and a list is a security boundary that the spec says master mode is not.

**Result**: The goal is non-blocking and a coordinator. The limit is stated in the spec, in the docs, and in the tests (a test confirms that `bash` with `async: true` is allowed).

## R11: Tests

**Decision**: Three new files. The tests prove properties and run the real code. There is no mirror test.

- `test/master-mode-guard.test.ts`
  - A table over `(tool, args) → allow | refuse` that calls `masterRefusal`. Rows: each allowlist entry, each refused tool from R2, `bash` with and without `async`, with a `name`, and with a blank `name`, `write` to a plain path, `xd://edit`, `agent://x`, `out://x`, `local://x.md`, `proc://bg_1/kill`, `proc://bg_1/stdin`, and a malformed selector, an MCP name, and an unknown name.
  - A seeded property: for random tool names that are not on the allowlist, the result is always a refusal. The test prints the seed (013 convention).
  - A session wiring test: with the state on, `session.agent.beforeToolCall` returns `{ block: true }` for `edit` and `undefined` for `read`. With the state off, it returns `undefined` for `edit`. A refused `write` to a file path leaves the file unchanged.
  - The refusal text for each case names master mode and the allowed way, and ends with the no-workaround sentence (FR-008).
- `test/task/master-task-refusal.test.ts`
  - A task call with an agent definition that sets `blocking: true`, and a task call with `async.enabled` off. Both return the refusal, and no run starts (the run counter stays at zero). With the mode off, the same calls run.
  - `#startSpeculative` returns no run in master mode for a foreground item.
  - FR-009: with the parent session in master mode, a subagent session that `TaskTool` creates has no master state. Its `beforeToolCall` returns `undefined` for `edit` and for foreground `bash`, and its own foreground `task` is not refused.
- `test/interactive-mode-master.test.ts` (modeled on `test/interactive-mode-vibe-toggle.test.ts`)
  - Enter and exit leave the active tool names unchanged (SC-005). Exit removes the hidden message from the state and the queues.
  - Resume: an entry `enabled: true` on the branch gives master mode after `#reconcileModeFromSession`. `/new` gives off. A later `enabled: false` entry wins.
  - Exclusion: each of vibe, plan (on and paused), and speckit-auto blocks entry and names the mode. Master blocks each of the three, in both orders. Goal and loop do not block it.
  - Entry with `async.enabled` off is refused and names the setting.
  - A reset loop under master mode is refused.
  - `startMasterAtStartup`: master mode is on before the first prompt. Refusal cases show a message and leave the mode off.
- `test/cli-master-flag.test.ts` (in `test/cli-goal-flag.test.ts` style): `--master` parses, `--master -p` and `--master --mode rpc` exit with code 2.
- `packages/tui/test/status-line-master.test.ts`: `Master` shows alone, shows beside goal mode and loop mode, and does not show when the mode is off.

The refusal texts are checked by a property (contains `Master mode`, names an allowed way, ends with the no-workaround sentence), not by a copy of the whole string.

## R12: Docs

**Decision**: Update these files in the same change.
- `packages/coding-agent/CHANGELOG.md`: an `Added` entry for `/master` and `--master`.
- `docs/master-mode.md` (new, beside `docs/vibe-mode.md`): the goal, the guarantee and its limit (R10), the allowlist, entry and exit, resume, and the flag.
- `docs/cli-reference.md`: a `--master` row (near `--goal` at `:164`).
- `UPSTREAM_DIVERGENCES.md`: a fork-only entry with the decision, key paths, and checks.
- `docs/slash-command-internals.md` does not list mode commands such as `/vibe`, so it needs no change.
