# Feature Specification: Fixed Interval for /loop

**Feature Branch**: `012-loop-every-interval`

**Created**: 2026-10-18

**Status**: Draft

**Input**: User description: "Like I want it to send every 15 minutes? How to set." The user chose a fixed interval only and the syntax `/loop every 15m`. The interval is measured from the start of each run, not from the end of the turn. The user does not want cron tools, a self-paced loop, or a default maintenance prompt.

## Clarifications

### Session 2026-10-18

- Q: When a scheduled run comes due while the user has unsent text in the input box, what should OMP do? → A: The run starts on time, and the draft stays in the input box with no change.
- Q: When loop mode is already on and the user runs `/loop` with arguments, should OMP replace the running loop or only turn loop mode off? → A: A bare `/loop` turns loop mode off. A `/loop` with arguments replaces the running loop with the new settings.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Send a prompt every N minutes (Priority: P1)

A user wants OMP to check something on a fixed schedule, for example a deploy or a CI run. The user types `/loop every 15m check the deploy status`. OMP runs the prompt at once. Then OMP sends the same prompt again 15 minutes after each run starts. The loop stops when the user runs `/loop` again.

**Why this priority**: This is the full request. Today `/loop` sends the prompt again almost at once after each turn. The only way to wait is a `--while 'sleep 900'` condition, and that also needs a change to the condition timeout setting.

**Independent Test**: Run `/loop every 1m <short prompt>`. Check that the first turn starts at once. Check that each later turn starts about 1 minute after the start of the turn before it, and not 1 minute after its end.

**Acceptance Scenarios**:

1. **Given** loop mode is off, **When** the user runs `/loop every 15m <prompt>`, **Then** the prompt runs at once, and the next run is due 15 minutes after that run started.
2. **Given** an interval loop and a turn that takes 4 minutes, **When** the turn ends, **Then** the next run starts 11 minutes later, so the gap between the two starts is 15 minutes.
3. **Given** an interval loop and a turn that takes longer than the interval, **When** the turn ends, **Then** the next run starts as soon as the session is idle, and only one run starts, not one for each missed interval.
4. **Given** loop mode is off, **When** the user runs `/loop every 15m` with no prompt, **Then** loop mode is on, and the next prompt the user sends runs at once and repeats every 15 minutes.
5. **Given** an interval loop that waits for its next run, **When** the user runs `/loop`, **Then** loop mode is off and no more runs start.

---

### User Story 2 - Combine the interval with the existing bounds (Priority: P2)

A user wants the scheduled check to stop by itself. The user adds a count, a total time, or a `--while` / `--until` condition, as with the current `/loop`. For example, `/loop 8h every 15m --until 'gh run view --exit-status' check CI` checks every 15 minutes for 8 hours at most, and stops when CI passes.

**Why this priority**: A scheduled check that never stops wastes tokens after the work is done. The current bounds already solve this, so the interval must work with them.

**Independent Test**: Run `/loop 2 every 1m <prompt>`. Check that the first turn runs, then 2 more runs at 1-minute starts, and then loop mode turns off with the "Loop limit reached" message.

**Acceptance Scenarios**:

1. **Given** `/loop 3 every 15m <prompt>`, **When** the loop runs, **Then** the first turn runs at once and does not use the count, then up to 3 more runs start at 15-minute starts, then loop mode turns off.
2. **Given** `/loop 1h every 15m <prompt>`, **When** a run comes due at or after 1 hour from the `/loop` command, **Then** that run does not start and loop mode turns off with the time-limit message.
3. **Given** an interval loop with `--until '<cmd>'`, **When** a run comes due, **Then** OMP runs the command at that time, and not during the wait, and the exit status decides whether the run starts.
4. **Given** an interval loop and the `loop.mode` setting `compact` or `reset`, **When** a run comes due, **Then** OMP compacts or resets first, as it does for a loop with no interval.

---

### User Story 3 - See and control the schedule (Priority: P3)

A user leaves an interval loop running and comes back later. The user wants to see when the next run is due. The user also wants to pause the loop or give it a new prompt without breaking the schedule rules.

**Why this priority**: A long wait with no sign of what happens next looks like a stuck session. Pause and replace already exist for loops, so they must also work during a long wait.

**Independent Test**: Start `/loop every 15m <prompt>`. After the first turn, check that the status line shows the interval and the time of the next run. Press Esc and check that no run starts at that time.

**Acceptance Scenarios**:

1. **Given** an interval loop that waits for its next run, **When** the user looks at the status line, **Then** it shows the interval and the clock time of the next run.
2. **Given** an interval loop that waits for its next run, **When** the user presses Esc, **Then** the pending run is canceled and the loop is paused, as for a loop with no interval.
3. **Given** a paused interval loop, **When** the user sends a prompt, **Then** that prompt runs at once and becomes the loop prompt, and the next run is due one interval after it started.
4. **Given** an interval loop that waits for its next run, **When** the user sends a different prompt, **Then** that prompt runs at once, it replaces the loop prompt, and the schedule starts again from that run.
5. **Given** the user starts `/loop every 15m <prompt>`, **When** OMP confirms the loop, **Then** the message states the interval.
6. **Given** an interval loop with a loop prompt, **When** the user runs `/loop every 30m` with no prompt, **Then** the loop keeps its prompt, uses the new 30-minute interval, and the next run is due 30 minutes after the start of the last run.
7. **Given** any running loop, **When** the user runs `/loop` with no arguments, **Then** loop mode turns off and the pending run is canceled.

---

### Edge Cases

- `every` is followed by a token that looks like a duration but does not parse, for example `every 1.5h`, `every 0m`, or `every 10x`. OMP shows a usage error and loop mode stays off.
- `every` is followed by a word that does not look like a duration, for example `/loop every file must have a test`. OMP treats the whole text as the prompt, as `/loop` does today for prose.
- `every` appears with no value after it. OMP shows a usage error.
- The user gives `every` two times. OMP shows a usage error.
- The tokens come in a different order, for example `/loop every 15m 2h <prompt>`. The text after the interval is prompt text, as with the current rule that places the limit first.
- A run comes due while a turn that the user started is still running, or while the session compacts. The run waits until the session is idle, then starts once.
- The computer sleeps during the wait and wakes after the due time. One run starts as soon as the session is idle. Missed runs do not stack.
- The interval is shorter than a typical turn, for example `every 10s`. Each run starts as soon as the turn before it ends, so the loop acts like a loop with no interval.
- The condition command runs longer than the interval. The run that it gates starts after the command ends and passes. The next due time is one interval after that run starts.
- A run comes due and the prompt is handled locally, or the prompt fails to send. The loop pauses, as it does today.
- The session exits during the wait. The schedule ends with the session. It is not restored on resume, as with the current loop.
- A run comes due while the user has unsent text or attachments in the input box. The run starts on time, and the draft stays in the input box with no change.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `/loop` MUST accept an interval clause `every <duration>`. The clause comes after the optional count or time limit and before the optional `--while` / `--until` flag.
- **FR-002**: The interval duration MUST accept the same forms as the current `/loop` time limit: a compact form (`15m`, `90s`, `1h30m`) and a spaced form (`15 minutes`). It MUST accept seconds, minutes, and hours.
- **FR-003**: The interval MUST be a positive duration. A duration-shaped value that does not parse, or a missing value, MUST show a usage error and leave loop mode off.
- **FR-004**: `every` followed by a word that does not look like a duration MUST start prompt text, not an error.
- **FR-005**: With an interval, the first run MUST start at once, as today. Each later run MUST be due one interval after the start of the run before it.
- **FR-006**: A run MUST NOT start while the session is busy. When a run is overdue, exactly one run MUST start when the session becomes idle.
- **FR-007**: The count limit, the time limit, the `--while` / `--until` condition, and the `loop.mode` setting MUST work with an interval in the same way that they work without one. Only re-runs use the count. The time limit counts from the `/loop` command.
- **FR-008**: The `--while` / `--until` command MUST run when a run is due, and not at the start of the wait.
- **FR-009**: Esc during the wait MUST cancel the pending run and pause the loop. A bare `/loop` MUST turn loop mode off and cancel the pending run.
- **FR-010**: A prompt that the user sends during an interval loop MUST run at once, become the loop prompt, and set the next due time to one interval after it started.
- **FR-011**: The status line MUST show the interval and the clock time of the next run while an interval loop waits.
- **FR-012**: The `/loop` confirmation message, the command description, the autocomplete hint, and the usage error MUST show the `every` form. They MUST say that a bare `/loop` turns loop mode off.
- **FR-013**: Every `/loop` form without `every` MUST keep its current behavior, except for FR-015 to FR-018.
- **FR-014**: The `/loop` command description (the in-app documentation for `/loop`) and the changelog MUST describe the interval form. No separate `/loop` doc file exists today, and none is required.
- **FR-015**: A loop run MUST NOT change the text or attachments in the input box. This applies to every loop run, with or without an interval.
- **FR-016**: When loop mode is on, `/loop` with arguments MUST replace the running loop. The new count or time limit, interval, and condition replace the old ones, and a part that the user leaves out is cleared. The count and time limit start again from this command.
- **FR-017**: When the replacing `/loop` has a prompt, that prompt MUST run at once and become the loop prompt. When it has no prompt, the loop MUST keep its current prompt. The next run is then due one new interval after the start of the last run, or as soon as the session is idle when no interval is given or that time has passed.
- **FR-018**: A replacing `/loop` with arguments that do not parse MUST show the usage error and leave the running loop unchanged.

### Key Entities

- **Loop interval**: The fixed time between the starts of two runs in one loop. It is set when the user enables loop mode. It changes only when a `/loop` with arguments replaces the loop, and it ends when loop mode turns off.
- **Next due time**: The clock time when the next run may start. It is the start of the previous run plus the interval. A user prompt or a resumed pause sets it again.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When the session is idle at the due time, each run starts within 2 seconds of that time.
- **SC-002**: With a 15-minute interval and turns shorter than 15 minutes, the gap between the starts of two runs is 15 minutes, plus or minus 2 seconds, for every pair in a 2-hour test.
- **SC-003**: No run starts while a turn is in progress. After a long turn or a system sleep, exactly one run starts.
- **SC-004**: A user can set up a loop that sends a prompt every 15 minutes with one command and no settings change.
- **SC-005**: All current `/loop` tests pass with no change to the behavior that they check, except for tests of the behavior that FR-015 to FR-018 change.

## Assumptions

- A fixed interval is the full scope. Cron expressions, one-time reminders, a model-chosen interval, a default maintenance prompt, a `loop.md` file, random delays, and automatic expiry are out of scope.
- There is no minimum interval. A short interval only removes the wait, and the current `/loop` already runs one turn after another.
- Units stop at hours, the same as the current time limit. Days are out of scope.
- The schedule exists only for the life of the session, the same as the current loop.
- The next run time on the status line uses the local time of the computer.
- No new setting is needed. The interval is set only on the `/loop` command line.
- FR-015 extends the draft answer to every loop run, with or without an interval. This is a planning decision, not part of the user's answer. Today every loop run clears the input box. One rule for all loop runs is simpler than a rule only for interval loops. It is also the reason that FR-013 lists FR-015 as an exception.
