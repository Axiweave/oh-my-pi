---

description: "Implementation tasks for the model profile picker"
---

# Tasks: Model Profile Picker

**Input**: Design documents from `specs/002-model-profile-picker/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [profile-switcher contract](contracts/profile-switcher.md)

**Tests**: The spec does not request test-first development. The focused behavior checks below prove the user journeys without adding a speculative test suite.

**Organization**: Tasks follow the three user stories. The existing Bun and TUI projects need no new setup, dependency, or storage layer.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with other marked tasks when file ownership does not overlap.
- **[Story]**: The user story that owns the task.
- Paths are relative to the repository root.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Use the current project structure without creating scaffolding.

- [X] T001 Identify the bound profile keys and a disposable configuration overlay in packages/coding-agent/src/modes/controllers/input-controller.ts and specs/002-model-profile-picker/quickstart.md

---

## Phase 2: Foundational (Blocking Prerequisite)

**Purpose**: Add the shared style preference before either key behavior uses it.

- [X] T002 Add the `modelProfileSwitchStyle` enum (`picker` default, `cycling` alternative) beside `modelProfile` with settings UI choices in packages/coding-agent/src/config/settings-schema.ts
- [X] T003 Add `modelProfileSwitchStyle: picker` to the user's default ~/.omp/agent/config.yml without changing `modelProfile` or `modelProfiles`

**Checkpoint**: Both key paths can read the same validated style value. T002 blocks US1 and US2; T003 does not block their source work.

---

## Phase 3: User Story 1 - Choose a Profile from a Picker (Priority: P1) MVP

**Goal**: Either profile key opens a searchable picker by default and selects a whole role bundle.

**Independent Test**: With two configured profiles and no style override, press either key. Filter, cancel, reopen, and select. Confirm the active bundle and plan/default role behavior.

### Implementation

- [X] T004 [US1] Add a bottom-anchored profile picker using `SelectList` with `search: "always"`, active-name preselection, no-match text, cancel cleanup, and empty-profile guidance in packages/coding-agent/src/modes/controllers/selector-controller.ts
- [X] T005 [US1] Apply a selected bundle with `session.applyModelProfile(name, plan-or-default-role)` and update status and border without saving the startup profile in packages/coding-agent/src/modes/controllers/selector-controller.ts
- [X] T006 [US1] Route both existing profile-key callbacks to the picker when `modelProfileSwitchStyle` is `picker` in packages/coding-agent/src/modes/controllers/input-controller.ts
- [X] T007 [US1] Exercise search, no-match, cancellation, selection, and both keys with zero, one, and two configured profiles using specs/002-model-profile-picker/quickstart.md; with one profile, cancel without changing state

**Checkpoint**: Default picker selection and cancellation work independently. Do not replace the existing `cycleModelProfile` implementation.

---

## Phase 4: User Story 2 - Retain Key-Based Cycling (Priority: P2)

**Goal**: The `cycling` style retains directional profile cycling and its current track and feedback.

**Independent Test**: Set `modelProfileSwitchStyle: cycling`, press forward and backward keys, and confirm the next and previous bundles and cycle track.

### Implementation

- [X] T008 [US2] Preserve forward and backward calls to the existing `cycleModelProfile` method under the `cycling` style in packages/coding-agent/src/modes/controllers/input-controller.ts
- [X] T009 [US2] Exercise forward and backward cycling, empty configuration, and unresolved-model feedback with specs/002-model-profile-picker/quickstart.md

**Checkpoint**: Both styles work with the same configured profiles.

---

## Phase 5: User Story 3 - Use Direct Profile Commands (Priority: P3)

**Goal**: Keep direct selection, status, and optional startup-profile saving unchanged in either style.

**Independent Test**: Under each style, run `/model-profile`, `/model-profile <name>`, and a scoped save in disposable configuration. Confirm that none opens the picker.

### Implementation

- [X] T010 [US3] Check status, named selection, and global/project save behavior against packages/coding-agent/src/slash-commands/builtin-modes.ts and specs/002-model-profile-picker/contracts/profile-switcher.md in both styles; fix only a proven regression

**Checkpoint**: Direct commands and scope behavior remain intact.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Verify the entire contract and retain only checks that catch a plausible regression.

- [X] T011 Run the end-to-end TUI steps in specs/002-model-profile-picker/quickstart.md and a focused Bun check for picker selection, cancellation, and style dispatch; retain a behavioral regression test only if it covers an uncertain boundary
- [X] T012 Review the new config setting in packages/coding-agent/src/config/settings-schema.ts and ~/.omp/agent/config.yml for agreement with specs/002-model-profile-picker/contracts/profile-switcher.md; update existing user-facing config documentation if it lists model-profile settings

---

## Dependencies & Execution Order

- **Setup**: T001 has no dependency. It locates existing key names and an isolated validation environment.
- **Foundational**: T002 precedes US1 and US2. T003 can proceed after the setting name is fixed and does not block source work.
- **US1**: T004 precedes T005. T005 and T002 precede T006. T007 follows T006.
- **US2**: T008 follows T006 because both touch `input-controller.ts`. T009 follows T008.
- **US3**: T010 follows T006 and T008 so it validates both styles. It changes the slash command only if a regression appears.
- **Polish**: T011–T012 follow the story work. They do not create a new framework or API.

## Parallel Opportunities

- **US1**: After T002, picker work in `selector-controller.ts` (T004–T005) can run beside the user's config update (T003). The key routing task T006 waits for the picker entry point.
- **US2**: A separate reviewer can inspect the cycling contract in `input-controller.ts` while US1 builds the picker, but edits to that file are sequential.
- **US3**: Command behavior can be inspected independently in `builtin-modes.ts`; the final two-style run waits for both key paths. Do not edit shared command code without a demonstrated regression.

## Implementation Strategy

1. Add the setting and ship US1 as the default picker path without removing the old cycle method.
2. Preserve the cycle path under the alternative style and validate each key direction.
3. Confirm the unchanged slash command and save scopes.
4. Run the complete quickstart and keep the final diff limited to behavior the spec requires.
