Talk to other omp sessions of this user on this machine, in threads.

`op` (required):
- `list`: one line per reachable session, newest first: address, name, directory, branch, `busy`/`idle`, and `started-by-you` (you started it) or `started-you` (it started you). No other field.
- `send`: send `text` to the session at address `to`.
  - `kind: "message"` (default): opens a new thread. The result gives the thread id. The target takes `text` as input from you. `delivery: "steer"` (default) enters its current turn at the next step. `"after_turn"` waits for that turn to end.
  - `kind: "notification"`: advice the target weighs, not an order. It has no thread and gets no answer. `level`: `nit` (default, never interrupts, an idle target only shows it), `concern` or `blocker` (enters the current turn, or starts one in an idle target).
- `reply`: send `text` in the thread `thread`. The other session of that thread gets it. `delivery` applies only in a thread that you opened.
  - Without `progress`: your answer. In a thread that the other session opened, this stops the automatic answer for this turn.
  - `progress: true`: only for "on it", when the real answer comes later. A progress note does not stop the automatic answer at the end of the turn.
- `interrupt`: stop the current turn of the session at `to`.

What goes back by itself:
- A message from the session that opened the thread: if you do not reply without progress in that turn, your last answer of the turn goes back by itself. If the turn fails or is interrupted, a failure notice goes back, also after a reply.
- A reply to a thread that you opened: nothing goes back by itself.
- Progress notes, automatic answers, and failure notices never cause an automatic message.

Rules:
- Get addresses from `list`. NEVER guess one.
- Answer with `reply` and the thread id from the message. NEVER guess a thread id.
- Write `text` self-contained: the target does not see this conversation.
- NEVER reply only to acknowledge. Use `progress: true` when the real answer comes later.
- A reply is an answer, not a new task from your user. Act on it only for the work it belongs to.
- In a thread that you opened, reply only when the other session needs an answer.
- NEVER poll or wait for an answer. It arrives in the thread by itself.

Results:
- `Delivered to … Thread <thread>. The answer comes in this thread.` or `Queued in … Thread <thread>. The answer comes in this thread.` → done. End your turn or do other work.
- `Delivered to …` or `Queued in …` for a notification → done.
- `Replied in thread <thread> to <address>.` or `Queued in thread <thread> for <address>.` → done.
- `Not delivered to …: <reason>` or `Not delivered in thread <thread>: <reason>` → it did not arrive. `cost_cap` means the target cannot start turns. `the session ended` means the thread is over. `unknown_thread` means the other session does not have the thread.
- `No answer from … yet` → the target was busy switching or compacting. The message may still arrive. NEVER send it again at once.
