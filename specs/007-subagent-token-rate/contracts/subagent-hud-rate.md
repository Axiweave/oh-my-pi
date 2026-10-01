# Contract: Subagents HUD rate display

## Function signature

```ts
export interface SubagentRate {
	rate: number;
	live: boolean;
}

export function renderSubagentHudLines(
	sessions: ObservableSession[],
	columns: number,
	expanded?: boolean,
	rateOf?: (id: string) => SubagentRate | undefined,
): string[];
```

- If `rateOf` is absent, or it returns `undefined` for every id, the output is the same as the output before this feature, byte for byte (SC-006).
- The function reads no global registry and no settings for rates. The caller handles the setting and the registry lookup.

## TokenRateMeter addition

```ts
/** True while a message streams (between begin and end). */
get live(): boolean;
```

## Rendered layout

Header, with one or more live agents:

```
Subagents  ⚡ 142.6 tok/s
```

Rows, with the Unicode preset:

```
 ├─ ● NamingDomainImplementation ⚡ 81.2: Complete assignment thoroughly…   (live: muted)
 ├─ ● NamingCliImplementation ⚡ 61.4: Implement migrate-naming CLI…        (live: muted)
 └─ ● ScoutWorker⟨scout⟩ ⚡ 40.3 Survey call sites…                         (held: dim)
```

- The header puts two spaces between `Subagents` and the total. The total uses `dim`.
- A row puts the rate after the id and role badge, with one space before it. The `: description` part or the task preview follows the rate.
- With the ASCII preset, the symbol is `tok/s:`. A row reads `Worker tok/s: 61.4: description`.

## Caller (InteractiveMode)

- `#renderSubagentList` gives `rateOf` only when `cfgComposerTokenRate` is on.
- `rateOf` reads each meter once per render and keeps the reading. The rows, the header sum and the focused agent's working row all use that one reading, so they show the same number (FR-011).
- The heartbeat runs while any meter is live, also before the meter has its first reading.
- Progress frames redraw the rates on streamed deltas. `#renderSubagentList` also clears and then re-arms a single-shot 500 ms heartbeat while one or more meters are live. The heartbeat fires only after 500 ms with no other redraw. It calls `unref()`, and shutdown clears it.
- The native `describeSubagentHud` pill does not change.
