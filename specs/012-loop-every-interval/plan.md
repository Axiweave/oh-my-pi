# Implementation Plan: Fixed Interval for /loop

**Branch**: `012-loop-every-interval` | **Date**: 2026-10-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/012-loop-every-interval/spec.md`

## Summary

Add `every <duration>` to `/loop` so that a loop prompt runs again a fixed time after the start of each run. The parser gets one new clause. The current auto-submit timer gets a due time. The status line shows the interval and the next run time. Two related changes are in the same feature:

- A loop run keeps the draft in the input box.
- `/loop` with arguments replaces a running loop. A bare `/loop` still turns loop mode off.

The feature adds no new run path, setting, or module.

## Technical Context

**Language/Version**: TypeScript on Bun 1.4.2

**Primary Dependencies**: Workspace packages `@oh-my-pi/pi-coding-agent` (loop logic) and `@oh-my-pi/pi-tui` (status line). No new dependency.

**Storage**: N/A. All state is in memory for the life of the session.

**Testing**: `bun:test` with `vi.useFakeTimers()`. Fake timers also move `Date.now()` (research R3).

**Target Platform**: The interactive TUI of `omp` on macOS, Linux, and Windows terminals.

**Project Type**: CLI/TUI application in a monorepo.

**Performance Goals**: Each run starts within 2 s of its due time when the session is idle (SC-001).

**Constraints**:
- No run starts while the session is busy.
- A run does not change the input box.
- System sleep must not delay a due run by more than about 1 s after the wake.

**Scale/Scope**: One loop per session. About 8 source files and 5 test files change.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template, so it defines no gates. These gates come from the repo rules (`AGENTS.md`):

| Gate | Status |
|---|---|
| No backward-compatibility shims. Change callers in place. | Pass. FR-016 changes `/loop` with arguments in place, with no flag or alias. |
| No over-engineering: no new abstraction, setting, or module without need. | Pass. The design uses one parser clause, two fields, and one timer change (R1). |
| Tests prove properties, not copies of the code. | Pass. R9 lists property checks: a reference parser, start-to-start gaps, one run after an overrun, the draft does not change. |
| Each feature that a user can configure gets its default in `~/.omp/agent/config.yml`. | N/A. There is no new setting. |
| Update `CHANGELOG.md`. Record fork-only behavior in `UPSTREAM_DIVERGENCES.md`. | Planned (R8). |

The check after Phase 1 also passes. The design adds no file, setting, or abstraction beyond the table above.

## Project Structure

### Documentation (this feature)

```text
specs/012-loop-every-interval/
├── plan.md              # This file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   └── loop-command.md  # Phase 1: /loop grammar, behavior, status line
└── tasks.md             # Phase 2 (/speckit.tasks)
```

### Source Code (repository root)

```text
packages/coding-agent/
├── src/modes/
│   ├── loop-limit.ts                 # every-clause parser, shared duration helper, LOOP_USAGE, interval text
│   ├── interactive-mode.ts           # due time, run start, replace, preserveDraft, status fields
│   └── types.ts                      # loopIntervalMs on the mode context
├── src/slash-commands/builtin-modes.ts  # description, inlineHint, autocomplete text
├── test/loop-limit.test.ts
├── test/interactive-mode-loop.test.ts
└── CHANGELOG.md
packages/tui/
├── src/status-line/types.ts          # loopMode.intervalMs, loopMode.nextRunAt
├── src/status-line/segments.ts       # render "every 15m next 10:21"
├── src/status-line/component.ts      # setLoopModeStatus equality
└── test/status-line-loop.test.ts
UPSTREAM_DIVERGENCES.md
```

**Structure Decision**: Change the existing loop files in place. The interval is a clause of the existing parser and a due time on the existing timer. A new module would split one state machine across two files.

## Design Notes

These notes refer to [research.md](research.md) and [contracts/loop-command.md](contracts/loop-command.md).

1. **Parser (R4).** Take the duration grammar out of `takeLoopLimit` into one helper, and use it for both the limit and `every`. `takeLoopInterval` runs between the limit and the condition.
2. **Due time (R1, R3).** `#scheduleLoopAutoSubmit` computes `dueAt = max(now + 800, #loopRunStartedAt + loopIntervalMs)`, or `now + 800` with no interval. It arms the timer in steps of at most 1 s against `Date.now()`. Busy retries keep the current 800 ms `#deferLoopAutoSubmit`.
3. **Run start (R2).** Set `#loopRunStartedAt` in `setLoopPrompt` and after `consumeLoopLimitIteration` in `#runLoopIteration`. Clear it in `pauseLoop` and `disableLoopMode`.
4. **Draft (R5).** In `#submitLoopPromptWhenReady`, call `startPendingSubmission({ text: prompt }, { preserveDraft: true })`.
5. **Replace (R6).** Split `handleLoopCommand` into three cases: on with blank args, on with args, and off.
6. **Status (R7).** `#syncLoopModeStatus` passes `intervalMs`, and `nextRunAt` from `#loopNextRunAt`. That field is set when an interval run is armed and cleared when the due timer fires, on cancel, on pause, and on disable.

## Risks

| Risk | Mitigation |
|---|---|
| A timer stays alive after disable or pause and fires a stale run. | Every step checks `loopModeEnabled`, `loopPrompt === prompt`, and that the loop is not paused. `#cancelLoopAutoSubmit` clears the step timer. |
| A replace while a turn runs arms two timers. | `#scheduleLoopAutoSubmit` always cancels the earlier timer first. |
| The existing `/loop` tests assume the 800 ms delay. | With no interval, the delay stays 800 ms exactly (FR-013). |
| Merge conflicts with upstream `/loop` changes. | Record FR-015 to FR-018 and `every` in `UPSTREAM_DIVERGENCES.md`. |

## Complexity Tracking

No gate violations.
