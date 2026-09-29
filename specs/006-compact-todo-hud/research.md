# Research: Compact Todo HUD

All paths are relative to `packages/coding-agent/src/` unless noted.

## D1 — Where the one-line layout lives today

- **Decision:** Reuse the short-terminal fold. It has two parts:
  - `TodoHudContainer.render` returns no rows while `isCompactTodoMode()` is true (`modes/interactive-mode.ts:661`).
  - `StatusHudContainer` then calls `renderCompactStatusLine(width, childLines)`. This joins the todo summary to the right side of the last status-HUD row (`modes/interactive-mode.ts:742`, `:4192`).
- **Rationale:** The one-line layout and its placement already exist. Only the trigger is new. FR-002 asks for "the place the short-terminal fallback uses today".
- **Alternatives considered:**
  - A new container or a status-line segment. Rejected. It is a second path for the same output.

## D2 — How to model the layout state

- **Decision:** Replace `todoExpanded: boolean` with a three-value selected layout.
  - Type: `TodoHudLayout = "full" | "preview" | "compact"`.
  - The selected layout is `#todoLayoutOverride ?? cfgTodoHud.get(settings)`.
  - The command sets the override. A `todo.hud` settings change clears it.
- **Rationale:**
  - A boolean cannot store three states. A render branch alone would lose Compact when `/todo expand` then `/todo collapse` runs.
  - The override-over-setting shape copies `#pinnedHudOverride` and `applyPinnedAgentsSetting()` (`modes/interactive-mode.ts:1517–1532`, `:3359`). That code also clears the override when the setting changes.
- **Alternatives considered:**
  - Keep `todoExpanded` and add `todoCompact`. Rejected. Two flags allow the invalid pair (expanded and compact), and callers must check both.
- **Callers to migrate:**
  - `modes/types.ts:194` (`todoExpanded`) and `:423–424` (`toggleTodoExpansion`, `setTodoExpanded`).
  - `modes/controllers/todo-command-controller.ts:159–164`.
  - `modes/interactive-mode.ts` (`#renderTodoList`, `toggleTodoExpansion`, `setTodoExpanded`).
  - `test/interactive-mode-todo-clear.test.ts:572`, which assigns `mode.todoExpanded = true`.
  - `test/input-controller-escape.test.ts:216`, a mock of `toggleTodoExpansion`.
  - `toggleTodoExpansion` has no other caller. Delete it.
- **Session scope (FR-009):** InteractiveMode lives across `/new`, resume, and session switches. `#loadTodoList` and `reloadTodos` reload only the phases. A bare override field would carry `/todo compact` into the next session. Store the override with the id of the main session: `#todoLayoutOverride?: { sessionId: string; layout: TodoHudLayout }`. The getter ignores an override whose `sessionId` differs from `this.session.sessionManager.getSessionId()`. The check runs in the getter, so every switch path is covered with no reset hook. Focusing a subagent view does not change `this.session`, so the override stays.

## D3 — The displayed layout and the short-terminal override (FR-010)

- **Decision:** `isCompactTodoMode()` returns `selected === "compact" || rows < TODO_COMPACT_TERMINAL_ROWS_THRESHOLD`. `#renderTodoList` computes `expanded = selected === "full"`.
- **Rationale:**
  - The override is computed each time the HUD renders, so the selected layout never changes. It comes back when the terminal grows (FR-010).
  - Native hosts read `TodoHudContainer.describe()` and `todoHudNative`. `isCompactTodoMode()` does not affect them. Their fallback tree already uses `expanded`, so on a native host Compact looks like Preview. This matches the native-host edge case.

## D4 — The setting (FR-008)

- **Decision:** Register `cfgTodoHud` in `tools/settings.ts`, next to `cfgTodoEager`:
  - `id: "todo.hud"`
  - `type: "enum"`, `values: ["preview", "compact"]`, `default: "preview"`
  - `ui` tab `tools`, group `Todos`
- **Decision:** Add `if (any("todo.hud")) this.#applyTodoHudSetting()` to the settings-change handler (`modes/interactive-mode.ts:3359`). It clears the override, renders the todo HUD again, and requests a render.
- **Rationale:** `todo.*` settings live in this file. Use the same enum shape as `todo.eager`.
- **Project rule:** Append `todo.hud: preview` to `~/.omp/agent/config.yml`.

## D5 — Summary text (FR-003, FR-004)

- **Decision:** Keep the current text and colors:
  - `TODO` in bold accent.
  - `closed/total` in dim.
  - A dim `·` separator.
  - `#formatTodoLine(task)` for the task.
- **Decision:** Append `· N blocked` in `warning` color when N > 0.
- **Decision:** The current task is `nextActionableTask(phases) ?? first blocked task`. Put the fallback in `renderCompactStatusLine`, not in `nextActionableTask`.
- **Rationale:**
  - `nextActionableTask` has other callers. `modes/interactive-mode.ts:2775` depends on `undefined` when only blocked tasks are open, and `controllers/event-controller.ts:2662` feeds recap text. A change there would change their behavior.
  - Today the fallback shows `☑ done` while blocked tasks are still open. That is the bug that SC-005 names.

## D6 — Shortening order (FR-005)

- **Today:** The right part is capped at 45% of the width, and then the left part is shortened (`modes/interactive-mode.ts:4237`). A long task can use the whole right part while the status text loses its space.
- **Decision:** Shorten the task text first.
  1. `fixed` = the visible width of `TODO a/b · ` plus the blocked suffix.
  2. `taskBudget = width - leftWidth - minGap - fixed - pad`, where `leftWidth` is 0 when no left content exists.
  3. If `taskBudget ≥ MIN_TASK_CELLS` (12), cut the task to `taskBudget` with `truncateToWidth`. Keep the left part whole.
  4. Otherwise, cut the task to `MIN_TASK_CELLS`. Then shorten the left part to fit, as today.
  5. As a final guard, cut the whole line to `width` with `truncateToWidth`. The result is never wider than the terminal.
- **Rationale:** This is the smallest change that gives the order in FR-005. `truncateToWidth` adds the ellipsis.

## D7 — A hidden or dismissed HUD

- **Finding:** `renderCompactStatusLine` ignores `#todoHudHidden`. On a short terminal, a dismissed or auto-cleared HUD still shows `TODO n/n · ☑ done` on the status row.
- **Decision:** Return `childLines` without change when `#todoHudHidden` is true.
- **Rationale:** The spec says that auto-clear removes the summary "as it does for the other layouts". This bug gets more visible when Compact is the default.

## D8 — Command behavior (FR-006, FR-007)

- **Decision:** Use one method, `setTodoLayout(layout)`.
  - `expand` calls `setTodoLayout("full")`.
  - `collapse` calls `setTodoLayout("preview")`.
  - `compact` calls `setTodoLayout("compact")`.
- **Decision:** `full` and `compact` keep the current reveal behavior of `setTodoExpanded(true)`. They cancel the auto-clear timer, set `#todoHudHidden` to false, and persist a `revealed` entry.
- **Rationale:** A user who runs `/todo compact` on a dismissed plan asks to see it. `collapse` keeps its current no-reveal behavior.
- **Decision:** In ACP mode, the non-interactive path (`slash-commands/helpers/todo.ts:280`, `handleTodoAcp`), add `case "compact"` to the existing `expand`/`collapse` refusal. Add a usage row with the `(TUI only)` prefix. Extend `test/acp-builtins.test.ts:910` to cover `compact`.

## D9 — What the tests must prove

Put the tests in `test/interactive-mode-todo-clear.test.ts`, the existing TUI todo harness. Use a fixed, printed seed where input is generated.

1. **Displayed layout:** Generate command sequences from `{expand, collapse, compact}` and terminal heights from `{10, 17, 18, 40}`. After each step:
   - The HUD rows are empty exactly when (last command = `compact`, or the initial setting when no command ran) OR rows < 18.
   - After the terminal grows, the last selected layout shows.
2. **Width bound:** Generate widths 20–300, task lengths 0–400, and left-part lengths 0–200. The line `visibleWidth(combined)` is never more than `width`. When the task is cut, the left part stays whole whenever the space allows `MIN_TASK_CELLS`.
3. **Current-task order (FR-004):** Generate status mixes. The current task is the first `in_progress`, else the first `pending`, else the first `blocked`. It is never a closed task while an open task exists.
4. **Setting precedence:**
   - `todo.hud: compact` starts Compact.
   - A command overrides the setting.
   - A setting change clears the override.
5. **Hidden HUD:** After dismissal, the status row has no todo summary.
6. **Session scope:** After `/todo compact` and a switch to another session, `todoLayout` equals the `todo.hud` setting.

Delete or rewrite the assertion that sets `todoExpanded` directly (`:572`). Do not keep it as a copy of the new field.
