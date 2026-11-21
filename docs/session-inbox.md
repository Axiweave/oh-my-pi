# Session inbox

The session inbox lets one live omp session send a message to another live omp session on the same machine. The agent in the sender session uses the hidden `session_inbox` tool. A message opens a thread. Both sessions can then reply in that thread by its thread id.

## Which sessions have an inbox

Every top-level interactive TUI session publishes an inbox. Subagents, RPC mode, ACP mode, and print mode have no inbox.

- The address of a session is `ZMX_SESSION`. Outside zmx, it is `omp-<pid>`.
- The parent link comes from `OMP_SPAWN_PARENT`. A session started with `/spawn` or `spawn_session` knows its parent.
- The endpoint is private. The directory `~/.omp/run/session-inbox` has mode 0700. Each `<entryId>.json` metadata file has mode 0600. Each entry has its own bearer token, and omp compares it in constant time.

## Setting

`inbox.enabled` (boolean, default `true`, group "Session Inbox") controls the inbox. The change applies at once. Off withdraws the endpoint and deactivates the tool. On publishes the endpoint again and activates the tool.

## The tool

The `session_inbox` tool is active while the inbox runs. It has four operations (`op`):

| `op` | Fields | Result |
| --- | --- | --- |
| `list` | none | One line for each other live session, newest first: address, `"name"`, cwd, `branch=`, `busy` or `idle`, and `started-by-you` or `started-you` for a parent link. |
| `send` | `to`, `text`, `kind`, `delivery`, `level` | Sends a message, which opens a thread, or a notification. |
| `reply` | `thread`, `text`, `progress`, `delivery` | Sends a message in a thread. |
| `interrupt` | `to` | Stops the current turn of the target. |

`send` fields:

- `kind`: `message` (default) or `notification`.
- `delivery`: `steer` (default) or `after_turn`. It applies to a message only.
- `level`: `nit` (default), `concern`, or `blocker`. It applies to a notification only.

`reply` fields:

- `thread`: the thread id from the send result or from an incoming message.
- `progress`: `false` (default) or `true`. Use `true` only for "on it", when the real answer comes later.
- `delivery`: `steer` (default) or `after_turn`. It matters only in a thread that this session opened.

The tool refuses `to`, `kind`, or `level` on `reply`, and `thread` on the other operations. It refuses a reply to a thread that this session does not have with `Unknown thread <thread>.` and sends nothing.

`send` returns one of these results:

- `Delivered to <address> (<conversationId>). Thread <thread>. The answer comes in this thread.`: the target was idle and started a turn for the message.
- `Queued in <address> (<conversationId>). Thread <thread>. The answer comes in this thread.`: the target was busy. A `steer` message enters the running turn at its next step. An `after_turn` message waits for the turn to end.
- `Not delivered to <address>: <reason>.`: the target refused it, and the sender drops the thread. The reason `cost_cap` means that the target is at its session cost cap. The target checks the cap before delivery.
- `No answer from … yet; the message may still arrive`: the target did not answer in 30 s. It can be compacting or switching sessions.

A notification gets the same results without the thread part.

`reply` returns one of these results:

- `Replied in thread <thread> to <address>.` or `Queued in thread <thread> for <address>.`
- `Not delivered in thread <thread>: <reason>.`: the reason `the session ended` means that the other session ended. The reason `unknown_thread` means that the other session does not have the thread.

## Threads

A thread belongs to exactly two sessions: the opener, which sent the first message, and the other session. The thread id has the form `t-` and 8 hex digits. Either session can reply any number of times, in any turn. The receiver gets the messages of one thread in send order.

Each thread message has one of these types:

- `message`: a first message, or a reply without progress.
- `progress`: a reply with `progress: true`. It says that the real answer follows later.
- `auto`: an automatic answer from omp (see below).
- `failure`: a failure notice from omp, with `aborted` or `error: <error text>`.

### Delivery paths

The receiver selects the path with its own thread table, not with a field from the peer.

- **A message from the opener** (a first message, or a later message in a thread that the receiver did not open) enters the receiver as agent input with the `steer` or `after_turn` delivery. The chat shows it as a collab-prompt card: `[thread t-… new|reply|progress from <name> (<address>)] <text>`. A `new` or `reply` message ends with a line that tells the agent to answer with `reply` and the thread id, without progress. It is agent input, not user input. Thus it never closes an open ask or approval dialog of the target user, and it never stops a running tool.
- **A message to the opener** (in a thread that the receiver opened) arrives as a `<system-notice>` block: `Thread t-…, reply|progress|automatic answer|failure from <address> ("<name>"):`. The block ends with the line "Nothing goes back by itself. Reply only when they need an answer." An idle opener starts a turn for it. After the opener's own user interrupts it, the message joins the context but does not start a turn.

omp escapes all peer text with `escapeHarnessTags` on both paths: text, names, addresses, and error text. Peer text thus cannot form a system block.

### Automatic answer and failure notice

Only messages from the opener get automatic messages. When the turn that such a message started or entered ends, omp checks the thread:

1. The turn completed and this session sent no reply without progress in that thread during the turn: omp sends the last visible answer of the turn as `auto`, one time. omp cuts the answer at 16 KiB on a UTF-8 boundary and marks it `[cut at 16 KiB]`.
2. The turn completed and this session replied without progress in that thread: omp sends nothing.
3. The turn failed or was interrupted: omp sends a `failure` notice with the error text, if there is one. omp sends it also when the session already replied in that turn.

A progress note does not count as a reply, so the opener never waits after "on it". All messages of one thread in one turn get one decision.

A message to the opener never gets an automatic answer or a failure notice. Progress notes, automatic answers, and failure notices never cause an automatic message.

### Threads across a new conversation

Threads belong to the session window, not to one conversation. `/new`, a resume, or a switch to another conversation does not end a thread. Later messages in either direction arrive in the new conversation. When the change cuts a turn that still owes the opener an answer, the opener gets a `failure: aborted` notice in that thread, and the thread stays open.

A thread ends only when one of its two sessions ends. Threads live only in memory. An omp restart loses them.

### Removed request path

The 023 request path is removed. `send` has no `kind: "request"`, and there is no reply that omp sends for each request. The thread rules above replace it.

## Notifications

A notification is not part of a thread and gets no answer. omp routes it like an advisor note: `<advisory advisor="<name> (<address>)" severity=…>`.

- A `nit` to an idle target is only shown. It does not start a turn.
- A `concern` or `blocker` steers the current turn, or starts a turn.
- In a plan-mode target, or after an interrupt that the target user has not followed with input, a `concern` or `blocker` is only shown. The result then says `(shown, no turn started)`.
- Like an advisor note, a `concern` or `blocker` steer can abort tools that are running.

## Interrupt

`interrupt` stops the current turn of the target, the same as Esc from its user. The target shows `<name> interrupted`. An idle target answers `idle`.

## Limits

- Message and reply text: at most 256 KiB (UTF-8 bytes).
- Automatic answer: cut at 16 KiB.

## Master mode

`session_inbox` is on the master-mode allowlist, with all its operations. The master can steer a child that it spawned with a message. The child answers in the thread. When the child does not reply, its last answer arrives in the master by itself. See [Master mode](./master-mode.md).

## Known gaps

- Plan mode does not limit the tool.
- The approval mode of the target applies to the tools that a message causes. An approval dialog waits for the target user.
- Two agents can loop when they reply to each other. omp does not stop a loop that the agents choose. Only automatic messages never cause automatic messages. The user stops a loop with an interrupt or with the session cost cap.
