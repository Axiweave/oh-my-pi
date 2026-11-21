# Contract: Session Inbox IPC, with threads

This contract changes `specs/023-session-inbox/contracts/inbox-ipc.md`. The transport, the discovery, the envelopes, the order of checks, `snapshot`, and `interrupt` do not change. Only the differences are listed here.

**Version:** `v: 1` stays. The format changes in place, with no version bump (research R8).

## Removed

- The `reply` op. A request answer is now a thread message (below).
- The error code `unknown_id`.
- `kind: "request"`.

## `send` with `kind: "thread"`

**Request**

```json
{
  "message": {
    "id": "<random>",
    "from": { "address": "cci-omp-api-k3x9q1", "name": "api master", "entryId": "<sender entry id>" },
    "kind": "thread",
    "thread": "t-3f2a9c1b",
    "type": "message",
    "first": true,
    "text": "which test runner do you use?",
    "delivery": "steer"
  }
}
```

The field rules are in [data-model.md](../data-model.md) under "Thread message".

**Response**

```json
{ "result": { "status": "delivered" | "queued", "conversationId": "...", "thread": "t-3f2a9c1b" } }
{ "result": { "status": "not_delivered", "reason": "unknown_thread" | "thread_conflict" | "cost_cap" | "aborted" | "..." } }
```

**Receiver behavior**
1. The receiver waits while `session.isSessionTransitioning` is true. This is the same as 023.
2. It checks the thread with its own table (data-model "Validation on the receiver"). A failed check gives `not_delivered` with the reason. Nothing else changes in that case.
3. **Request path.** This path is for a thread that the receiver did not open, which includes a first message. The receiver calls `promptCustomMessage` with `customType: "collab-prompt"`, `attribution: "agent"`, and `streamingBehavior` `steer` or `followUp`. The content is the escaped text with the thread prefix and the footer (research R6). A `type: "message"` opens an answer ticket before the prompt. A `type: "progress"` opens none. The response is written on `onPromptQueued` or `onPromptAdmitted`, the same as 023.
4. **Reply path.** This path is for a thread that the receiver opened. The receiver calls `session.queueInboxReply(...)`, which adds a YieldQueue `inbox-reply` entry. The response is `delivered`, with no wait for the injection. This is the same as the 023 reply.

**Answer tickets** (the receiver of messages from the opener)
- The receiver decides once for each turn of each thread, at the first ticket report of that turn (research R4). It sends one message to the opener's entry (`readInboxEntry(peer.entryId)`): `type: "failure"` for `aborted` or `error`, or `type: "auto"` for `completed` when this session did not reply in that turn. Later reports of the same turn send nothing.
- The receiver makes one attempt. If the opener is gone, gives `unknown_thread`, or does not answer, the receiver logs it at debug level and drops the message.

## `send` with `kind: "notification"`

This is the same as 023. It has no thread fields.

## Error codes (changes)

| Code | Meaning |
|---|---|
| `unsupported_protocol` | `v` is not 1. This is unchanged. |
| `invalid` | A field combination is not allowed, for example `first` with `type: "progress"`, or `outcome` on a `message`. An `auto` or `failure` in a thread that the receiver did not open is also `invalid`. The response is `{ ok: false, error: "invalid" }`. |
