# Implementation Plan: Master Mode

**Branch**: `022-master-mode` (the work happens on `main`) | **Date**: 2026-11-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/022-master-mode/spec.md`

## Summary

Master mode makes the main agent a central orchestrator that never blocks on delegated work: it never waits for a worker, a background job, or a foreground command. `ask` can still wait for the user. The main agent stays free to talk to the user and to react to results. Subagents and background jobs do the work. The mode is not a security boundary (spec Clarifications).

The key enforcement is that the main agent cannot start foreground or blocking work: no foreground `bash`, no foreground `task`, no `wait`, no `eval`, no browser, no web search, and no other tool that holds the turn. A second rule keeps the main agent a coordinator: it has no direct file-change tool (`edit`, `ast_edit`, and `write` to a project file). Background `bash` (`async: true`) stays allowed, so checks stay cheap. "Give every change to a subagent" is a prompt rule, not an enforced rule (R10).

The design has four parts:

1. **Guard.** A small pure function, `masterRefusal(toolName, args)`, returns a refusal text or `undefined`. `AgentSession.#beforeToolCall` calls it first, when master mode is on. The loop turns a refusal into an error tool result, and the tool does not run (R1, R2). The `task` tool adds its own check, because a foreground `task` is a property of the agent type and of the async setting, not of the call arguments (R3).
2. **State.** `AgentSession` holds `{ enabled }`. `InteractiveMode` owns the toggle, the mutual exclusion, the status label, and the save as a custom session entry. The saved entry makes resume work (R6, R7, R9).
3. **Instructions.** A hidden per-turn message, built from `orchestrate-notice.md`, tells the agent the rules. It is never saved in the transcript (R5).
4. **Entry points.** `/master` toggles the mode in the TUI. `--master` starts an interactive session in the mode. The flag is an error in print, RPC, and ACP mode (R8).

The design does not change the active tool set. The guard alone enforces the rule, so goal mode and loop mode keep adding and removing their own tools without a conflict (R4).

## Technical Context

**Language/Version**: TypeScript on Bun 1.4.x

**Primary Dependencies**: Workspace packages `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui`. No new dependency.

**Storage**: One `custom` session entry, `master-mode`, with `{ enabled }`. Nothing else is saved.

**Testing**: `bun:test`. The guard test is a table over `(tool, args)` that calls the real function. One seeded property test uses random tool names, and the test prints the seed.

**Target Platform**: The interactive TUI of `omp`. `/master` has only a TUI handler, as `/vibe` has. `--master` works in interactive mode only.

**Project Type**: CLI/TUI application in a monorepo.

**Performance Goals**: The guard is synchronous and does a few string checks and one router lookup. It adds no await to the tool path. SC-002 and SC-004 depend on existing behavior (the async job sink), not on new code.

**Constraints**:
- A refused call has no effect (FR-003). The guard runs before the tool, so no side effect can start.
- The guard applies to the main agent only (FR-009). Only `InteractiveMode` sets the state, and subagent sessions are created with no state.
- A tool in the active set can still be called by an extension or a bridge outside the loop. The guard covers the loop path and the `write xd://` bypass (R2). Other paths are listed as limits (R2).

**Scale/Scope**: About 15 source files change, plus 1 new source file, 1 new prompt file, 5 new test files, and docs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template, so it defines no gates. These gates come from the repo rules (`AGENTS.md`):

| Gate | Status |
|---|---|
| No backward-compatibility shims. | Pass. The refusal sites for vibe, plan, and speckit-auto get one more case in place. There is no alias (R7). |
| No over-engineering. | Pass. The design reuses the vibe pattern for the per-turn message and the status label, the speckit-auto pattern for the saved entry, and the internal-URL write policy for the `write` check. The new parts are one pure guard function and one state field (R1, R2). |
| Tests prove properties. | Pass. R11 plans a table test over the real guard, one seeded property, and state checks for enter, exit, resume, and refusal. There is no mirror test. |
| Each feature that a user can configure gets its default in `~/.omp/agent/config.yml`. | N/A. There is no new setting. The allowlist is fixed (spec Assumptions). |
| Update `CHANGELOG.md`. Record fork-only behavior in `UPSTREAM_DIVERGENCES.md`. | Planned (R12). |

The check after Phase 1 also passes. The design adds no setting, no tool, and no tool-set swap.

## Project Structure

### Documentation (this feature)

```text
specs/022-master-mode/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── master-mode.md   # /master states, --master flag, guard table, refusal texts
└── tasks.md             # /speckit.tasks
```

### Source Code (repository root)

Line numbers in this plan come from the tree at the start of this plan. Open the file before an edit, because lines move.

```text
packages/coding-agent/
├── src/session/master-mode.ts               # NEW: MasterModeState, MASTER_MODE_ENTRY, MASTER_MODE_CONTEXT_MESSAGE_TYPE, masterRefusal()
├── src/prompts/system/master-mode-active.md # NEW: per-turn instructions (from orchestrate-notice.md)
├── src/session/agent-session.ts             # #masterModeState, get/set, guard call in #beforeToolCall (:6068), #buildMasterModeMessage, push at :9403, persistence skip at :4702
├── src/tools/index.ts                       # ToolSession.getMasterModeState? (beside getPlanModeState? at :464)
├── src/sdk.ts                               # wire getMasterModeState (beside getPlanModeState at :2721)
├── src/task/index.ts                        # refuse a foreground task in #dispatch (:1160-1184) and #startSpeculative (:1003)
├── src/modes/interactive-mode.ts            # masterModeEnabled, handleMasterModeCommand, #enterMasterMode, #exitMasterMode, startMasterAtStartup, status, restore/reset, refusal cases
├── src/modes/types.ts                       # masterModeEnabled, handleMasterModeCommand on InteractiveModeContext (vibe at :711)
├── src/slash-commands/builtin-modes.ts      # /master entry; "blocked by master" hints on /vibe and /plan (vibe entry at :531)
├── src/cli/args.ts                          # Args.master, parse branch beside --wait-async (:370), validateMasterLaunch beside validateGoalLaunch (:137)
├── src/cli/flag-tables.ts                   # --master in VALUELESS_FLAGS (:327)
├── src/commands/launch-help.ts              # master flag help (beside wait-async :99)
├── src/main.ts                              # validateMasterLaunch call (beside :1990), startupMaster to runInteractiveMode (:683), startupBlocker (:762)
packages/tui/src/status-line/
├── types.ts                                 # SegmentContext.masterMode (beside prewalk :111)
├── component.ts                             # #masterModeStatus, setMasterModeStatus (beside :1205), ctx field (beside :2646)
└── segments.ts                              # "Master" label beside the main mode (modeSegment :707)
packages/coding-agent/test/
├── master-mode-guard.test.ts                # NEW: table + property over the real guard, session wiring
├── interactive-mode-master.test.ts          # NEW: enter, exit, resume, exclusion, startup
├── task/master-task-refusal.test.ts         # NEW: foreground task refusal, no run starts
└── cli-master-flag.test.ts                  # NEW: parse, non-interactive usage error
packages/tui/test/
└── status-line-master.test.ts               # NEW: Master label alone, beside goal and loop, hidden when off
docs/master-mode.md                          # NEW
docs/cli-reference.md                        # --master row
packages/coding-agent/CHANGELOG.md
UPSTREAM_DIVERGENCES.md
```

**Structure Decision**: Put the state type, the two constants, and the guard function in one new file beside the session code. The guard is a pure function, so the table test needs no session. Keep the toggle, the exclusion, and the status in `InteractiveMode`, next to the vibe code that they copy. The `task` tool refuses its own foreground path, because only that tool knows its agent types.

## Design Notes

These notes refer to [research.md](research.md) and [contracts/master-mode.md](contracts/master-mode.md).

1. **Guard (R1, R2).** `#beforeToolCall` starts with `if (this.#masterModeState?.enabled) { const reason = masterRefusal(ctx.tool.name, ctx.args); if (reason) return { block: true, reason }; }`. It runs before the TTSR and extension logic, so a refused call never reaches them.
2. **Allowlist (R2).** `task`, `bash` with `async: true` and no `name`, `read`, `grep`, `glob`, `find`, `todo`, `ask`, `goal`, `loop`, and `write` to `agent://`, `out://`, `local://`, or `proc://<id>/kill`. Everything else is refused, including `xd://`.
3. **Foreground task (R3).** `TaskTool` refuses a call when master mode is on and the call would run in the foreground. `#startSpeculative` returns `undefined` for the same case, so no run starts early.
4. **Message (R5).** `#buildMasterModeMessage` renders `master-mode-active.md`. The prompt flow pushes it each turn after the vibe push. `sendMasterModeContext` is not added (R5).
5. **Toggle (R6, R7).** `handleMasterModeCommand` toggles. Entry refuses on speckit-auto, plan, vibe, and a disabled `async.enabled`. Exit clears the state and removes the message. Exit does not abort the turn (US3/AC4).
6. **Save (R6).** `#saveMasterModeState` appends a `master-mode` custom entry on each change. `restoreMasterMode` runs in `#reconcileModeFromSession` and `#clearTransientModeState` clears the memory state.
7. **Startup (R8).** `--master` becomes `startMasterAtStartup()` after `init` and before the goal start and the first prompt in `runInteractiveMode`.
8. **Status (R9).** `Master` shows beside the main mode, as `Prewalk` does.

## Risks

| Risk | Mitigation |
|---|---|
| A background shell job changes files, so the "every change goes to a subagent" rule is not enforced (R10). | The spec states this limit. The per-turn message names the rule. The honest wording is in the docs and the refusal texts do not claim more. |
| The guard misses a path that runs a tool outside the loop. | R2 lists the paths: `write xd://` (closed by the `write` check), `eval` bridge (the tool is refused), speculative launch (closed for `task`), and provider-side direct execution (an accepted limit). |
| `--master` applies per process start. `/new` and `/resume` take the mode of the target branch (R6). | The docs and the quickstart say it. The cc-ide Master Session starts with `--master` each time. |
| The tool-set swap is absent, so the model still lists tools that it cannot use (R4). | The per-turn message lists the allowed tools. Each refusal names the allowed way. |
| A reset loop (`/loop` with a reset) switches the session and drops master mode. | `#loopIteration` refuses reset loops under master mode (R7). |
| The per-turn message grows the context by one copy per turn, as vibe does. | Keep the message short, about 150 words (R5). |

## Complexity Tracking

No gate violations.
