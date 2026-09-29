# Implementation Plan: Compact Todo HUD

**Branch**: `006-compact-todo-hud` | **Date**: 2026-09-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-compact-todo-hud/spec.md`

## Summary

The one-line todo summary already exists as the short-terminal fold. This plan makes it a layout that the user can select. It has four parts:

1. **Layout state.** A `TodoHudLayout` (`full | preview | compact`) replaces the `todoExpanded` boolean. The selected layout is a command override over the `todo.hud` setting. The design copies `#pinnedHudOverride` ([research D2](./research.md#d2--how-to-model-the-layout-state)).
2. **Trigger.** `isCompactTodoMode()` returns true for the `compact` layout or for a short terminal. The existing containers do the rest ([D1](./research.md#d1--where-the-one-line-layout-lives-today), [D3](./research.md#d3--the-displayed-layout-and-the-short-terminal-override-fr-010)).
3. **Summary fixes.** Add the blocked count. Fall back to a blocked task as the current task. Shorten the task text first. Suppress the summary when the HUD is hidden ([D5](./research.md#d5--summary-text-fr-003-fr-004), [D6](./research.md#d6--shortening-order-fr-005), [D7](./research.md#d7--a-hidden-or-dismissed-hud)).
4. **Surface.** Add the `/todo compact` verb in the TUI and in ACP, the `todo.hud` setting, the docs, and the divergence entry ([D4](./research.md#d4--the-setting-fr-008), [D8](./research.md#d8--command-behavior-fr-006-fr-007)).

## Technical Context

**Language/Version**: TypeScript on Bun, in `packages/coding-agent`.

**Primary Dependencies**: None new. The plan reuses `truncateToWidth` and `visibleWidth` from `@oh-my-pi/pi-tui`.

**Storage**: One layered-YAML setting, `todo.hud`. Nothing new goes into the session. The existing `revealed` HUD-state entry is reused.

**Testing**: `bun test` in `packages/coding-agent/test/`. The property cases are in [research.md D9](./research.md#d9--what-the-tests-must-prove).

**Target Platform**: Cross-platform CLI under Bun. The change affects only the text-terminal HUD.

**Project Type**: CLI application, monorepo package.

**Performance Goals**: The summary work is O(tasks) per status render, the same as today. There is no new allocation on the path that renders rows.

**Constraints**:
- `AGENTS.md` rules apply: no `any`, `#private` fields, no inline imports.
- The new setting default goes into `~/.omp/agent/config.yml`.
- Tests prove properties with fixed seeds.
- `nextActionableTask` keeps its current behavior.

**Scale/Scope**: About 6 source files, 3 test files, 2 docs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is an unfilled template. It supplies no gates. This plan uses the MUST rules in the repository `AGENTS.md` files.

| Gate | Source | Status |
|---|---|---|
| Reuse existing seams | `AGENTS.md`, ponytail ladder | Pass. The plan reuses the short-terminal fold, the override-over-setting pattern, and the `todo.*` settings block. |
| Clean cutover, no shims | System contract | Pass. `todoExpanded`, `toggleTodoExpansion`, and `setTodoExpanded` are deleted. Every caller moves to `todoLayout` and `setTodoLayout`. |
| Tests prove properties | Global `AGENTS.md` → Tests | Pass. See D9. The test that set `todoExpanded` directly is rewritten. |
| Config default recorded | `.omp/AGENTS.md` local addition | Pass. This is a task. |
| Fork divergence recorded | `UPSTREAM_DIVERGENCES.md` convention | Pass. This is a task. |

**Post-design re-check:** Pass. The design adds one type alias and one setting. It adds no new module and no new abstraction.

## Project Structure

### Documentation (this feature)

```text
specs/006-compact-todo-hud/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── todo-command.md
│   └── compact-summary.md
└── tasks.md             # /speckit.tasks output
```

### Source Code (repository root)

```text
packages/coding-agent/src/
├── tools/settings.ts                          # + cfgTodoHud (todo.hud)
├── modes/types.ts                             # todoExpanded/toggle/setExpanded → todoLayout/setTodoLayout
├── modes/interactive-mode.ts                  # layout state, isCompactTodoMode, #renderTodoList, renderCompactStatusLine, settings handler
├── modes/controllers/todo-command-controller.ts  # compact verb + usage row
└── slash-commands/helpers/todo.ts             # ACP refusal + usage row

packages/coding-agent/test/
├── interactive-mode-todo-clear.test.ts        # layout, width, current-task, precedence, hidden properties
├── input-controller-escape.test.ts            # drop toggleTodoExpansion mock
└── acp-builtins.test.ts                       # compact verb refusal

docs/tools/todo.md                             # /todo compact + todo.hud
UPSTREAM_DIVERGENCES.md                        # "Compact todo HUD" entry
~/.omp/agent/config.yml                        # todo.hud: preview
```

**Structure Decision**: Edit files in place. No file is new except the spec artifacts.

## Implementation Notes

- **Type location.** Export `TodoHudLayout` from `modes/types.ts`, beside `InteractiveModeContext`. The controller and the tests import it from there.
- **Setting type.** `cfgTodoHud.get(settings)` returns `"preview" | "compact"`. This value can be assigned to `TodoHudLayout` with no cast.
- **Width constant.** Define `MIN_TASK_CELLS = 12` next to `TODO_COMPACT_TERMINAL_ROWS_THRESHOLD` (`modes/interactive-mode.ts:628`).
- **Render trigger.** `setTodoLayout` must call `#renderTodoList()` and `ui.requestRender()`. `StatusHudContainer` reads `isCompactTodoMode()` on each render, so it needs no other change.
- **Test access to height.** The harness must control `ui.terminal.rows`. If the test double makes this field read-only, add a test seam only in the test file. Do not change the production API for it.
- **Smoke.** Run the real TUI through `xd://tui` or a real terminal. Follow [quickstart.md](./quickstart.md) steps 1–7.

## Complexity Tracking

No violations.
