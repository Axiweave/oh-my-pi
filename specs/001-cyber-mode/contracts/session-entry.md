# Contract: Session Entry (`model_change.cyber`)

Cyber mode state rides the session's existing `model_change` entry rather than a
new entry type. This is what makes `/new`, the delete paths, resume, and session
switching behave as the spec requires without new reconciliation logic.

## Field

```ts
export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	model: string;
	role?: string;
	resolvedModelIsFallback?: boolean;
	profile?: string;
	/**
	 * Cyber mode state in effect at this transition. Every model change records
	 * it, so the most recent entry always names the truth.
	 */
	cyber?: boolean;
}
```

`packages/coding-agent/src/session/session-entries.ts`, beside `profile`.

## Writer

`SessionManager.appendModelChange` gains a trailing parameter:

```ts
appendModelChange(
	model: string,
	role?: string,
	resolvedModelIsFallback = false,
	profile?: string,
	cyber?: boolean,
): string
```

`packages/coding-agent/src/session/session-manager.ts:2790`.

**Write rule**: every call site passes the state currently in effect. Unlike
`profile`, which only profile switches tag, `cyber` is written on *every* model
change. The two differ because a profile is never uninstalled in-session, while
cyber mode toggles both ways, and a turn recorded after a disable must not read
as still protected.

## Reader

```ts
/** Cyber mode state recorded for this branch; undefined when never recorded. */
getLastCyberMode(): boolean | undefined
```

`packages/coding-agent/src/session/session-manager.ts`, mirroring
`getLastModelProfile` at line 3009.

**Read rule**: Scan the current branch backward for the most recent entry with a
defined `cyber` value. If none exists, use the configured startup value, which
defaults to `false`. A different session's state does not supply that fallback.

## Consumers

| Consumer | Behavior |
|---|---|
| `newSession` | Revalidate inherited protection, then record its actual state beside the inherited model and profile. This covers `/new` and `/delete` |
| `switchSession` | Restore the destination's recorded cyber state before restoring its model. On failure, restore the outgoing state, protection, and notice history. Publish cyber notices only after success |
| `fork`, `branchFromBtw`, `branch`, `navigateTree` | Restore and revalidate the destination state before model use. Record a degraded off state without clearing another owner's protection |
| Constructor and SDK startup | Restore recorded state beside the model profile. Send startup refusals and resumed active-model substitutions through `configWarnings` or `modelFallbackMessage` |
| Enable, disable | Record through the normal model-change path, so a toggle is durable without a new write path |

## Compatibility

- **Older sessions**: without a `cyber` field, an older session uses the configured
  startup value. That value defaults to off (FR-003, FR-025).
- **Newer session read by an older build**: the field is ignored by the older
  `ModelChangeEntry` consumers, which read named fields only. No parse failure.
- **Session sharing or export**: the field is a boolean on an existing entry, so
  no export format, schema version, or migration changes.

## Invariants

1. The recorded state and the recorded model always agree, because one call
   writes both.
2. `/clear` writes nothing, so the state survives it trivially (FR-022).
3. A session switch cannot leak state, because each branch is read independently
   (FR-024).
4. A recorded on state carries no list of its own, so it is re-validated against
   current configuration on read. An empty list, or one where no entry resolves,
   degrades the state to off with a warning, rather than pinning a list the
   configuration no longer supports (FR-026).
5. A same-transcript reload retains notice history. A new transcript starts a new
   notice history. Failed switches retain the outgoing history.
