# Research: Attach File Ranges Before Sending

## Evidence and current behavior

Research covered the attachment producer, prompt ordering, model conversion, transcript display, persistence, hashline snapshots, and existing tests.

A runtime probe called the real mention extractor and generator against this feature's saved specification:

```text
@specs/004-attach-file-ranges/spec.md       attachmentCount: 1
@specs/004-attach-file-ranges/spec.md:1-3   attachmentCount: 0
```

The extractor retained the suffix. The generator could not resolve it as a literal file. The probe ran successfully with Bun 1.4.2.

The root package declares `bun@>=1.4` and TypeScript `^7.0.2`. No dependency installation, build, test suite, or implementation change ran during research.

## 1. Keep the existing attachment seam

**Decision**: Implement range selection inside `packages/coding-agent/src/utils/file-mentions.ts`. Preserve its exported interfaces.

**Rationale**: `AgentSession.prompt` already awaits `generateFileMentionMessages` before model dispatch. The extractor already preserves suffix text and deduplicates identical mentions.

**Alternatives considered**:

- An editor-side `read` instruction does not preload content.
- A new attachment delivery mechanism duplicates the existing prompt flow.
- Calling the full read tool adds unrelated selectors, code summaries, and context lines.

**Evidence**: `file-mentions.ts:168-208`, `agent-session.ts:7608-7618`, and the runtime probe above.

## 2. Use a restricted selector after literal precedence

**Decision**: Recognize only a terminal `:N` or `:N-M` suffix. Reuse `probeLiteralPathExists` before interpreting a candidate.

**Rationale**: Existing filenames may contain colons. The shared probe handles dangling links, ambiguous access errors, and Windows alternate data streams.

Keep exact literal resolution when the probe reports `exists`. Do not strip the suffix when it reports `unknown`. Interpret a range only for `missing`.

Validate positive safe integers and ordered bounds before reading the base file. Resolve that base through the existing mention path rules.

**Alternatives considered**:

- Stripping a suffix after any failed `stat` could disclose a different file after an access error.
- The full read-selector parser accepts extra formats and gives `:N` different semantics.
- A second filesystem-probe implementation would duplicate platform-specific behavior.

**Evidence**: `tools/path-utils.ts:205-255` and `utils/file-mentions.ts:57-71`.

**Punctuation clarification during task generation**: A runtime extractor probe returned `file` for unquoted `@file:` and `file:` for `@"file:"`.

Preserve this existing distinction. The unquoted form is ordinary punctuation, not an empty selector. The quoted form never falls back to the base file.

This follows the specification's existing punctuation rule and avoids changing the tokenizer for an unrelated ambiguity.

## 3. Separate real source paths from attachment labels

**Decision**: Keep real paths in private resolution state. Store the effective range label in the existing attachment `path` string.

For example, requesting `note.txt:4-9` from a five-line file yields the attachment label `note.txt:4-5`.

**Rationale**: Model conversion, transcript display, history, and persistence already carry that string without reopening it as a file.

The existing message shape needs no new field or migration. Distinct requested ranges remain separate entries even when clipping produces identical effective labels.

**Alternatives considered**:

- New range fields would require serializer and renderer changes without adding necessary behavior.
- Deduplication by base path would lose distinct selections.
- A range suffix in a hashline header would name the wrong edit target.

**Evidence**: `session/messages.ts:1045-1082`, `packages/tui/src/chat/transcript-render-helpers.ts:160-183`, and the downstream consumer review.

## 4. Select source lines before output truncation

**Decision**: Normalize line endings with `normalizeToLF`. Use `splitAddressableFileLines` for ranged text. Clamp the end and select exactly the requested span.

Apply existing output limits only after selection. Keep the 5 MiB source-file auto-read limit before text loading.

**Rationale**: Truncating the whole-file prefix first could remove a valid selection near the end. The shared splitter excludes the final newline sentinel.

A selected blank line is valid even when its joined text is empty. Detect an empty selection by line count, not string truthiness.

Preserve the current whole-file path. Its existing line counts and formatting are not part of this change.

**Alternatives considered**:

- A new streaming reader is unnecessary under the existing bounded source-file policy.
- Whole-file read-tool output may include lines outside the requested range.
- Normalizing unrelated whole-file output would expand the change scope.

**Evidence**: `edit/normalize.ts:11-14`, `packages/tui/src/tools/hashline-format.ts:39-43`, and `file-mentions.ts:289-319`.

## 5. Preserve snapshot and displayed-line integrity

**Decision**: Record the complete normalized file from the same saved read. Keep the real source path in the hashline header.

Use `formatNumberedLines(selectedBody, originalStartLine)` for displayed source rows. Record their provenance with `recordSeenLinesFromBody`.

Append truncation notices after source numbering and provenance recording. Do not number notices as source lines.

**Rationale**: A fragment is not a valid full-file snapshot. Source coordinates must remain correct for later edits.

The current mention producer records full snapshots but does not record displayed-line provenance. The new range path must not imply that the whole source was displayed.

Reuse the read tool's provenance pattern only for the new range output. Do not refactor unrelated whole-file behavior.

An overlong selected line keeps the current UTF-8-safe prefix policy. Its notice uses the original line number. No omitted source line gains provenance.

**Alternatives considered**:

- Recording the selected fragment would corrupt snapshot identity.
- Numbering an appended notice would create false source coordinates.
- Re-reading for the snapshot could associate displayed content with a different file version.

**Evidence**: `tools/read.ts:1491-1497`, `file-mentions.ts:308-317`, `packages/tui/src/tools/hashline-format.ts:24-43`, and `crates/pi-edit/src/store.rs`.

## 6. Retain limits and format offsets explicitly

**Decision**: Keep 3,000-line and 50 KiB inline limits. Keep the selected body and notice separate until final assembly.

Reuse `truncateHead`, `truncateHeadBytes`, and `formatHeadTruncationNotice`. Supply the original start and full source line count to coordinate-aware notices.

Use the effective selected line count for the live attachment's `lineCount`. The label describes the effective selection before inline truncation.

**Rationale**: These helpers already implement the current output policy. Explicit source offsets prevent hardcoded line 1 notices for later selections.

**Alternatives considered**: Raising limits or bypassing the source-file limit would change independent safety and memory policies.

**Evidence**: `packages/tui/src/tools/streaming-output.ts:9-14,1541-1552` and `file-mentions.ts:74-104`.

## 7. Verify content, first-request timing, and visible output

**Decision**: Extend filesystem-backed mention tests and add one session-level first-request regression. Use generated source-line identities and a fixed printed seed.

The provider capture uses real mention preparation and `convertToLlm`, with a deterministic provider response and no tools.

Capture the first request inside the provider handler. Do not rely on post-turn mutable message references or a model's answer.

Run the source CLI separately to observe the actual attachment row. Keep that smoke separate from the permanent tests.

**Rationale**: Correct editor text alone did not satisfy this feature. Generated attachment content and first-request capture test the required behavior.

**Alternatives considered**:

- Mocking the attachment producer would only test forwarding.
- A UI label test alone could pass while source content was absent.
- A real model's answer cannot prove that no later read supplied the content.

**Evidence**: `test/file-mentions.test.ts`, `test/agent-session-plan-reference-setup-bail.test.ts`, `test/agent-session-video-attachment.test.ts`, and `test/session-messages.test.ts`.

## Resolved scope

No technical clarification remains. No new configuration, dependencies, message schema, editor behavior, or standalone CLI attachment behavior is required.

The constitution contains unfilled template text, not concrete project gates. Current repository instructions remain applicable.

The setup script reported feature label `004-attach-file-ranges`. `git branch --show-current` reported `main`. Planning does not create or switch a branch.
