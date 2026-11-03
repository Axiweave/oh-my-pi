# Feature Specification: Fork Start Reminder

**Feature Directory**: `specs/020-fork-start-reminder` · **Git Branch**: `main`

**Created**: 2026-11-02

**Status**: Draft

**Input**: User description: "I want to some kind of this; by a config toggle (default true); remeber we recently add a fork request from escape sequence; my normal usecase; is one session running -> fork -> starting working on the forked session; the problem is that I might fork in the middle; so I need to manually type this session is a fork, this is the new request to ignore whats ongoing; so I want a thing like system reminder to inject; so we dont need to type it everytime; think about it and usecase;"

## Context

The user often works like this:

1. Session A runs a long task.
2. The user forks A, often from the IDE fork request (the `fork-spawn` action) and often while A is still in a turn.
3. A new session B starts with a copy of A's conversation. A keeps running.
4. The user types a new, unrelated request in B.

B's copy can end in the middle of A's task. Examples are an unanswered request, a reply cut off, or tool calls with no results. The model in B then reads that unfinished task as its own work and tries to resume it. To prevent this, the user now types a preface by hand every time: "this session is a fork, this is a new request, ignore what is ongoing".

This feature adds that preface automatically. A hidden reminder, like the other system reminders, goes with B's first request. A user setting controls it, and it is on by default.

## Clarifications

### Session 2026-11-02

- Q: Must a fork of an idle session also get the reminder, or only a fork made while the source session is in a turn? → A: Every fork gets the reminder. The "copied work is unfinished" text is added only when the copy stops in the middle of a task.
- Q: Must the reminder be saved in the fork's history as a hidden message, or added only to the outgoing request and never saved? → A: Save it as a hidden message on the fork's first request. A resume, `/dump`, and a later fork all see it as past context.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fork mid-turn and give a new request (Priority: P1)

The user forks A while A is in a turn. In B, the user types only the new request. The model in B treats that request as its task. It does not resume, retry, or finish the copied unfinished work.

**Why this priority**: This is the daily workflow. It removes the preface that the user now types for each fork.

**Independent Test**: Fork a session while its turn runs. In the fork, send a short unrelated request. Look at the request that goes to the model. It must contain the fork reminder, and the reminder must say that the copied work ended mid-task.

**Acceptance Scenarios**:

1. **Given** the copied conversation ends mid-task and the setting is on, **When** B accepts its first request, **Then** the reminder identifies the copied work as the source session's task.
2. **Given** the same fork, **When** the user sends a second request in B, **Then** the system inserts no second fork reminder. That request carries the first reminder only as earlier history.
3. **Given** the same fork, **When** the user's first request in B asks to continue the copied work (for example "continue what you were doing"), **Then** the model continues it, because the reminder lets an explicit user request override it.

---

### User Story 2 - Fork an idle session (Priority: P2)

The user forks A while A is idle. B still gets a fork reminder with its first request. The reminder says that B is a fork and that the source session can still run on its own. It does not say that work was cut off.

**Why this priority**: The user often starts B to do a side task while A continues later. The model in B must know that another session can change the same files.

**Independent Test**: Fork an idle session, send a first request in the fork, and look at the outgoing request. It must contain the fork reminder without the "ended mid-task" part.

**Acceptance Scenarios**:

1. **Given** A is idle and the setting is on, **When** the user forks A and sends a first request in B, **Then** the request carries the fork reminder, and the reminder does not claim unfinished copied work.
2. **Given** B shares A's working directory, **When** the reminder goes out, **Then** it tells the model that the source session can still change files in this directory.
3. **Given** B starts in its own new worktree, **When** the reminder goes out, **Then** it does not give the shared-directory warning.

---

### User Story 3 - Turn the reminder off (Priority: P2)

A user who does not want new reminders turns off the setting. New forks then add no reminder.

**Why this priority**: The user asked for a toggle. Some users write their own fork preface or do not want extra context.

**Independent Test**: Disable the setting and fork a session. Send its first request. Confirm that it adds no new reminder.

**Acceptance Scenarios**:

1. **Given** the setting is off at fork creation, **When** B accepts its first request, **Then** B adds no reminder or notice.
2. **Given** no value is set, **When** the user forks, **Then** the reminder is on.

---

### User Story 4 - See that the reminder is in place (Priority: P3)

After B accepts its first model-bound request, it shows one advisor-style `Fork reminder` card. The collapsed card is one header line that lists the fork facts. Ctrl+O expands it to the reminder text that the model got.

**Why this priority**: This answers the earlier question "reminders are not shown anywhere" for this one reminder, in the same form as advisor notes.

**Independent Test**: Send the first request in B and check its chat. One card appears. A second request adds no second card.

**Acceptance Scenarios**:

1. **Given** the setting is on, **When** B accepts its first model-bound request, **Then** B shows one collapsed `Fork reminder` card with the facts in its header, and Ctrl+O shows the reminder text.
2. **Given** the setting is off when B starts, **When** B accepts its first request, **Then** B adds no reminder or notice.

---

### Edge Cases

- **The first message in B is a command that does not reach the model** (for example `/model`): the reminder waits for the first message that goes to the model.
- **B's first model-bound message comes from a start text** (for example the handoff request in `/spawn` `fork_handoff` mode): the reminder goes with that message.
- **The user closes B before a first request**: B retains its fork facts. The reminder waits for its first model-bound request after resume.
- **The user resumes B later**: B inserts no duplicate reminder. Later requests retain any existing reminder as past context.
- **The user forks B (a fork of a fork)**: the new fork gets its own reminder. The earlier reminder stays in the copied history as past context.
- **The user forks in place with plain `/fork`**: no reminder. Plain `/fork` refuses to run during a turn, and the original session does not keep running beside the fork.
- **The user rewinds or branches inside a session (`/branch`, double Escape)**: no reminder. This is not a fork into a new session.
- **The fork comes from a manual `omp --fork <file>` command**: B gets the reminder. B cannot know if the source is still running, so the reminder uses the idle wording unless the copied history ends mid-task.
- **Compaction runs in B later**: the reminder can enter the summary or leave active context like other past messages. B does not insert it again.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When a session starts as a fork of another session, the system MUST insert a fork reminder into its history before the first message that goes to the model.
- **FR-002**: The fork forms in scope MUST be all forms that start a new session from a copy while the source session stays alive: `/fork spawn`, the IDE `fork-spawn` action, `/fork pane`, `/fork window`, the Tern pane fork, `/spawn` in `fork` and `fork_handoff` modes, and a manual `omp --fork` start.
- **FR-003**: In-place `/fork`, `/branch`, rewind, resume, and fresh sessions MUST NOT create a new fork reminder. Resume preserves a pending first-request reminder.
- **FR-004**: The reminder MUST tell the model that this session is a fork, the source session is separate and can still run, and the user's message is the new task.
- **FR-005**: When the copied conversation ends mid-task, the reminder MUST also say that the copied unfinished work belongs to the source session and that the model must not resume, retry, or finish it.
- **FR-006**: When the copied conversation ends with a complete turn, the reminder MUST NOT claim unfinished copied work.
- **FR-007**: The reminder MUST let an explicit user request override it. If the user asks to continue the copied work, the model can do so.
- **FR-008**: When the fork shares the source session's working directory, the reminder MUST warn that the source session can still change files there. When the fork starts in a new worktree, the reminder MUST leave out this warning.
- **FR-009**: The system MUST insert the reminder at most once per fork, also across a resume of that fork. Later requests carry that one entry as earlier history.
- **FR-010**: The reminder MUST use the same hidden system-reminder form as the other reminders. The chat MUST NOT show its text until the user expands the card.
- **FR-011**: When B accepts its first model-bound request with the reminder, it MUST show one advisor-style card in chat. The collapsed card is one header line with the fork facts. The expanded card shows the reminder text.
- **FR-012**: A user setting MUST control reminder creation for new forks. The default MUST be on. Disabling it MUST NOT delete existing history.
- **FR-013**: The source session MUST NOT change in any way because of this feature. It gets no message, no notice, and no change to its running turn.
- **FR-014**: The feature MUST NOT add a user step, confirmation, or model request to fork creation.

### Key Entities

- **Fork reminder**: hidden context text for the model, saved once in the fork's history. It carries the fork facts: is a fork, copied work unfinished or not, shared directory or not.
- **Fork reminder setting**: one on/off user setting, on by default.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a fork, the user types zero preface words for the model to treat the first request as a new task.
- **SC-002**: With the setting on, 100% of forks in scope get exactly one reminder entry, placed before their first model-bound message.
- **SC-003**: With the setting off, 0% of new forks add a reminder or notice. Reminders inherited as past context remain unchanged.
- **SC-004**: In a fork made mid-turn, the first reply works on the user's new request and does not continue the copied unfinished task. Check this in at least 9 of 10 trial forks with a real model.
- **SC-005**: Fork creation adds zero user steps, confirmation dialogs, or model requests.
- **SC-006**: The source session's transcript and running turn stay identical with or without this feature.

## Assumptions

- "Fork" in the user's request means a new session that starts from a copy while the source session can keep running. In-place `/fork` is out of scope because it cannot run mid-turn and leaves no second live session.
- The reminder goes with every in-scope fork, idle or mid-turn, and the wording changes with the copied state. The user asked for the mid-turn case, but a fork of an idle session has the same shared-file risk.
- B uses the copied conversation to determine whether work remains unfinished. A running source can have a snapshot that ends at a completed turn.
- B treats unanswered requests, unresolved tool calls, and tool results awaiting a reply as unfinished copied work.
- B preserves the existing recovery behavior for interrupted tool calls before it adds the reminder.
- B saves the reminder with its first model-bound request. Later requests retain it as history, and the session dump includes it.
- The setting lives with the other fork and spawn settings in `config.yml`. Its default also goes into the user's `~/.omp/agent/config.yml`, as the repo rules require.
- The notice line is the only visible part. A general view of all hidden reminders is out of scope.
