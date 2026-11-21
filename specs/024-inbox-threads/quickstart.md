# Quickstart: validate Inbox Threads

## Prerequisites

1. Build the local source from the repo root: `PATH="$HOME/.cargo/bin:$PATH" bun run setup`.
2. Make sure `zmx` is on `PATH` for section 3.
3. Restart every open omp session after the build. A session from the older build reads the old message format and refuses thread messages as `invalid` (research R8).

## 1. Automated checks

Run these commands from `packages/coding-agent`:

```sh
bun test test/inbox/ test/session/inbox-reply.test.ts
bun test test/master-mode-guard.test.ts test/settings-gated-tools-live.test.ts
```

These outcomes must hold. The terms are in [data-model.md](data-model.md) and [contracts/](contracts/).

- **Explicit reply:** a target that replies with the tool in its turn sends exactly one message back, and no `auto` follows.
- **Fallback:** a target that ends its turn with no reply sends one `auto` with the last answer. A failed or interrupted turn sends one `failure`, even after a reply.
- **Clarification B:** a reply to the opener never causes an `auto` or a `failure`, whatever its turn does.
- **One decision for each thread for each turn:** N messages from the opener in one turn (fixed printed seed, N from 1 to 10) give exactly one `auto` or `failure`. A message that arrives right after a turn ends starts its own turn and gets its own decision. The earlier turn's answer is not lost. A run and its tail run are one turn, so a reply in either one stops the `auto`.
- **100 turns (SC-003):** 100 seeded turns with mixed outcomes each get exactly the expected `auto` or `failure`, and none is lost or sent twice. 100 turns on replies to the opener send nothing automatic.
- **Timing:** a reply shows in an idle opener in under 1 s (SC-004). An `auto` arrives in under 2 s after the turn ends.
- **Order:** 10 messages back and forth in one thread arrive in send order on both sides.
- **Progress:** a progress note opens no ticket and does not count as a reply. A turn that ends after only a progress note still sends one `auto`. A progress note never causes an automatic message in return.
- **Thread checks:** an unknown thread gives `unknown_thread`. A first message with a known id gives `thread_conflict`. A message from the wrong entry for a known thread gives `unknown_thread`. The tool refuses `reply` for a thread that it does not know, and sends nothing.
- **Conversation change (clarification B):** `/new` in the receiver sends one `failure: aborted` for each thread whose owed turn it cut. The threads stay open. A later message in either direction arrives in the new conversation, in the same thread.
- **Escaping:** crafted `</system-notice>`, `<system-reminder>`, and `<irc>` tags in the text, name, and error of every message kind reach the model escaped.
- **Unchanged:** notifications, `list`, `interrupt`, the dialog rule (T031), and the editor rule (T037) still pass.

Then run the repo checks:

```sh
bun check
omp --smoke-test
```

## 2. Two sessions, no zmx link

1. Start session A in one terminal: `omp`.
2. Start session B in a second terminal: `omp`.
3. In A, type `ask B with session_inbox: which directory are you in? Wait for its answer in the thread.`
   - **Expected in A:** the result says `Delivered … Thread t-…`, and A's turn ends.
   - **Expected in B:** the card shows `[thread t-… new from …]` and the footer line. B answers with `session_inbox reply`.
   - **Expected in A:** a `<system-notice>` with `Thread t-…, reply from …` arrives and starts a turn. No `automatic answer` follows.
4. In B, type `reply in that thread: done`.
   - **Expected in A:** the reply arrives. When A's turn on it ends, B gets nothing more.
5. In A, type `send B "say only the word PONG in plain text, do not use any tool"`.
   - **Expected in A:** an `automatic answer (no final reply)` with `PONG`.
6. In A, run `/new`. Then in B, type `reply in the first thread: still there?`.
   - **Expected in A:** the reply arrives in A's new conversation with the same thread id.
7. Quit A. Then in B, type `reply in the first thread again`.
   - **Expected in B:** `Not delivered in thread t-…: the session ended.`

## 3. Master and child (zmx)

1. Run `zmx attach smoke-master omp --master`, and detach with `ctrl+\`.
2. Run `zmx send smoke-master $'start a child session that waits for instructions\r'`.
3. Run `zmx send smoke-master $'ask the child for its working directory, then for its git branch, in the same thread\r'`.
4. Run `zmx history smoke-master | tail -60`.
   - **Expected:** both questions and both answers use one thread id, and they arrive in order.

**Cleanup:** run `zmx kill smoke-master <child>`.
