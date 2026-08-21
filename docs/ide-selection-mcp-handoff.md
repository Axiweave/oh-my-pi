# IDE Selection via MCP — Handoff

How omp's MCP stack carries a user's IDE text selection into the next prompt turn.
Reference implementation: Claude Code (`/Users/fuyu0425/agents/claude-code`). omp reuses
the already-installed `anthropic.claude-code` extension as the MCP server — no extension work.

## 1. How MCP works in omp

All paths under `packages/coding-agent/src/`.

### Config types (`mcp/types.ts:135`)

`MCPServerConfig = MCPStdioServerConfig | MCPHttpServerConfig | MCPSseServerConfig`.
Three transports only: `stdio`, `http` (Streamable HTTP), `sse`. **No WebSocket transport.**
The VS Code extension speaks SSE (`http://127.0.0.1:<port>/sse`), so that gap does not block this port.

### Capability shape (`capability/mcp.ts:15`)

`MCPServer` is the canonical server config all discovery providers emit:
`name`, `transport?: "stdio" | "sse" | "http"`, `url?`, `command?`, `args?`, `headers?`, `timeout?`, `enabled?`, `_source`.
Registered under `mcpCapability.id === "mcps"` (`capability/mcp.ts:94`).

### Discovery providers (`discovery/`)

Each provider calls `registerProvider<MCPServer>(mcpCapability.id, { id, displayName, description, priority, load(ctx) })`
and `load` returns `{ items, warnings }`. Providers self-register on import; `discovery/index.ts`
imports them all (`./vscode`, `./cursor`, `./windsurf`, …). A new `discovery/ide.ts` would follow the same shape —
read `discovery/vscode.ts:22-41` for the minimal template.

### Connect flow (`mcp/client.ts`)

- `createTransport(config)` (`client.ts:73`) switches on `config.type` → stdio/http/sse.
- `connectToServer(name, config, { onNotification, onRequest })` (`client.ts:137`):
  builds the transport, then sets `transport.onNotification = options.onNotification` (`client.ts:151-153`).
- `initializeConnection` (`client.ts:91`): `initialize` request → `setProtocolVersion` →
  `notify("notifications/initialized")` → optional `onInitialized` (opens the GET SSE stream after).

### Notification dispatch (`mcp/manager.ts`)

- SSE transport fires `onNotification(method, params)` for every id-less JSON-RPC message
  (`transports/sse.ts:193-195`).
- `MCPManager.#handleServerNotification(serverName, method, params)` (`manager.ts:705`):
  switch on method — `tools/list_changed`, `resources/list_changed`, `resources/updated`,
  `prompts/list_changed` trigger internal refresh; everything else falls through. Then it either
  buffers (`#pendingNotifications`, cap 100) or fans out to `#notificationListeners`.
- `addNotificationListener(listener: (serverName, method, params) => void): () => void`
  (`manager.ts:268`) — returns an unsubscribe fn; first listener drains the startup buffer.
  This is the wiring point for `selection_changed`: register a listener keyed on `serverName === "ide"`.

### Context injection precedent (`session/date-cwd-reminder.ts`)

`withDateCwdReminder(context, date, cwd)` (`date-cwd-reminder.ts:71`) prepends a rendered
`<system-reminder>` to the **first user message** of a provider `Context`, keeping the system prompt
byte-stable for tool-schema prefix caching (#7404). Applied at `sdk.ts:3161` and `sdk.ts:3807`.
A selection reminder rides the same path: new `withIdeSelectionReminder(context, selection)` applied
at the same two call sites, right next to `withDateCwdReminder`.

## 2. IDE interaction

### Lockfiles

The extension writes lockfiles to `~/.claude/ide/*.json`. Fields:

```
workspaceFolders: string[]   port: number   pid?: number   ideName?: string
transport: 'ws' | 'sse'      runningInWindows?: boolean   authToken?: string
```

Endpoint for SSE: `http://127.0.0.1:<port>/sse`. WS entries use `ws://host:<port>` — unsupported
in omp today; skip with a debug log. Leak: `src/utils/ide.ts:294-808` (detection/validation),
`src/services/mcp/client.ts:678-708` (connect, note: "IDE servers don't need authentication").

### `selection_changed` notification (server → client)

Method: `selection_changed`. Params:

```ts
{ selection: { start: { line: number, character: number }, end: { line: number, character: number } } | null,
  text?: string, filePath?: string }
```

Schema: leak `src/hooks/useIdeSelection.ts:33-54`. The extension already sends `text`
(selection content) with the ranges — no file read required on the client side.

### Line math (must match exactly)

```ts
lineCount = end.line - start.line + 1
if (end.character === 0) lineCount--   // selection ending at column 0 does not count that line
lineStart = start.line
lineEnd = lineStart + lineCount - 1
```

Source: leak `src/hooks/useIdeSelection.ts:24-28, 124-150`. `IDESelection = { lineCount, lineStart, text, filePath }`.

## 3. The prompt

Leak `src/utils/messages.ts:3613-3627`, attachment type `selected_lines_in_ide`.
Max content length **2000 chars**, truncated with `\n... (truncated)` suffix.
Rendered as a meta user message wrapped in `<system-reminder>`:

```
The user selected the lines {lineStart} to {lineEnd} from {filename}:
{content}

This may or may not be related to the current task.
```

omp port: template file `packages/coding-agent/src/prompts/system/ide-selection.md`
(rendered via `prompt.render` from `@oh-my-pi/pi-utils`, same as `date-cwd-reminder.md`),
injected with a `withIdeSelectionReminder` mirroring `withDateCwdReminder`.

## 4. Port mapping (one line per reuse point)

| Need | Reuse in omp |
|---|---|
| MCP client + notifications | `mcp/client.ts` `connectToServer` + `mcp/manager.ts` `addNotificationListener` |
| Lockfile discovery | new `discovery/ide.ts` (mirror `discovery/vscode.ts`), register in `discovery/index.ts` |
| Selection state | new `mcp/ide-selection.ts` listener + `IDESelection` type |
| Prompt injection | new `session/ide-selection-reminder.ts` mirroring `session/date-cwd-reminder.ts`; apply at `sdk.ts:3161`/`3807` |
