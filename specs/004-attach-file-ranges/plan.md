# Implementation Plan: Attach File Ranges Before Sending

**Branch**: `main` | **Date**: 2026-09-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-attach-file-ranges/spec.md`

**Setup feature label**: `004-attach-file-ranges`. The setup script returned this as `BRANCH`, but the actual Git branch is `main`.

## Summary

Extend automatic prompt file mentions so `@path:N-M` and `@path:N` attach selected saved text before the first model request.

Keep the existing attachment module and exported interfaces. Reuse literal-path probing, source-line helpers, output limits, and full-file snapshot storage.

Use the existing attachment path field for effective range labels. Keep actual source paths separate for file access and hashline headers.

No editor change, new configuration, dependency, message schema, or standalone CLI attachment change is required.

## Technical Context

**Language/Version**: TypeScript `^7.0.2`, Bun `>=1.4`. Research ran on Bun 1.4.2.

**Primary Dependencies**: Existing workspace packages `pi-agent-core`, `pi-ai`, `pi-natives`, `pi-tui`, and `pi-utils`. No new dependencies.

**Storage**: Saved local files, existing session messages, and the existing native edit snapshot store. No migration.

**Testing**: `bun:test`, real temporary files, deterministic generated source lines, and one first-request session regression.

**Target Platform**: Existing omp CLI platforms. Preserve path-probe behavior for POSIX paths and Windows alternate data streams.

**Project Type**: TypeScript/Bun CLI monorepo with native snapshot and formatting helpers.

**Performance Goals**: Keep source text processing linear in file size under the existing 5 MiB file limit. Do not add model round trips.

**Constraints**: Keep 3,000-line and 50 KiB inline limits. Use exact selections without extra context. Preserve snapshot and source-coordinate integrity.

**Scale/Scope**: One attachment producer, its existing tests, one session regression, and existing documentation. No external interface version change.

## Constitution Check

### Before Phase 0

The constitution contains unfilled template placeholders. It establishes no concrete project-specific gate or mandatory architecture.

| Applicable gate | Result | Basis |
| --- | --- | --- |
| Implement the requested pre-send behavior | Pass | Generation remains before the first model request |
| Reuse existing patterns | Pass | Existing attachment, path, truncation, and snapshot interfaces suffice |
| Preserve security and limits | Pass | Literal precedence, bounded reads, and exact source selection remain explicit |
| Avoid speculative abstraction | Pass | No service, settings, dependency, or message-schema expansion |
| Verify consumer-visible behavior | Pass | Plan includes content, provider-capture, snapshot, and actual UI validation |

### After Phase 1

All gates still pass. The contracts and data model require no exceptions. No unresolved technical clarification remains.

The feature is not implemented by this planning command. The validation guide separates observed research evidence from future implementation checks.

## Project Structure

### Documentation (this feature)

```text
specs/004-attach-file-ranges/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── file-range-mentions.md
└── checklists/
    └── requirements.md
```

`tasks.md` belongs to the later task-generation phase and is not created here.

### Source Code (repository root)

```text
packages/coding-agent/
├── src/
│   ├── utils/file-mentions.ts                 # Production change
│   ├── tools/path-utils.ts                    # Reuse literal-path probe
│   ├── edit/normalize.ts                      # Reuse line normalization
│   └── session/
│       ├── agent-session.ts                  # Existing pre-send caller
│       └── messages.ts                       # Existing model conversion
├── test/
│   ├── file-mentions.test.ts                  # Extend behavior coverage
│   ├── agent-session-file-mentions.test.ts    # Proposed first-request regression
│   └── session-messages.test.ts               # Existing conversion regression
└── CHANGELOG.md                               # Update after implementation proof
packages/tui/src/
├── tools/hashline-format.ts                   # Reuse line and header helpers
├── tools/streaming-output.ts                  # Reuse current limits and notices
└── chat/transcript-render-helpers.ts          # Existing range-label display
 docs/cli-reference.md                         # Explain inline mentions separately
```

**Structure Decision**: Keep production logic local to `file-mentions.ts`. Leave callers, conversion, rendering, and persistence unchanged because their current interfaces carry the result.

The source paths marked for reuse are not planned refactor targets. No general selector or renderer rewrite is required.

## Phase 0: Research Results

See [research.md](research.md) for decisions, evidence, and rejected alternatives.

Resolved questions include literal-path precedence, single-line semantics, output labels, source coordinates, truncation, snapshot provenance, and the first-request verification seam.

Runtime evidence confirmed one whole-file attachment and zero attachments for the same path with `:1-3`.

## Phase 1: Design

### Resolution and selection

1. Keep token extraction and exact-string deduplication unchanged.
2. Recognize only terminal positive decimal `:N` and `:N-M` candidates.
3. Reuse the literal-path probe before interpreting a candidate.
4. Preserve literal paths and refuse selector fallback on inconclusive probes.
5. Validate positive safe bounds and resolve the base source through existing path rules.
6. Keep directory, image, video, and binary inputs outside the range text path.
7. Apply the existing source-file size policy before loading text.
8. Normalize line endings and split addressable source lines once.
9. Reject empty selections and clamp an excessive end to the final line.
10. Select source text before applying inline output limits.

No-suffix mentions retain their current flow. Invalid ranges never retry as whole-base-file attachments.

### Output and snapshots

Use the effective range in `files[].path`. Keep `resolvedPath` and `absolutePath` for their real-source roles.

For ranged output, separate bounded source rows from notices. Reuse existing truncation helpers with original source coordinates.

In hashline mode, record the full normalized file and number only displayed source rows. Record their seen-line provenance before appending notices.

The hashline header names the real source without its range suffix. Snapshot data and selected output derive from the same saved read.

Keep the selected source-line count as live `lineCount`. Existing persistence count adjustments remain unchanged.

### Public contract

See [contracts/file-range-mentions.md](contracts/file-range-mentions.md) for grammar, precedence, delivery, examples, limits, and failures.

See [data-model.md](data-model.md) for transient state, existing message fields, and invariants.

### Verification design

Extend existing filesystem-backed mention tests rather than testing private parser helpers in isolation.

Use deterministic generated line identities with seed `20260925`, printed in test diagnostics. Cover empty, single, boundary, and over-limit inputs.

Assert these properties:

- Agreement with independently tagged source lines, with no out-of-range source content.
- Equivalent selected content for `:N` and `:N-N`.
- Stable selection across supported line-ending and final-newline variants.
- Full-file snapshot identity and original displayed-line coordinates.
- Literal-filename precedence and no whole-file fallback for invalid selectors.
- Independent valid mentions survive invalid or unsupported selections.

Use one session regression with the real generator, real `convertToLlm`, and a deterministic provider handler. Capture the first context by value.

Assert selected source identities in the first request, absent outside identities, preserved prompt text, and zero tool executions.

The provider replacement must not supply or echo attachment content. It only captures the prepared request and returns a terminal response.

After implementation, run a source CLI smoke and observe the actual range-labeled attachment row. Use [quickstart.md](quickstart.md).

### Documentation after implementation

Update `docs/cli-reference.md` to distinguish inline prompt mentions from standalone `@file` launch arguments.

Document single-line and inclusive-range syntax, quoting, saved-file contents, literal precedence, and unchanged limits.

Add an Unreleased changelog entry after runtime proof. Do not claim automatic ranges work until implementation verification passes.

## Complexity Tracking

No gate violations or complexity exceptions. The design uses the existing module and message format.
