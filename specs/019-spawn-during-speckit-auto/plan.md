# Implementation Plan: Spawn During Speckit-Auto Mode

**Branch**: `019-spawn-during-speckit-auto` | **Date**: 2026-11-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/019-spawn-during-speckit-auto/spec.md`

## Summary

`/spawn` refuses while speckit-auto mode is on, because the speckit run counts the spawn turn as a user turn. The change removes the refusal and makes the run ignore the spawn turn. A shared helper, `isSpawnKickoff`, identifies the kickoff by the `/spawn` display text that `handleSpawnCommand` sets. Three places use it:

- `isSpeckitUserTurn` excludes the kickoff.
- `isSpeckitSideTraffic` includes it.
- The live event handler keeps the phase reply at the kickoff's start, on both routes.

Also, `handleSpawnCommand` holds the existing `speckitSubmitInFlight` counter until it has sent its kickoff. So the run's own start cannot take the spawn window's run (research R5).

## Technical Context

**Language/Version**: TypeScript on Bun ≥ 1.4.4

**Primary Dependencies**: None new. The change uses the existing `AgentSession` events, the speckit-auto module, and the spawn window.

**Storage**: The session file (`.jsonl`). The kickoff's `displayText` is already saved. The saved speckit run entry does not change shape.

**Testing**: `bun test` in `packages/coding-agent` (`test/interactive-mode-speckit-auto.test.ts`, `test/spawn-command.test.ts`). Then one real-omp smoke run in zmx.

**Target Platform**: The omp interactive TUI

**Project Type**: CLI/TUI application (monorepo package `packages/coding-agent`)

**Performance Goals**: N/A. One extra check for each `message_start` event.

**Constraints**:
- Every other refusal of `/spawn` and of speckit-auto mode stays the same.
- No change to the `ai` message types.

**Scale/Scope**: Two source files: `interactive-mode.ts` and `speckit-auto.ts`. One test file. CHANGELOG and divergence notes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The constitution file is the empty template. These repository rules act as the gates.

| Gate | Status |
|---|---|
| Fix the root cause in shared code | Pass. One helper is used by `isSpeckitUserTurn`, which all user-turn readers share. |
| No speculative scope | Pass. Loop mode has the same start gap, and it is out of scope (R5). |
| Tests prove behavior | Pass. The new tests (R7) check the run's observable state. Each one fails before the change, except the paused guards. |
| Real smoke run | Pass. A quickstart run uses real `omp-dev` in zmx. |
| Changelog and divergence notes | Pass. They are in scope. |
| `bun check` before commit | Pass. It is in the quickstart. |

Re-check after Phase 1: still pass. The design adds no state, no setting, and no message field.

## Project Structure

### Documentation (this feature)

```text
specs/019-spawn-during-speckit-auto/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── spawn-in-speckit-run.md
└── tasks.md             # /speckit.tasks
```

### Source Code (repository root)

```text
packages/coding-agent/
├── src/modes/speckit-auto.ts        # isSpawnKickoff; isSpeckitUserTurn excludes it
├── src/modes/interactive-mode.ts    # isSpeckitSideTraffic, live kickoff branch, submit counter in handleSpawnCommand, refusal removed
├── test/interactive-mode-speckit-auto.test.ts
└── CHANGELOG.md
UPSTREAM_DIVERGENCES.md               # speckit-auto and /spawn entries
```

**Structure Decision**: Edit the existing mode files only. No new module.

## Complexity Tracking

No violations.
