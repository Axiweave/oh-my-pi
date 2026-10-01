# Research: Subagent Generation Rate in the Subagents HUD

All findings come from the current tree. Paths are relative to the repository root.

## R1. Where does the HUD get each subagent's rate?

- **Decision**: The caller looks up the rate in the host process. `#renderSubagentList` passes a lookup function to `renderSubagentHudLines`. The lookup reads `AgentRegistry.global().get(id)?.session?.tokenRate`.
- **Rationale**:
  - `renderSubagentHudLines` gets `ObservableSession[]` (`packages/tui/src/overlays/session-observer-registry.ts:47-67`). That type has no rate and no streaming flag.
  - Every `AgentSession` owns a `TokenRateMeter` (`packages/coding-agent/src/session/agent-session.ts:1684`). Its own streamed deltas feed it (`agent-session.ts:3906-3918`).
  - The observer id comes from `progress.id` (`session-observer-registry.ts:254`). The executor registers the same id in `AgentRegistry` (`task/executor.ts:1505`). Click-to-focus already maps HUD ids to registry ids. The lookup by id is therefore safe.
  - Because the lookup is a parameter, the render function stays pure. Tests can pass fake rates without real sessions.
- **Alternatives considered**:
  - *Put the rate on `ObservableSession` or `AgentProgress`.* Rejected. The executor emits progress only on tool and message boundaries, not on deltas (`task/executor.ts:1856-1876`). The rate in a snapshot is old by the time the HUD draws it. The change also touches the event payload, the `pi-tui` package and the RPC consumers, for no gain.
  - *Read `AgentRegistry` inside `renderSubagentHudLines`.* Rejected. The render function then needs global state, and tests need real registry entries.

## R2. How does the HUD know if a rate is live or a last reading?

- **Decision**: Add one public getter to `TokenRateMeter`: `get live(): boolean`. It returns `this.#startedAt !== null`, which is true between `begin()` and `end()`.
- **Rationale**:
  - The spec separates "streams output now" from "between model requests". The meter already tracks exactly this with `#startedAt` (`utils/token-rate.ts:164-165`).
  - `AgentSession.isStreaming` is not usable here. It stays true for the whole agent run, including tool execution, so tool time would show a live rate.
  - Between messages, `rate()` keeps returning the last reading (`token-rate.ts:153-154`), so the held value needs no extra state.
- **Alternatives considered**: Compare two `rate()` samples over time. Rejected. That needs extra state and a delay, and a stable stream can look idle.

## R3. How does the HUD update the rate while agents stream? (FR-009, FR-010)

- **Decision**: Use two redraw sources. Progress frames redraw the HUD on streamed deltas. A 500 ms heartbeat timer covers silent spans. `#renderSubagentList` clears the heartbeat on every call, and arms it again only when one or more meters are live. The heartbeat therefore fires only after 500 ms with no other redraw. Shutdown clears it, and it calls `unref()`.
- **Rationale**:
  - `processEvent` in the executor calls `scheduleProgress(flushProgress)` for every event, including each `message_update` delta (`task/executor.ts:1980`). Frames come at most every 150 ms (`PROGRESS_COALESCE_MS`). The observer sync then rebuilds the HUD within 100 ms.
  - Frames come only after events. During a silent span, `TokenRateMeter.rate()` still changes, because it credits hidden tokens over time (hidden reasoning and the lead-in to the first token). No frame arrives in that span. Without the heartbeat, the number freezes, and FR-009 fails.
  - Every render restarts the heartbeat, so it adds no redraws while frames arrive.
  - 500 ms gives one or more redraws in each 1-second window (SC-003), also with timer drift.
  - When no meter is live, the heartbeat stops. This meets FR-010.
- **Alternatives considered**:
  - *Progress frames only.* Rejected. The number freezes during silent spans.
  - *A timer that ignores other redraws.* Built first. It added up to 2 redraws each second on top of the frames.
  - *Hook into the working-row loader tick.* Rejected. The loader runs only while the main session works.

## R4. Which symbol, number format and colors?

- **Decision**:
  - Symbol: `theme.icon.throughput`, the same symbol as the working row (`interactive-mode.ts:1239`). The preset values are `⚡` (Unicode), the `\uf0e4` gauge (Nerd Font) and `tok/s:` (ASCII) (`packages/tui/src/theme/symbols.ts:495`, `888`, `1276`).
  - Number: `rate.toFixed(1)`, as in the working row.
  - Row: `${icon} ${value}`. Header: `${icon} ${value} tok/s`, the same text as the working row.
  - Live row rate: `muted`. Held last reading: `dim`. Header total: `dim`, as in the working row.
- **Rationale**:
  - The spec needs a visible difference between "normal" (live) and "dimmed" (held). The working-row readout already uses `dim`, so the live row rate needs a lighter tone. `muted` already exists in the same function for task previews (`interactive-mode.ts:1038`).
  - A change of preset changes `theme.icon.throughput`. The next HUD rebuild picks up the new symbol without other work.
- **Alternatives considered**: Leave out the `tok/s` text in the header with the ASCII preset to avoid `tok/s: 142.6 tok/s`. Rejected. The working row has the same text today, and FR-002 requires the same format.

## R5. Where does the row put the rate, and what happens at small widths?

- **Decision**: Add the rate after the role badge and before the `: description` part. The row reads `● Id⟨role⟩ ⚡ 61.4: description`. The rate goes into the row only if `visibleWidth(line + " " + rate) <= rowWidth`. If it does not fit, the row has no rate. The description budget then uses the width that remains after the rate.
- **Rationale**: The current code computes the description budget from `visibleWidth(line)` (`interactive-mode.ts:1026`, `1037`). When the rate is in `line` before that step, the description gets shorter first (FR-003). This needs no change to the budget code.

## R6. The native HUD

- **Decision**: No change. `describeSubagentHud` draws one pill with a count of running agents (`interactive-mode.ts:914-936`). It has no rows and no header.
- **Rationale**: The spec scope is the Subagents text block. If the pill needs a total later, add a separate `rate` node, the same as `#describeIdleStatusHud` does.

## R7. Tests

- **Decision**: Add cases to `packages/coding-agent/test/subagent-hud-render.test.ts`. They call `renderSubagentHudLines` with a fake rate lookup and check these properties:
  - A live rate shows the symbol and one decimal place. A held rate shows the same number in a different style. A missing rate shows nothing.
  - The header total is the sum of the live rates across all running agents, including collapsed rows. It never includes held rates.
  - For widths 30 to 160 and generated rates, every line is at most `width` columns. Each row has the full rate text or no rate. A partial number never shows.
  - The rate symbol is the same as `theme.icon.throughput` for each of the 3 presets.
  
  Add one `live` case around `begin` and `end` to the existing `packages/coding-agent/test/utils/token-rate-meter.test.ts`.

  Add two tests to the `InteractiveMode subagent observer UI sync` suite. Both register a real `AgentSession` in `AgentRegistry` and use fake timers.
  - Freshness: each progress frame shows the current meter value. A faster stream shows a higher number. No rate shows after `composer.tokenRate` is turned off.
  - Cadence: during a silent span, the HUD rebuilds one or more times in each 1-second window (SC-003). While frames arrive every 200 ms, the HUD rebuilds no more than once for each frame. After `end()`, it makes 0 rebuilds in the next 2 seconds (FR-010).
- **Rationale**: These are the visible behaviors, boundaries and invariants. The cadence test fails without the heartbeat, and it also fails with a timer that ignores other redraws.
