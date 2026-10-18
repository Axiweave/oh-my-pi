# Implementation Plan: Guided Loop Setup

**Branch**: `013-guided-loop` (the work happens on `main`) | **Date**: 2026-10-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/013-guided-loop/spec.md`

## Summary

`/guided-loop [rough idea]` starts an interview in the chat, in the same way as `/guided-goal`. At the end, the agent calls a new hidden `loop` tool with the prompt, limit, interval, and condition. The tool builds the `/loop` line, checks that it parses back to the same setup, and calls a handler that InteractiveMode installs only for the interview. The handler shows the line in a yes/no dialog. On yes, it runs the existing `/loop` code to turn on or replace the loop, and queues the prompt as the first run. A loop that was on before the interview pauses, and interview answers do not become its prompt.

## Technical Context

**Language/Version**: TypeScript on Bun 1.4.2

**Primary Dependencies**: Workspace package `@oh-my-pi/pi-coding-agent`. No new dependency.

**Storage**: N/A. The interview and its handler are in memory only.

**Testing**: `bun:test`. Property tests use a seeded generator, and the test prints the seed.

**Target Platform**: The interactive TUI of `omp`. `/guided-loop` has only a TUI handler, as `/guided-goal` has.

**Project Type**: CLI/TUI application in a monorepo.

**Performance Goals**: N/A. The interview speed is the model speed.

**Constraints**:
- Loop mode never turns on without Yes in the dialog (SC-003).
- The line in the dialog parses back to the same setup (SC-004).
- An interview answer never becomes a loop prompt (US3/AC4).

**Scale/Scope**: About 12 source files change, plus 2 new source files, 2 new prompt files, and 2 new test files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template, so it defines no gates. These gates come from the repo rules (`AGENTS.md`):

| Gate | Status |
|---|---|
| No backward-compatibility shims. | Pass. `goalInterviewActive` is renamed in place, with no alias (R9). |
| No over-engineering. | Pass. The design reuses the `/guided-goal` kickoff, the `PlanProposalHandler` slot pattern, `handleLoopCommand`, and `setLoopPrompt`. The new parts are one tool, one handler type, and one interview flag (R2, R4, R6). |
| Tests prove properties. | Pass. R10 plans a seeded round-trip property for the tool and state-transition checks for the interview. |
| Each feature that a user can configure gets its default in `~/.omp/agent/config.yml`. | N/A. There is no new setting. |
| Update `CHANGELOG.md`. Record fork-only behavior in `UPSTREAM_DIVERGENCES.md`. | Planned. |

The check after Phase 1 also passes. The design adds no setting, no persistence, and no new module beyond the tool file.

## Project Structure

### Documentation (this feature)

```text
specs/013-guided-loop/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── guided-loop.md   # command states, tool input and results
└── tasks.md             # /speckit.tasks
```

### Source Code (repository root)

```text
packages/coding-agent/
├── src/tools/loop.ts                         # NEW hidden tool: build args, round-trip check, call handler
├── src/prompts/tools/loop.md                 # NEW tool description
├── src/prompts/loop/guided-loop-interview.md # NEW kickoff prompt
├── src/tools/builtin-names.ts                # "loop" in HIDDEN_TOOL_NAMES
├── src/tools/index.ts                        # HIDDEN_TOOLS entry, isToolAllowed gate, ToolSession handler slot
├── src/tools/resolve.ts                      # LoopStartHandler type beside PlanProposalHandler
├── src/sdk.ts                                # wire the slot, pre-register the tool, keep it out of the first active set
├── src/session/agent-session.ts              # handler slot wrapped in waitForUser
├── src/modes/interactive-mode.ts             # handleGuidedLoopCommand, begin/end interview, handler, guards, rename
├── src/modes/types.ts                        # context members, interviewActive rename
├── src/modes/controllers/input-controller.ts # c and . guard, draftDetached list
├── src/modes/controllers/{event,extension-ui,session-focus}-controller.ts  # interviewActive rename
├── src/slash-commands/builtin-modes.ts       # /guided-loop entry
├── test/tools/loop-tool.test.ts              # NEW
├── test/guided-loop.test.ts                  # NEW
└── CHANGELOG.md
UPSTREAM_DIVERGENCES.md
```

**Structure Decision**: Put the tool in its own file, as each existing tool has one. Keep all interview and loop state in InteractiveMode, next to the guided-goal and loop code that it reuses. The tool layer sees only the handler slot.

## Design Notes

These notes refer to [research.md](research.md) and [contracts/guided-loop.md](contracts/guided-loop.md).

1. **Kickoff (R1).** `handleGuidedLoopCommand` copies `handleGuidedGoalCommand`. It runs the refusals (R7), calls `pauseLoop()` if the loop runs, calls `#beginGuidedLoopInterview()`, and sends the rendered kickoff.
2. **Tool (R2, R3).** `loop` builds `args`, checks the round trip with `parseLoopArgs`, and calls `session.peekLoopStartHandler()`.
3. **Handler (R4).** The handler shows the dialog. On yes, it ends the interview, shows the `/loop` line, calls `handleLoopCommand(args)` and `setLoopPrompt(prompt)`, and queues `session.followUp(prompt)`.
4. **Guards (R5).** `setLoopPrompt` returns at once during the interview. `handleLoopCommand` ends the interview first.
5. **Lifecycle (R6).** `#endGuidedLoopInterview()` is the only exit. It clears the flag, `interviewActive`, and the handler, and it removes `loop` from the active tools.
6. **Input (R8), IDE (R9), speckit (R7).** Small edits in the input controller, a rename, and one more speckit blocker case.

## Risks

| Risk | Mitigation |
|---|---|
| The model calls `loop` before the user agrees. | The dialog is the gate. The model cannot turn the loop on without Yes (SC-003). |
| The tool stays active after the interview, as the `goal` tool does after an abandoned `/guided-goal`. | Every end point goes through `#endGuidedLoopInterview()`. `isToolAllowed` also drops the tool when the handler is gone. |
| The first interval run starts a few seconds early, because the run start is recorded at the tool call (R4). | The tool result tells the agent to end its turn at once. Mark it with a `ponytail:` comment. |
| Removing a tool during the tool call that uses it. | `#exitGoalMode` already changes tools from a session event during a turn. The tests cover the `started` path. |
| The spec edge case about plan, goal, and vibe refusals does not match `/loop` (R7). | The plan follows FR-011. `/speckit.analyze` fixes the edge case text. |

## Complexity Tracking

No gate violations.
