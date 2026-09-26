# Feature Specification: Attach File Ranges Before Sending

**Feature Branch**: No branch created. This specification does not require a branch change.

**Created**: 2026-09-25

**Status**: Draft

**Input**: User description: "now make file:1-3 to read content in advance and sent throguh prompt like we do for filename without line number"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Attach selected lines automatically (Priority: P1)

A user sends `@TODOs.org:1-3` in a prompt. Omp reads lines 1 through 3 before it sends the prompt to the model. The model receives those lines as attached file content, without a later read request.

**Why this priority**: The current reference remains plain text. Users expect the same automatic attachment behavior as `@TODOs.org`, limited to their selected lines.

**Independent Test**: Submit a range from a file with distinct line contents. Inspect the initial model-bound prompt and the visible attachment. Confirm that only the requested source lines appear in that attachment.

**Acceptance Scenarios**:

1. **Given** a readable file with five distinct lines, **When** the user submits `@TODOs.org:1-3`, **Then** the initial prompt contains lines 1–3 as an attachment.
2. **Given** that attachment, **When** the model first receives the prompt, **Then** it already has the selected content without calling a read tool.
3. **Given** a successful range attachment, **When** the user views the submitted prompt, **Then** the attachment identifies the source file and selected line range.
4. **Given** an editor inserts `@TODOs.org:1-3`, **When** the user submits the prompt, **Then** omp handles it like the same manually typed reference.

---

### User Story 2 - Preserve ordinary mentions and combine selections (Priority: P2)

A user combines whole-file mentions, single-line mentions, and line ranges in one prompt. Each attachment preserves its own source and selected content.

**Why this priority**: Range support must not break existing file attachments or silently lose a second selection from the same file.

**Independent Test**: Submit one whole-file mention and two distinct selections from another file. Compare their attachments with the source files.

**Acceptance Scenarios**:

1. **Given** a readable file, **When** the user submits `@TODOs.org` without a suffix, **Then** omp preserves its existing whole-file attachment behavior and limits.
2. **Given** a file with at least three lines, **When** the user submits `@TODOs.org:3`, **Then** the attachment contains only line 3.
3. **Given** two distinct ranges from one file, **When** the user submits both mentions, **Then** both selections reach the model with separate range identities.
4. **Given** repeated identical range mentions, **When** the user submits the prompt, **Then** omp attaches that selection once.
5. **Given** a path containing spaces, **When** the user submits `@"notes for review.txt:1-3"`, **Then** omp attaches the selected lines from that file.
6. **Given** an existing file whose literal name ends in `:1-3`, **When** the user mentions that exact name, **Then** the existing literal-file behavior takes precedence.

---

### User Story 3 - Keep invalid selections bounded (Priority: P2)

A user mistypes a range or selects beyond the end of a file. Omp must not substitute the whole file or unrelated content.

**Why this priority**: An invalid selection must not disclose more source content than the user requested.

**Independent Test**: Submit reversed, zero-based, missing-file, and out-of-bounds selections alongside one valid mention. Confirm that invalid selections attach no source content and the valid mention still works.

**Acceptance Scenarios**:

1. **Given** a five-line file, **When** the user submits `@file.txt:4-9`, **Then** the attachment contains only lines 4–5 and identifies the effective range.
2. **Given** a five-line file, **When** the user submits `@file.txt:6-9`, **Then** omp attaches no source content for that selection.
3. **Given** an empty file, **When** the user requests line 1, **Then** omp attaches no source content for that selection.
4. **Given** `@file.txt:0-3` or `@file.txt:3-1`, **When** the user submits the prompt, **Then** omp attaches no source content for that selection.
5. **Given** a missing or unreadable file, **When** the user submits a range mention, **Then** omp preserves its existing unreadable-mention behavior without blocking other valid mentions.
6. **Given** a selected range that exceeds existing attachment limits, **When** omp prepares the prompt, **Then** it preserves those limits and their existing truncation or skip indications.

### Edge Cases

- Line numbers are one-based. Both endpoints are inclusive. `:N` and `:N-N` select the same source line.
- The first and last source lines are valid selections. A final newline does not create an extra selectable source line.
- Files with or without a final newline produce the same selected source text for equivalent lines.
- Common line-ending styles preserve the same line boundaries. Non-ASCII text remains intact.
- An endpoint beyond the final source line stops at that line. A start beyond it produces no source content.
- Zero, negative, reversed, non-integer, and unrepresentable line numbers never fall back to a whole-file attachment.
- Unsupported selectors, including open-ended ranges, multiple ranges in one suffix, and `#L` suffixes, remain outside this feature.
- Directories, images, binary files, and other non-text attachments do not gain line-selection behavior.
- Existing exact filenames take precedence over interpreting a trailing selector, including filenames containing colons.
- Mixed valid and invalid mentions preserve the valid attachments. The submitted reference text remains in the user prompt.
- Existing quotation and punctuation rules continue to identify mention boundaries.
- A bare trailing colon in unquoted `@file:` remains punctuation, so this is an ordinary whole-file mention, not an empty selector.
- Quoted `@"file:"` preserves the colon. Without that exact literal file, it attaches nothing and never selects the base file.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Omp MUST recognize `@path:N-M` and `@path:N` in user prompts that already support automatic file mentions.
- **FR-002**: Omp MUST attach valid selected text before the first model request for that prompt, without requiring a model-issued read action.
- **FR-003**: Omp MUST interpret line numbers as one-based and inclusive. A single number MUST select exactly one source line.
- **FR-004**: A range attachment MUST exclude source lines outside the effective selection, including extra context lines.
- **FR-005**: Omp MUST identify the source file and effective line range in the attachment sent to the model and shown to the user.
- **FR-006**: Any source line labels MUST retain original file line numbers rather than restart at one for each selection.
- **FR-007**: Omp MUST preserve existing no-suffix mention behavior, path resolution, quotation support, and literal-filename precedence.
- **FR-008**: Distinct selections from the same file MUST remain distinct attachments. Repeated identical mentions MUST not duplicate an attachment.
- **FR-009**: Omp MUST stop a range at the final source line when its end exceeds the file length.
- **FR-010**: Invalid ranges, empty selections, and starts beyond the file end MUST attach no source content and MUST NOT select the whole file.
- **FR-011**: Omp MUST preserve existing attachment size limits, skip rules, and truncation notices. A notice MUST NOT imply that omitted selected content reached the model.
- **FR-012**: Omp MUST preserve existing behavior for missing, unreadable, and unsupported files. A failed selection MUST NOT block independent valid mentions.
- **FR-013**: Typed references and editor-inserted references MUST produce the same attachments when their prompt text and source files match.
- **FR-014**: Range attachment MUST read the saved file content during prompt preparation, just as ordinary file mentions do.

### Key Entities

- **File mention**: A user prompt reference containing a source path and an optional single line or inclusive line range.
- **Requested selection**: The line bounds the user wrote in the reference.
- **Effective selection**: The requested lines that exist in the source file, before existing attachment limits apply.
- **File attachment**: The source identity, effective selection, selected text, and any applicable limit notice included with the prompt.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every valid selection within existing limits reaches the model in the initial prompt, with zero follow-up read actions required.
- **SC-002**: Every such attachment contains all selected source lines and zero source lines outside its effective selection.
- **SC-003**: All acceptance cases preserve whole-file mentions, mixed selections, original line identities, and identical typed versus editor-inserted behavior.
- **SC-004**: Every invalid-selection acceptance case attaches zero unintended source lines and leaves independent valid mentions available.
- **SC-005**: Users can identify each attached file and effective range from the submitted prompt view without opening the source file.

## Assumptions

- The request refers to `@file:1-3` prompt mentions, following the preceding Emacs workflow. Bare `file:1-3` text does not become an automatic attachment.
- Existing prompt submission paths, file access rules, and attachment limits remain the basis for this feature.
- Source content comes from saved files, not unsaved editor buffers.
- Exact existing filenames retain precedence to avoid changing established attachment behavior.
- Invalid selections follow existing unsuccessful-mention behavior. This feature does not add a separate error notification system.
- Only finite inclusive ranges and single-line selectors are in scope. New selector formats, configuration settings, and editor changes are not required.
- This invocation produces a specification and quality checklist. Implementation and Emacs commits remain separate work.
