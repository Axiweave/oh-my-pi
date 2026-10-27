# Implementation Plan: Speckit-Auto Follows a Phase the Agent Starts Itself

**Branch**: `017-speckit-auto-self-advance` (work happens on `main`) | **Date**: 2026-10-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/017-speckit-auto-self-advance/spec.md`

## Summary

The mode watches `tool_execution_start` and `tool_execution_end` of the main session. A pure function `speckitPhaseLoad(toolName, args)` recognizes two load forms: a `specify …` CLI segment that names `speckit.<phase>`, and a `read` of `speckit.<phase>.md`, `speckit-<phase>/SKILL.md`, or `skill://speckit-<phase>`. When the call succeeds, `#applySpeckitPhaseLoad(phase)` applies the agent rules of data-model.md: a new run when none exists or for specify (through `#startSpeckitRun`, shared with the typed-command branch), no change for the same phase, and otherwise a move that counts the converge round and keeps `paused` and `editing`. The typed and own-turn branches keep their rules. In a tasks-scope run, an implement or converge load ends the run as "stopped before implement" and aborts the turn. The settle check needs no change, because `run.phase` already holds the moved phase.

## Technical Context

**Language/Version**: TypeScript on Bun

**Primary Dependencies**: `AgentSessionEvent` (`tool_execution_start`/`tool_execution_end`), `AgentSession.abort`, and the existing speckit-auto module and `InteractiveMode` methods. No new dependency.

**Storage**: No change. The session `custom` entry `speckit-auto` keeps its shape, and each move saves through `#saveSpeckitAutoState`.

**Testing**: `bun test` in `packages/coding-agent/test` (`speckit-auto.test.ts`, `interactive-mode-speckit-auto.test.ts`)

**Target Platform**: The omp interactive TUI on macOS and Linux

**Project Type**: CLI/TUI monorepo package (`packages/coding-agent`)

**Performance Goals**: One string split and a few token compares per `bash` or `read` start event. No measurable cost.

**Constraints**: Typed and mode-sent phase commands keep their current behavior. No new setting (FR-012). Subagent tool calls must not count. The session subscription already covers only the main session (research R1).

**Scale/Scope**: 2 source files, 2 test files, and 2 docs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the empty template. The gates come from the repository rules (`AGENTS.md`, project memory):

| Gate | Status |
|---|---|
| Reuse existing patterns, no second convention | Pass. The run start is one extracted method (`#startSpeckitRun`) that the typed branch and the agent path share. The agent move differs on purpose from the typed and own paths (R3). The abort reuses the `/speckit-auto next` call (R4), and the end result reuses `planned` (R4). |
| No speculative scope | Pass. Only the two observed load forms are matched. Bash `cat`, async bash, and a transcript notice are left out with reasons (R2, R5). |
| Tests prove behavior, not wiring | Pass. The detector table covers matches and rejections, including the `.specify/` false positive. Interactive cases cover each transition row and the failed-load edge. |
| Changelog and divergence notes | Pass. `packages/coding-agent/CHANGELOG.md` and the `UPSTREAM_DIVERGENCES.md` speckit-auto entry are in scope (R8). |
| New config default appended to `~/.omp/agent/config.yml` | Not applicable. No setting. |
| `bunx oxfmt --check` before commit | Pass. `bun check` is in quickstart section 1. |

Post-design re-check: still passes. Extracting `#startSpeckitRun` touches the typed branch only to share its run start. Its behavior does not change.

## Project Structure

### Documentation (this feature)

```text
specs/017-speckit-auto-self-advance/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/phase-load.md
└── tasks.md             # /speckit.tasks
```

### Source Code (repository root)

```text
packages/coding-agent/src/modes/
├── speckit-auto.ts          # speckitPhaseLoad (contracts/phase-load.md)
└── interactive-mode.ts      # #speckitPendingLoads, tool events in #handleSpeckitSessionEvent,
                             # #applySpeckitPhaseLoad, #startSpeckitRun (shared with the typed branch), tasks-scope abort

packages/coding-agent/test/
├── speckit-auto.test.ts                     # detector table
└── interactive-mode-speckit-auto.test.ts    # run transitions

packages/coding-agent/CHANGELOG.md
UPSTREAM_DIVERGENCES.md                      # Speckit-auto mode entry: one decision line + check
```

**Structure Decision**: No new module. The detector sits beside `parseSpeckitPhaseCommand` in the pure speckit-auto module. The event handling stays in `InteractiveMode`, because it needs the private run state, `#finishSpeckitRun`, and `#bumpSpeckitGeneration`.

## Complexity Tracking

No violations.
