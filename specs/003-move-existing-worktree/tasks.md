# Tasks: Move to an Existing Worktree

**Input**: Design documents in `specs/003-move-existing-worktree/`.

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), and [command contract](contracts/wtmove.md).

**Tests**: No TDD or new permanent test suite was explicitly requested. Use existing tests and runnable acceptance scenarios below.
Keep one small invariant check for new non-trivial logic, following repository rules. Do not create forwarding or wording tests.

**Organization**: Both user stories have priority P1. US1 provides the complete command path. US2 validates its session-preservation guarantees.
The first working increment must already preserve history. US2 is not permission to defer data safety.

## Format: `[ID] [P?] [Story] Description`

Each checkbox is one execution task. `[P]` identifies disjoint work within the ready wave described below.
All paths are repository-relative. New files are identified explicitly.
Run checks after integration, not during parallel edits.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the existing runtime and source contracts without adding infrastructure.

- [X] T001 Verify Bun/native prerequisites from `packages/coding-agent/package.json` and `package.json`. Read the command and picker contracts before editing. Use language-server references before changing exported symbols. Run setup only if required dependencies are absent.

No new dependency, configuration setting, project scaffold, or session schema is needed.
The constitution contains placeholders only and adds no adopted constraint.

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Supply one destination identity and matching contract for both user stories.

- [X] T002 Add destination discovery and shared matching functions in `packages/coding-agent/src/session/session-worktree.ts`. Use native `worktrees()` with live cwd. Canonicalize and deduplicate available roots, exclude the current checkout even from nested cwd, retain primary/external roots, and normalize branch/detached labels.
- [X] T003 Add exact destination validation in `packages/coding-agent/src/session/session-worktree.ts`. Resolve absolute, relative, home-relative, and quoted paths. Accept canonical root aliases. Reject missing, unrelated, ordinary, and nested directories. Distinguish the current-root no-op. Re-query membership before relocation.

**Shared contract**: Discovery returns canonical path values with branch or detached labels. Matching uses case-insensitive branch/path substrings.
The coding-agent controller passes data and the matching callback into the TUI picker. The TUI package must not import coding-agent modules.
Explicit validation must retain the current root long enough to return its no-op result rather than treating it as unrelated.

**Checkpoint**: Discovery and validation perform no Git mutation and require no persistent cache.

## Phase 3: User Story 1 - Select an Existing Worktree (Priority: P1)

**Goal**: Select or complete an existing worktree path and move the current session there.

**Independent Test**: Use the disposable repository in `quickstart.md` with primary, external linked, and detached checkouts.
Confirm discovery, case-insensitive filtering, keyboard selection, explicit paths, cancellation, and correct destination cwd.
Verify that no checkout or branch changes.

### Implementation

- [X] T004 [P] [US1] Create `packages/tui/src/overlays/worktree-selector.ts` using existing `SelectList` and overlay chrome. Accept destination items and the host matching callback. Enable search for every list size. Return only confirmed path values. Support Escape, scrolling beyond 15 results, empty/no-match states, and wrapped full-path details. Use the existing wildcard package export.
- [X] T005 [P] [US1] Add worktree argument completion in `packages/coding-agent/src/slash-commands/builtin-completions.ts` and register it in `packages/coding-agent/src/slash-commands/builtin-registry.ts`. Read live session cwd for each request. Reuse shared discovery/matching and insert usable paths with spaces. Do not change `/move` completion.
- [X] T006 [US1] Add the dedicated handler in `packages/coding-agent/src/modes/controllers/command-controller.ts`. Reject active responses, show discovery progress, distinguish empty/error states, and handle picker cancellation or explicit paths. Enter `#withSessionMove`, revalidate the target, and invoke `#relocateSession`. Preserve existing transition guards and report success only after relocation. Never call directory creation or source cleanup.
- [X] T007 [US1] Register `/wtmove [<path>]` in `packages/coding-agent/src/slash-commands/builtin-lifecycle.ts` and add its context/interactive forwarding methods in `packages/coding-agent/src/modes/types.ts` and `packages/coding-agent/src/modes/interactive-mode.ts`. Retain interactive transition guards. Expose help and discovery. Reject headless use without mutation. Leave `/move` and `/wt` unchanged.
- [X] T008 [US1] Execute the selection and explicit-path scenarios in `specs/003-move-existing-worktree/quickstart.md` through the actual source CLI. Cover empty/single/multiple lists, mixed case, primary/external/detached roots, spaces, symlink aliases, nested cwd, unrelated paths, current-root no-op, ambiguous filters, and cancellation. Record observed results in that guide.

**Checkpoint**: `/wtmove` is a usable vertical slice with existing session-move semantics, not a picker-only scaffold.

## Phase 4: User Story 2 - Continue the Same Conversation (Priority: P1)

**Goal**: Establish that the new command conserves session identity, history, artifacts, and checkout contents.

**Independent Test**: Move a session with a unique message and artifact into an existing worktree containing another saved session.
Restart omp there and resume the moved session. Compare identities, full message sequences, artifact contents, and both checkouts.

### Integration and validation

- [X] T009 [US2] Trace the new handler through `packages/coding-agent/src/modes/controllers/command-controller.ts` and `packages/coding-agent/src/session/session-manager.ts`. Verify settings flush, BTW gating, session relocation, rollback, cwd resource refresh, and todo reload remain on the shared path. Correct only new-handler omissions. Do not duplicate session persistence or bypass guards.
- [X] T010 [P] [US2] Execute the history/artifact/resume scenario in `specs/003-move-existing-worktree/quickstart.md` with isolated sessions. Compare full prior history, session identity, artifact bytes, and existing destination-session contents. Verify unchanged branch refs and tracked/untracked files in both checkouts. Record the observed evidence in the guide.
- [X] T011 [P] [US2] Exercise active-response rejection, stale selections, discovery failure, and relocation failure around `packages/coding-agent/src/modes/controllers/command-controller.ts`. Use disposable sessions and the existing failure-injection patterns from `packages/coding-agent/test/sdk-move-cwd.test.ts`. Confirm retained history, unchanged pre-move state, and no false success. Report evidence without editing T010's guide concurrently.

**Checkpoint**: The same session resumes from the destination. Failure paths retain history and do not silently select another destination.

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Verify compatibility, performance, and user documentation after both stories work.

- [X] T012 Run the focused existing checks in `packages/coding-agent/test/sdk-move-cwd.test.ts`, `packages/coding-agent/test/git-linked-worktree.test.ts`, and `packages/coding-agent/test/acp-builtins.test.ts`. Run the type checks declared in `packages/coding-agent/package.json` and `packages/tui/package.json` after integration. Fix feature-caused failures without changing unrelated behavior.
- [X] T013 Execute the 20-worktree timing and `/move`/`/wt` compatibility scenarios in `specs/003-move-existing-worktree/quickstart.md`. Prove every destination remains reachable and initial/filter rendering stays within one second. Verify `/move` still accepts ordinary directories and `/wt` still creates worktrees with its existing cleanup setting.
- [X] T014 [P] Document `/wtmove`, path completion, history retention, and its distinction from `/move` and `/wt` in `packages/coding-agent/README.md`. Describe current-repository scope and invalid-path behavior without promising headless support.
- [X] T015 [P] Add the completed feature to the existing unreleased section in `packages/coding-agent/CHANGELOG.md`. Describe existing-worktree selection and preserved session history without unrelated changes.
- [X] T016 Consolidate verification results in `specs/003-move-existing-worktree/quickstart.md`. Include T011 evidence, observed timings, commands, and any blockers. Check all acceptance rows below before declaring completion. Do not mark unexercised scenarios as passed.

## Dependencies & Execution Order

```text
T001 -> T002 -> T003
                 |
                 +-> T004 ----+
                 +-> T005 ----+-> T006 -> T007 -> T008
                                                   |
                                                 T009
                                                   |
                                     +-------------+-------------+
                                     |                           |
                                   T010                        T011
                                     +-------------+-------------+
                                                   |
                                                 T012 -> T013
                                                           |
                                               +-----------+-----------+
                                               |                       |
                                             T014                    T015
                                               +-----------+-----------+
                                                           |
                                                         T016
```

### User Story Dependencies

US1 requires the foundation and supplies the command used by US2.
US2 depends on US1 integration, but its preservation scenario runs independently with its own fixture.
Do not split session safety into a later optional release. Both stories are P1.
T006 and T009 touch the controller and must remain sequential.

### Parallel Opportunities

- After T003, T004 and T005 edit separate files using the agreed destination contract.
- After T009, T010 and T011 use separate disposable repositories and session storage.
- After T013, T014 and T015 edit separate documentation files.
- One integration owner handles shared files and consolidates evidence in T016.

## Parallel Example: User Story 1

```text
Ready after T003:
Worker A: T004 — worktree-selector.ts, no coding-agent dependency.
Worker B: T005 — completion builder and registry, using live cwd.
Then integrate T006 and T007 sequentially before exercising T008.
```

## Parallel Example: User Story 2

```text
Ready after T009:
Worker A: T010 — history, artifacts, resume, and unchanged checkout checks.
Worker B: T011 — stale destination and transition failure checks.
Use separate temporary repositories and session directories.
Worker B returns evidence to the integration owner instead of editing the shared guide.
```

## Acceptance Coverage

| Requirement or outcome | Tasks |
|---|---|
| FR-001 command registration | T006, T007, T008 |
| FR-002 keyboard picker and cancellation | T004, T006, T008 |
| FR-003 primary/external worktree scope | T002, T008 |
| FR-004 current/unavailable exclusion | T002, T003, T008 |
| FR-005 branch/detached labels and full paths | T002, T004, T008 |
| FR-006 case-insensitive argument completion | T002, T005, T008 |
| FR-007 path forms and spaces | T003, T005, T006, T008 |
| FR-008 exact registered-root validation | T003, T006, T008 |
| FR-009 history/artifact/resume preservation | T006, T009, T010 |
| FR-010 no checkout or branch mutation | T003, T006, T010 |
| FR-011 cancellation and pre-move failure safety | T006, T008, T011 |
| FR-012 relocation failure and truthful confirmation | T006, T009, T011 |
| FR-013 unchanged existing commands | T007, T012, T013 |
| FR-014 help and discovery | T007, T008, T014 |
| FR-015 explicit ambiguous-result selection | T004, T006, T008 |
| SC-001 one command and selection | T008 |
| SC-002 one-second performance at 20 worktrees | T013 |
| SC-003 complete available-destination coverage | T002, T008, T013 |
| SC-004 complete history/artifact preservation | T009, T010 |
| SC-005 unchanged rejected/cancelled state | T008, T011 |
| SC-006 unchanged checkout contents and branches | T010 |
| SC-007 distinguishable destination labels and paths | T004, T008 |

## Implementation Strategy

### MVP First

Complete setup, foundation, and US1 as the first demonstrable vertical slice.
Reuse protected session relocation from the first successful move. Never substitute `chdir` or a fresh session.
Before release, finish US2 preservation checks and the cross-cutting validation. Both stories remain in the required scope.

### Incremental Delivery

1. Implement destination identity, discovery, and validation.
2. Build the picker and completion in the first parallel wave.
3. Integrate command routing and the protected move operation.
4. Exercise US1 through the actual TUI.
5. Verify US2 with isolated sessions and failure scenarios.
6. Run compatibility checks and measure the 20-worktree interaction.
7. Update documentation and record verified results.

Do not add retries, telemetry, caches, configuration, or service abstractions outside this scope.

## Phase 6: Convergence

Assessment scope: 15 functional requirements, seven success criteria, 25 acceptance scenarios, nine edge cases, and 14 plan decisions.
The constitution remains an unfilled template. Existing T001–T016 remain unchanged.
These findings concern the current implementation, not a branch comparison.

- [X] T017 HIGH — Preserve exact picker-selected root identity in `packages/coding-agent/src/session/session-worktree.ts` and `packages/coding-agent/src/modes/controllers/command-controller.ts`. Separate typed-argument parsing from validation of canonical selection values. Do not trim or normalize whitespace in a selected root. Verify trailing-space and Unicode-space roots cannot resolve to another registered checkout. Cover both successful selection and rejection without alternate moves per US1/AC4, US1/AC19, FR-008, and plan: canonical destination identity (contradicts).
- [X] T018 MEDIUM — Preserve distinguishable whitespace in displayed paths in `packages/tui/src/overlays/worktree-selector.ts` and the worktree completion display. Inspect `packages/tui/src/components/select-list.ts` normalization before choosing the smallest scoped correction. Keep terminal-control sanitization and exact selection values. Verify detached roots `/tmp/worktree  one` and `/tmp/worktree one` remain visually distinct per FR-005, SC-007, and spec: paths with spaces (partial).
- [X] T019 MEDIUM — Make long worktree paths distinguishable in `packages/coding-agent/src/slash-commands/builtin-completions.ts`. Keep the exact path as the completion value. Display branch state and sufficient full-path detail instead of truncating every destination to the same prefix. Verify two detached roots under a shared long prefix in the actual completion dropdown. Preserve `/move` completion behavior per US1/AC3, SC-007, and plan: usable worktree completion (partial).
- [X] T020 MEDIUM — Keep destination paths visible in narrow terminals in `packages/tui/src/overlays/worktree-selector.ts`. Use wrapped or stacked path details when `SelectList` would omit its description column. Verify two detached destinations remain distinguishable at 40 columns and retain keyboard selection and cancellation per FR-005, SC-007, and plan: wrapped full-path details (partial).
- [X] T021 LOW — Validate the source repository before resolving an explicit destination in `packages/coding-agent/src/session/session-worktree.ts`. Outside Git, both existing and missing target paths must explain the repository requirement without moving the session. Preserve target-specific errors inside a repository per spec: outside-repository edge case and FR-011 (partial).

### Dependencies and validation

Complete T017 before T021 because they share the resolver.
Coordinate T018–T020 because path display spans the picker, completion metadata, and shared list rendering.
Avoid global display changes that alter unrelated selectors.
Exercise the concrete counterexamples above and the existing worktree/session checks before marking these tasks complete.

## Phase 7: Convergence

- [X] T022 MEDIUM — Make completion labels distinguishable across mixed-prefix destination sets in `packages/coding-agent/src/slash-commands/builtin-completions.ts`. The common prefix of all matches does not distinguish long-prefix siblings when another destination has a different prefix. Verify three detached destinations: two long-prefix siblings ending in `alpha` and `beta`, plus a destination outside that shared prefix. Confirm the unfiltered dropdown distinguishes both siblings at 80 columns using the actual completion renderer. Preserve exact insertion values, path escaping, live-cwd discovery, and `/move` completion per US1/AC3, SC-007, T019, and plan: usable worktree completion (partial).

## Phase 8: Convergence

- [X] T023 MEDIUM — Keep worktree completion destinations distinguishable after renderer truncation in `packages/coding-agent/src/slash-commands/builtin-completions.ts`. Verify four detached roots shaped as `/tmp/{A,B}/<long-shared-name>{alpha,beta}`. Current suffix labels are distinct before rendering, but each group's `alpha` and `beta` rows become identical at 80 columns. Use path-derived distinctions that remain visible, and check uniqueness across the full match set rather than only pairwise suffixes. Extend the actual-editor regression in `packages/coding-agent/test/session-worktree-move.test.ts` to cover repeated sibling groups, empty and single matches, and sets beyond the visible-row limit. Verify distinguishable rendered rows and exact keyboard insertion, including whitespace-bearing roots. Preserve live-cwd discovery, display escaping, and `/move` behavior per SC-007, US1/AC3, T019, T022, and plan: usable worktree completion and verification design (partial).

## Phase 9: Convergence

- [X] T024 HIGH — Correct Git metadata path parsing in `crates/pi-vcs/src/git/mod.rs` to preserve significant Unicode whitespace. Remove only format delimiters and line endings rather than trimming literal path characters. Add a real-worktree regression whose `.git` pointer targets a metadata directory ending in U+00A0. Create it without a plain-name sibling, then verify exact metadata identity with a plain-name sibling present. Extend `packages/coding-agent/test/session-worktree-move.test.ts` to cover the native boundary rather than only typed-path parsing. Rebuild the native addon. Verify native discovery, quoted explicit paths, picker moves, and discovery from the affected checkout through the actual source CLI. Retain repository membership checks, invalid-root rejection, session preservation, and `/move` and `/wt` compatibility. Update the observed limitation in `specs/003-move-existing-worktree/quickstart.md` after successful verification per FR-003, FR-007, US1/AC4, US1/AC7, T017, and plan: canonical destination identity and native discovery (partial).
