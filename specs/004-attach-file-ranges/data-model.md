# Data Model: File Range Attachments

## 1. Mention token

The existing `extractFileMentions(text): string[]` interface remains unchanged.

| Value | Meaning |
| --- | --- |
| Mention string | Path token after existing quotation and punctuation handling |
| Ordering | First appearance in the prompt |
| Identity | Exact extracted string |

Exact duplicate strings collapse before generation. Different requested ranges do not collapse by source path or effective label.

No new persisted token entity is required.

## 2. Resolved source and requested bounds

Extend private resolution state in `file-mentions.ts`, not the public message schema.

| Field | Meaning |
| --- | --- |
| `resolvedPath` | Base source spelling for source identity and hashline headers |
| `absolutePath` | Real path used for filesystem reads and snapshot storage |
| Optional requested range | One-based inclusive `startLine` and `endLine` |

No range means the existing whole-file flow. For `:N`, both requested bounds equal N.

### Validation

- Probe the complete literal path before interpreting a numeric suffix.
- Only a confirmed missing literal path permits suffix interpretation.
- Both bounds must be positive safe integers.
- The end must be at least the start.
- Require a nonempty base path.
- Do not pass directory, image, video, or binary content into text selection.
- Do not catch a failed range and retry as a whole-base-file mention.

## 3. Effective selection

This is transient state derived from one saved text read.

| Value | Meaning |
| --- | --- |
| Full normalized text | Complete source text used for line boundaries and snapshot identity |
| Source line count | Number of addressable lines, excluding a final newline sentinel |
| Effective start | Requested start, when that line exists |
| Effective end | Minimum of requested end and source line count |
| Selected line count | Effective end minus effective start plus one |
| Selected body | Source lines in the effective span, without extra context |

An empty file has no effective selection. A selected blank source line has a count of one and can have an empty body.

Normalization changes line terminators only. It does not trim source text or replace non-ASCII characters.

## 4. Bounded attachment output

The existing output limits apply to selected source text.

Keep source rows separate from truncation notices during formatting. A notice is not an addressable source row.

| Value | Meaning |
| --- | --- |
| Bounded source body | Selected source text that fits current output limits |
| Original start line | Coordinate supplied to source-row numbering |
| Notice | Existing limit information, adjusted to original source coordinates |
| Displayed provenance | Only the source rows actually included in bounded output |

The full-file 5 MiB auto-read check remains independent of the selected-output limit.

## 5. Existing `FileMentionMessage`

Retain the current shape from `packages/tui/src/chat/messages.ts`.

| Existing field | Range behavior |
| --- | --- |
| `role` | Remains `fileMention` |
| `files` | Ordered attachment entries |
| `timestamp` | Existing message timestamp |
| `files[].path` | Effective label, such as `note.txt:4-5` |
| `files[].content` | Bounded selected text with existing metadata formatting |
| `files[].lineCount` | Effective selected source-line count before inline truncation |
| `files[].byteSize` | Existing source-size metadata for applicable skip cases |
| `files[].skippedReason` | Existing skip values only |

A single-line label uses `path:N`. A multi-line label uses `path:N-M`.

When selection never occurs because of a size skip, retain the requested label with the existing skip indication. Do not invent an effective end.

No schema migration is needed. Existing model conversion and rendering carry the label and content.

Persistence may recalculate counts when it applies existing oversized-string handling. This feature preserves that policy and does not promise new restored-count semantics.

## 6. Snapshot relationship

Each ranged hashline attachment references the complete saved source version through the existing edit store.

- Snapshot key: real `absolutePath`.
- Snapshot text: full normalized source from the same read as the selection.
- Hashline header: real `resolvedPath` and full-source tag, without a range suffix.
- Numbered rows: original file coordinates.
- Seen-line provenance: displayed source rows, excluding notices and undisplayed lines.

Repeated selections of the unchanged file may share the same snapshot. Existing provenance merge behavior combines displayed rows without replacing full source text.

## State transitions

```text
Prompt text
  -> extracted mention token
  -> literal-path probe
     -> literal exists: existing attachment flow
     -> probe unknown: no selector fallback
     -> literal missing: restricted selector validation
        -> invalid or unsupported: no range content
        -> valid: resolve base source and apply file policies
           -> skipped or unreadable: existing skip behavior
           -> readable text: derive effective selection
              -> empty: no range content
              -> nonempty: bound and format selected source
                 -> existing fileMention message
                 -> prompt context and submitted attachment display
```

## Invariants

1. A range attachment never includes source lines outside its effective selection.
2. A truncated attachment never records an omitted source line as displayed.
3. A full-source snapshot never contains only a selected fragment.
4. A display label never becomes a filesystem or edit target.
5. Distinct mention strings retain independent selection results.
6. The first model request contains prepared range attachments without a read-tool round trip.
