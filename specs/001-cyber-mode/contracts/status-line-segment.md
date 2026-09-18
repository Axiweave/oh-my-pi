# Contract: `cyber` Status Line Segment

A new segment shows the protection's state, following the `model_profile`
segment that already serves the same purpose for model profiles.

## Segment

```ts
const cyberSegment: StatusLineSegment = {
	id: "cyber",
	render(ctx) {
		if (!ctx.session.cyberMode) return { content: "", visible: false };
		return { content: theme.fg("warning", withIcon(theme.icon.cyber, "Cyber")), visible: true };
	},
};
```

`packages/coding-agent/src/modes/components/status-line/segments.ts`, beside
`modelProfileSegment` at line 317, and registered in the `SEGMENTS` map at line
1011.

| Property | Rule |
|---|---|
| `id` | `"cyber"` |
| Label | `Cyber`, rendered through `withIcon`, so the mark and the word read together as `⚔️ Cyber` |
| Mark | `theme.icon.cyber`, resolved through `SYMBOL_PRESETS` like every other status-line icon: unicode and nerd render the crossed-swords mark `⚔️`, ascii renders the text fallback `[C]`. A per-theme `symbols.overrides["icon.cyber"]` replaces it |
| Visibility | Hidden while off (FR-019). No content, no space, no separator |
| Source | `ctx.session.cyberMode`, the session's live state — never a cached setting |
| Styling | Warning tone, so it reads as a protection indicator rather than as ordinary chrome. Distinct from the model profile's muted tone so the two never blur |

The `SegmentContext` already carries `session: AgentSession`
(`modes/components/status-line/types.ts:62-63`), so no context field is added.

## Registration

| File | Change |
|---|---|
| `config/settings-schema.ts:242` | Add `"cyber"` to `STATUS_LINE_SEGMENT_IDS`, which widens `StatusLineSegmentId` |
| `modes/theme/symbols.ts` | Add `"icon.cyber"` to the `SymbolKey` union, then to all three presets: `UNICODE_SYMBOLS` and `NERD_SYMBOLS` render the crossed-swords mark, `ASCII_SYMBOLS` renders `[C]`. Follow the file's existing `// pick:` / `// alt:` comment convention for the nerd glyph |
| `modes/theme/theme-class.ts` | Expose `cyber: this.#symbols["icon.cyber"]` on the icon accessor, beside `package` |
| `modes/components/status-line/segments.ts:1012` | Add `cyber: cyberSegment` to `SEGMENTS`. The record is typed `Record<StatusLineSegmentId, StatusLineSegment>`, so a missing entry fails the build rather than failing silently |
| `modes/components/status-line/presets.ts` | Add `"cyber"` to the `default` preset's `leftSegments`, after `model_profile` |
| `modes/components/status-line/component.ts:3061` | Render the segment in `renderClaudeFooter` (the segment resolves at `:3075`, beside the existing `model_profile` render at `:3074`), joined by the same dot separator |

## Placement rules

- **Default preset**: included, so the state is visible with no configuration.
  This matches how `model_profile` ships.
- **Custom preset**: selectable by adding `"cyber"` to `statusLine.leftSegments`
  or `statusLine.rightSegments`. Registration in the catalog is what makes it
  accepted; an unregistered id is rejected by the settings validator.
- **`claude3` footer**: rendered automatically, with no operator configuration.
  This is the explicit requirement in FR-020 and item 3 of the feature request.

## Related surfaces

| Surface | Behavior |
|---|---|
| `omp gallery --segment cyber` | Renders through the existing segment gallery, since the gallery enumerates `ALL_SEGMENT_IDS` |
| Web export palette | No new color token. The segment reuses the existing `warning` theme color |
| Status line when cyber mode is off | Fully absent. The segment reports `visible: false`, so no separator is emitted for it |

## Invariants

1. The segment's visibility always matches the session's live state. It reads the
   session, not a setting, so a toggle updates it within one render cycle
   (SC-004).
2. It never implies more than the feature guarantees: it says cyber mode is on,
   not that a provider accepted the turn. The allowlist is an operator
   declaration (`spec.md` Assumptions), and the indicator reports the declaration
   being in force.
3. It may imply less than the configuration enforces. When another session
   sharing the configuration state has installed protection while this session's
   state is off, the indicator stays hidden (FR-019) and the configuration is
   more restrictive than the indicator shows. Under-reporting is the accepted
   direction, because it never tells the operator that they are protected when
   they are not.
