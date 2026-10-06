# Implementation Plan: Speckit-Auto Mode

**Branch**: `009-speckit-auto-pipeline` (no git branch, the repo has no branch hook) | **Date**: 2026-10-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/009-speckit-auto-pipeline/spec.md`

## Summary

Speckit-auto mode is a built-in interactive mode, beside loop and goal mode in `InteractiveMode`. It watches user turns that start with `/speckit.<phase>`. When a run turn settles, it reads a turn verdict from the last assistant message and then starts the next phase command, the same way loop mode submits its prompt.

The design has two parts:

1. A pure module `src/modes/speckit-auto.ts`. It holds the run state, the phase command parser, the text cues, the judge call, the decision function `decideSpeckitStep(run, verdict)`, and the parser for the saved session state. It has no UI and no timers, so a test can drive it with a seeded random verdict sequence.
2. Wiring in `InteractiveMode`. This part has an 800 ms self-arming tick (armed from `getUserInput()` and every `agent_end`), the settled-turn guard, a generation counter that drops stale work, a `message_start` listener that detects the start of user turns and phase turns, Esc pause, notification suppression, mutual exclusion, status-bar updates, and save/restore through a `custom` session entry.

The verdict comes from text cues first: the analyze report structure and counts, and the converge "✅ Converged" line or appended convergence phase. A single `resolveJudge` call with four yes/no questions answers the rest. When the judge call fails, the module uses text cues that need positive proof. Anything it cannot prove holds the run. A reported error holds every phase.

## Technical Context

**Language/Version**: TypeScript on Bun (version from root `packageManager`)

**Primary Dependencies**: `src/judgment` (`resolveJudge`, `journalJudgmentUsage`, `sharedJudgmentCache`), `@oh-my-pi/pi-ai` judgment types (`NoulQuestion`), `@oh-my-pi/pi-tui` status line, the config registry (`register` in `src/config/registry.ts`)

**Storage**: One `custom` session entry type, `speckit-auto`, written with `SessionManager.appendCustomEntry`. The mode reads the latest entry on the current branch.

**Testing**: `bun test` (bun:test with `vi`). No property-test library is installed. The decision test uses a hand-rolled seeded generator and prints the seed and the failing sequence.

**Target Platform**: The omp interactive TUI (macOS, Linux, Windows). Print mode, RPC, and ACP are out of scope.

**Project Type**: Monorepo CLI (`packages/coding-agent`, `packages/tui`)

**Performance Goals**: SC-007: the next phase starts within 5 s in a typical run and never later than 30 s. The judge call has a 15 s deadline, and the grace period is 800 ms.

**Constraints**: No new model setting (FR-024). Exactly one new setting (FR-034, FR-036). No backward compatibility (AGENTS.md). Core feature, not an extension.

**Scale/Scope**: 1 new source module, 4 new prompt files, about 9 changed source files in 2 packages, 3 new test files, 7 status-line fixture literals, 3 doc files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template, so it defines no gates. The plan uses the repo rules in AGENTS.md and `.omp/AGENTS.md` as gates:

| Gate | Status |
|---|---|
| Reuse existing patterns, no second convention | Pass. The scheduler copies loop and goal mode (`getUserInput` → timer → `startPendingSubmission`). Persistence copies the todo and context-notes `custom` entry pattern. The judge call copies `unexpected-stop-classifier.ts`. The status bar copies the loop mode segment. |
| No unrequested abstraction | Pass. One pure module and wiring in the existing `InteractiveMode`. No controller class, no strategy table per phase beyond one `Record`. |
| Tests prove a property | Pass. The decision test checks the SC-004 bounds and the "never advance on a question or failure" invariants over seeded random verdict sequences. The interactive test checks the user-first and settled-turn rules (SC-002, SC-003, SC-005). |
| Changelog and docs updated | Pass. `packages/coding-agent/CHANGELOG.md`, `packages/tui/CHANGELOG.md`, `docs/settings.md`, and `UPSTREAM_DIVERGENCES.md` are in scope. |
| New config default appended to `~/.omp/agent/config.yml` | Pass. Append `speckitAuto.convergeRounds: 3`. |

Post-design re-check: still passes. Research R2 explains why the stateful part stays in `InteractiveMode` and does not get its own controller.

## Project Structure

### Documentation (this feature)

```text
specs/009-speckit-auto-pipeline/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── speckit-auto.md      # commands, status bar, setting, session entry, mode messages
├── checklists/
│   └── requirements.md
└── tasks.md                 # /speckit.tasks output
```

### Source Code (repository root)

```text
packages/coding-agent/src/
├── modes/
│   ├── speckit-auto.ts                   # NEW: run state, phase parser, text cues, judge call, decideSpeckitStep, saved-state parser
│   ├── interactive-mode.ts               # fields, tick, guards, message_start hook, exclusion, status, save/restore, commands
│   ├── types.ts                          # InteractiveModeContext: speckit fields and methods
│   ├── settings.ts                       # cfgSpeckitAutoConvergeRounds
│   └── controllers/
│       ├── input-controller.ts           # Esc pause line, submit-in-flight counter
│       └── event-controller.ts           # completion and error notification suppression
├── prompts/speckit-auto/                 # NEW: answer.md, continue.md, remediation.md, judge.md
└── slash-commands/
    └── builtin-modes.ts                  # /speckit-auto-mode, /speckit-auto, "blocked by speckit-auto" autocomplete text

packages/tui/src/status-line/
├── types.ts                              # SegmentContext.speckitAuto
├── component.ts                          # setSpeckitAutoStatus
└── segments.ts                           # modeSegment render + describe branch

packages/coding-agent/src/cli/gallery-fixtures/segments.ts   # speckitAuto: null (+ gallery states)
packages/coding-agent/test/
├── speckit-auto.test.ts                  # NEW: decision properties, text cues, phase parser, saved-state parser
├── interactive-mode-speckit-auto.test.ts # NEW: scheduler, user-first, Esc, exclusion, restore
└── (3 status-line tests)                 # speckitAuto: null in SegmentContext literals
packages/tui/test/
├── status-line-speckit-auto.test.ts      # NEW: modeSegment render + describe for all six states, paused uses warning color (SC-009)
└── (3 status-line tests)                 # speckitAuto: null in SegmentContext literals (loop, model, path)

docs/settings.md
packages/coding-agent/CHANGELOG.md
packages/tui/CHANGELOG.md
UPSTREAM_DIVERGENCES.md
~/.omp/agent/config.yml                   # speckitAuto.convergeRounds: 3
```

**Structure Decision**: Add one pure module. Put the stateful wiring in `InteractiveMode` beside loop and goal mode, because it needs the same private seams (`onInputCallback`, `#isAutoSubmitBlocked`, `#pendingSubmittedInput`, `#reconcileModeFromSession`, `prepareSessionSwitch`).

## Complexity Tracking

No gate violations.
