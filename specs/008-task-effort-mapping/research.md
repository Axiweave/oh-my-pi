# Research: Task Effort Matches Auto Mode Levels

The Technical Context has no open NEEDS CLARIFICATION items. This file records the design decisions.

Every dependency in the Technical Context is in this repository. The research read the source directly, so no external best-practice research applies: `packages/tui/src/thinking.ts` (effort helpers), `@oh-my-pi/pi-catalog` `THINKING_EFFORTS` and the catalog `thinking-efforts` rules (many ladders start at `minimal`), `task/types.ts` (ArkType string-literal unions), and the `{{#each}}` templates in `prompts/tools/*.md` (renderer support).

## R1. Where the mapping lives

- **Decision**: Rewrite `resolveTaskEffortLevel` in `packages/tui/src/thinking.ts`. Keep its signature `(model, effort, maxEffort?) => Effort | undefined`.
- **Rationale**: `task/executor.ts:3810-3814` is the only production caller, and it already passes the resolved model and the `task.maxEffort` ceiling. The ceiling block (lines 306-313) stays as it is.
- **Alternatives considered**: A new function next to the old one was rejected because it would leave dead code.

## R2. Eligible levels and position math

- **Decision**: Move the floor logic from `clampAutoThinkingEffort` (lines 257-260) into one private helper: supported levels at or above `Effort.Low`, or all supported levels when none qualifies. Both functions call it. The mapping picks the first eligible level (1-based index k) where `k * 5 >= i * n`. Here i is the 1-based index of the request in `TASK_EFFORTS` and n is the eligible count.
- **Rationale**: One floor rule for auto mode and task effort (clarification Q1). Integer cross-multiplication gives exact comparison with no floating-point error. A match always exists, because k = n satisfies `5n ≥ i·n` for every i ≤ 5.
- **Alternatives considered**: Floating-point `k/n >= i/5` was rejected because `3/5` and similar values do not have an exact binary form. Nearest-position and floor rules were rejected by the user.

## R3. Single source for level criteria

- **Decision**: Move `LEVEL_CRITERIA` and `MAX_CRITERION` from `auto-thinking/classifier.ts` into a new `auto-thinking/criteria.ts`. Export them. The classifier and `task/index.ts` both import from it. `renderDescription` passes `effortLevels: [{ level, criterion }]` to the `task.md` template, which renders them with `{{#each}}`.
- **Rationale**: FR-002 needs the same text in both places. The task tool does not import `auto-thinking/` today. Importing `classifier.ts` would load the judge, tiny-model, and settings modules into the task tool for five strings.
- **Alternatives considered**: A copy of the text in `task.md` was rejected because the two copies would drift. A direct export from `classifier.ts` was rejected because of its import weight.

## R4. Type and schema

- **Decision**: `TASK_EFFORTS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] as const`. `TaskEffort` derives from it. `task/types.ts` `effortRule` becomes `'"low" | "medium" | "high" | "xhigh" | "max"'`. `packages/tui/src/tools/task.ts` uses the `TaskEffort` type instead of the inline literal union.
- **Rationale**: `Effort` enum values are these exact strings, so a wire value is directly an `Effort`. `validateEffort` in `task/index.ts` keeps rejecting stale values that bypass the wire schema. Its message lists the five levels from `TASK_EFFORTS`.
- **Alternatives considered**: Translating `lo|med|hi` from old transcripts was rejected (no backward compatibility, spec FR-001).

## R5. Test strategy

- **Decision**: Replace the `lo|med|hi` test block in `test/auto-thinking-classifier.test.ts:420-483` with one exhaustive test. It enumerates all 63 non-empty ordered subsets of `THINKING_EFFORTS` × 5 requests. It checks each result against a slow reference that compares rationals by brute force, and checks these invariants: results never decrease as the request goes up, `max` gives the top eligible level, `low` gives the bottom eligible level, and no result is below `low` when the model has a level at or above `low`. Keep the existing ceiling-error, no-effort-surface, and no-model cases with the new values. Update the three `effort: "hi"` cases in `test/task/executor-pass-through.test.ts` to `effort: "max"`.
- **Rationale**: AGENTS.md requires property tests with generated input. The input space is small, so a full enumeration covers it with no seed.
- **Alternatives considered**: fast-check is not installed, and an exhaustive loop covers the full space.

## R6. Docs and changelog

- **Decision**: Update `docs/tools/task.md` (schema line 29, field row 42), `docs/task-agent-discovery.md:43`, the `executor.ts:472` doc comment, and the `TaskItem.effort` doc in `packages/tui/src/tools/task.ts`. Add a `### Changed` entry under `[Unreleased]` in `packages/coding-agent/CHANGELOG.md`.
- **Rationale**: These are the only places that name `lo|med|hi` (from a repository search).
