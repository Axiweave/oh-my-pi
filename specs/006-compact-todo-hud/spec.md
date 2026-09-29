# Feature Specification: Compact Todo HUD

**Feature Branch**: `006-compact-todo-hud`

**Created**: 2026-09-29

**Status**: Draft

**Input**: User description: "Do we have a way to fold the todo list? Only show the current working item and a summary of the todo status. It sometimes takes too much space." Follow-up: "Let's do it; propose your design."

## Context

The todo HUD sits above the input editor in the interactive terminal. It has two layouts today:

- **Preview** (default): the active phase, the last closed task, up to five open tasks, and up to four later phase headers. Long task text wraps, so this layout often uses 8–15 rows.
- **Full** (`/todo expand`): every phase and every task.

A third, one-line layout already exists, but only as an automatic fallback. When the terminal has fewer than 18 rows, the HUD disappears and the status row shows `TODO <closed>/<total> · <current task>` on its right side. The user cannot select this layout on a normal-size terminal.

This feature lets the user select the one-line layout at any time and make it the start layout.

## Clarifications

### Session 2026-09-29

- Q: Which progress count should the one-line compact summary show? → A: The whole-plan count only (`TODO 10/12`). The summary does not show the phase name or the phase count.
- Q: Which layout should a new session start with when the config does not set the todo layout? → A: `preview`. Compact is opt-in through the `todo.hud` config option or `/todo compact`.
- Q: Where should the compact summary show while the agent works? → A: On its own row, directly above the working (spinner) row and below the transcript. It must not share the spinner row, because both texts were cut on a normal-width terminal.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fold the todo HUD to one line on demand (Priority: P1)

During a long plan, the user types `/todo compact`. The multi-row todo tree goes away. The status row shows the overall progress, the current task, and the number of blocked tasks. The transcript gets the freed rows.

**Why this priority**: This is the direct request. It removes the space problem without a change to settings.

**Independent Test**: Start a session with a plan of two phases and six tasks, one in progress and one blocked. Run `/todo compact`. Make sure the HUD rows go away and one status-row segment shows `3/6`, the in-progress task text, and `1 blocked`.

**Acceptance Scenarios**:

1. **Given** the HUD shows the Preview layout, **When** the user runs `/todo compact`, **Then** the todo tree rows go away and the status row shows the compact todo summary.
2. **Given** the Compact layout, **When** the agent marks a task done or starts the next task, **Then** the summary updates the progress count and the current task on the next render.
3. **Given** the Compact layout, **When** the user runs `/todo collapse`, **Then** the HUD returns to the Preview layout.
4. **Given** the Compact layout, **When** the user runs `/todo expand`, **Then** the HUD shows the Full layout.
5. **Given** the Compact layout, **When** the user runs `/todo compact` again, **Then** nothing changes.
6. **Given** the Preview layout is selected and the terminal has fewer than 18 rows, **When** the user runs `/todo expand` and then the terminal grows to 18 rows or more, **Then** the Compact layout shows while the terminal is short, and the Full layout shows after it grows.

---

### User Story 2 - Make Compact the start layout (Priority: P2)

The user always wants the one-line layout. The user sets the todo HUD layout option to `compact` in the configuration. Each new interactive session starts with the Compact layout.

**Why this priority**: It removes the need to type the command in each session. The command from Story 1 works without it.

**Independent Test**: Set the option to `compact`. Start a new session and create a plan. Make sure the HUD starts in the Compact layout. Set the option to `preview`, start a new session, and make sure the Preview layout shows.

**Acceptance Scenarios**:

1. **Given** the layout option is `compact`, **When** a session starts and the agent creates a plan, **Then** the HUD shows the Compact layout.
2. **Given** the layout option is `compact`, **When** the user runs `/todo collapse` in that session, **Then** the Preview layout shows for the remainder of that session only.
3. **Given** the layout option is not set, **When** a session starts, **Then** the HUD shows the Preview layout, as it does today.

---

### User Story 3 - Find the new layout in help (Priority: P3)

The user runs `/todo help` or `/todo` with a bad verb. The usage text lists `compact` next to `expand` and `collapse`, with a one-line description.

**Why this priority**: Discovery only. The feature works without it.

**Independent Test**: Run `/todo help` in the interactive terminal and in non-interactive command mode. Make sure both usage texts list `compact`.

**Acceptance Scenarios**:

1. **Given** any session, **When** the user shows the `/todo` usage text, **Then** the text lists `/todo compact` and its purpose.

### Edge Cases

- **No plan**: With no tasks, the Compact layout shows nothing. The status row keeps its normal content.
- **All tasks closed**: The summary shows the full count and a done mark. The existing auto-clear then removes it, as it does for the other layouts.
- **No in-progress task**: The summary shows the first pending task as the current task.
- **Several in-progress tasks**: The summary shows the first in-progress task in plan order.
- **Only blocked tasks remain open**: The summary shows the blocked count. The current task segment shows the first blocked task, marked as blocked.
- **Narrow terminal**: The summary never wraps. The system shortens the task text first, then the other status-row content, and marks each cut with an ellipsis.
- **Short terminal (fewer than 18 rows)**: In the text-terminal HUD, the system temporarily shows the Compact layout. This override applies to every selected layout, as it does today. The override does not change the selected layout. A `/todo expand` or `/todo collapse` command on a short terminal changes the selected layout, but the Compact layout stays visible. When the terminal grows to 18 rows or more, the selected layout shows again.
- **Non-interactive use**: `/todo compact` outside the interactive terminal reports that the command has an effect only in the interactive terminal, the same as `expand` and `collapse`.
- **Native HUD hosts**: Hosts that draw the todo HUD as a native checklist keep their current display. FR-002, FR-003, FR-005, and FR-010 do not apply to them. For these hosts, the Compact layout draws the same as the Preview layout.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support three todo HUD layouts: Full, Preview, and Compact.
- **FR-002**: The Compact layout MUST use exactly one row. The row MUST sit directly above the working (spinner) row, or above the idle status row when no work runs. The working row MUST keep its full width.
- **FR-003**: The Compact summary MUST show, in this order: the `TODO` label, the closed/total task count for the whole plan, the current task text, and the blocked-task count when that count is more than zero. It MUST NOT show the phase name or a per-phase count.
- **FR-004**: The current task MUST be the first in-progress task in plan order. If no task is in progress, it MUST be the first pending task. If no task is pending, it MUST be the first blocked task.
- **FR-005**: The Compact summary MUST fit on one line at every terminal width. The system MUST shorten the task text before it shortens the counts.
- **FR-006**: Users MUST be able to select the Compact layout with `/todo compact`.
- **FR-007**: `/todo collapse` MUST select the Preview layout from both the Full and the Compact layouts. `/todo expand` MUST select the Full layout from both other layouts.
- **FR-008**: The system MUST provide a configuration option for the start layout with the values `preview` and `compact`. The default MUST be `preview`.
- **FR-009**: A layout selected with a `/todo` command MUST last until the session ends or the user selects another layout. It MUST NOT change the configuration option.
- **FR-010**: In the text-terminal HUD, when the terminal has fewer than 18 rows, the system MUST show the Compact layout for every selected layout. This override MUST NOT change the selected layout. When the terminal has 18 rows or more, the system MUST show the selected layout again. This keeps the current short-terminal behavior. Native HUD hosts keep their current display (see Edge Cases).
- **FR-011**: The `/todo` usage text in the interactive terminal and in non-interactive command mode MUST list `compact`.
- **FR-012**: The Compact summary MUST update on each plan change, with the same timing as the other layouts.

### Key Entities

- **Todo HUD layout**: The way the todo HUD draws the plan. Values: Full, Preview, Compact. One layout is active per interactive session.
- **Start layout option**: A user configuration value, `preview` or `compact`. It sets the layout that a new session starts with.
- **Compact summary**: One status-row segment with the plan progress, the current task, and the blocked count.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the Compact layout, the text-terminal todo HUD uses exactly 1 row for any plan size. The Preview layout in the reported case used 9 rows.
- **SC-002**: A user can switch from any layout to the Compact layout with one command of 13 characters or fewer.
- **SC-003**: At terminal widths from 40 to 300 columns, the Compact summary never wraps to a second line.
- **SC-004**: After each plan change, the Compact summary shows the correct progress count and current task in 100% of checks, with no manual refresh.
- **SC-005**: On terminals with 18 rows or more, users who do not change the configuration see no change to the todo HUD. On shorter terminals, the existing one-line summary changes in four ways only: its own row above the working row, the blocked count, the new shortening order, and a blocked task as the current task when only blocked tasks remain open.

## Assumptions

- The start layout option is opt-in. The default stays `preview`, so users on terminals with 18 rows or more see no change. The user can set `compact` in the configuration to make it the default.
- The configuration option accepts only `preview` and `compact`. Full stays a command-only layout, because a full plan at start contradicts the space goal.
- A layout selected with a command is not saved in the session file. It follows the current `/todo expand` behavior, which also is not saved.
- The Compact summary reuses the text and color of the current short-terminal fallback. The new elements are the blocked count, the rule that shortens the task text first, and the blocked-task fallback in FR-004. Today the fallback shows a done mark when only blocked tasks remain open, which is wrong. All three changes also apply to the short-terminal fallback, because it uses the same summary.
- No keyboard shortcut is added. The user can add one later if the command is too slow.
- Project rule: the new configuration option and its default value also go into the user's personal configuration file.
