# Contract: Prompt File Range Mentions

## Interface

This contract extends automatic `@` file mentions in user prompt text. It does not change the `read` tool or standalone CLI file arguments.

```text
@path
@path:N
@path:N-M
@"path with spaces:N-M"
@'path with spaces:N-M'
```

The existing mention tokenizer defines quoting, punctuation, and token boundaries. The suffix belongs inside the quotes.

A bare trailing colon in unquoted `@file:` remains punctuation and produces the ordinary `@file` mention. It is not an empty selector.

Quoted `@"file:"` retains the colon. It attaches only that literal filename, if readable, and never falls back to `file`.

`N` and `M` are positive decimal safe integers. Leading zeros are accepted and canonical labels use ordinary decimal numbers.

- `:N` selects exactly line N.
- `:N-M` selects N through M, inclusive.
- M must be at least N.
- Bare `path:N-M` does not trigger automatic attachment.

## Resolution precedence

1. Preserve an existing exact literal path, including a filename that ends in a selector-shaped suffix.
2. Interpret the suffix only when the literal path is confirmed missing.
3. Resolve the remaining path with the existing file-mention path rules.
4. Accept only the finite numeric suffix forms above.

An inconclusive literal-path probe does not authorize reading a different file. A dangling literal symlink does not authorize a fallback to its selector-free name.

Directories, images, videos, and binary files do not support range attachment. Exact literal mentions of those files keep their existing behavior.

## Selection semantics

Saved text supplies the source lines. Normalize common line endings before selecting lines. Preserve all other characters, including non-ASCII text and blank lines.

A final line terminator does not create an extra source line. An empty file has zero selectable lines. A file containing one newline has one blank source line.

For a file with L lines:

- If N is greater than L, attach no source content.
- Otherwise, the effective end is the smaller of M and L.
- A single-line request uses M equal to N.
- Select no leading or trailing context lines.

## Prompt delivery and display

Omp prepares the attachment before the first model request for the submitted prompt. The original user text remains unchanged.

A successful attachment identifies the base file and effective range. Its source line labels, when present, use original file coordinates.

The selected source text is the only source text in that range attachment. Existing truncation notices and source headers are metadata, not additional source lines.

The submitted prompt view shows the attachment using the existing file-mention display. A range label must remain visible there.

Different ranges remain separate attachment entries. Repeating an identical mention attaches it once. This contract does not require merging overlaps or deduplicating equivalent path spellings.

## Limits and errors

The existing 5 MiB text-file auto-read limit remains a file-size limit, even for a small requested selection.

The existing inline limits remain 3,000 lines and 50 KiB of source output before existing formatting overhead.

Select the range before applying inline limits. Truncation identifies the actual displayed source coordinates and does not claim that omitted lines reached the model.

Missing, unreadable, invalid, unsupported, and empty selections attach no source content. Existing skip markers may describe size or binary-file limits.

A failed selection does not prevent independent valid mentions from attaching. It never falls back to the whole base file.

## Examples

Assume `note.txt` has five source lines and no literal selector-shaped sibling files.

| Prompt | Result |
| --- | --- |
| `@note.txt` | Existing whole-file behavior |
| `@note.txt:` | Existing whole-file behavior, because the final colon is punctuation |
| `@"note.txt:"` | Literal `note.txt:` only, otherwise no source attachment |
| `@note.txt:2` | Source line 2 |
| `@note.txt:2-4` | Source lines 2, 3, and 4 |
| `@note.txt:4-9` | Source lines 4 and 5, labeled `note.txt:4-5` |
| `@note.txt:6-9` | No source attachment |
| `@note.txt:0-3` | No source attachment |
| `@note.txt:3-1` | No source attachment |
| `@note.txt:2-` | No source attachment |
| `@note.txt#L2` | No new behavior |
| `@note.txt:2 @note.txt:4-5` | Two distinct selections |
| `@note.txt:2 @note.txt:2` | One attachment |

If a literal file named `note.txt:2-4` exists, `@note.txt:2-4` retains its whole-file literal interpretation.

## Verification obligations

- Compare selected content against independently generated source-line identities.
- Check first, last, blank, empty, single-line, and over-limit cases.
- Verify LF, CRLF, CR, final-newline, and non-ASCII cases.
- Check literal-path precedence and failed probes without exposing the base file.
- Observe the initial model-bound request, not just the inserted editor text.
- Observe the actual prompt attachment display, not just the serialized message.
- Confirm that hashline headers still identify the real file and the full-file snapshot.
