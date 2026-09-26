---
description: "Executable tasks for automatic pre-send file range attachments"
---

# Tasks: Attach File Ranges Before Sending

**Input**: Design documents from `specs/004-attach-file-ranges/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contract](contracts/file-range-mentions.md), and [quickstart.md](quickstart.md).

**Tests**: Include the specification's independent content and first-request checks. The plan requires filesystem-backed regressions and one session regression.

**Organization**: Each story has its own acceptance checkpoint. Shared production-file edits remain sequential.

## Format: `[ID] [P?] [Story] Description`

- `[P]` identifies independent work in different files after its prerequisites finish.
- `[US1]`, `[US2]`, and `[US3]` map to the specification's stories.
- All source paths are relative to the repository root.
- No task changes Emacs, global settings, dependencies, or the standalone CLI file-argument interface.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the existing workspace can run the feature checks. Do not create new infrastructure.

- [X] T001 Confirm runtime prerequisites from `package.json` and `specs/004-attach-file-ranges/quickstart.md` with `bun --version` and a source-module import.

For T001, import `packages/coding-agent/src/utils/file-mentions.ts` through Bun. Run setup only if dependencies or the native addon are missing.

Do not upgrade the system toolchain. Preserve unrelated working-tree changes and `TODOs.org`.

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the shared interface and safety rules before story changes.

- [X] T002 Trace attachment preparation in `packages/coding-agent/src/session/agent-session.ts` and resolution in `packages/coding-agent/src/utils/file-mentions.ts` against `specs/004-attach-file-ranges/contracts/file-range-mentions.md`.

For T002, confirm these existing interfaces:

- `extractFileMentions(text): string[]` retains token boundaries and exact-string deduplication.
- `generateFileMentionMessages(paths, cwd, options)` runs before model dispatch.
- `probeLiteralPathExists` comes from `packages/coding-agent/src/tools/path-utils.ts`.
- `normalizeToLF`, `splitAddressableFileLines`, and current truncation helpers already exist.
- `FileMentionMessage.path` is a label, but filesystem access and hashline headers require the real source path.

Reuse the literal-path probe, not the full read-selector grammar. A single `:N` will mean one line, not an open-ended read.

Keep all invalid-range safety checks active from the first production change. US3 expands boundary coverage, not permission to ship unsafe intermediate behavior.

**Checkpoint**: No public interface, message migration, or new configuration is required. Story work can start.

## Phase 3: User Story 1 - Attach selected lines automatically (Priority: P1)

**Goal**: A valid `@path:N-M` reaches the model as selected file content before its first response.

**Independent Test**: A saved five-line source yields only its requested lines in the first model request and an effective-range attachment row.

### Tests for User Story 1

- [X] T003 [P] [US1] Add generated selection and snapshot invariants in `packages/coding-agent/test/file-mentions.test.ts` using real temporary files and seed `20260925`.
- [X] T004 [P] [US1] Add first-request capture coverage in `packages/coding-agent/test/agent-session-file-mentions.test.ts` with real prompt preparation and no tools.
- [X] T005 [US1] Run the new cases in `packages/coding-agent/test/file-mentions.test.ts` and `packages/coding-agent/test/agent-session-file-mentions.test.ts` before implementation.

T003 must compare generated source-line identities with attached content. The independent expected result must not call the production parser or selector.

Cover first, middle, and final spans, blank lines, Unicode, supported line endings, and optional final newlines. Print the seed and failing case.

Use a real edit store for snapshot cases. Assert complete normalized snapshot text, original source coordinates, and no provenance for undisplayed lines.

T004 reuses patterns from `packages/coding-agent/test/agent-session-plan-reference-setup-bail.test.ts` and `packages/coding-agent/test/agent-session-video-attachment.test.ts`.

Capture a copy of the first provider context inside the handler. The handler returns a fixed terminal response and does not construct attachment content.

Assert selected identities, absent outside identities, preserved submitted reference text, and zero tool executions. Use isolated settings and temporary storage.

T005 must fail because the selected content is missing, not because imports, credentials, or unrelated setup fail.

### Implementation for User Story 1

- [X] T006 [US1] Add private finite-range resolution with literal precedence and safe bounds in `packages/coding-agent/src/utils/file-mentions.ts`.
- [X] T007 [US1] Generate bounded selected text, effective labels, original line numbers, and full-source snapshots in `packages/coding-agent/src/utils/file-mentions.ts`.
- [X] T008 [US1] Verify both US1 regressions and the actual attachment display using `specs/004-attach-file-ranges/quickstart.md`.

T006 retains the public interfaces. Only a confirmed missing literal candidate permits interpreting `:N-M` as a range.

Existing literals, including dangling links, never fall back to a different source. Unknown probe results do not authorize suffix stripping.

Reject invalid or unsupported selectors without reading the whole base file. Preserve size, binary, directory, image, and video policies.

T007 reads saved source text once for selection and snapshot creation. Normalize line endings and use the existing addressable-line splitter.

Clamp the end, reject empty selections by line count, and select before truncating. Keep existing limits throughout.

Keep source rows separate from notices. Number only source rows, record displayed provenance, and then append unnumbered notices.

Use the real path in hashline headers and the effective range in the attachment label. Do not record a fragment as a full-file snapshot.

For T008, run the source CLI with a disposable text fixture. Confirm a range-labeled attachment row before relying on any model answer.

If parallel agents write T003 and T004, they must skip checks. The integration owner runs T005 after both return.

**Checkpoint**: US1 supplies selected source content before the first model request. It does not require US2's mixed-mention scenarios.

## Phase 4: User Story 2 - Preserve ordinary mentions and combine selections (Priority: P2)

**Goal**: Whole-file mentions, single lines, and multiple selections coexist without losing content or changing literal-path behavior.

**Independent Test**: One prompt contains a whole-file mention, two distinct selections, and an identical repeated selection with correct attachment identities.

### Tests for User Story 2

- [X] T009 [US2] Add whole-file, single-line, mixed-selection, quotation, literal-name, and punctuation cases in `packages/coding-agent/test/file-mentions.test.ts`.

Verify equivalent content for `:N` and `:N-N`. Equivalent content does not require deduplicating different authored strings.

Verify exact-string deduplication and distinct requested ranges. Include ranges that clip to the same effective span.

Create different content in a base file and a literal selector-shaped filename. Assert that the literal file wins.

Cover quoted paths with spaces through the real extractor and generator. Preserve ordinary image, directory, and binary mention behavior.

Preserve the punctuation distinction: unquoted `@file:` means ordinary `@file`. Quoted `@"file:"` never falls back to `file`.

### Implementation for User Story 2

- [X] T010 [US2] Add single-line selection and preserve mixed-mention identity and literal behavior in `packages/coding-agent/src/utils/file-mentions.ts`.
- [X] T011 [US2] Verify mixed attachments and ordinary mentions through `packages/coding-agent/test/file-mentions.test.ts` and `specs/004-attach-file-ranges/quickstart.md`.

Run T009 before T010. New single-line cases must expose the missing behavior if T006 implemented only finite ranges.

T010 maps `:N` to equal inclusive bounds. Reuse T006's validation and T007's output path without duplicating them.

Do not change the tokenizer merely to add selector support. Do not add path-only or effective-label deduplication.

For T011, submit the mixed prompt in the source CLI. Observe separate range rows and the unchanged whole-file attachment.

**Checkpoint**: US2's mixed prompt works independently of US3's boundary matrix. Existing no-suffix behavior remains intact.

## Phase 5: User Story 3 - Keep invalid selections bounded (Priority: P2)

**Goal**: Invalid, clipped, unsupported, and oversized selections never disclose unintended source content.

**Independent Test**: A prompt mixes invalid selections with a valid mention. Only permitted source content appears, and limits remain unchanged.

### Tests for User Story 3

- [X] T012 [US3] Add invalid-bound, source-type, truncation, and provenance boundary cases in `packages/coding-agent/test/file-mentions.test.ts`.

Cover zero, negative, reversed, fractional, unsafe integer, open-ended, compound, missing-file, empty-file, and start-past-end cases.

Include end clipping, one blank source line, selected output near 3,000 lines and 50 KiB, and source files around 5 MiB.

Check an oversized first selected line at a non-one source offset. The notice must use the original coordinate and preserve valid UTF-8.

Verify unsupported directory, image, video, and binary ranges disclose no source content. Keep independent valid mentions available.

Test literal probe failures deterministically, without depending on host permissions or administrator behavior. Preserve safe outcomes for unknown results and dangling links.

Test real literal-name behavior on platforms that support those names. Do not introduce platform-dependent failures into the full suite.

### Implementation for User Story 3

- [X] T013 [US3] Complete rejection, clipping, skip-label, and truncation-coordinate behavior in `packages/coding-agent/src/utils/file-mentions.ts` against the boundary matrix.
- [X] T014 [US3] Verify invalid selections and output-limit invariants through `packages/coding-agent/test/file-mentions.test.ts` and `specs/004-attach-file-ranges/quickstart.md`.

Run T012 before T013. Already-covered safety cases may pass immediately. Change only behavior that violates the contract.

Do not relax limits, add retries, or read the whole base file as a fallback. Keep incomplete skip labels distinct from effective selections.

Record provenance only for displayed source rows. Truncation notices and omitted lines must not gain source coordinates.

For T014, run the boundary cases and the direct generated-content probe. Confirm the valid companion mention survives invalid inputs.

**Checkpoint**: All three stories satisfy their acceptance cases without extra source content or model read actions.

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Verify the complete feature and document the observed behavior.

- [X] T015 Run all targeted regressions, the source CLI smoke, and repository checks from `specs/004-attach-file-ranges/quickstart.md` after production edits finish.
- [X] T016 [P] Document inline single-line and range attachments separately from launch arguments in `docs/cli-reference.md` after T015 feature checks pass.
- [X] T017 [P] Add the verified pre-send range attachment behavior under Unreleased in `packages/coding-agent/CHANGELOG.md` after T015 feature checks pass.
- [X] T018 Record observed validation results and remaining environment blockers in `specs/004-attach-file-ranges/quickstart.md` without claiming unrun checks.

T015 runs the mention tests, new session regression, existing session-message tests, direct content probe, and actual submitted attachment display.

Run `bun run check` once after all code edits finish. Tests alone do not replace the source CLI smoke.

Implementation gate result: targeted tests, source CLI smoke, changed-file lint and formatting, and coding-agent type checks passed.
The repository check remains blocked by formatting in `selector-controller.ts` and `model-profile-picker.test.ts`, which this feature did not change.
The check runner interrupted Rust checks after that failure.
T015 records the completed check run, not a passing repository check.
T016 and T017 proceed on the passing feature checks and retain the separate repository blocker in the verification record.

T016 documents inclusive bounds, one-line selectors, quotes, literal precedence, colon punctuation, saved-file content, and unchanged limits.

T018 distinguishes actual passes from blocked checks. Remove only disposable fixtures and probes created for verification. Do not delete user files.

## Dependencies & Execution Order

### Phase Dependencies

```text
Setup T001
  -> Foundation T002
  -> US1: (T003 + T004) -> T005 -> T006 -> T007 -> T008
  -> US2: T009 -> T010 -> T011
  -> US3: T012 -> T013 -> T014
  -> T015 -> (T016 + T017) -> T018
```

### User Story Dependencies

- US1 depends on setup and foundation only.
- US2 reuses US1's selection and attachment output path.
- US3 reuses the established selector and formatter, then completes their boundary validation.
- Each story has a separate acceptance scenario. This does not make shared-file edits safe to run concurrently.

### Within Each User Story

1. Write behavior checks before related production changes.
2. Run new checks against the current behavior.
3. Implement only the contract differences.
4. Run the story's acceptance checks and smoke scenario.
5. Continue to the next story after the checkpoint passes.

The integration owner owns `packages/coding-agent/src/utils/file-mentions.ts` and serializes all edits to that file.

## Parallel Execution Examples

### User Story 1

After T002, separate agents may write T003 and T004 concurrently:

```text
Agent A: T003, packages/coding-agent/test/file-mentions.test.ts
Agent B: T004, packages/coding-agent/test/agent-session-file-mentions.test.ts
Integration owner: wait for both, then run T005 and implement T006–T008
```

Neither agent runs checks during shared work. They use the existing exported interfaces and separate temporary test state.

### User Story 2

T009–T011 remain sequential. They share the attachment producer and its main behavior test file.

A read-only review of the US2 contract may accompany T009. It must not edit the same test file or execute shared checks.

### User Story 3

T012–T014 remain sequential. Boundary checks define the behavior T013 must satisfy.

A read-only review of truncation and snapshot invariants may accompany T012. Production changes wait for the completed matrix.

### Cross-cutting documentation

After T015, T016 and T017 can run concurrently because they edit different files. T018 waits for both.

## Requirement Coverage

| Requirement | Tasks |
| --- | --- |
| FR-001, finite ranges and single lines | T003, T006, T009, T010 |
| FR-002, attachment before first request | T004, T005, T008, T015 |
| FR-003, one-based inclusive bounds | T003, T006, T009, T010, T012 |
| FR-004, no source outside the selection | T003, T004, T007, T012, T014 |
| FR-005, source and effective range identity | T007, T008, T011, T013 |
| FR-006, original source line labels | T003, T007, T012, T014 |
| FR-007, existing behavior and literal precedence | T006, T009, T010, T012 |
| FR-008, distinct ranges and repeated mentions | T009, T010, T011 |
| FR-009, end clipping | T007, T012, T013, T014 |
| FR-010, invalid and empty selections | T006, T007, T012, T013, T014 |
| FR-011, limits and honest truncation | T007, T012, T013, T014 |
| FR-012, independent valid mentions survive failures | T009, T012, T013, T014 |
| FR-013, editor and typed text equivalence | T004, T008, T011 |
| FR-014, saved content during preparation | T003, T004, T007 |
| SC-001 and SC-002, initial content and exact selection | T004, T008, T014, T015 |
| SC-003, compatibility and mixed selections | T009, T010, T011, T015 |
| SC-004, no unintended content | T012, T013, T014, T015 |
| SC-005, visible file and range | T008, T011, T015 |

## Implementation Strategy

### MVP First

Complete setup, foundation, and US1 as the first demonstrable increment. It must already retain input validation, output limits, and snapshot safety.

US1 is an acceptance checkpoint, not permission to omit US2 or US3 from the requested deliverable.

### Incremental Delivery

1. Prove finite range attachment before the first model request.
2. Add single-line and mixed-mention compatibility.
3. Complete invalid-selection and output-limit boundary coverage.
4. Run final checks and document the observed behavior.

### Parallel Team Strategy

Use parallel work only for T003/T004 and T016/T017. Keep shared production and main-test-file edits under one integration owner.

No branch creation, commit, or push is implied by this task list.

## Notes

- Total tasks: 18. US1: 6. US2: 3. US3: 3. Setup and foundation: 2. Cross-cutting: 4.
- All tasks start unchecked because this command generates tasks, not the implementation.
- The constitution contains only template placeholders and adds no concrete project gates.
- Scope excludes `#L`, open-ended and compound selectors, new settings, and broader read-tool behavior.
- No permanent test should assert helper names, source text, mock forwarding, or incidental wording.
- Keep existing attachment limits and failure policy unless the feature contract explicitly changes them.
