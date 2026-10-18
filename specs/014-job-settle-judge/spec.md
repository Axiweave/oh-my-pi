# Feature Specification: Judge Whether a Turn Needs the User While Background Jobs Run

**Feature Branch**: `014-job-settle-judge`

**Created**: 2026-10-18

**Status**: Draft

**Input**: User description: "llm call — when turn ends + having background job, llm call decide to require user input or not, not fixed logic anymore" (from `TODOs.org`).

Today a fixed rule controls the end of a turn. When the agent stops its turn and one of its own background jobs (a bash job or a subagent) still runs, OMP always treats the stop as "wait for the job". The run stays `working` in the title, the status line, and the IDE state. OMP sends no attention notification and defers the stop hooks until the job ends. This is correct when the agent only waits for the job result. It is wrong when the agent asks the user a question or needs a decision while the job runs, for example while a log watcher that never exits runs. Then the user does not learn that the agent waits for them. This feature replaces the fixed rule with a model judgment of the final reply.

## Clarifications

### Session 2026-10-18

- Q: Must speckit-auto also use the new judgment instead of its fixed job wait? → A: Yes. Speckit-auto holds for the user when the reply needs input, and waits for the job otherwise. Both fixed rules go. Speckit-auto reuses the "waits for the user" answer of its existing judge and makes no second judge call.
- Q: What is a reply that does not need the user? → A: Example from the user: "Next action: when the first E6 Runs finish, I will check their cost and their errors." with a background job that runs. The reply states the agent's own next step after the job. It does not need user input, so the run stays `working`.
- Q: What is a reply that needs the user? → A: Example from the user: a status report ("The luna campaigns are still running … the watcher bg_4 is waiting for the first campaign to end.") that ends with "To start the E6 E7 pair, reply with approval of the two sha256 values above. I will then write approved_by into each frozen file, add a LEDGER line, and run launch.sh for each protocol.". The watcher still runs, but the next step needs the user's approval. The run shows `needs-input`.
- Q: When a turn ends while a job runs, must OMP hold the end-of-turn event until the judge answers, or send it at once and change the status later? → A: Send the `awaitingAsyncWork` end event at once, as today. On a yes verdict, change only the run status, the title, the IDE state, and the notification to `needs-input`. Send no second end event.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Learn that the agent waits for me while a job runs (Priority: P1)

The agent starts a background job, for example a dev server or a log watcher. Then the agent ends its turn with a question to the user: "The server is up. Must I run the migration now?". OMP asks the judge model if the final reply needs the user's input. The judge says yes. The "Working…" loader stops, the IDE state shows `needs-input`, and OMP sends the completion notification, as during a guided interview (FR-003). The background job continues to run.

**Why this priority**: This is the full request. Without it, a question asked while a job runs stays hidden until the job ends, and a watcher never ends.

**Independent Test**: Start a background job that sleeps for 10 minutes. Make the agent end the turn with a question. Check that the IDE shows `needs-input` and that the notification fires within the judge time limit, while the job still runs.

**Acceptance Scenarios**:

1. **Given** an owned background job runs, **When** the agent ends the turn with a question or a request for a decision, **Then** the IDE shows `needs-input`, the attention notification fires, and the job continues to run.
2. **Given** the IDE shows `needs-input` while a job runs, **When** the user replies, **Then** the reply starts a new turn in the normal way.
3. **Given** the IDE shows `needs-input` while a job runs, **When** the job ends and its result wakes the session before the user replies, **Then** the agent gets the result in a new turn, as it does today for a job that ends after a normal stop.
4. **Given** the watcher `bg_4` still runs, **When** the agent ends the turn with a status report and then "To start the E6 E7 pair, reply with approval of the two sha256 values above. I will then write approved_by into each frozen file, add a LEDGER line, and run launch.sh for each protocol.", **Then** the judge says input is needed, the IDE shows `needs-input`, and the notification fires. The status report before the request does not change the verdict.

---

### User Story 2 - Keep the wait for a job when the agent only waits (Priority: P1)

The agent starts a test run in the background and ends the turn with "Tests run in the background. I will report when they finish.". Another example: "Next action: when the first E6 Runs finish, I will check their cost and their errors.". The judge says the reply does not need the user's input. OMP keeps the behavior of today: the run stays `working`, no notification fires, and the job result wakes the agent.

**Why this priority**: The change must not make every job wait look like a question. A false `needs-input` calls the user for nothing.

**Independent Test**: Start a background job. Make the agent end the turn with a status line and no question. Check that the run stays `working`, that no notification fires, and that the job result wakes the agent.

**Acceptance Scenarios**:

1. **Given** an owned background job runs, **When** the agent ends the turn with only a status or a promise to report later, **Then** the run stays `working` and no attention notification fires.
2. **Given** background runs that the agent started still run, **When** the agent ends the turn with "Next action: when the first E6 Runs finish, I will check their cost and their errors.", **Then** the judge says no input is needed, the run stays `working`, and no attention notification fires.
3. **Given** the judge cannot answer (no judge model, an error, or the time limit), **When** the turn ends while an owned job runs, **Then** OMP keeps the behavior of today: the run stays `working`.

---

### User Story 3 - Speckit-auto uses its existing judgment (Priority: P2)

This story amends the speckit-auto rules in `specs/009-speckit-auto-pipeline/spec.md`. Speckit-auto already asks its own judge at each phase settle whether the reply waits for the user (009 FR-024, research R6). Today a fixed rule overrides that answer. When a phase reply looks unfinished and a job that the phase started still runs, speckit-auto always waits for the job wake reply and never holds for the user. With this feature, speckit-auto uses its existing "waits for the user" answer instead. It holds for the user when that answer is yes, and it waits for the job otherwise. Speckit-auto does not make a second judge call for this.

**Why this priority**: Speckit-auto runs long phases and starts background jobs. The same hidden-question problem applies to it, but the main session status is the base case.

**Changes to 009**: Acceptance scenario US1-8 and the edge case "Queued messages or background jobs exist when a phase turn pauses" now apply only when the existing judge says the reply does not wait for the user. FR-010 does not change: a phase start still needs a settled turn with no job that can wake it. FR-023 does not change.

**Independent Test**: Turn speckit-auto on. In a phase, make the agent start a background job and end the turn with a question for the user. Check that speckit-auto holds with "needs you" while the job runs.

**Acceptance Scenarios**:

1. **Given** speckit-auto runs a phase and a job that the phase started still runs, **When** the phase reply asks the user a question, **Then** speckit-auto holds for the user and the job continues to run.
2. **Given** speckit-auto runs a phase and a job that the phase started still runs, **When** the phase reply only waits for the job, **Then** speckit-auto waits for the job wake reply, as it does today.

### Edge Cases

- A job finished and its result is about to wake the session at the moment the turn ends. OMP does not ask the judge. The wake turn starts at once, as it does today.
- The job result wakes the session while the judge still decides. OMP drops the late verdict, and the new turn owns the run status.
- The user sends a message or switches the session while the judge decides. OMP drops the verdict and does not show `needs-input` for the old turn.
- Only jobs that another agent owns run. The fixed rule does not apply to them today, so OMP does not ask the judge. The turn ends in the normal way.
- The final reply ends with an error or the user aborted the turn. OMP does not ask the judge. The error or idle state shows as it does today.
- The final reply has tool calls, or OMP schedules its own continuation (a todo reminder, a retry, a compaction continuation). OMP does not ask the judge for that stop.
- A subagent ends its turn while its own job runs. A subagent has no user to ask, so OMP does not ask the judge, and the subagent waits for the job as it does today.
- A print-mode run (`omp -p`) has no user who can reply. OMP does not ask the judge there, and print mode waits for jobs as it does today.
- The reply asks a rhetorical question or offers optional next steps ("Tell me if you want X") and also says it waits for the job. The judge decides. A wrong `working` is the same as today. A wrong `needs-input` costs one extra notification.
- Several settles happen while the same job runs (each wake reply ends a new turn). OMP asks the judge once for each settle.
- The IDE shows `needs-input` after a yes verdict, and then the job ends with no wake (for example the user cancels it). The IDE keeps `needs-input` until the user replies. The end of the job does not change it to `done`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When the agent ends a turn and owned background work still runs, OMP MUST ask the judge model one yes/no question: does the final reply need the user's input before the agent can go on?
- **FR-001a**: The judge question MUST say "no" for a reply that only states the agent's own next step after the job, or a promise to report later. Example: "Next action: when the first E6 Runs finish, I will check their cost and their errors.". The judge question MUST say "yes" for a reply that asks the user a question, asks for a decision or approval, or asks the user to do an action. Example: "To start the E6 E7 pair, reply with approval of the two sha256 values above.". A yes request at the end of a long status report MUST still give "yes", and a running watcher MUST NOT change that answer.
- **FR-002**: OMP MUST ask the judge only for a clean stop with no tool calls, no OMP-scheduled continuation, and at least one running job that the agent owns. OMP MUST NOT ask when a finished job result is about to wake the session.
- **FR-003**: When the judge says yes, the TUI MUST show the settled state of a question, as during a guided interview: the "Working…" loader stops, the title and the terminal run status show the settled state (`done`), the IDE state shows `needs-input`, and the completion notification fires. Nothing else MUST change: the stop hooks stay deferred as today, the background jobs MUST continue to run, and a later job result MUST wake the session as it does today.
- **FR-004**: When the judge says no, OMP MUST keep the behavior of today for a turn that waits for a job.
- **FR-005**: When the judge cannot answer, OMP MUST keep the behavior of today for a turn that waits for a job. "Cannot answer" includes no judge model, a model error, and no verdict within 15 seconds.
- **FR-006**: The judge MUST get the final reply text and the user's request that opened the turn. It MUST NOT get the full transcript.
- **FR-007**: OMP MUST drop a verdict that arrives after a new turn starts (for example after the user sends a message) or after the session changes.
- **FR-008**: OMP MUST ask the judge only in the interactive TUI, because only the TUI shows the status, the title, the IDE state, and the notification that a verdict changes (FR-003, FR-010). Subagents, print mode, RPC, and ACP MUST keep the behavior of today and MUST NOT make the judge call. While a speckit-auto run is active, OMP MUST NOT make this judge call. Speckit-auto decides with its existing judge (FR-011a).
- **FR-009**: The judge call MUST use the existing `judge` model role and MUST record its usage in the session cost, as other judge calls do.
- **FR-010**: OMP MUST send the `agent_end` event at once, before the verdict, with `awaitingAsyncWork` as today. A yes verdict MUST NOT send a second `agent_end` event or change the event that was sent. Extensions and RPC clients see the same events as today.
- **FR-011**: OMP MUST NOT add a setting to turn the judgment off. The judgment replaces the fixed rule.
- **FR-011a**: Speckit-auto MUST use the "waits for the user" answer of its existing phase judge (009 FR-024, research R6). It MUST NOT make a second judge call. When a job that the phase started still runs, speckit-auto MUST hold for the user when that answer is yes. It MUST wait for the job wake reply when that answer is no or when the judge cannot answer. The fixed rule that always waits for the job MUST go. 009 FR-010 and FR-023 do not change.
- **FR-012**: The changelog MUST describe the change.

### Key Entities

- **Settle with running jobs**: the end of an agent turn while one or more background jobs that the agent owns still run. It has the final reply, the user request that opened the turn, and the set of running jobs.
- **Input verdict**: the judge answer for one settle: needs input, does not need input, or no answer. It is valid only for the settle that asked for it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of test settles where the final reply asks the user a direct question or for approval while a job runs, and a judge model is available, the IDE shows `needs-input` and the notification fires within 15 seconds of the end of the turn. The test set includes the "reply with approval of the two sha256 values" reply with the watcher `bg_4` running.
- **SC-002**: In 100% of test settles where the final reply only reports that it waits for a job or states the agent's own next step after the job (for example the "Next action: when the first E6 Runs finish" reply), the run stays `working` and no notification fires.
- **SC-003**: In 100% of test settles where the judge fails or times out, the visible behavior is the same as before this feature.
- **SC-004**: A settle with no running owned job causes zero judge calls.
- **SC-005**: All current tests about a turn that waits for a job pass with no change. No current test pins the fixed rule for a reply that needs the user.

## Assumptions

- "Background job" means the work that makes OMP treat a stop as "wait for a job" today: a running job that the agent owns, or a finished job result that is about to wake the session.
- The user's reply while a job runs uses the normal input path. This feature does not change how a reply or a job result starts the next turn.
- The judge is a small, fast model through the existing `judge` role. A judgment costs a few hundred tokens and runs only at settles with running jobs.
- The time limit of 15 seconds matches the existing unexpected-stop and speckit-auto judge time limits. A settle shows `working` until the verdict arrives.
- A wrong verdict has a low cost. A false `needs-input` sends one extra notification. A false `working` gives the behavior of today.
- The judgment does not cancel, pause, or change any background job.
