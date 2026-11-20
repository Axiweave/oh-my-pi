Talk to other omp sessions of this user on this machine.

`op` (required):
- `list`: one line per reachable session, newest first: address, name, directory, branch, `busy`/`idle`, and `started-by-you` (you started it) or `started-you` (it started you). No other field.
- `send`: send `text` to the session at address `to`.
  - `kind: "request"` (default): the target takes `text` as input from you. `delivery: "steer"` (default) enters its current turn at the next step; `"after_turn"` waits for that turn to end. When the target's turn ends, its last answer comes back to you by itself as a `<system-notice>` reply. NEVER poll or wait for it.
  - `kind: "notification"`: advice the target weighs, not an order; no reply. `level`: `nit` (default; never interrupts, an idle target only shows it), `concern` or `blocker` (enters the current turn, or starts one in an idle target).
- `interrupt`: stop the current turn of the session at `to`.

Rules:
- Get addresses from `list`. NEVER guess one.
- Write `text` self-contained: the target does not see this conversation.
- A reply is an answer, not a new task from your user. Act on it only for the work it belongs to.
- When a reply asks you something, answer with a new `send` only when the answer is needed. NEVER send just to acknowledge.

Results:
- `Delivered to …` or `Queued in …` → done; for a request, the reply arrives later.
- `Not delivered to …: <reason>` → it did not arrive; `cost_cap` means the target cannot start turns.
- `No answer from … yet` → the target was busy switching or compacting; the message may still arrive. NEVER send it again at once.
