# Session inbox

The session inbox lets one live omp session send a message to another live omp session on the same machine. The agent in the sender session uses the hidden `session_inbox` tool. A request gets one reply, which arrives in the sender by itself.

## Which sessions have an inbox

Every top-level interactive TUI session publishes an inbox. Subagents, RPC mode, ACP mode, and print mode have no inbox.

- The address of a session is `ZMX_SESSION`. Outside zmx, it is `omp-<pid>`.
- The parent link comes from `OMP_SPAWN_PARENT`. A session started with `/spawn` or `spawn_session` knows its parent.
- The endpoint is private. The directory `~/.omp/run/session-inbox` has mode 0700. Each `<entryId>.json` metadata file has mode 0600. Each entry has its own bearer token, and omp compares it in constant time.

## Setting

`inbox.enabled` (boolean, default `true`, group "Session Inbox") controls the inbox. The change applies at once. Off withdraws the endpoint and deactivates the tool. On publishes the endpoint again and activates the tool.

## The tool

The `session_inbox` tool is active while the inbox runs. It has three operations (`op`):

| `op` | Fields | Result |
| --- | --- | --- |
| `list` | none | One line for each other live session, newest first: address, `"name"`, cwd, `branch=`, `busy` or `idle`, and `started-by-you` or `started-you` for a parent link. |
| `send` | `to`, `text`, `kind`, `delivery`, `level` | Sends a request or a notification. |
| `interrupt` | `to` | Stops the current turn of the target. |

`send` fields:

- `kind`: `request` (default) or `notification`.
- `delivery`: `steer` (default) or `after_turn`. It applies to a request only.
- `level`: `nit` (default), `concern`, or `blocker`. It applies to a notification only.

`send` returns one of these results:

- `Delivered to …`: the target was idle and started a turn for the request.
- `Queued in …`: the target was busy. A `steer` request enters the running turn at its next step. An `after_turn` request waits for the turn to end.
- `Not delivered to …: <reason>`: the target refused it. The reason `cost_cap` means that the target is at its session cost cap. The target checks the cap before delivery.
- `No answer from … yet; the message may still arrive`: the target did not answer in 30 s. It can be compacting or switching sessions.

## Requests

A request enters the target as agent input `[from <name> (<address>)] <text>`. The chat shows it as a collab-prompt card.

- `steer` puts the request into the running turn at the next step. An idle target starts a turn.
- `after_turn` waits for the current turn to end.

The request is agent input, not user input. Thus it never closes an open ask or approval dialog of the target user, and it never stops a running tool.

### Replies

When the turn that carried the request ends, the target sends its last visible assistant answer back one time. omp cuts the answer at 16 KiB on a UTF-8 boundary.

The reply arrives in the sender as a `<system-notice>` message: `Reply from <address> ("<name>") to your request <id>: completed|aborted|error`. Rules:

1. An idle sender starts a turn for the reply.
2. After the sender user interrupts the sender, a reply joins the context but does not start a turn.
3. The sender accepts a reply only for a request ID that it sent from the same conversation.
4. `/new` or a resume in the sender drops the pending replies.
5. `/new` in the target answers its open requests with `aborted`.

## Notifications

A notification gets no reply. omp routes it like an advisor note: `<advisory advisor="<name> (<address>)" severity=…>`.

- A `nit` to an idle target is only shown. It does not start a turn.
- A `concern` or `blocker` steers the current turn, or starts a turn.
- In a plan-mode target, or after an interrupt that the target user has not followed with input, a `concern` or `blocker` is only shown. The result then says `(shown, no turn started)`.
- Like an advisor note, a `concern` or `blocker` steer can abort tools that are running.

## Interrupt

`interrupt` stops the current turn of the target, the same as Esc from its user. The target shows `<name> interrupted`. An idle target answers `idle`.

## Limits

- Request text: at most 256 KiB (UTF-8 bytes).
- Reply text: cut at 16 KiB.

## Master mode

`session_inbox` is on the master-mode allowlist. The master can steer a child that it spawned with a request. The reply of the child arrives in the master by itself. See [Master mode](./master-mode.md).

## Known gaps

- Plan mode does not limit the tool.
- The approval mode of the target applies to the tools that a request causes. An approval dialog waits for the target user.
- Two agents can loop when they send requests to each other. Only the prompt rule "never send just to acknowledge" stops this.
