---

description: "Task list for Task Effort Matches Auto Mode Levels"
---

# Tasks: Task Effort Matches Auto Mode Levels

**Input**: Design documents from `specs/008-task-effort-mapping/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/task-effort.md, quickstart.md

**Tests**: Included. SC-001 needs a check against a slow reference, and AGENTS.md needs property tests. Do not add tests that check prompt wording.

**Organization**: Tasks are grouped by user story. US1 and US2 are both P1. US3 (P2) changes no production code. It only moves the existing ceiling tests to the new values.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an open task)
- **[Story]**: The user story the task belongs to (US1, US2, US3)

## Path Conventions

- TUI package: `packages/tui/src/`
- Coding agent package: `packages/coding-agent/src/`, tests in `packages/coding-agent/test/`
- Docs: `docs/`
- Run each command from the repository root.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Record a baseline, so a later failure can be compared with the state before the change.

- [X] T001 Run `bun test packages/coding-agent/test/auto-thinking-classifier.test.ts packages/coding-agent/test/task/executor-pass-through.test.ts packages/coding-agent/test/task/task-batch.test.ts` and record which tests pass before any edit (no file change)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Change the effort type that every story uses.

**⚠️ CRITICAL**: Finish this phase before you start US1 or US2.

- [X] T002 In `packages/tui/src/thinking.ts`, set `TASK_EFFORTS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] as const`, keep `TaskEffort` as `(typeof TASK_EFFORTS)[number]`, and change both doc comments to say "the auto-mode ladder `low..max`"
- [X] T003 [P] In `packages/tui/src/tools/task.ts`, change `TaskItem.effort` (line 2139) and `TaskParams.effort` (line 2166) from `"lo" | "med" | "hi"` to `TaskEffort` imported from `../thinking`, and change both doc comments to "Per-spawn thinking level on the auto-mode ladder, mapped onto the resolved model's eligible levels"

**Checkpoint**: The new type exists. `resolveTaskEffortLevel` does not compile until T011. This is expected.

---

## Phase 3: User Story 1 - Delegating agent requests a level on the auto-mode ladder (Priority: P1) 🎯 MVP

**Goal**: The task tool accepts only `low|medium|high|xhigh|max`, and its description lists each level with the auto classifier criterion.

**Independent Test**: With `task.enableEffort: true`, the tool description lists the five levels with criteria. A spawn with `effort: "xhigh"` starts. A spawn with `effort: "med"` fails with an error that lists the five values (quickstart.md step 4).

### Implementation for User Story 1

- [X] T004 [P] [US1] Create `packages/coding-agent/src/auto-thinking/criteria.ts` and move `LEVEL_CRITERIA` and `MAX_CRITERION` into it from `packages/coding-agent/src/auto-thinking/classifier.ts` (lines 48-63) as named exports. In `classifier.ts`, import them and keep `BUCKET_CRITERIA` and `buildQuestionSet` working with no text change. Type `LEVEL_CRITERIA` with its own `"low" | "medium" | "high" | "xhigh"` key union in `criteria.ts`, so the file does not depend on `classifier.ts`
- [X] T005 [P] [US1] In `packages/coding-agent/src/task/types.ts` line 46, set `effortRule = '"low" | "medium" | "high" | "xhigh" | "max"'` and keep the sync comment that points at `TASK_EFFORTS`
- [X] T006 [US1] In `packages/coding-agent/src/task/index.ts`, change the `validateEffort` message (line 232) to list the values from `TASK_EFFORTS`, for example `Use "low", "medium", "high", "xhigh", or "max".` Then, in `renderDescription` (line 176), pass `effortLevels: [...Object.entries(LEVEL_CRITERIA).map(([level, criterion]) => ({ level, criterion })), { level: "max", criterion: MAX_CRITERION }]` imported from `../auto-thinking/criteria`. Build the list once at module scope, not on each render
- [X] T007 [US1] In `packages/coding-agent/src/prompts/tools/task.md` line 16, replace the `effort` line inside `{{#if effortEnabled}}` with the format from `specs/008-task-effort-mapping/contracts/task-effort.md` ("Tool description"), using `{{#each effortLevels}}- \`{{level}}\`: {{criterion}}\n{{/each}}`. Keep the line and spacing compact, like the nearby input lines
- [X] T008 [P] [US1] In `packages/coding-agent/src/task/executor.ts` line 472, change the `effort` doc comment from "coarse effort (`lo`/`med`/`hi`)" to "auto-mode effort (`low`..`max`)"

**Checkpoint**: The schema, validator, and description use the five levels. `task-batch.test.ts` still passes, because it only checks that `` `effort` `` is present or absent.

---

## Phase 4: User Story 2 - Requested level maps proportionally onto the subagent model's supported range (Priority: P1)

**Goal**: `resolveTaskEffortLevel` picks the first eligible level with `k·5 ≥ i·n`. Eligible levels ignore anything below `low` (as auto mode does).

**Independent Test**: The exhaustive test in T010 passes, and the quickstart.md step 3 smoke script prints the expected rows.

### Tests for User Story 2

- [X] T009 [US2] In `packages/coding-agent/test/auto-thinking-classifier.test.ts`, replace the test "maps task effort selectors onto each model's supported thinking range" (lines 420-483) with one exhaustive test. For each of the 63 non-empty ordered subsets of `THINKING_EFFORTS` (build a mock model with `buildModel({ thinking: { mode: "effort", efforts: subset } })`) and each of the 5 `TASK_EFFORTS`, compare `resolveTaskEffortLevel(model, effort)` with a slow reference that computes eligible levels and scans k = 1..n for the first `k/n >= i/5` (float division: ties only occur at n = 5, where both sides are the same double). Also assert these invariants for each subset: (a) results never decrease as the request goes up, (b) `max` gives the last eligible level, (c) `low` gives the first eligible level, (d) no result is `minimal` when the subset has a level at or above `low`. On failure, print the subset and the request
- [X] T010 [US2] In the same file, keep these cases with new values: the ceiling `RangeError` for the high-only model (`Effort.Max`, `Effort.Low`), the devin-shape model returning `undefined` (`Effort.Max`), and no model (each task level resolves to itself)

### Implementation for User Story 2

- [X] T011 [US2] In `packages/tui/src/thinking.ts`, add one private helper `autoEligibleEfforts(supported)`, which returns the supported levels at or above `Effort.Low`, or all supported levels when none qualifies. Use it in `clampAutoThinkingEffort` (replacing lines 257-260 with no behavior change). Rewrite the body of `resolveTaskEffortLevel` (lines 292-305): return `undefined` for an empty supported list, compute `i = TASK_EFFORTS.indexOf(effort) + 1` and `eligible`, and select the first `eligible[k-1]` with `k * TASK_EFFORTS.length >= i * eligible.length`. Keep the ceiling block (lines 306-313) unchanged. Update the doc comment to describe the position rule

**Checkpoint**: T009 and T010 pass. `bun check` passes.

---

## Phase 5: User Story 3 - Operator ceiling still limits the mapped level (Priority: P2)

**Goal**: `task.maxEffort` still clamps the mapped level, and the spawn still fails when the ceiling is below the model floor.

**Independent Test**: `bun test packages/coding-agent/test/task/executor-pass-through.test.ts` passes.

### Tests for User Story 3

- [X] T012 [US3] In `packages/coding-agent/test/task/executor-pass-through.test.ts`, change `effort: "hi"` to `effort: Effort.Max` (`TaskEffort` is the `Effort` enum subset) at lines 410, 439, and 463. Keep each expected result (ceiling `low` → `low`, the below-floor error text, and the default ceiling result), and make sure each still holds under the new mapping

**Checkpoint**: All three stories work.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T013 [P] In `docs/tools/task.md`, change the `effort` type in the field table (line 42) to `"low" \| "medium" \| "high" \| "xhigh" \| "max"`. Replace "lowest/middle/highest level" with the position rule (request at i/5, eligible levels at or above `low` at k/n, first k with k/n ≥ i/5, then `task.maxEffort`). Make sure line 29 still reads correctly
- [X] T014 [P] In `docs/task-agent-discovery.md` line 43, replace "coarse `effort` (`lo`, `med`, `hi`) ... lowest, middle, or highest supported effort" with the five levels and the same position rule
- [X] T015 [P] In `packages/coding-agent/CHANGELOG.md`, add an entry under `## [Unreleased]` → `### Changed` (create the subsection if it is missing). The entry says the task `effort` field now uses `low|medium|high|xhigh|max` with the auto classifier criteria, maps by position onto the model's levels at or above `low` ("next upper"), and no longer accepts `lo|med|hi`
- [X] T016 Run `PATH="$HOME/.cargo/bin:$PATH" bun check` and fix every error in the touched files (type checks pass; the only remaining format error is in the unmodified `session-focus-controller.ts` on `main`)
- [X] T017 Run the three test files from T001 and compare the results with the T001 baseline
- [X] T018 Run the smoke steps in `specs/008-task-effort-mapping/quickstart.md` (done with a throwaway `bun test` file so that workspace imports resolve: real catalog models, the rendered description, and a stale `"med"` call), then delete the throwaway file

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Phase 1. Blocks US1 and US2.
- **US1 (Phase 3)** and **US2 (Phase 4)**: depend on Phase 2. They touch different files, so they can run in parallel.
- **US3 (Phase 5)**: depends on US2 (T011), because the test results come from the new mapping.
- **Polish (Phase 6)**: T013-T015 can start after Phase 2. T016-T018 need all earlier tasks.

### User Story Dependencies

- **US1**: needs T002 only.
- **US2**: needs T002 only.
- **US3**: needs T011.

### Within Each User Story

- US1: T004 and T005 in parallel, then T006 (imports from T004), then T007 (uses `effortLevels` from T006). T008 can run at any time.
- US2: T009 and T010 first (they fail), then T011 (they pass).

### Parallel Opportunities

- T003 runs in parallel with T002's dependents in other files.
- T004, T005, and T008 run in parallel (three files).
- All of US1 runs in parallel with all of US2.
- T013, T014, and T015 run in parallel (three files).

---

## Parallel Example: User Story 1

```text
Task: "T004 Create packages/coding-agent/src/auto-thinking/criteria.ts and import it in classifier.ts"
Task: "T005 Set effortRule in packages/coding-agent/src/task/types.ts"
Task: "T008 Update the effort doc comment in packages/coding-agent/src/task/executor.ts"
```

## Parallel Example: User Story 1 with User Story 2

```text
Agent A: T004 → T005 → T006 → T007 → T008   (US1: coding-agent task tool and prompt)
Agent B: T009 → T010 → T011                  (US2: packages/tui/src/thinking.ts and its test)
```

---

## Implementation Strategy

### MVP First

1. Finish Phase 1 and Phase 2.
2. Finish US1 and US2 together. Both are P1, and US1 alone does not compile without T011.
3. Stop and run T016 and T017.

### Incremental Delivery

1. Phase 1 + Phase 2 → the new type.
2. US1 + US2 → new vocabulary and mapping (MVP).
3. US3 → ceiling tests on the new values.
4. Polish → docs, changelog, smoke.

---

## Notes

- Do not add an alias or translation for `lo|med|hi`.
- Do not add tests that check prompt wording. Check the description by the smoke step only.
- No new config key, so `~/.omp/agent/config.yml` does not change.
- Commit with the smart-commit skill after T018.

---

## Phase 7: Convergence

- [X] T019 Change the stale-value error text in `specs/008-task-effort-mapping/contracts/task-effort.md` (Errors table) to the implemented message `Use one of "low", "medium", "high", "xhigh", "max".` per plan: contracts/task-effort.md (partial)
- [X] T020 Correct the tie comment in `packages/coding-agent/test/auto-thinking-classifier.test.ts` (reference function): ties occur at n = 5 and at the shared `max` endpoint (1 === 1), and both sides are the same double per SC-001 (partial)
