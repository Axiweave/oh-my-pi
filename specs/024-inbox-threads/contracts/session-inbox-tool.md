# Contract: `session_inbox` tool, with threads

The availability, the class fields, `list`, and `interrupt` do not change from `specs/023-session-inbox/contracts/session-inbox-tool.md`. Master mode already allows the tool, so `reply` needs no new allowance (FR-017).

## Schema

```ts
{
  op: "list" | "send" | "reply" | "interrupt",
  "to?": string,                               // address; required for send and interrupt
  "thread?": string,                           // required for reply; refused on other ops
  "text?": string,                             // required for send and reply
  "kind?": "message" | "notification",        // send only; default "message"
  "progress?": boolean,                        // reply only; default false
  "delivery?": "steer" | "after_turn",        // message, or reply in a thread you opened; default "steer"
  "level?": "nit" | "concern" | "blocker",    // notification only; default "nit"
}
```

`execute` rejects any field combination outside these comments with a `ToolError` before it sends anything.

## Results (text for the model)

### `send`, `kind: "message"`

- `Delivered to <address> (<conversationId>). Thread <thread>. The answer comes in this thread.`
- `Queued in <address> (<conversationId>). Thread <thread>. The answer comes in this thread.`
- `Not delivered to <address>: <reason>.` The opener drops the thread.

### `send`, `kind: "notification"`

This is the same as 023, with no thread.

### `reply`

- `Replied in thread <thread> to <address>.` (or `Queued in thread <thread> for <address>.`)
- `Not delivered in thread <thread>: <reason>.` The reasons are `the session ended`, and `unknown_thread`, which means the other session does not have the thread. Threads stay open across `/new` (spec FR-011), so `unknown_thread` comes only from a peer that does not know the id.
- A `ToolError` for:
  - a thread that this session does not have: `Unknown thread <thread>.` Nothing is sent (FR-012).
  - `to`, `kind`, or `level` on `reply`.
  - a text over 256 KiB.

## Incoming thread messages, as the model sees them

**A message from the opener** (request path, `collab-prompt` card):

```
[thread t-3f2a9c1b new from api master (cci-omp-api-k3x9q1)] which test runner do you use?
Answer with session_inbox reply, thread "t-3f2a9c1b", without progress. Use progress: true only for "on it". A progress note does not stop your last answer from going back.
```

The word after the thread id shows the kind (FR-006): `new` for a first message, `reply` for a later message from the opener, and `progress` for a progress note from the opener. A progress note has no footer.

**A message to the opener** (reply path, `<system-notice>`):

```
<system-notice>
Thread t-3f2a9c1b, reply from cci-omp-upload-k3x9q1 ("upload retry"):
<text>
Nothing goes back by itself. Reply only when they need an answer.
</system-notice>
```

The word `reply` in the header changes for the other kinds:
- `progress (the answer follows later)`
- `automatic answer (no final reply)`, with `[cut at 16 KiB]` when the text was cut
- `failure: aborted` or `failure: error: <error text>`

All peer text is escaped with `escapeHarnessTags` (research R6).

## Tool description rules (FR-018)

The description in `prompts/tools/session-inbox.md` must say these things:
- `send` opens a thread, and the result gives its id.
- Answer with `reply` and the thread id. NEVER guess a thread id.
- Use `progress: true` when the real answer comes later. A progress note does not stop the automatic answer at the end of the turn.
- NEVER reply only to acknowledge.
- If the answer to the opener is not sent in that turn, the last answer goes back by itself. Nothing goes back for replies to the opener.
- NEVER poll or wait for an answer.
