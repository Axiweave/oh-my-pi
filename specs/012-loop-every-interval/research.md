# Research: Fixed Interval for /loop

The Technical Context has no open unknowns. This file records the design decisions and the code facts that support them.

## R1. Where the interval plugs in

- **Decision:** Change the delay in `#scheduleLoopAutoSubmit` (`packages/coding-agent/src/modes/interactive-mode.ts`). Without an interval, the delay stays 800 ms. With an interval, the next run is due at `max(now + 800, lastRunStartedAt + intervalMs)`.
- **Rationale:** `getUserInput()` already calls `#scheduleLoopAutoSubmit()` each time the session goes idle. The same path is used by `armLoopAutoSubmit()` after a `/skill:` turn and by the compaction-queue drain. `#runLoopIteration` already applies, in order: the busy check, the limit check, the condition, the budget, and the `loop.mode` action. A due time placed in front of that path gives FR-006, FR-007, and FR-008 with no new run path.
- **Alternatives considered:** A second timer next to the 800 ms timer. Rejected: two timers race on cancel, and every guard in `#runLoopIteration` would need a twin.

## R2. When a run "starts"

- **Decision:** Set `#loopRunStartedAt = Date.now()` at two points:
  1. In `setLoopPrompt()`. Every prompt that the user sends while idle goes through it, including the inline prompt from `/loop ... <prompt>`.
  2. In `#runLoopIteration()`, right after `consumeLoopLimitIteration` succeeds and before the `compact` or `reset` action.
- **Rationale:** Point 2 comes after the condition passes, so a slow condition moves the schedule (spec edge case). It comes before compaction, so the `compact` mode keeps the cadence. Point 1 makes FR-010 and FR-017 (a new prompt starts the schedule again) hold with no extra code.
- **Alternatives considered:** Record the start at `agent_start`. Rejected: that needs a session-event hook, and the time of the user prompt is the same within milliseconds.

## R3. Long waits and system sleep

- **Decision:** Arm the due-time timer in steps of at most 1 s. Each step compares `Date.now()` with the due time and arms the next step until the time is reached.
- **Rationale:** The `setTimeout` clock of the runtime may not advance while macOS sleeps. A single 15-minute timer could then fire late by the full sleep time. Steps of 1 s cap the delay after a wake at about 1 s, which meets SC-001 and the system-sleep edge case. One `Date.now()` comparison each second costs nothing. The process is already kept alive by `EventLoopKeepalive` in `getUserInput()`.
- **Alternatives considered:** One timer for the full wait. Rejected because of the sleep risk above. A `sleep`/`wake` OS event. Rejected: no listener exists in the codebase, and the gain over 1 s steps is zero.
- **Test fact:** In Bun 1.4.2, `vi.useFakeTimers()` with `vi.advanceTimersByTime()` also moves `Date.now()` (checked with a probe test). Tests can drive the due time with fake timers alone.

## R4. Arguments

- **Decision:** Add `takeLoopInterval` to `packages/coding-agent/src/modes/loop-limit.ts`, between `takeLoopLimit` and `takeLoopCondition`. `ParsedLoopArgs` gets `intervalMs?: number`. The duration grammar is shared with the time limit through one helper. That helper is taken out of the current `takeLoopLimit` code for the compound form (`15m`, `1h30m`) and the spaced form (`15 minutes`).
- **Rules** (FR-001 to FR-004, and spec edge cases):
  - The keyword is `every`, matched case-insensitively.
  - `every` with no value is an error.
  - `every <digit…>` must parse as a duration. Otherwise it is an error. A bare `every 15` is an error because it has no unit.
  - `every <non-digit word>` is not an interval. The whole remaining text is prompt text.
  - A second `every <digit…>` right after a parsed interval is an error ("Use only one every").
- **Rationale:** The current parser has this rule: a token that looks like a limit and fails to parse is an error, and prose is prompt text. The interval follows the same rule.

## R5. Draft in the input box (FR-015)

- **Decision:** `#submitLoopPromptWhenReady` passes `{ preserveDraft: true }` to `startPendingSubmission`.
- **Rationale:** Today a loop run calls `startPendingSubmission({ text })` with no options. At `interactive-mode.ts:4144`, that clears the input box and its image links. Other automatic submissions already pass `preserveDraft: true` (for example the goal and objective paths at lines 6992, 7070, 7566, and 7597). `cancelPendingSubmission` then also skips the draft restore, which is correct because the loop text is not a user draft. Pending images stay in the editor in both paths.

## R6. `/loop` with arguments while loop mode is on (FR-016 to FR-018)

- **Decision:** In `handleLoopCommand`:
  - A blank `args` while loop mode is on turns loop mode off, as today.
  - Non-blank `args` are parsed first. A parse error shows the error and changes nothing.
  - On success, OMP replaces the limit, condition, and interval, and starts the limit runtime again. It aborts a condition check that is still running, cancels the pending timer, and keeps `loopPrompt` and `#loopRunStartedAt`.
  - If the arguments include a prompt, OMP returns it. The dispatcher then submits it, and `setLoopPrompt` starts the schedule again.
  - If there is no new prompt, OMP calls `#scheduleLoopAutoSubmit()`. It does nothing while paused, because a paused loop has no prompt.
- **Rationale:** When idle, the slash command runs while `getUserInput()` waits, so nothing else arms the next run. `#scheduleLoopAutoSubmit()` cancels its earlier timer first, so it never arms a second timer. During a turn, the armed timer does not show `next` (it shows only on an idle step), and `getUserInput()` re-arms it with the new interval when the turn ends.
- **Speckit-auto check:** It stays only on the enable path. Loop mode and speckit-auto cannot both be on.

## R7. Status line (FR-011)

- **Decision:** Extend `SegmentContext["loopMode"]` (`packages/tui/src/status-line/types.ts`) with `intervalMs?: number` and `nextRunAt?: number` (epoch ms). Both the `mode` segment renderers (`renderMainMode` and `describeMainMode` in `segments.ts`) add `every 15m` and `next 10:21`. Add the new fields to the equality check in `StatusLine.setLoopModeStatus` (`component.ts:1138`).
- **Rationale:** A clock time does not change each second, so no new render tick is needed. The `time` segment and the chat rows already format the local `HH:MM` with `toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })`.
- **When `nextRunAt` is set:** Only while an interval loop waits for an armed run. `#scheduleLoopAutoSubmit` stores `dueAt` in `#loopNextRunAt` when an interval is set. It is cleared when the due timer fires, when the timer is canceled, on pause, and on disable. A turn that runs past the interval therefore shows no `next`, and the status line never shows a time in the past.

## R8. Text and docs (FR-012, FR-014)

- **Decision:** Update these to show the `every` form and to say that a bare `/loop` turns loop mode off:
  - the `/loop` slash-command `description` and `inlineHint` (`slash-commands/builtin-modes.ts`)
  - `LOOP_USAGE` (`loop-limit.ts`)
  - the enable message and the new "Loop updated." message (`handleLoopCommand`)
  - the autocomplete text
- **Docs:** No user doc file describes `/loop` today (a search of `docs/` and both READMEs found none). The command description is the user doc. Add a `CHANGELOG.md` entry under `[Unreleased]`. Add an entry to `UPSTREAM_DIVERGENCES.md`, because FR-015 to FR-018 change upstream `/loop` behavior.
- **Config:** There is no new setting, so `~/.omp/agent/config.yml` does not change.

## R9. Tests

- **Decision:** Keep these tests as checks of properties:
  - **Parser** (`test/loop-limit.test.ts`): `parseLoopArgs` agrees with a slow reference for generated `every` forms (unit × amount × compound/spaced). Boundary cases: `every`, `every 0m`, `every 1.5h`, `every 15`, two `every` clauses, and `every <word>` as prose.
  - **Schedule** (`test/interactive-mode-loop.test.ts`, fake timers):
    - the start-to-start gap equals the interval for generated turn lengths below the interval
    - one run after an overrun
    - one run after a wall-clock jump with no timer progress (system sleep)
    - a prompt sent during the wait starts the schedule again
    - no run while streaming
    - the draft text and images do not change after a run
    - replace keeps the prompt and moves the due time
    - an invalid replace keeps the loop
- **Rationale:** These fail on plausible user-visible bugs: a gap measured end-to-start, runs that stack, a lost draft, or a replace that silently stops the loop.
- **Old test to change:** No test pins draft clearing. A test that pins "any `/loop` disables" would need to change under SC-005. Only `interactive-mode-speckit-auto.test.ts:1098` calls `handleLoopCommand("")` while loop mode is off, so it is not affected.
