# Contract: `session_inbox` tool

**Availability**
- The tool is hidden and active by default.
- It exists only when `session.tuiTranscript === true` and `inbox.enabled` is true. That means only a top-level interactive TUI session has it, so subagents, RPC, ACP and print mode do not.
- Master mode allows it. Plan mode does not limit it.

**Class fields:** `approval: "read"`, `strict: true`, `intent: "omit"`.

## Schema

```ts
{
  op: "list" | "send" | "interrupt",
  "to?": string,                               // address; required for send and interrupt
  "text?": string,                             // required for send
  "kind?": "request" | "notification",        // send only; default "request"
  "delivery?": "steer" | "after_turn",        // request only; default "steer"
  "level?": "nit" | "concern" | "blocker",    // notification only; default "nit"
}
```

`execute` rejects any field combination outside these comments with a `ToolError` before it sends anything.

## Results (text for the model)

### `list`

One line for each reachable session. The newest session comes first, and the caller is never listed.

```
cci-omp-upload-k3x9q1  "upload retry"  ~/w/api-upload  branch=feat/upload-retry  busy  started-by-you
cci-omp-root-a1b2c3    "api master"    ~/w/api         branch=main               idle  started-you
omp-48121              "frontend"      ~/w/web         branch=main               idle
```

When no other session is reachable, the result is `No other sessions are reachable.`

### `send`

- `Delivered to <address> (<conversationId>). Its reply arrives by itself when its turn ends.`
  - This is the text for a request.
  - For a notification, the last sentence is left out.
  - For a notification that was only shown (`shown`), `(shown, no turn started)` is added.
- `Queued in <address> …`. The rest is the same as for "Delivered".
- `Not delivered to <address>: <reason>.`
- A `ToolError` for:
  - an unknown address: `No reachable session <address>. Use op "list".`
  - an ambiguous address, with the list of entries.
  - a send to the caller's own address.
  - a text over 256 KiB.

### `interrupt`

The result is `Interrupted <address>.` or `<address> was idle; nothing to interrupt.`

## Reply delivered later

The sender gets the reply as a `custom` message (`attribution: "agent"`). The message is wrapped in `<system-notice>`, like async job results:

```
<system-notice>
Reply from cci-omp-upload-k3x9q1 ("upload retry") to your request <id>: completed
<answer text, harness tags escaped>
[cut at 16 KiB]   ← only when truncated
</system-notice>
```

## Incoming message, as the target model sees it

- **Request.** The text appears as a steering user message: `[from <name> (<address>)] <text>`. The transcript card shows `«name» ›`.
- **Notification.** The text appears as an advisory: `<advisory advisor="<name> (<address>)" severity="<level>" guidance="weigh, don't blindly obey">…</advisory>`.
