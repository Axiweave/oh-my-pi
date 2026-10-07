# Feature Specification: Speckit-Auto Mode

**Feature Branch**: `009-speckit-auto-pipeline`

**Created**: 2026-10-06

**Status**: Approved

**Input**: User description: "I want to just impl on omp; this is my fork for my personal use; so not need to add extra extension complexity. Ideally; I want clarify -> I answer questions => all cleared -> go to plan->tasks and rest of pipeline automatically? I only need to take care when init specify and clarify; the rest go automatically; think more detail; and more ergonomics" — then: "spec it first; then I will take a look; also debate with reviewer" — then: "speckit-auto might be a good command; but more like to have it a mode call speckit-auto-mode like plan-mode debate-mode cyber-mode; that will show in status bar. and I can use originally speckit.specify command then it will automatically advance for me?? we can keep auto command as well"

## Clarifications

### Session 2026-10-06

- Q: What does the mode do with HIGH findings from analyze? → A: It shows a notice with the HIGH count and continues. Only CRITICAL findings start remediation rounds.
- Q: What does the mode do when plan, tasks, implement, or converge asks a routine question to proceed? → A: It answers "Yes, proceed with your recommended option." once in each run of that phase. If the agent asks again, the mode holds for the user.
- Q: Is the mode on after the user resumes a session in which it was on? → A: Yes. The mode comes back on with the run paused at its last phase, the same way plan mode comes back.
- Q: Is the converge round limit fixed? → A: No. It is the setting `speckitAuto.convergeRounds`, default 3.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Turn on the mode, use the normal spec-kit commands, and let the rest run (Priority: P1)

The user turns on speckit-auto mode with `/speckit-auto-mode`. The status bar shows the mode, the same way it shows plan mode or goal mode. The user then works as usual: they type `/speckit.specify <feature description>` and answer its questions. The mode runs `/speckit.clarify` next, and the user answers its questions. When clarify reports that the spec is ready for planning, the mode runs plan, tasks, analyze, implement, and converge in the same session. The user types nothing more. When converge reports that the work is complete, omp shows a short summary. The mode stays on for the next feature.

The `/speckit-auto` command stays as the run control. `/speckit-auto <feature description>` is a shortcut: it turns the mode on and runs `/speckit.specify <feature description>` in one step. `/speckit-auto resume` and `/speckit-auto next` control the active run.

**Why this priority**: This is the request. The user owns the two phases that need human judgment. After clarify, every phase only needs someone to type the next command, and the mode does that.

**Independent Test**: In a project with the spec-kit commands installed, turn on the mode. Type `/speckit.specify <small feature>`. Answer each specify and clarify question. Make sure that after the last clarify answer, the transcript shows `/speckit.plan`, `/speckit.tasks`, `/speckit.analyze`, `/speckit.implement`, and `/speckit.converge` in this order, with no more user input. Make sure the run ends with a summary and the mode is still on.

**Acceptance Scenarios**:

1. **Given** the mode is off, **When** the user runs `/speckit-auto-mode`, **Then** the mode turns on, the status bar shows it, and no phase starts.
2. **Given** the mode is on, **When** the user types `/speckit.specify add a CSV export`, **Then** the specify phase starts and the status bar shows the specify phase.
3. **Given** the mode is off, **When** the user runs `/speckit-auto add a CSV export`, **Then** the mode turns on and the transcript shows the user row `/speckit.specify add a CSV export`.
4. **Given** specify wrote the spec and asked no question, **When** its turn settles, **Then** omp runs `/speckit.clarify`.
5. **Given** clarify reports that the spec is ready for planning, **When** its turn settles, **Then** omp runs `/speckit.plan`.
6. **Given** plan, tasks, analyze, and implement each complete their work without a question and without a blocking finding, **When** each turn settles, **Then** omp runs the next phase in the order plan → tasks → analyze → implement → converge.
7. **Given** converge reports that the work is complete, **When** its turn settles, **Then** omp shows a summary with the phases that ran, the remediation and converge round counts, and the result. The mode stays on, and the status bar shows that it waits for the next `/speckit.*` command.
8. **Given** the mode is on and the user did clarify earlier without the mode, **When** the user types `/speckit.plan`, **Then** the mode runs plan and continues from there.
9. **Given** the mode is off, **When** the user types any `/speckit.*` command, **Then** the command behaves as it does today and nothing runs on its own.

---

### User Story 2 - The mode never runs ahead of the user (Priority: P1)

While specify or clarify waits for an answer, the mode does nothing. The mode also stops when a phase fails or does not finish its work. The user's own input always comes first. If the user sends a message while the mode is about to start a phase, omp drops that start, runs the user's message, and decides again after that turn.

**Why this priority**: If the mode starts plan while the user still owes an answer, plan works from an incomplete spec. If it continues after a failed phase, the next phase builds on a broken result. Both are worse than no automation.

**Independent Test**: Run a clarify phase that asks a question. Make sure no phase starts. Answer the question while the mode decides about the previous turn. Make sure no phase starts before the turn for the answer settles.

**Acceptance Scenarios**:

1. **Given** the clarify turn ends with a question, **When** the turn settles, **Then** the mode starts nothing and the status bar shows that it is the user's turn.
2. **Given** specify shows its questions together and waits, **When** the user answers all of them in one message, **Then** the mode stays in specify and decides again after the answer turn settles.
3. **Given** the mode has decided to start the next phase but has not started it yet, **When** the user sends a message or a command that starts an agent turn, **Then** omp drops that start and runs the user's input.
4. **Given** the mode has decided to start the next phase, **When** the user runs a command that completes without an agent turn (for example `/model`), **Then** the phase start stays scheduled. If that command opens a selector, the phase does not start while the selector is open. After the user picks a model and the selector closes, the phase starts and uses the picked model.
5. **Given** the editor holds draft text or an image, **When** the mode is ready to start the next phase, **Then** the mode waits. When the user clears the editor, the phase starts with no other input.
6. **Given** the mode cannot tell whether a specify or clarify turn waits for an answer, **When** the turn settles, **Then** the mode holds and tells the user that `/speckit-auto next` advances.
7. **Given** plan stops with an error (for example a constitution gate failure), **When** its turn settles, **Then** the mode holds and shows the reason. It does not run tasks.
8. **Given** a phase turn pauses while a background job still runs, **When** that job later wakes the turn, **Then** the mode starts no phase until the resumed turn settles.

---

### User Story 3 - Pause, steer, skip, and turn off at any time (Priority: P2)

The user can interrupt the mode without losing the run. Esc pauses the run. `/speckit-auto resume` continues it. `/speckit-auto next` skips to the next phase. `/speckit-auto-mode` turns the mode off. The user can type a message during any phase to steer it, the same way as without the mode. The user can also type any `/speckit.<phase>` command to move the run to that phase.

**Why this priority**: The automatic stretch can run for a long time and change code. The user must be able to stop it or correct it at once.

**Independent Test**: During an automatic phase, press Esc. Make sure the phase turn stops and no next phase starts. Run `/speckit-auto resume`. Make sure the mode decides again about the stopped phase and continues.

**Acceptance Scenarios**:

1. **Given** an automatic phase runs, **When** the user presses Esc, **Then** the turn stops, the run pauses, and the status bar shows that it is paused.
2. **Given** the run is paused, **When** the user runs `/speckit-auto resume`, **Then** the run continues. If the last phase turn was interrupted, the mode asks the agent to continue that phase.
3. **Given** the run holds or is paused in any phase, **When** the user runs `/speckit-auto next`, **Then** the mode clears the hold and the pause and starts the next phase. After converge, `next` ends the run and the mode stays on.
4. **Given** a phase turn runs, **When** the user runs `/speckit-auto next`, **Then** omp stops that turn first and then starts the next phase.
5. **Given** the mode is on, in any state, **When** the user runs `/speckit-auto-mode`, **Then** the mode turns off, drops any pending phase start, and the status bar no longer shows it. A phase turn that runs at that moment finishes normally.
6. **Given** an automatic phase runs, **When** the user types a message, **Then** omp handles it as a normal steering or queued message, and the run stays in the same phase.
7. **Given** a phase turn runs, **When** the user queues `/speckit.tasks`, **Then** the run stays in the current phase until the queued `/speckit.tasks` turn starts.
8. **Given** the run holds in analyze, **When** the user types `/speckit.implement`, **Then** the run moves to implement and continues from there.

---

### User Story 4 - Bounded self-correction after analyze and converge (Priority: P2)

analyze can report findings, and converge can add tasks for work that is still missing. The mode fixes these on its own a limited number of times. A fix never changes what the user already decided. When a fix needs a new decision, or when the limit is reached, the mode stops and tells the user why.

**Why this priority**: Without a limit, a run that cannot fix a finding runs forever and uses tokens. Without self-correction, every finding stops the run and the user must type again. Without the decision boundary, the mode can clear a finding by weakening an approved requirement.

**Independent Test**: Make analyze report one CRITICAL finding on every run. Make sure the mode runs the remediation turn and analyze again two times, then holds with a notice. Make converge add a task on every run. Make sure the mode runs implement and converge as many extra times as the converge round limit allows (3 by default), then ends the run with a notice.

**Acceptance Scenarios**:

1. **Given** analyze reports at least one CRITICAL finding, **When** its turn settles, **Then** omp sends a visible remediation message and then runs analyze again. The message tells the agent to fix the findings in the feature documents, keep every accepted requirement, success criterion, and user decision, change no application code, and ask the user when a fix needs a new decision.
2. **Given** a CRITICAL finding is a conflict between two approved requirements, **When** the remediation turn asks the user which requirement wins, **Then** the mode holds for the user and does not answer for them.
3. **Given** a plan correction changes an interface that a contract document in the feature directory also describes, **When** the remediation turn runs, **Then** the agent may update that contract document too.
4. **Given** two remediation rounds ran and CRITICAL findings remain, **When** analyze settles, **Then** the mode holds and shows the count of remaining CRITICAL findings.
5. **Given** the analyze turn ends without a readable findings report, **When** it settles, **Then** the mode holds. It does not treat a missing report as zero findings.
6. **Given** analyze ends with its offer to suggest remediation edits and no finding blocks, **When** its turn settles, **Then** the mode runs implement. **Given** analyze asks any other question, **When** its turn settles, **Then** the mode holds for the user.
7. **Given** analyze reports only HIGH findings, **When** its turn settles, **Then** omp shows a notice with the HIGH count and the mode runs implement.
8. **Given** converge adds tasks and the run has an extra round left under its converge round limit, **When** its turn settles, **Then** omp runs `/speckit.implement` again, then `/speckit.converge`.
9. **Given** the converge round limit is 3 (the default) and three extra rounds already ran, **When** the fourth converge adds tasks again, **Then** the run ends and omp tells the user that open tasks remain. The mode stays on.
10. **Given** the user set the converge round limit to 1, **When** converge adds tasks twice, **Then** the mode runs one extra implement and converge, and the run ends after the second converge. **Given** the limit is 0, **When** the first converge adds tasks, **Then** the run ends at once with the notice.
11. **Given** converge neither reports completion nor adds tasks, **When** its turn settles, **Then** the mode holds and shows the reason.

---

### User Story 5 - The user knows where the run is without watching (Priority: P3)

The status bar always shows the mode, the phase, and who must act next. omp sends a desktop notification only when the mode needs the user or a run ends. It does not send one for each phase.

**Why this priority**: The automatic stretch is long. The user leaves the terminal and must come back only when needed.

**Independent Test**: Run a full feature with desktop notifications on. Make sure the user gets one notification after each specify and clarify turn that waits for an answer, one at the end, and none for plan, tasks, analyze, implement, or converge turns that continue on their own.

**Acceptance Scenarios**:

1. **Given** the mode is on and no run is active, **When** the user looks at the status bar, **Then** it shows the mode as on and waiting for a `/speckit.*` command.
2. **Given** the run is in plan, **When** the user looks at the status bar, **Then** it shows the mode and the plan phase.
3. **Given** the run holds for an answer, **When** the user looks at the status bar, **Then** it shows the phase and "your turn".
4. **Given** the run is paused, **When** the user looks at the status bar, **Then** it shows the mode in the warning color with a paused mark, the same as a paused plan mode.
5. **Given** a phase turn settles and the mode continues on its own, **When** desktop notifications are on, **Then** omp sends no notification for that turn.
6. **Given** the run holds or ends, **When** desktop notifications are on, **Then** omp sends one notification that names the reason.

---

### Edge Cases

- **The session changes**: the user starts a new session or switches to another one. The mode stops acting in the old session. The old session keeps its mode state. When the user returns to it, FR-035 applies. A new session from `/new` or `/delete` starts with the mode on and no run, the same way the model profile carries over. A switch with `/resume` takes the mode state of the target session.
- **omp restarts**: when the user resumes the session, the mode comes back on with the run paused (FR-035). `/speckit-auto resume` continues it.
- **Loop, goal, plan, debate, or vibe mode is on or paused**: `/speckit-auto-mode` and `/speckit-auto <description>` refuse to turn the mode on and name that mode. While speckit-auto mode is on, every way to start or resume those modes refuses, including `/guided-goal`, and tells the user to turn off speckit-auto mode first.
- **A spec-kit command is missing**: the mode refuses to turn on and lists each missing `/speckit.*` command.
- **`/speckit-auto resume` or `/speckit-auto next` while the mode is off, or with no active run**: omp shows a short message that says so and does nothing else.
- **A phase reports an error as normal text** (for example specify with an empty description, analyze with a missing artifact, or implement with a failed task): the mode holds and shows the reason.
- **A phase turn fails** (provider error or output limit, after omp's own retries): the mode holds, shows the error reason, and does not retry.
- **Compaction runs during a phase**: the mode waits until compaction and the phase turn finish. Compaction does not stop the run.
- **Queued messages or background jobs exist when a phase turn pauses**: the mode waits until the queue is empty, every job that can wake the turn has finished, and the last turn settles.
- **Clarify used its question quota with a high-impact item left**: clarify flags the item as Deferred. The mode holds, so the user decides between another `/speckit.clarify` and `/speckit-auto next`.
- **The user runs a spec-kit command that is not a phase** (for example `/speckit.checklist`): the mode treats it as a user turn, keeps the phase, and decides again after it.
- **An extension hook in a spec-kit command asks a question**: the mode treats it the same as any other question in that phase.
- **The analyze report ends with its offer to suggest edits**: the mode does not treat this offer as a question. Any other question in analyze holds the run, because analyze only reads and a question there needs the user.
- **The implement checklist gate asks whether to proceed**: the mode follows the policy in FR-019.
- **The turn check cannot run** (no model for it, or it fails): the mode decides from the phase text alone. In specify and clarify, a turn that the mode cannot read holds the run.
- **`/speckit-auto <description>` or a new `/speckit.specify` while a run is active**: when the specify turn starts, the old run ends as stopped by the user, and a new run starts with fresh counters.

## Requirements *(mandatory)*

### Functional Requirements

**The mode**

- **FR-001**: `/speckit-auto-mode` MUST toggle speckit-auto mode. Turning it on MUST start no phase. Turning it off MUST drop any pending decision or phase start and MUST let a running phase turn finish normally.
- **FR-002**: `/speckit-auto <description>` MUST turn the mode on if it is off and run `/speckit.specify <description>`.
- **FR-003**: `/speckit-auto resume` MUST continue a paused run. `/speckit-auto next` MUST drop any pending decision, clear the hold and the pause, and start the next phase. If a phase turn runs, `next` MUST stop that turn first. The start guards in FR-010 apply to `next`. The grace period in FR-011 does not apply. After converge, `next` MUST end the run, and the mode MUST stay on. When the mode is off or no run is active, `resume` and `next` MUST only show a message. `/speckit-auto` with no argument MUST show the usage and the current state.
- **FR-004**: The autocomplete for `/speckit-auto-mode` and `/speckit-auto` MUST show whether the mode is on and the current phase, the same way `/plan` shows its state.
- **FR-005**: While the mode is on, a `/speckit.<phase>` command that the user sends MUST start a run at that phase, or move the active run to that phase. The phases are specify, clarify, plan, tasks, analyze, implement, and converge. The phase MUST change when the command's turn starts. A phase command that waits in the queue MUST NOT change the phase. A `/speckit.specify` command, typed or from the `/speckit-auto <description>` shortcut, MUST always start a new run: the active run ends as stopped by the user, and the round counts, the pause, the hold, and the automatic-answer flag reset.
- **FR-006**: The mode MUST refuse to turn on when any of `/speckit.specify`, `/speckit.clarify`, `/speckit.plan`, `/speckit.tasks`, `/speckit.analyze`, `/speckit.implement`, or `/speckit.converge` is not available, and MUST list the missing commands.
- **FR-007**: The mode MUST refuse to turn on while loop, goal, plan, debate, or vibe mode is on or paused. While the mode is on, every way to start or resume those modes MUST refuse, including `/guided-goal`, and MUST tell the user to turn off speckit-auto mode first.
- **FR-008**: While the mode is off, `/speckit.*` commands MUST behave as they do today.

**Phase start**

- **FR-009**: The mode MUST start each phase the same way as a command that the user types. The transcript MUST show the short command line, for example `/speckit.plan`, as a user row. All phases MUST run in the current visible session. Compaction during a run is allowed.
- **FR-010**: The mode MUST start a phase only when the previous turn has settled. Settled means: the turn ended and nothing can continue it. Nothing streams, no compaction runs, no queued or admitted message waits, no retry is pending, and no background job can wake the turn. The editor MUST also hold no draft text or image, and no selector, dialog, or other local interaction may be open. The mode MUST check these conditions again just before the start.
- **FR-011**: The mode MUST wait a short grace period (under 1 second) between its decision and the phase start, so that Esc can still pause the run.
- **FR-012**: The mode MUST decide at most once for each settled turn. When a start guard blocks a decided phase start and then clears (the editor empties, or a selector or dialog closes), the mode MUST start the phase with no other user input and without a new decision.

**Advance rules**

- **FR-013**: The mode MUST advance from a phase only when that phase reports that it completed its work. When a phase reports an error, stops early, or ends without its expected outcome, the mode MUST hold and show the reason.
- **FR-014**: In specify, the mode MUST hold while specify waits for answers. When specify completes without an open question, the mode MUST run clarify.
- **FR-015**: In clarify, the mode MUST hold while clarify waits for an answer. When clarify reports that the spec is ready for planning, the mode MUST run plan. Ready means: clarify found no critical ambiguity, or its completion report recommends `/speckit.plan`. Items that clarify defers to planning or marks as low-impact Outstanding do not block. When clarify reports a high-impact item that it could not ask about, the mode MUST hold. The mode MUST NOT run clarify again on its own.
- **FR-016**: After plan, the mode MUST run tasks. After tasks, it MUST run analyze.
- **FR-017**: After analyze, when the report has at least one CRITICAL finding, the mode MUST start a remediation round and then run analyze again, up to 2 rounds. If CRITICAL findings remain after 2 rounds, the mode MUST hold. When the analyze turn has no readable findings report, the mode MUST hold, except in one case: the user started the turn with a request to fix the analyze findings, and the reply reports the fixes. Then the mode MUST run analyze again, and the user's fix MUST count as a remediation round. When no finding blocks, the mode MUST run implement.
- **FR-018**: When analyze reports HIGH findings and no CRITICAL finding, the mode MUST show a notice with the HIGH count and run implement. HIGH findings MUST NOT start a remediation round.
- **FR-019**: When plan, tasks, implement, or converge asks a routine question to proceed, the mode MUST send "Yes, proceed with your recommended option." once in each run of that phase. If the agent asks again in the same phase run, the mode MUST hold for the user. A question that asks for a new scope or requirement decision MUST always hold the run.
- **FR-020**: A remediation round MUST tell the agent to keep every accepted requirement, success criterion, and user decision, to change only documents in the feature directory, to change no application code, and to ask the user when a fix needs a new decision. When a remediation turn asks a question, the mode MUST hold.
- **FR-021**: After implement, the mode MUST run converge. When converge reports that the work is complete, the run MUST end. When converge adds tasks, the mode MUST run implement and then converge again, up to the converge round limit (FR-036), and then end the run with a notice that open tasks remain. When converge reports neither result, the mode MUST hold.
- **FR-022**: The mode MUST NOT treat the analyze offer to suggest remediation edits as a question. When analyze asks any other question, the mode MUST hold.
- **FR-023**: When the mode cannot tell whether a specify or clarify turn waits for the user, it MUST hold.
- **FR-024**: The mode MUST use omp's existing turn-check model selection and MUST NOT need a new model setting. When no turn-check model is available or the check fails, the mode MUST decide from the phase output text alone.
- **FR-025**: When a phase turn fails after omp's own retries, the mode MUST hold and show the reason.

**The user comes first**

- **FR-026**: Any submission that the mode did not make and that starts an agent turn MUST drop every pending decision and every scheduled phase start. This includes typed text, slash commands that start a turn, and queued messages. The mode MUST decide again only after that turn settles. Commands that complete without an agent turn MUST NOT drop a pending decision or a scheduled start.
- **FR-027**: Messages that the user types during a running phase MUST behave the same as without the mode (steering or queueing). The run MUST keep its phase.

**Pause**

- **FR-028**: Esc MUST pause the run while the mode acts: a phase turn runs, or a turn check or phase start is pending. When a phase runs, Esc MUST also stop that turn, as it does today. While the mode holds for the user or waits for a `/speckit.*` command, Esc MUST keep its normal behavior.
- **FR-029**: A paused run MUST start nothing until the user runs `/speckit-auto resume`, `/speckit-auto next`, or a `/speckit.<phase>` command, or turns the mode off. On resume, the mode MUST decide about the latest settled turn. If that turn was interrupted, the mode MUST ask the agent to continue the phase.

**Visibility**

- **FR-030**: While the mode is on, the status bar MUST show it in the same place as plan, goal, and loop mode. It MUST show the phase and the state: waiting for a `/speckit.*` command, running, next phase due, your turn, needs you (with the reason), or paused. A paused run MUST use the warning color, the same as a paused plan mode.
- **FR-031**: While the mode continues on its own, omp MUST NOT send the per-turn completion notification. omp MUST send one notification when the mode holds for the user or a run ends. When completion notifications are off, omp MUST send none.
- **FR-032**: When a run ends, omp MUST show a summary: the phases that ran, the remediation and converge round counts, and the result (complete, stopped at a limit, or stopped by the user).

**Scope**

- **FR-033**: When the user switches to another session or starts a new one, the mode MUST stop acting in the old session. The old session MUST keep its mode state for FR-035. A new session from `/new` or `/delete` MUST start with the mode on and no run when the mode was on before, and with the mode off otherwise. If the new session does not start, the old session MUST get its saved state back.
- **FR-034**: The feature MUST be part of omp itself, not an extension. It MUST add only the setting in FR-036.
- **FR-035**: The mode state MUST be saved with the session: on or off, and for an active run its phase, phases run so far, round counts, converge round limit, automatic-answer flag, and hold reason. When the user resumes a session in which the mode was on, the mode MUST come back on with the run paused at its last phase, the same way plan mode comes back. A restored run MUST have no pending decision or scheduled phase start, and MUST start nothing until the user runs `/speckit-auto resume`, `/speckit-auto next`, or a `/speckit.<phase>` command. If no run was active, the mode MUST come back on and wait for a `/speckit.*` command. `/speckit-auto-mode` MUST turn the mode off. The saved state is session data, not a setting.
- **FR-036**: The converge round limit MUST be a user setting `speckitAuto.convergeRounds`: a whole number of extra implement-and-converge rounds, 0 or more, with a default of 3. The value 0 means no extra round. The mode MUST read the setting when a run starts and keep that value for the whole run. A change to the setting applies to the next run.

### Key Entities

- **Speckit-auto mode**: an on/off mode of the interactive session. While it is on, it watches for `/speckit.<phase>` commands and runs the next phases on its own.
- **Run**: one pass through the phases for one feature while the mode is on. It has the current phase, the round counts for remediation and converge, a flag for whether it already sent its automatic answer in this phase run, and a paused flag. A run starts with a `/speckit.<phase>` command. It ends at converge, at a limit, when a new `/speckit.specify` starts, or when the mode turns off.
- **Phase**: one of specify, clarify, plan, tasks, analyze, remediation, implement, converge. Each phase except remediation matches one `/speckit.<phase>` command. Remediation is internal, and the user cannot select it.
- **Turn verdict**: what the mode reads from a settled phase turn. It shows whether the phase completed its work, whether the turn waits for the user, whether clarify reports the spec ready for planning, the CRITICAL and HIGH finding counts from analyze (or that no readable report exists), and whether converge reports completion or added tasks.
- **Pending decision**: a turn check or a scheduled phase start that has not finished. A user submission that starts an agent turn drops it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a feature where specify and clarify ask N questions and the later phases raise no question or finding, the user types one `/speckit.specify` command (or one `/speckit-auto <description>`) and N answers. After the last clarify answer, the user types nothing until the run ends.
- **SC-002**: In 100% of test runs where a specify or clarify turn ends with a question, the mode starts no phase.
- **SC-003**: In 100% of test runs where the user sends input that starts an agent turn while a decision is pending, no phase starts before the turn for that input settles.
- **SC-004**: Without user input, one run starts at most 1 clarify run, 3 analyze runs, 2 remediation rounds, and 1 + N implement runs, where N is the `speckitAuto.convergeRounds` value when the run started (4 with the default).
- **SC-005**: After the user presses Esc during an automatic phase, no new phase starts until the user resumes, in 100% of test runs.
- **SC-006**: In a full run, the user gets zero desktop notifications for turns after which the mode continued, and exactly one for each hold or end.
- **SC-007**: When a phase turn settles and nothing holds the run, the next phase starts within 5 seconds in a typical run and never later than 30 seconds.
- **SC-008**: In 100% of test runs where a phase reports an error or ends without its expected outcome, the mode starts no next phase.
- **SC-009**: While the mode is on, the status bar shows it in 100% of states: waiting, running, holding, and paused.

## Assumptions

- The user installed the spec-kit commands for omp in the project with `specify init`. The mode uses these commands as they are and does not change them.
- The installed commands keep their current output cues: the specify questions with "Wait for user response", the clarify "No critical ambiguities detected" message and its coverage summary with Resolved, Deferred, Clear, and Outstanding, the analyze report table with a Severity column and the "Critical Issues Count" metric, the implement checklist gate, and the converge "✅ Converged" line or its new convergence tasks.
- The mode toggle is `/speckit-auto-mode`, as the user named it. `/speckit-auto` stays as a separate command for the shortcut and the run controls. The status bar label is "Speckit auto".
- The mode follows the active feature that spec-kit resolves on its own. The mode does not track feature directories.
- A user message after a phase command belongs to that phase. Answers and steering both count.
- Every feature runs all phases. The mode does not skip analyze for small features.
- The remediation round is a visible message in the transcript, not a hidden instruction.
- The mode conflicts with loop, goal, plan, debate, and vibe mode. Plan, debate, and vibe mode take away the tools that the phases need to edit files. Loop and goal mode submit their own prompts. The mode does not conflict with cyber mode, which only limits model choice.
- Out of scope: running phases in a fresh context or a subagent, more than one run at a time in a session, headless or print mode, and changes to spec-kit itself.
