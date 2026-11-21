# Feature Specification: Inbox Threads

**Feature Branch**: `main`

**Created**: 2026-11-20

**Status**: Draft

**Input**: User description: "commit existing and spec it next" (Context: the session inbox from feature 023 lets one live session send a request to another live session. The target's last answer at turn end goes back to the sender by itself, and the agent has no action to reply. The user asked whether there is a reply tool, and then asked for a better design: "thread-like stuff like real chats; thread with thread-id and agent use tool send and reply". The user also asked what to copy from the in-process agent messaging (IRC). The proposal that the user accepted: two-session threads in the IRC style, an explicit reply and a progress note, an automatic answer only when the agent did not reply in that turn, notifications unchanged, and a fix for the request text that is not escaped.)

## Clarifications

### Session 2026-11-20

- Q: When a session gets a message in a thread and ends its turn without replying, should omp always send that turn's last answer back automatically, or only for messages from the session that opened the thread? → A: Only for messages from the session that opened the thread (the first message and the opener's later replies). Replies to the opener never get an automatic answer or a failure notice.
- Q: When a session runs `/new` or switches to another conversation, should its open threads end, or stay with the session window so that later messages land in the new conversation? → A: They stay with the window (B). A conversation change does not end a thread. Later messages in the thread land in the new conversation. A turn that the change cut still sends its failure notice ("aborted") to the opener.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A session opens a thread and the other side replies explicitly (Priority: P1)

A master session asks a child: "which test runner do you use, and is the suite green?". The send opens a thread, and the master gets the thread id in the send result. The child sees the question with the thread id, the sender's name, and a short line that tells it how to answer. The child answers with the reply action and names the thread. The master gets the answer in the same thread and reacts to it.

**Why this priority**: This is the request. Today the target cannot choose its answer. The answer is always its last text at turn end, and the target is never told this. A chat needs an explicit reply.

**Independent Test**: From one session, send "reply with PONG" to another session. The target's conversation shows the message with a thread id and a line that says how to reply. The target answers with the reply action. The sender gets "PONG" in that thread, once.

**Acceptance Scenarios**:

1. **Given** two live sessions, **When** one agent sends a message to the other, **Then** the send opens a new thread, and the send result names the thread id.
2. **Given** a session gets a message from the session that opened the thread, **When** the message shows, **Then** it shows the thread id, the sender's name and address, and a line that tells the agent to answer with the reply action.
3. **Given** a session got a message in a thread, **When** its agent replies in that thread, **Then** the other session gets the reply in the same thread, and the reply names the thread id.
4. **Given** an agent replied in a thread during a turn, **When** that turn ends, **Then** the system sends no automatic answer for that thread.

---

### User Story 2 - A conversation continues in one thread over many turns (Priority: P1)

The master asks a child to fix a bug. The child replies with a progress note: "on it, the fix takes a few steps". Later the child replies with a question: "keep the old flag or remove it?". The master answers "remove it" in the same thread. The child finishes and replies "done, tests pass". All messages stay in one thread, in order.

**Why this priority**: Real work needs more than one question and one answer. Without threads, every new message is a separate request, and the agents cannot tell which answer belongs to which question.

**Independent Test**: Send a message from session A to session B. Let B reply three times in the thread, the first time as a progress note. Let A reply once between B's replies. Each session sees all messages of the thread in send order, with one thread id.

**Acceptance Scenarios**:

1. **Given** a thread exists, **When** either session replies in it, **Then** the other session gets the reply in that thread. Either side can reply any number of times.
2. **Given** a session replies with a progress note, **When** the other session gets it, **Then** the note is marked as progress, and it says that the real answer follows later.
3. **Given** many replies in one thread, **When** they arrive, **Then** the receiver gets them in send order.
4. **Given** a session sends a reply that is not a progress note in each of several turns, **When** each of those turns ends, **Then** the system sends no automatic answer for that thread.

---

### User Story 3 - The sender still gets an answer when the receiver does not reply (Priority: P1)

A child gets a question but ends its turn without the reply action. The master still gets the child's last answer of that turn in the thread, marked as an automatic answer. Another time, the child's turn fails or its user interrupts it. The master gets a notice in the thread that the turn failed or was interrupted, with the error text when there is one.

**Why this priority**: A sender that waits for an answer must not wait forever. An agent can forget to reply, and a turn can fail.

**Independent Test**: Send a message to a session whose agent answers in plain text and never uses the reply action. The sender gets that text in the thread, marked as automatic. Then make the target's turn fail with an error. The sender gets a failure notice in the thread with the error text.

**Acceptance Scenarios**:

1. **Given** a session got a message from the session that opened the thread, **When** the turn that the message started or entered ends with no reply in that thread from this session, **Then** the opener gets the turn's last answer in that thread, marked as automatic, once.
2. **Given** a session got a message from the session that opened the thread, **When** that turn is interrupted or fails, **Then** the opener gets a notice in that thread that says so, with the error text when there is one. This notice is sent even when the session already replied in that turn.
3. **Given** a session gets an automatic answer, a failure notice, or a progress note, **When** its turn on that message ends, **Then** the system sends nothing automatic back.
4. **Given** the answer text is longer than a fixed limit, **When** the system sends it as an automatic answer, **Then** the answer is cut and says that it was cut.
5. **Given** the opener got a reply in its thread (for example "done, tests pass"), **When** the opener's turn on that reply ends with no reply, fails, or is interrupted, **Then** the system sends nothing automatic to the other session.

---

### User Story 4 - Threads outlive a new conversation, and a reply to an ended session fails clearly (Priority: P2)

A child replies in a thread, but the master ran `/new` since then. The thread is still open, and the reply arrives in the master's new conversation. Another time, the master session ended. The child gets a clear "not delivered" result that says why. The child does not crash, and it does not try again in a loop.

**Why this priority**: Threads belong to the session window, not to one conversation (clarification). Work in a thread must not break when one side starts a new conversation. The agent must know when a reply cannot arrive.

**Independent Test**: Open a thread from A to B. Run `/new` in A. Let B reply in the thread. The reply arrives in A's new conversation in the same thread. Then end session A. Let B reply again. B gets "not delivered" with the reason that the session ended.

**Acceptance Scenarios**:

1. **Given** the other session ended, **When** an agent replies in the thread, **Then** the reply result is "not delivered" with the reason that the session ended.
2. **Given** the other session started a new conversation, **When** an agent replies in a thread from before, **Then** the reply arrives in the other session's new conversation, in the same thread.
3. **Given** an agent names a thread id that this session never had, **When** it replies, **Then** the reply is refused with an "unknown thread" error, and nothing is sent.
4. **Given** a session starts a new conversation while a turn that owes the opener an answer is running, **When** the change cuts that turn, **Then** the opener gets a failure notice in that thread that the turn was aborted, and the thread stays open.

---

### User Story 5 - Message text cannot pose as a system message (Priority: P2)

A peer session sends text that contains a fake system block, for example a fake reply notice or a fake user steer. The receiver shows the text as plain text inside the peer's message. The agent cannot mistake it for a block from the system.

**Why this priority**: This is a security fix that the IRC review found. Today the request text enters the target with no escape, while replies and IRC messages are escaped.

**Independent Test**: Send a message whose text contains a closing tag and a new opening tag of a system block. In the receiver's conversation, the text shows inside the peer message, and no new system block forms.

**Acceptance Scenarios**:

1. **Given** a message, reply, or progress note whose text contains system block tags, **When** the receiver gets it, **Then** the tags are made harmless, and the text stays inside the peer's message.

---

### Edge Cases

- Two sessions share one address (two windows with one name): a thread routes to the session that is in the thread, never to the other one.
- A message in a thread arrives while the receiver shows a dialog to its user: it waits in the queue, and the sender gets "queued", the same as today.
- The receiver is busy: a message from the session that opened the thread, or one that opens a new thread, enters at the next step or after the turn, by the sender's choice, the same as a request today. An answer to a thread that the receiver opened arrives like a background job result, the same as a reply today.
- The receiver's own user interrupted it: answers to threads that it opened join its conversation without a turn, the same as a reply today.
- One turn gets messages from several threads: each thread gets its own automatic answer or failure notice when the turn ends with no reply in that thread.
- A session replies in a thread before the send result of the first message reaches the other side: the reply is accepted.
- An agent sends only an acknowledgment: the tool rules say NEVER to reply only to acknowledge, and to use a progress note when the real answer comes later.
- A thread gets no message for a long time: it stays open until one of its two sessions ends. A new conversation does not close it. No timer closes it.
- A notification is not part of a thread. It gets no reply and no automatic answer, the same as today.
- Many replies in a loop: the system does not stop a back-and-forth that the agents choose. Only automatic messages never cause automatic messages. The user stops a chosen loop with an interrupt or with the spending cap.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each message that an agent sends to another session with the send action MUST open a new thread. The send result MUST include the thread id.
- **FR-002**: A thread MUST belong to exactly two sessions: the one that opened it and the one that got the first message.
- **FR-003**: An agent MUST be able to reply in a thread by its thread id, with no address. The reply MUST go to the other session of that thread.
- **FR-004**: Either session in a thread MUST be able to reply any number of times, in any turn.
- **FR-005**: A reply MUST be able to be marked as a progress note. A progress note MUST tell the receiver that the real answer follows later. A progress note MUST NOT stop the automatic answer at the end of the turn (FR-008).
- **FR-006**: Each incoming thread message MUST show the thread id, the sender's name and address, and whether it is a first message, a reply, a progress note, an automatic answer, or a failure notice.
- **FR-007**: Each incoming message from the session that opened the thread MUST include a line that tells the agent how to answer: use the reply action with this thread id, use a progress note only for "on it", and know that its last answer goes back unless it sends a reply without progress in that turn. Each incoming reply to the opener MUST include a line that says nothing goes back automatically, and that the agent replies only when the other side needs an answer.
- **FR-008**: Only messages from the session that opened the thread get automatic messages. When a turn that such a message started or entered ends, and the receiving session sent no reply in that thread during that turn, the system MUST send the turn's last answer in that thread, marked as automatic, once. A progress note does not count as a reply here, so an opener is never left waiting after "on it". When that turn was interrupted or failed, the system MUST send a notice in that thread that says so, with the error text when there is one, even when the session already replied. A reply to the opener MUST NOT get an automatic answer or a failure notice.
- **FR-009**: An automatic answer, a failure notice, or a progress note MUST NOT cause any automatic message in return.
- **FR-010**: The receiver MUST get the messages of one thread in send order.
- **FR-011**: A thread MUST belong to the two session windows, not to one conversation. It MUST end only when one of its two sessions ends. When a session starts a new conversation, its threads MUST stay open, and later messages in them MUST arrive in the new conversation. When the conversation change cuts a turn that still owes the opener an answer, the opener MUST get a failure notice ("aborted") in that thread. A reply to a thread whose other session ended MUST give "not delivered" with the reason.
- **FR-012**: A reply that names a thread id unknown to the sending session MUST be refused with an "unknown thread" error, and the system MUST NOT send anything.
- **FR-013**: The system MUST make system block tags harmless in all peer text before it enters the receiver's conversation: first messages, replies, progress notes, automatic answers, and failure notices.
- **FR-014**: Delivery MUST keep the rules of the current inbox. A first message, or a reply from the session that opened the thread, MUST follow the request rules (steer or after the turn, never closes the receiver's dialog, never stops a running tool). A reply to the session that opened the thread MUST follow the reply rules (arrives like a background job result, starts a turn in an idle session, joins without a turn after that session's own user interrupt).
- **FR-015**: An automatic answer MUST be cut to the same fixed limit as today's reply, and it MUST say that it was cut.
- **FR-016**: Notifications MUST stay as they are: one-way, not in a thread, with the "nit", "concern", or "blocker" level.
- **FR-017**: The list and interrupt actions MUST stay as they are. Master mode MUST allow the reply action.
- **FR-018**: The tool description MUST explain threads, the reply action, progress notes, and the automatic fallback. It MUST say NEVER to reply only to acknowledge.
- **FR-019**: The thread rules in FR-008 MUST replace the automatic answer that the current inbox sends for a request. A second reply path MUST NOT remain.

### Key Entities

- **Thread**: a conversation between two sessions. It has a thread id, the two sessions, which one opened it, and whether the other session still owes the opener an answer for the current turn.
- **Thread message**: text in a thread. It has the thread id, the sender's name and address, the text, and a kind: first message, reply, progress note, automatic answer, or failure notice. A first message also has the delivery choice.
- **Send result**: the answer to a send or reply: "delivered", "queued", or "not delivered" with a reason, plus the thread id.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a real two-session test, a session that is asked a question answers with the reply action, and the sender gets exactly one answer for that turn, with no automatic answer.
- **SC-002**: In a test with 10 messages back and forth in one thread, each session gets every message of the other side once, in send order, with one thread id.
- **SC-003**: For every turn on a message from the thread opener that ends with no reply, the opener gets exactly one automatic answer or one failure notice. In 100 such turns, none is lost and none is sent twice. A turn on a reply to the opener sends nothing automatic in all cases.
- **SC-004**: A reply shows in the other session within 1 second after the reply action, when that session is idle.
- **SC-005**: No peer text can form a system block in the receiver. A test with crafted tags in every message kind finds no forged block.
- **SC-006**: A reply to a thread that is gone always gets a result with a reason. No reply is lost without a result.

## Assumptions

- Feature 023 (session inbox) is in place: the private local inbox, the list, the send, the interrupt, notifications, and the master-mode allowance. This feature changes only how requests and their answers work.
- The thread id is a short opaque id. Agents copy it from the send result or the incoming message, and they never make one up.
- Threads are not capped. Each one is a few hundred bytes (estimate). They stay until the session ends, also across `/new`. A cap would make an older live thread fail with "unknown thread".
- Threads live only in the memory of the two session windows. A restart of omp loses them. No thread history is stored on disk beyond the normal conversation log.
- The two sessions in a thread are identified by their inbox entries, not only by their addresses, so two windows with one address never mix threads.
- Group threads with more than two sessions are out of scope.
- A list of open threads is out of scope. The thread id is in the send result and in each incoming message, so it is in the agent's context.
- The IRC mailbox, wait, and broadcast parts are out of scope. Inbox peers are separate processes, and a send to an ended session already fails with a clear result.
- The change to the request rules is a clean cutover. There is no compatibility with sessions that run the older inbox, because the inbox is not released.
