# Contract: Session Inbox IPC

**Transport:** `@oh-my-pi/pi-natives` `IpcServer` / `IpcConnection`, `framing: "lines"`, `maxFrameBytes: 2 MiB` (research.md R10). The client sends one JSON request line, the server sends one JSON response line, and the server then ends the connection. Connect times out after 3 s.

**Discovery:** read `<getSessionInboxDir()>/*.json`. The fields are in [data-model.md](../data-model.md) under "Inbox entry".

**Version:** `v: 1`. The server answers any other value with `unsupported_protocol`.

## Request envelope

```json
{ "v": 1, "token": "<entry token>", "op": "snapshot" | "send" | "interrupt" | "reply", ... }
```

The server checks the request in this order:
1. The JSON must parse to an object. Otherwise the answer is `malformed_request`.
2. `v` must be 1. Otherwise the answer is `unsupported_protocol`.
3. The token must match, compared with `timingSafeEqual`. Otherwise the answer is `authentication_failed`.
4. `op` must be known. Otherwise the answer is `invalid_operation`.

## Response envelope

```json
{ "ok": true, "v": 1, ... }
{ "ok": false, "v": 1, "error": "<code>", "detail"?: "<text>" }
```

## `snapshot`

- **Request:** `{}`
- **Response:** `{ "snapshot": { address, name, parent, pid, createdAt, cwd, branch, busy, conversationId } }`

## `send`

**Request**

```json
{
  "message": {
    "id": "<random>",
    "from": { "address": "cci-omp-api-k3x9q1", "name": "api master", "entryId": "<sender entry id>" },
    "kind": "request",
    "text": "also cover the retry case",
    "delivery": "steer"
  }
}
```

The rules for `kind`, `delivery` and `level` are in [data-model.md](../data-model.md) under "Inbox message".

**Response**

```json
{ "result": { "status": "delivered" | "queued" | "not_delivered", "reason"?: "...", "conversationId": "...", "shown"?: true } }
```

**Target behavior**
1. The target waits while `session.isSessionTransitioning` is true.
2. A request goes through `promptCustomMessage`, with `customType` `collab-prompt`, `attribution` `agent`, and `streamingBehavior` `steer` or `followUp`. When `kind = request`, the target opens a reply ticket first.
3. A notification goes through `session.routeInboxNote(fromLabel, text, level)`. That call uses the advisor channel rules.
4. The response is written when the target knows the status. For a request, that is the `onPromptAdmitted` or `onPromptQueued` callback, or a `false` return. The target never waits for the end of the run.

## `interrupt`

- **Request:** `{ "from": { "address", "name" } }`
- **Response:** `{ "result": "interrupted" | "idle" }`
- **Target behavior:** when the target is busy, it calls `session.abort({ reason: USER_INTERRUPT_LABEL })` and then `emitNotice("info", "<name> interrupted", "inbox")`.

## `reply`

The target sends this request to the sender's endpoint. It finds the endpoint by reading the registry entry whose `entryId` equals the `from.entryId` of the request. It does not look up by address, so two live sessions with one address do not change where the reply goes. When no entry has that `entryId`, the sender is gone (see **Failure**).

**Request**

```json
{
  "reply": {
    "id": "<request message id>",
    "from": { "address", "name" },
    "outcome": "completed" | "aborted" | "error",
    "error"?: "<text>",
    "text": "<≤16 KiB>",
    "truncated"?: true
  }
}
```

**Response**
- `{ "result": "accepted" }`
- `{ "ok": false, "error": "unknown_id" }`. The sender answers this when the ID is not in its pending map. The sender adds the ID to the map before it sends the request, so a fast reply always finds it.

**Sender behavior:** the sender calls `session.queueInboxReply(reply)`. This adds a YieldQueue `"inbox-reply"` entry, which starts a turn when the sender is idle. After the sender's own user interrupt, the YieldQueue holds back background results. While it does, the reply joins the conversation without a turn (spec FR-015).

**Failure:** the target makes one attempt. If the sender is gone or does not answer, the target drops the reply and logs it at debug level (User Story 5, scenario 5).

## Error codes

| Code | Meaning |
|---|---|
| `malformed_request` | The request is not a JSON object. |
| `unsupported_protocol` | `v` is not 1. |
| `authentication_failed` | The token does not match. |
| `invalid_operation` | `op` is unknown. |
| `invalid` | A field combination is not allowed, for example `level` on a request. |
| `too_large` | The text is over 256 KiB. `detail` gives the limit. |
| `unknown_id` | A reply came for an ID that is not pending. |
| `inbox_off` | The host is stopping. |
