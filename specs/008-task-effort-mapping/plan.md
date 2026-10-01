# Implementation Plan: Task Effort Matches Auto Mode Levels

**Branch**: `008-task-effort-mapping` | **Date**: 2026-10-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/008-task-effort-mapping/spec.md`

## Summary

The task tool's per-spawn `effort` changes from `lo|med|hi` to the auto-mode ladder `low|medium|high|xhigh|max`. `resolveTaskEffortLevel` maps the request by position. The request is at i/5. The model's eligible levels (supported levels at or above `low`, the same floor that `clampAutoThinkingEffort` uses) are at k/n. The function picks the first eligible level with `k·5 ≥ i·n`. The `task.maxEffort` ceiling still applies after the mapping, with no change. The tool description lists the five levels with the auto classifier's criteria from one shared source.

## Technical Context

**Language/Version**: TypeScript on Bun (version from root `packageManager`)

**Primary Dependencies**: `@oh-my-pi/pi-tui/thinking` (effort helpers), `@oh-my-pi/pi-catalog` (`Effort`, `THINKING_EFFORTS`), ArkType (task wire schema), the repo prompt template renderer (`prompt.render`, Handlebars-style `{{#each}}`)

**Storage**: N/A

**Testing**: `bun test` (bun:test with `vi` spies). No property-test library is installed. The mapping test enumerates every non-empty supported list (63 lists × 5 requests) against a slow reference.

**Target Platform**: The omp CLI (macOS, Linux, Windows)

**Project Type**: Monorepo CLI and library (`packages/tui`, `packages/coding-agent`)

**Performance Goals**: N/A. The mapping runs once per spawn over at most 6 items.

**Constraints**: No backward compatibility (AGENTS.md). Old `lo|med|hi` values are rejected, not translated. No new config key, so `~/.omp/agent/config.yml` does not change.

**Scale/Scope**: About 10 source and doc files, 2 test files changed. No new package.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template, so it defines no gates. The plan uses the repo rules in AGENTS.md as gates:

| Gate | Status |
|---|---|
| No backward compatibility until required | Pass. `lo|med|hi` are removed everywhere, with no alias. |
| Tests prove a property, not a copy of the body | Pass. The mapping test checks the result against a slow reference and checks invariants (monotonic, `max` → top, `low` → bottom, no result below `low` when the model has one). |
| Reuse existing patterns | Pass. The eligible-level floor is shared with `clampAutoThinkingEffort`. The criteria are shared with the auto classifier. |
| Changelog and docs updated | Pass. `packages/coding-agent/CHANGELOG.md`, `docs/tools/task.md`, and `docs/task-agent-discovery.md` are in scope. |
| New config default appended to `~/.omp/agent/config.yml` | N/A. No new config key. |

Post-design re-check: still passes. The design adds one small module (`auto-thinking/criteria.ts`) so that the task tool does not import the classifier and its judge dependencies. See research R3.

## Project Structure

### Documentation (this feature)

```text
specs/008-task-effort-mapping/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── task-effort.md
└── tasks.md             # /speckit.tasks output
```

### Source Code (repository root)

```text
packages/tui/src/
├── thinking.ts                     # TASK_EFFORTS, TaskEffort, resolveTaskEffortLevel, shared eligible-floor helper
└── tools/task.ts                   # TaskItem/TaskParams effort type → TaskEffort

packages/coding-agent/src/
├── auto-thinking/
│   ├── criteria.ts                 # NEW: level criteria shared by classifier and task tool
│   └── classifier.ts               # imports criteria from criteria.ts
├── prompts/tools/task.md           # effort line lists five levels with criteria
└── task/
    ├── types.ts                    # effortRule → five literals
    ├── index.ts                    # renderDescription passes effortLevels; validateEffort message
    └── executor.ts                 # doc comment only

packages/coding-agent/test/
├── auto-thinking-classifier.test.ts      # replace lo/med/hi block with exhaustive mapping test
└── task/executor-pass-through.test.ts    # "hi" → "max" in the three ceiling tests

docs/tools/task.md
docs/task-agent-discovery.md
packages/coding-agent/CHANGELOG.md
```

**Structure Decision**: Change existing modules in place. Add one module, `auto-thinking/criteria.ts`, to hold the single source of level criteria.

## Complexity Tracking

No gate violations.
