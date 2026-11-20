# Feature Specification: Session Inbox

**Feature Branch**: `main`

**Created**: 2026-11-20

**Status**: Draft

**Input**: User description: "do B" (Context: the user asked how easy it is to let an interactive omp session, one that does not run in RPC mode, accept instructions from another session. The sender can be a normal top-level session or a master-mode session, and the target can be a child session that master mode or `/spawn` started. Subagents are out of scope. Three options were offered: A, raw keystrokes into the child's terminal; B, a small per-session inbox for prompt, interrupt, and status, plus an agent tool to use it; C, the full RPC protocol next to the terminal UI. The user picked B. Today master mode can start a child session, but "nothing comes back here": the master cannot steer the child after the start.)

## Clarifications

### Session 2026-11-20

- Q: Does the target's answer come back to the sender? → A: Yes. When the turn that a message started (or entered) ends, the target's last answer comes back to the sender by itself, like a background job result. Also, the target can send its own messages back to the sender with the same tool.
- Q: Which sessions get the send tool? → A: Every top-level interactive session. Master mode also allows it. Subagents do not get it.
- Q: What happens when an agent in plan mode sends a message to another session? → A: The send is allowed. Only the target's own mode and approvals apply. A plan-mode sender can have a target change files without plan approval, and this is an accepted gap.
- Q: Can a sender turn off the reply for one send? → A: Yes. Each send is either a "request" or a "notification". A request gets a reply and is the default. A notification is one-way and never gets a reply.
- Q: When a notification reaches an idle session, does it start a turn there? → A: It follows the advisor-note rules. A notification is advice that the target weighs, not an order. It has a level: "nit", "concern", or "blocker". A "nit" never interrupts. In a busy target it enters at the next step, and in an idle target it only shows and starts no turn. A "concern" or "blocker" enters the current turn of a busy target and starts a turn in an idle target. No reply comes back.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A master session sends an instruction to a child session (Priority: P1)

A user in master mode asks for a new feature. The master agent starts a child session on its own branch. Later the user tells the master: "tell the upload child to also cover the retry case". The master agent sends that instruction to the child. The instruction shows in the child's conversation with the name of the sender, and the child agent acts on it as if the user had typed it there. The master agent gets a confirmation that the child received the message. The master does not wait for the child's work.

**Why this priority**: This is the request. After the start, master mode has no way to steer a child session. The user must switch to the child and type there.

**Independent Test**: Turn master mode on in a terminal session. Start one child session. Ask the master to send "reply with the word PONG" to the child. The child's conversation shows the message with the master as the sender, and the child answers. The master's turn ends without a wait on the child.

**Acceptance Scenarios**:

1. **Given** a child session is idle, **When** the master agent sends it an instruction, **Then** the child shows the instruction with the sender's name and starts a turn on it.
2. **Given** a child session is busy with a turn, **When** the master agent sends an instruction with the default delivery, **Then** the child takes it at the next step of that turn. The instruction does not close a question or approval that the child shows to its own user, and it does not stop a tool that runs at that time.
3. **Given** a child session is busy with a turn, **When** the master agent sends an instruction with "after the turn" delivery, **Then** the child starts a new turn on it after the current turn ends.
4. **Given** the master agent sends an instruction, **When** the child accepts it, **Then** the master agent gets a delivery confirmation and its own turn is not blocked.
5. **Given** master mode is on, **When** the master agent uses the send tool, **Then** master mode allows the call.

---

### User Story 2 - A session finds the sessions it can reach (Priority: P1)

Before the agent sends a message, it must know the target. The agent asks for the list of live sessions. Each entry shows a name the agent can use as the address, the working directory, the branch when there is one, whether the session is busy or idle, and whether this session started it. Sessions that ended do not show.

**Why this priority**: A send without a reliable address fails or reaches the wrong session. The user names sessions by their work ("the upload child"), so the agent needs enough data to match them.

**Independent Test**: Open two top-level sessions in two directories. In a third session, ask the agent to list reachable sessions. Both show with the correct directories and states, and the current session does not show as a target. Close one session and list again. Only the other one shows.

**Acceptance Scenarios**:

1. **Given** two other interactive sessions run under the same user, **When** an agent lists reachable sessions, **Then** both show with address, directory, branch, and busy or idle state.
2. **Given** a session started a child session, **When** that session lists reachable sessions, **Then** the child shows as its child.
3. **Given** a session ended or crashed, **When** an agent lists reachable sessions, **Then** that session does not show.
4. **Given** a session runs in RPC mode or is a subagent, **When** an agent lists reachable sessions, **Then** that session does not show.

---

### User Story 3 - A normal top-level session sends to another top-level session (Priority: P2)

A user works in two separate omp sessions, one for the backend and one for the frontend. In the backend session the user says: "tell the frontend session that the API now returns `items` instead of `results`". The backend agent sends that message to the frontend session. Neither session uses master mode, and neither session started the other.

**Why this priority**: The user asked for this for normal sessions too, not only for master mode. It uses the same parts as User Story 1, so it adds little work.

**Independent Test**: Open two top-level sessions with no parent link. From one, send a message to the other. The other shows the message with the sender's name and acts on it.

**Acceptance Scenarios**:

1. **Given** two unrelated top-level interactive sessions, **When** one agent sends a message to the other, **Then** the target shows it with the sender's name and acts on it.
2. **Given** a session in a terminal that has no session multiplexer, **When** another session sends it a message, **Then** the message arrives the same way.

---

### User Story 4 - A session interrupts another session (Priority: P2)

The master agent sees that a child goes in the wrong direction. It interrupts the child's current turn, then sends a corrected instruction.

**Why this priority**: Steering without a stop is weak. The user can already interrupt a session at its own terminal, and the coordinator needs the same control.

**Independent Test**: Start a child on a long task. From the master, interrupt it. The child's turn stops, and the child shows that the master interrupted it.

**Acceptance Scenarios**:

1. **Given** a child session is busy, **When** the master agent interrupts it, **Then** the child's turn stops and the child shows who interrupted it.
2. **Given** a child session is idle, **When** the master agent interrupts it, **Then** nothing changes and the master gets a result that says the target was idle.

---

### User Story 5 - The sender gets the target's reply, and the target can report back (Priority: P1)

The master agent sends a question to a child: "what is your status?". The master's turn ends. When the child's turn on that question ends, the child's last answer comes back to the master by itself, the same way a background job result arrives. The master reacts to it without a user message. Later, the child hits a design choice it cannot make. It sends a message to the master by itself, and the master gets it like any other incoming message.

**Why this priority**: The user picked this. In master mode, "nothing comes back here" is the main gap. A coordinator that must poll its children cannot react to their results.

**Independent Test**: From a master session, send "reply with PONG" to a child. End the master's turn. Within seconds after the child's turn ends, the master gets a result that contains "PONG" and starts a turn on it. Then ask the child, in its own window, to "tell the master you are blocked". The master gets that message with the child's name as the sender.

**Acceptance Scenarios**:

1. **Given** a sender sent a message to an idle target, **When** the target's turn on that message ends, **Then** the sender gets the target's last answer as a result that names the target, and the result starts a turn in the sender.
2. **Given** a sender sent a message with "steer" delivery to a busy target, **When** the target's current turn ends, **Then** the sender gets the last answer of that turn.
3. **Given** two senders' messages entered the same target turn, **When** that turn ends, **Then** each sender gets the answer once.
4. **Given** the target's turn ends because of an interrupt or an error, **When** the reply goes back, **Then** it says that the turn was interrupted or failed, and it includes the error text when there is one.
5. **Given** the sender ended before the target's turn ends, **When** the turn ends, **Then** the reply is dropped and the target does not change.
6. **Given** a child session, **When** its agent sends a message to the session that started it, **Then** that session gets the message the same way as any other incoming message.
7. **Given** a sender sent a notification, **When** the target's turn on that message ends, **Then** the sender gets no reply and no turn starts in the sender.
8. **Given** a target is idle, **When** a sender sends it a "nit" notification, **Then** the target shows it with the sender's name and starts no turn.
9. **Given** a target is idle, **When** a sender sends it a "concern" or "blocker" notification, **Then** the target shows it with the sender's name and starts a turn on it. Two advisor limits apply (FR-018). When the target is in plan mode, or after an interrupt that its user has not yet followed with input, the notification only shows and starts no turn.
10. **Given** a target is busy, **When** a sender sends it a "nit" notification, **Then** the current turn is not interrupted, and the agent sees the notification at its next step.
11. **Given** a target gets a notification, **When** its agent reads it, **Then** the notification is marked as advice to weigh, not as an instruction from the user.

---

### Edge Cases

- The target ended between the list and the send: the send fails with a clear "session not found" result, and nothing else happens.
- The target shows a dialog to its user (for example a question or an approval): the message waits in the target's queue and enters after the dialog ends. The sender gets "queued", not "failed".
- The target starts a new conversation or switches conversations while a message is on its way: the message goes to the conversation that is current when it arrives. The delivery confirmation names that conversation.
- The target refuses or drops the message (for example a spending cap stops all turns): the sender gets "not delivered" with the reason.
- An agent sends a message to its own session: the send is refused.
- Two senders send to one target at the same time: the target takes both, in arrival order, and loses neither.
- The message is larger than a normal user prompt can be: the send is refused with the size limit in the result.
- A process that runs as a different OS user tries to send: the target refuses it.
- The target's user types in the editor when a message arrives: the user's draft does not change.
- A reply arrives at a sender: the reply does not make a new reply. A reply goes back only for an incoming message, so two sessions do not answer each other forever by themselves.
- The target's last answer is very long: the reply is cut to a fixed length, and the reply says that it was cut.
- The sender is in plan mode: the send is allowed. Plan mode does not limit what the target does. Only the target's own mode and approvals apply, so a plan-mode sender can have the target change files without plan approval. This is an accepted gap.
- The sender uses an approval mode that asks before file changes: the send needs no approval in the sender, the same as starting a session with `/spawn`. Only the target's own mode and approvals apply, so the target can change files that the sender's user did not approve. This is an accepted gap, for the same reason as the plan-mode gap.
- The sender's user interrupted the sender: while the sender holds back background job results after that interrupt, a reply that arrives joins the sender's conversation without a turn, the same as a background job result. The sender's next turn sees it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every top-level interactive session MUST accept messages from other local sessions while it runs, with no start option and no multiplexer.
- **FR-002**: Sessions in RPC mode and subagents MUST NOT accept messages through this feature.
- **FR-003**: The system MUST let an agent list the sessions it can reach. Each entry MUST show an address, the working directory, the branch when there is one, the busy or idle state, whether the caller started it, and whether it started the caller.
- **FR-004**: The list MUST NOT show sessions that ended or crashed, and MUST NOT show the caller's own session.
- **FR-005**: An agent MUST be able to send a text message to a session by its address.
- **FR-006**: For a request, the sender MUST be able to choose the delivery: "steer" (enter the current turn at its next step) or "after the turn" (start a new turn when the current one ends). "Steer" MUST be the default. A steered request MUST NOT close a question or approval that the target shows to its own user, and MUST NOT stop a running tool. The sender uses an interrupt (FR-009) to stop the target's work.
- **FR-007**: The target MUST show each received message in its conversation as a message from the sending session, with the sender's name. The target MUST treat a request as user input for the agent. The target MUST mark a notification as advice to weigh, not as an order, the same way it marks an advisor note.
- **FR-008**: The sender MUST get one result for each send: "delivered", "queued", or "not delivered" with a reason. The send MUST NOT block until the target's work ends.
- **FR-009**: An agent MUST be able to interrupt the current turn of another session. The target MUST show who interrupted it.
- **FR-010**: Master mode MUST allow the list, send, and interrupt actions.
- **FR-011**: Every top-level interactive session MUST have the list, send, and interrupt actions, in every mode, plan mode included. Subagents and RPC-mode sessions MUST NOT have them.
- **FR-012**: Only processes of the same OS user MUST be able to reach a session. A session MUST refuse any other caller.
- **FR-013**: A message MUST NOT change the target user's editor draft.
- **FR-014**: When two messages arrive at one target, the target MUST keep both, in arrival order.
- **FR-015**: Each send MUST be a "request" or a "notification", chosen by the sender. "Request" MUST be the default. When the target's turn that a request started or entered ends, the system MUST send the target's last answer back to each sender of a request in that turn, once. A notification MUST NOT get a reply. The reply MUST arrive like a background job result, MUST start a turn in the sender, and MUST NOT block the sender before it arrives. The one exception is the background-job rule after the sender's own user interrupt: while the sender holds back background job results, a reply joins the sender's conversation without a turn. A reply MUST NOT make another reply.
- **FR-016**: A user MUST be able to turn the inbox off for a session through settings. The default is on.
- **FR-017**: A reply MUST say whether the turn ended normally, was interrupted, or failed. When the answer is longer than a fixed limit, the reply MUST be cut and MUST say that it was cut.
- **FR-018**: A notification MUST have a level: "nit", "concern", or "blocker". "Nit" MUST be the default. The target MUST deliver a notification by the same rules as an advisor note of the same level: whether it interrupts the current turn, whether it starts a turn in an idle target, and when it only shows. These rules include the advisor's limits after a user interrupt.

### Key Entities

- **Reachable session**: a live top-level interactive session that accepts messages. It has an address, a display name, a working directory, a branch when there is one, a busy or idle state, and the address of the session that started it when there is one.
- **Inbox message**: text from one session to another. It has the sender's address and name, the text, and the kind. A request also has the delivery choice ("steer" or "after the turn"). A notification also has the level ("nit", "concern", or "blocker").
- **Delivery result**: the answer to one send: "delivered", "queued", or "not delivered" with a reason, plus the conversation that got the message.
- **Reply**: the target's last answer for the turn that a request started or entered. It has the target's address and name, how the turn ended, and the answer text, cut when it is too long.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A message to an idle session shows in that session within 1 second after the send.
- **SC-002**: Every send ends with one of the three results. In a run of 100 sends that include ended targets and busy targets, no send is lost without a result.
- **SC-003**: A session that starts shows in the list within 2 seconds. A session that ends no longer shows within 2 seconds.
- **SC-004**: A master session can steer a child session without the user switching to the child's window. In the test, the user does not type in the child.
- **SC-005**: The sender's turn ends in the same time with or without the send. The send adds no wait for the target's work.
- **SC-006**: A sender gets the target's reply within 2 seconds after the target's turn ends, with no poll and no user input.

## Assumptions

- "Local" means the same machine and the same OS user. Sessions on other machines are out of scope. The existing Collab feature covers remote work.
- The address is a short name that stays the same for the life of the session window. For a child session it can be the same name that `/spawn` gives it.
- A message is treated as user input in the target. The target's own rules (master mode, plan mode, approvals) apply to it as to typed input. The sender cannot get more rights in the target than the target's user has.
- The inbox belongs to the session window, not to one conversation. After `/new` or a resume, the same window keeps its address.
- The existing `/spawn` and master-mode start flow does not change. Today's start message stays the way the child gets its first instruction.
- No approval prompt shows in the target before a message enters. A user who does not want messages turns the inbox off (FR-016).
- The system does not limit back-and-forth that the agents choose. A reply can start a turn in the sender, and that turn can send a new request. A "concern" or "blocker" notification can also start a turn. Only the automatic reply loop is blocked (a reply never makes a reply). The user stops a chosen loop with an interrupt or with the spending cap. A per-pair limit that resets only when the user types is out of scope, because it would stop a master session that steers a child through many steps.
- The full RPC protocol (session switch, dictation, live mode, and other host commands) is out of scope.
