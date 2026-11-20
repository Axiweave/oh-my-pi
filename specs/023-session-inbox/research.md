# Research: Session Inbox

All paths are under `packages/coding-agent/src/` unless noted. The facts come from three read-only scout passes (transport, target delivery, sender and tools) and from direct reads.

## R1. Transport: native IPC, own registry

- **Decision:** Each interactive session listens on a private IPC endpoint from `@oh-my-pi/pi-natives`. It uses `IpcServer.listen(endpoint, { framing: "lines", maxFrameBytes: 2 MiB }, onConnection)` (R10), and a client uses `IpcConnection.connect(endpoint, { framing: "lines", timeoutMs })`. The protocol is one JSON request line and one JSON response line per connection, the same as collab. Discovery uses its own directory `getSessionInboxDir()` = `dirs.baseRootSubdir("run/session-inbox", "state")` in `packages/utils/src/dirs.ts`. That directory is profile-independent, so sessions under any profile see each other, and it lives next to `getSessionOwnersDir`.
- **Rationale:**
  - The native layer already gives most of what the inbox needs: a 0600 socket, a 0700 parent dir, a bind lock, and stale-socket replacement.
  - `connect` refuses a peer owned by another user with `EACCES`. That covers FR-012 with no new code.
  - Windows named pipes with a current-user DACL use the same API.
  - The collab registry (`collab/registry.ts`) already proves the discovery pattern:
    - The metadata file is written as tmp, then renamed with mode 0600.
    - A bearer token is checked with `timingSafeEqual`.
    - Listing is a bounded pool with a 1.5 s deadline for each entry.
    - An `ENOENT`/`ECONNREFUSED` answer means the entry is dead and gets pruned. Any other error only hides the entry.
    - Cleanup runs through `process.once("exit")` plus `postmortem`.
- **Not reused as is:**
  - The collab handler always snapshots first and accepts only `snapshot` and `link` (`registry.ts:312-327`).
  - Its listing deletes every `.json` that fails `parseDiscoveryMetadata` (`:611-615`). Inbox files in `run/collab-hosts` would be deleted by `omp collab list`.
  - Its token also mints control links (`:338-341`).
  - The inbox therefore has its own directory, metadata schema, token, and handler.
- **Shared code:** move the generic, module-private helpers from `collab/registry.ts` into `ipc/private-registry.ts`. Collab and the inbox both import them. The helpers are:
  - `ensurePrivateDir` and `assertPrivateDir`, with a `label` parameter for error text.
  - `tokenMatches`, `pidAlive`, `endpointFiles` and `removeFilesSync`.
  - `pruneEntry`.
  - The one-request `query` skeleton (`ok` / `dead` / `skip`).
  - The bounded worker pool.
  This avoids a second copy of about 120 lines of security-relevant code. The existing collab registry tests cover the move.
- **Alternatives considered:**
  - The launch daemon broker (`launch/broker.ts`) has one server per scope and a shared token file. It is the wrong shape for one endpoint per session.
  - `zmx send` raw keystrokes give no result. They also mix with the user's typing and do not work outside zmx.
  - The full RPC protocol next to the TUI makes two controllers drive one `AgentSession`. Its dialog routing, session switch and process lifetime would all conflict with the TUI.

## R2. Address and parent link

- **Decision:** The address is `process.env.ZMX_SESSION` when it is set. Otherwise the address is `omp-<pid>`. The metadata records `parent = process.env.OMP_SPAWN_PARENT ?? null`.
  - "Caller started it" means `entry.parent === callerAddress`.
  - "It started the caller" means `callerParent === entry.address`.
  - The display name is `session.sessionName ?? address`.
  - When two live entries have the same address, for example after an omp restart in one zmx window, `send` answers `ambiguous` and names the entry IDs. The newest live entry is listed first.
- **Rationale:**
  - A `/spawn` child already has a zmx name (`siblingName`, `session/sibling-spawn.ts:47`).
  - A child already gets its parent name in `OMP_SPAWN_PARENT` (`sibling-spawn.ts:136`).
  - `sessionId` changes on `/new` and on resume, so it cannot be a window address.
  - A session outside zmx has no parent notion, so its link fields are always false. This matches the spec assumption "the inbox belongs to the session window".
- **Alternatives considered:**
  - A random instance ID as the address is not something a user can say ("the upload child").
  - The session title is not unique and can change.

## R3. Delivering a request in the target

- **Decision:** Use `session.promptCustomMessage(...)` (`session/agent-session.ts:9040`), with the following settings:
  - `customType: COLLAB_PROMPT_MESSAGE_TYPE`, `display: true`, and `details: { from: senderName }`.
  - `content` set to `[from <name> (<address>)]` and then the text, because the model does not see `details.from` (`session/messages.ts:803-820`).
  - `streamingBehavior` set to `"steer"` or `"followUp"` from the delivery choice.
  - `attribution: "agent"`.

  Before dispatch, the target loops on `session.isSessionTransitioning` and `waitForSessionTransition()`, the same as collab (`collab/host.ts:1040`).

  The delivery result never awaits the returned promise, because for an idle target that promise resolves only when the whole run ends (`agent-session.ts:9660`). The target uses the callbacks instead:
  - `onPromptQueued` gives "queued".
  - `onPromptAdmitted` without a queue gives "delivered".
  - A `false` return gives "not delivered", for example when the cost cap stops the turn.
  - A throw gives "not delivered" with the error.
- **Why `attribution: "agent"`:**
  - A user-attributed steer closes an open `ask` dialog (`tools/ask.ts:762-771`) and the TUI approval dialog (`modes/controllers/extension-ui-controller.ts:758-760`). In the default `interruptMode: "immediate"`, it also cuts the running tool batch.
  - The spec edge case says that a message waits for the target user's dialog, and the dialog belongs to the target's user.
  - An agent-attributed steer enters at the next step boundary and does not close the dialog.
  - [INFERENCE] The step-boundary entry for an agent-sourced steer comes from `steeringQueueState` (`packages/agent/src/agent-loop.ts:1884-1898`). Task T010 step 0 proves it with a test before any delivery code depends on it. When that test fails, this decision changes first.
- **Why reuse the collab message type:**
  - It already has a renderer in both places: `modes/utils/ui-helpers.ts:377` and `packages/tui/src/chat/chat-transcript-builder.ts:641`. The renderer shows the `«from» ›` header.
  - It already has user-turn semantics (`isSteeringUserMessage`, `isUserTurnInitiator`).
  - A new type would need four more wiring points and would add nothing.
- **Editor draft (FR-013):** `promptCustomMessage` never touches the editor. Its only UI effect is the pending-message chip.

## R4. Reply tracking

- **Decision:** Reuse `RpcPromptResults` (`modes/rpc/rpc-prompt-results.ts`).
  - Add the answer text to its private `RunOutcome`. Extract it from the last assistant message with `extractVisibleAssistantText` (`modes/rpc/rpc-live.ts:36`).
  - Pass the text to the `output` callback as a second argument. RPC mode ignores that argument, so the RPC wire frame does not change.
  - The inbox host creates one instance for each target session and feeds it every event through `session.subscribe`.
  - For each request that asks for a reply, the target calls `begin(messageId)` before dispatch and `settle(ticket)` from `onPromptAdmitted`/`onPromptQueued`. It calls `discard` on "not delivered" and `abortOpen()` after `/new` or a session switch.
- **Rationale:** The class already handles the cases the inbox needs:
  - An idle dispatch owns the first run after acceptance.
  - A steer or follow-up into a live run reports at the first yield that leaves the queue empty. This gives one report for each sender for each turn (User Story 5, scenario 3).
  - A cost-cap refusal and a session transition each get a report.
  - The outcome is `completed`, `aborted` or `error`, and an error includes its text (FR-017).
- **Alternatives considered:**
  - Copying the ticket logic gives a second copy of a subtle state machine.
  - `session.getLastAssistantText()` can be stale after a later turn.

## R5. Delivering a reply in the sender

- **Decision:** Add a new YieldQueue kind `"inbox-reply"`, registered in `AgentSession` next to `"async-result"` (`agent-session.ts:2865`). It has a public `queueInboxReply(entry)` that mirrors `queueLaunchCompletion` (`:10483`): `enqueueWithReceipt` followed by `requestIdleFlush()`.
  - The built message is a `custom` message with `attribution: "agent"`. Its content is wrapped in `<system-notice>` and run through `escapeHarnessTags`, the same as async results (`session/async-job-delivery.ts:114-120`).
  - `isStale` uses the async-delivery epoch, so a `/new` in the sender drops pending replies. The epoch bump at `:3850` also clears the `"inbox-reply"` kind.
  - The target sends the reply over IPC with `op: "reply"`. It finds the sender's endpoint by the `from.entryId` in the request, not by address. Two live sessions can share one address (R2), and the reply must reach the session that sent the request.
  - The sender accepts a reply only for a message ID that it sent and that is still pending. This blocks forged replies and makes "a reply never makes a reply" structural, because a reply is not a request. The sender adds the ID before it sends the request, so a reply that comes back before the send call returns is still accepted.
  - After the sender's own user interrupt, the YieldQueue holds back background results, and a reply joins the conversation without a turn. Spec FR-015 records this as the one exception to "a reply starts a turn".
- **Rationale:**
  - This is exactly how background results "arrive by themselves". The queue starts a turn when the session is idle and drains at a step boundary when it is busy.
  - It holds back during a session transition.
  - It folds the reply into context with no turn while a user-interrupt latch is set (`:2625-2632`).
- **Alternatives considered:**
  - Keeping the request connection open until the turn ends ties a socket to a turn that can last hours. It also gains nothing over a lookup.
  - `AsyncJobManager` would show replies as jobs, which the spec does not ask for.

## R6. Notifications: advisor routing

- **Decision:** Add one public seam to `SessionAdvisors` (`session/session-advisors.ts`): `routeExternalNote(source, note, severity)`. `AgentSession.routeInboxNote` exposes it.
  1. Split the private `#routeAdvice` (`:1797-1850`) into an advisor-agnostic `#routeNote(source, note, severity)`. The advisor path calls it.
  2. Register the `"advisor"` YieldQueue dispatcher even when no advisor is configured. Today it is registered only when `#advisors.length > 0` (`:1760-1773`).
  3. In an idle target, the channel `aside` becomes `preserve`. An `aside` dispatcher has `skipIdleFlush`, so an idle `nit` would otherwise stay hidden until the next run. Spec scenario 8 asks for a visible card.
  4. The note uses `customType: "advisor"` with `AdvisorNote.advisor = "<name> (<address>)"`. `formatAdvisorBatchContent` then emits `<advisory advisor="…" severity="…" guidance="weigh, don't blindly obey">`, which is the "advice, not an order" framing (FR-007). The card shows the source for each note.
- **Rationale:**
  - FR-018 asks for the same rules as advisor notes. This reuses `resolveAdvisorDeliveryChannel` and every input it reads:
    - `continueSeverity`, with default `concern`.
    - The interrupt latch and immune turns.
    - Plan mode, which downgrades `steer` to `preserve`.
  - An inbox `concern` arms the same immune window that advisor notes use. FR-018 asks for this ("same rules").
- **Delivery result:** `steer` gives "delivered", `aside` gives "queued", and `preserve` gives "delivered" with `shown: true` and no turn.

## R7. Interrupt

- **Decision:** `interrupt` checks `session.isStreaming || session.queuedMessageCount > 0`. When neither is true, it answers `idle`. Otherwise it calls `session.abort({ reason: USER_INTERRUPT_LABEL })`, then `session.emitNotice("info", "<name> interrupted", "inbox")`. This is the collab pattern (`collab/host.ts:1063-1068`).
- **Consequence:** `abort` sets the advisor `autoResumeSuppressed` latch (`agent-session.ts:11879`). Until the target's user types, a later notification of level `concern` or `blocker` shows as a card and starts no turn. FR-018 accepts this because of "the advisor's limits after a user interrupt". A request still starts a turn, because `promptCustomMessage` dispatches directly.

## R8. Tool and gating

- **Decision:** Add one hidden tool, `session_inbox`, with `op: "list" | "send" | "interrupt"`. This follows `loop`, `memory-edit` and `gh`.
  - **Name and factory:** `tools/builtin-names.ts` (`HIDDEN_TOOL_NAMES`) and `tools/index.ts` (`HIDDEN_TOOLS`).
  - **Gate:** `isToolAllowed` returns `!restrictToolNames && session.tuiTranscript === true && cfgInboxEnabled.get(session.settings)`. `tuiTranscript` is true only for a top-level interactive TUI session (`sdk.ts:2442`), so subagents, RPC, ACP and print mode never get the tool (FR-011).
  - **Registration:** in `sdk.ts`, copied from the `spawn_session` block (`:3922-3930`).
  - **Active:** by default, so the active set does not need a toggle.
  - **Master mode:** add `session_inbox` to `ALLOWED_TOOLS` (`session/master-mode.ts:34-45`) and to the toolset line in `prompts/system/master-mode-active.md`. Replace "nothing comes back here" with the inbox reply rule.
  - **Plan mode:** no change. `plan-mode-guard.ts` guards only paths, which matches the accepted gap.
- **`approval = "read"`:** the same as `spawn_session`. A send can make another session change files with no approval in the sender. The spec records this as an accepted gap for plan mode and for approval modes, for the same reason (spec Edge Cases). A stricter tier only for approval modes would be inconsistent with the plan-mode decision.
- **Host access:** `InteractiveMode` creates the `InboxHost` next to `setSpawnHandler` (`modes/interactive-mode.ts:3059`). It exposes the host through `ToolSession.getSessionInbox?()`. With no host (the setting is off), the tool throws a `ToolError`.

## R9. Setting

- **Decision:** `inbox/settings.ts` registers `inbox.enabled` (boolean, default `true`, `protocolDefault: ["rpc", "acp"]`, ui tab `interaction`, group `Session Inbox`). `config/all-settings.ts` imports it after collab.
  - `settings.onEffectiveChange([cfgInboxEnabled], …)` starts or stops the host while the session runs.
  - The setting goes in `docs/settings.md`.
  - The local rule says to append `inbox:\n  enabled: true` to `~/.omp/agent/config.yml`.

## R10. Limits

- **Decision:**
  - The request text is 256 KiB at most. A larger request is refused with `too_large` and the limit.
  - The frame limit is 2 MiB. JSON escaping can make a 256 KiB text up to 6 times longer (a control character becomes `\u00XX`), so the text can need about 1.5 MiB. A 1 MiB frame would refuse a text that passes the 256 KiB check.
  - The reply text is 16 KiB at most. A longer reply is cut on a UTF-8 boundary and gets `truncated: true` plus a one-line note.
  - Connect times out after 3 s. A list query times out after 1.5 s for each entry.
- **Rationale:** a normal pasted prompt fits in 256 KiB. A reply goes into the sender's context, so it must stay small. The sender can ask for more.

## Verified constraints (no open item)

- Same-user only: native `EACCES` peer check plus a bearer token for each entry (FR-012).
- Editor draft untouched (FR-013): see R3.
- Arrival order (FR-014): one JS thread handles connections in accept order. `promptCustomMessage` queues in call order.
- Session transition (spec edge case 3): the target waits for the transition, then reports `session.sessionManager.getSessionId()` in the result.
