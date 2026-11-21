# Research: Inbox Threads

All decisions build on the 023 session inbox (`packages/coding-agent/src/inbox/`). The plan's Technical Context has no open items. Each item below records a decision, the reason, and the alternatives.

## R1. Where the thread state lives

- **Decision:** The `InboxHost` of each session keeps a `Map<threadId, Thread>` in memory for the life of the session window (clarification B). A thread records the peer's identity (address, name, entry id), whether this session opened it, the number of open answer tickets, the turns in which this session replied, and the last turn that got a decision. A second map, `messageId → { thread, turn }`, points each open answer ticket at the thread record itself and at the turn that the message belongs to (R4).
- **Rationale:** The host already owns the per-session inbox state (`#pending`, `#replyTo`). The two maps replace those two maps one for one. Threads live as long as the session window (spec FR-011, Assumptions), so no disk storage is needed.
- **Alternatives:** Storing threads in the session JSONL would let them survive a restart. The spec puts restarts out of scope. A thread object in `AgentSession` would split the inbox state across two classes.

## R2. Thread id

- **Decision:** The opener creates the id before it sends the first message: `t-` plus 8 lowercase hex characters from `crypto.randomBytes(4)`. The first message carries `first: true`. The receiver creates its thread entry only for a first message with an id it does not know. Any other message with an unknown id gets `unknown_thread`.
- **Rationale:** The opener must register the thread before the call returns, because a fast peer can reply before the send result arrives (the 023 race, edge case "reply before the send result"). A short id is easy for an agent to copy. The receiver keys threads by id only. It refuses a first message whose id it already has (`thread_conflict`), so a collision cannot merge two threads.
- **Alternatives:** A UUID is safe but long to copy. Using the first message id as the thread id ties two ideas into one field. A receiver-minted id needs a round trip before the opener can accept a reply.

## R3. Which rules deliver a message

- **Decision:** The receiver uses its own thread table. A message from the opener (a first message, or a message in a thread that the receiver did not open) uses the **request path**: `promptCustomMessage` with the `collab-prompt` type, agent attribution, `steer` or `followUp`, and an answer ticket. A message to the opener (a thread that the receiver opened) uses the **reply path**: the `inbox-reply` YieldQueue kind, which wakes an idle session and is held after the session's own user interrupt.
- **Rationale:** This keeps both 023 delivery paths and all their proven behavior (T031, T034, T037) without a new flag on the wire. The receiver cannot be told the wrong path by a peer, because the decision uses local state only.
- **Alternatives:** A `fromOpener` flag on the wire duplicates local state, and a peer could set it wrong. One single path for all messages would lose either the "never closes a dialog" rule or the "held after user interrupt" rule.

## R4. Automatic answer and failure notice (FR-008, clarification B)

- **Decision:** The request path opens an `RpcPromptResults` ticket for every message from the opener, except a progress note. `Thread.openTickets` counts the open tickets. A count above 0 means that this session owes the opener an answer.
  1. **Turn counter.** The host counts finished turns in `#turn`. It adds 1 at each yielded `agent_end` that leaves the queue empty (`session.queuedMessageCount === 0`). This is the same test that `observe` uses to report waiting tickets (`rpc-prompt-results.ts:159`, `:163`). It also adds 1 in the `settledWithoutRun` hook (a message that ended with no run, `:121`), and after `abortOpen` on a conversation change (the cut turn is over, R7).
  2. **Turn key.** At `begin`, a ticket stores `turn = #turn`. That is the turn that the message enters or starts.
  3. **Replies.** When the agent calls `reply` without `progress` while `openTickets > 0`, the host adds `#turn` to `Thread.repliedTurns`.
  4. **Decision.** When a ticket reports, the host decreases `openTickets`. If `turn <= thread.decidedTurn`, that turn already got its decision, and the host drops the frame. Otherwise it decides now and sets `decidedTurn = turn`. An `error` or `aborted` outcome sends a `failure` with the error text. A `completed` outcome sends an `auto` with the answer text, unless `repliedTurns` has `turn`. Then the host deletes every key up to `turn` from `repliedTurns`.
- **Rationale:**
  - **One turn, one decision.** All tickets of one turn have the same key, whenever they report. Waiting tickets report at the yielded `agent_end` (`:164-166`), and a ticket that started its own run reports later at `settle()` (`:109-113`). Both kinds have the same key, so the second frame is dropped (SC-003, "none sent twice").
  - **Back-to-back turns.** A message that arrives after turn K yields, but before turn K's own-run ticket reports, gets key K+1. Turn K's answer is decided by its own frame, so it is not lost or merged (SC-003, "none lost").
  - **Retries.** A retry inside one turn starts a run again but yields only once, so its tickets keep one key. A counter of `agent_start` events would split that turn into two keys and send a duplicate.
  - **Tail runs.** A message that arrives as a run ends makes a tail run. Its `agent_end` is yielded with `isTerminal: false` (`agent-session.ts:1967`), and `observe` holds the waiting tickets until the queue is empty. The counter does not count that end, so the run and its tail are one turn with one key. A reply in either run then stops the `auto`, and a message that opens a ticket during the tail shares the key. A counter that counts every yielded end splits them into two keys. Then an `auto` goes out after a reply, and a second decision goes out for one turn.
  - **Replies to the opener.** The reply path opens no ticket, so a reply to the opener never gets an automatic message (clarification B).
  - **No new decision without a new turn.** Without the extra counts in step 1, a message that ended with no run, or a turn cut by `/new`, would leave the next message with a key that already got its decision. That message would then never get an answer.
  - **Known limits.** These cases are not handled.
    - A frame of an older turn that reports after a newer turn got its decision is dropped. For this, a whole newer turn must finish inside the settle gap, which is a few microtasks and one `setImmediate`.
    - `abortOpen` keeps a ticket that has not started a run for the run that it starts in the new conversation (`:143-146`). If the same thread also had a cut ticket, the kept ticket has a key that already got its decision.
    - With a tail, a ticket that started its own run stores run 0's outcome (`:167-168`). If it reports first, the opener gets run 0's text, and the tail's text is dropped. The turn still gets exactly one decision, and nobody waits.
    - `ponytail:` keep a set of decided keys instead of the maximum if either of the first two cases ever occurs. Hold a turn's decision until its last ticket reports if the third case matters.
- **Alternatives:**
  - **Decide when `openTickets` reaches 0.** Rejected. A message in the settle gap merges two turns into one decision.
  - **Decide once for each `setImmediate` tick.** Rejected. A ticket that started its own run and the tickets steered into that run can report in different ticks. The result is two decisions and a duplicate `auto`.
  - **Count `agent_start` events.** Rejected for the retry reason above.
  - **One answer for each ticket.** Rejected. It sends duplicates when two messages enter one turn.

## R5. Progress notes and loops (FR-005, FR-009)

- **Decision:** A `progress` message never opens a ticket, and it does not add the turn to `repliedTurns`. A turn that ends after only "on it" still sends the `auto` answer. `auto` and `failure` messages go from the non-opener to the opener, so they use the reply path and open no ticket.
- **Rationale:** With these rules, no automatic message can cause another one, and an opener is never left waiting. A session can send "on it" and then end its turn with no real answer. The opener still gets that turn's last text. One extra message is the cheaper failure.
- **Alternatives:** Counting progress as a reply, as IRC `sentSince` does, saves one message. But an opener then waits forever when the receiver stops after "on it", which breaks User Story 3.

## R6. Message text and escaping (FR-006, FR-007, FR-013)

- **Decision:** The request path shows `[thread t-… new from <name> (<address>)] <text>` for a first message, `[thread t-… reply from …]` for a later message from the opener, and `[thread t-… progress from …]` for a progress note from the opener (FR-006). A `new` or `reply` message has one footer line. A progress note has none. The reply path keeps the `<system-notice>` block with a header that names the thread and the kind. All peer text passes through `escapeHarnessTags` on both paths: text, names, addresses, and error text.
- **Footer for a message from the opener:** "Answer with session_inbox reply, thread "t-…", without progress. Use progress: true only for "on it". A progress note does not stop your last answer from going back." A progress note is a `reply` call, so the footer must say that only a reply without progress counts (FR-007, FR-008).
- **Footer for a message to the opener:** "Nothing goes back by itself. Reply only when they need an answer."
- **Rationale:** The 023 request content was not escaped (`host.ts:420`). That is the bug that the IRC review found. `escapeHarnessTags` already covers `irc` and every `system-*` tag. The bracket prefix is plain text, so no new tag name is needed. The `collab-prompt` card shows the same text to the user, so the user also sees the thread id.
- **Alternatives:** A new `<inbox>` tag would have to be added to the escape list and would show as raw tags in the collab card.

## R7. Conversation change (FR-011)

- **Decision:** Threads belong to the session window (clarification B). The existing session change callback runs `RpcPromptResults.abortOpen()` and then adds 1 to `#turn` (R4). It does not clear or replace `#threads`. The cut tickets report `aborted` through R4, so each opener that is still owed an answer gets one `failure` with outcome `aborted`. The threads stay open, and later messages in either direction land in the new conversation by the normal path rules (R3).
- **Rationale:** The user chose this in clarify question 2. A new conversation must not break work in a thread. The cut turn still owes the opener an answer, so the opener must not wait forever (FR-008, FR-011). The 023 reply path checked the sender's conversation id (`#acceptReply`). Threads have no such check, so a later message goes to the current conversation.
- **Alternatives:**
  - **End threads on `/new` (option A).** Rejected by the user.
  - **Keep threads, but only show old-thread messages as a card (option C).** Rejected by the user. It needs a third delivery rule.

## R8. Wire format

- **Decision:** `INBOX_VERSION` stays 1, and the wire format changes in place. The `reply` op is removed. Thread messages travel in `send` with `kind: "thread"`. Notifications keep `kind: "notification"`.
- **Rationale:** The repo rules forbid versioning for compatibility until it is required. The inbox is not released (spec Assumptions). Sessions from the older build must be restarted after the build.
- **Alternatives:** A bump to v2 keeps old and new sessions apart. That is compatibility versioning, which the repo rules forbid.

## R9. Tool surface

- **Decision:** `session_inbox` gets the op `reply` with `thread`, `text`, optional `progress`, and optional `delivery`. `send` loses `kind: "request"`. Its default is a thread message, and `kind: "notification"` stays. The local tool check refuses `reply` for an unknown thread before anything is sent (FR-012).
- **Rationale:** One tool keeps master mode unchanged (`ALLOWED_TOOLS` already lists `session_inbox`, FR-017). `delivery` on `reply` matters only when the opener replies, because only that message uses the request path.
- **Alternatives:** A second tool (`session_reply`) needs its own gate and its own master-mode entry.
