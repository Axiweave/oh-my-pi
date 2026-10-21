# Feature Specification: Expand Job Commands in the Background Jobs Report

**Feature Branch**: `015-jobs-report-expand`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "[Image #1, 1466x414] allow C-o to expand job detail to see full command here" (the image shows the docked "Background Jobs" report from `/jobs`, with a running `bg_5 [bash]` job whose command is cut to "for r in benchmarks benchmarks-multi-full benchma…", and the status line "Tool output expansion: disabled" after the user pressed Ctrl+O).

## Clarifications

### Session 2026-10-21

- Q: When the Background Jobs report is open, should Ctrl+O also switch tool output expansion for the whole transcript? → A: Yes. The report and the transcript share one expansion state.
- Q: Should Ctrl+O also show full commands in the live jobs sheet (the overlay that the jobs pill opens, and that `/jobs` opens in native rendering)? → A: Yes. Both surfaces react.
- Q: In the live jobs sheet, what should Ctrl+O expand? → A: Only the selected job's command in the detail pane. Rows stay one line each.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See the full command of a job from the open report (Priority: P1)

A user opens the Background Jobs report and sees a job whose command is cut with "…". The user presses the expand key (Ctrl+O by default, the same key that expands tool output). The open report changes in place and shows the full command of each job. The full command wraps across lines and stays indented under its job row.

**Why this priority**: This is the request in the screenshot. Today the user must close the report and know about `/jobs full` to read a long command. The expand key already means "show more detail" everywhere else in the session.

**Independent Test**: Start a background job with a command longer than the terminal width. Open `/jobs`. Press Ctrl+O. Confirm that the report shows every character of the command and no "…" marker.

**Acceptance Scenarios**:

1. **Given** the Background Jobs report is open in its short form and a job command is cut, **When** the user presses the expand key, **Then** the same report shows the full command of every job, wrapped and indented under its row.
2. **Given** a multi-line job command (for example a heredoc), **When** the report is in its full form, **Then** every line of the command shows, in order, under the job row.
3. **Given** the report is open in its full form, **When** the user presses the expand key again, **Then** the report goes back to the short form with one cut line for each job.

---

### User Story 2 - See the full command of the selected job in the live jobs sheet (Priority: P2)

A user opens the live jobs sheet from the jobs pill (or with `/jobs` in native rendering) and selects a job. The detail pane shows only the first lines of a long command. The user presses the expand key. The detail pane shows the full command of the selected job, wrapped, with no line limit. The job rows stay one line each.

**Why this priority**: The sheet is the `/jobs` surface in native rendering. Without this story, the same key press shows full commands in one rendering mode and does nothing in the other.

**Independent Test**: Start a background job with a command of more than 4 lines. Open the jobs sheet and select the job. Press Ctrl+O. Confirm that the detail pane shows every line of the command.

**Acceptance Scenarios**:

1. **Given** the jobs sheet is open and the selected job has a command longer than the preview, **When** the user presses the expand key, **Then** the detail pane shows the full command, wrapped, with no line limit.
2. **Given** the sheet is in its full form, **When** the user selects a different job, **Then** the detail pane shows that job's full command.
3. **Given** the sheet is in its full form, **When** the user presses the expand key again, **Then** the detail pane goes back to its preview.
4. **Given** the sheet runs in a terminal without the native surface, **When** the sheet is in its full form, **Then** the full command of the selected job shows in the detail lines under the job list.

---

### User Story 3 - Job views follow the session expansion state (Priority: P3)

The expand key already switches the session-wide "tool output expansion" state. The Background Jobs report and the jobs sheet use that same state. A press of the expand key while one of them is open also switches tool output in the transcript. When expansion is on, a newly opened report or sheet starts in its full form. When expansion is off, it starts in its short form.

**Why this priority**: One key and one state are easier to learn than a second toggle for each job view. It also makes the "Tool output expansion: enabled/disabled" status line true for both job views.

**Independent Test**: Turn expansion on with Ctrl+O. Open `/jobs`. Confirm that the report opens in its full form.

**Acceptance Scenarios**:

1. **Given** tool output expansion is on, **When** the user opens `/jobs` or the jobs sheet, **Then** it opens in its full form.
2. **Given** tool output expansion is off, **When** the user opens `/jobs` or the jobs sheet, **Then** it opens in its short form.
3. **Given** the user runs `/jobs full`, **When** the report opens, **Then** it shows the full form whatever the expansion state is.
4. **Given** the report or the sheet is open, **When** the user presses the expand key, **Then** tool output in the transcript also switches, and the status line shows the new state.

### Edge Cases

- If a job has no command and only a label (for example a subagent task), both surfaces show the label in both forms.
- If the command is the same as the job id, the docked report shows no detail line in either form (the current behavior).
- If the full form of the report is taller than the space above the editor, the report opens as a full-screen view, as other tall reports do. The expand key MUST still switch it back to the short form, which returns to the space above the editor when it fits.
- If the full command in the sheet detail pane is taller than the sheet, the native sheet scrolls its detail pane as it does today. In a terminal without the native surface, the sheet shows the full command and cuts the rows at the bottom of the sheet (facts and output tail) that do not fit.
- If no jobs exist, the expand key changes nothing that the user can see in either surface, but it still switches the session state.
- If neither job view is open, the expand key keeps its current behavior for tool output only.
- If tool activity is hidden and a job view is open, the expand key still switches the job view and the session state. With no job view open, the key keeps its current "Tool activity is hidden" message.
- If the job list changes while the docked report is open, a toggle shows the jobs as they are at the time of the toggle.
- If the user rebinds the expand action to a different key, that key toggles both job views. Ctrl+O then has no effect on them.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When the Background Jobs report is open, the expand action MUST switch the report between its short form and its full form in place, without a close and reopen. This MUST work in all three ways the report can show: above the editor, as a full-screen view (report too tall for the space above the editor), and as a centered sheet (native rendering, for example `/jobs full`).
- **FR-002**: The full form of the report MUST show the complete command text of each job, wrapped to the report width, with each line indented under its job row. It MUST NOT show a "…" cut marker.
- **FR-003**: The short form of the report MUST stay as it is today: one line for each job, cut to fit the width.
- **FR-004**: The form of a newly opened report or sheet MUST follow the session tool-output expansion state. `/jobs full` MUST always open the full report. To do this, `/jobs full` MUST turn the session expansion state on, so transcript tool output also expands.
- **FR-005**: The expand action MUST continue to switch tool output expansion for the whole session, also while a job view is open. It MUST show the same "Tool output expansion: enabled/disabled" status message.
- **FR-006**: Both job views MUST use the configured key for the expand action, not a fixed Ctrl+O.
- **FR-007**: This feature MUST NOT change the content or behavior of other command reports (for example Advisor Status, Context Usage, MCP, SSH).
- **FR-008**: The hint line of each job view MUST tell the user that the expand key shows the full commands, next to the existing close hint.
- **FR-009**: When the jobs sheet is open, the expand action MUST switch the selected job's command in the detail pane between its preview and the full command, wrapped, with no line limit.
- **FR-010**: In the jobs sheet, job rows MUST stay one line each in both forms.
- **FR-011**: In the full form, the jobs sheet MUST keep the full form when the selection changes and MUST show the newly selected job's full command.
- **FR-012**: In a terminal without the native surface, the full form of the jobs sheet MUST show the selected job's full command in the detail lines under the job list. The short form MUST stay as it is today.

### Key Entities

- **Background Jobs report**: The panel that `/jobs` opens outside native rendering (and `/jobs full` in all modes). It shows above the editor, as a full-screen view when too tall, or as a centered sheet in native rendering. It lists running and recent jobs in a tree, with one cut detail line (short form) or the complete command (full form) under each job.
- **Jobs sheet**: The live overlay that the jobs pill opens, and that `/jobs` opens in native rendering. It lists jobs as one-line rows beside a detail pane for the selected job. The detail pane shows a command preview (short form) or the complete command (full form).
- **Tool output expansion state**: The session-wide on/off state that the expand key switches. The transcript, the report, and the sheet read their form from this state.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can read the full command of any background job with one key press while a job view is open, and with no extra command.
- **SC-002**: In the full form, 100% of the characters of each shown job command are visible, for commands up to at least 20 lines.
- **SC-003**: Two presses of the expand key bring a job view back to its first form, with the same job rows in the same order.
- **SC-004**: No other command report changes its content when the user presses the expand key.

## Assumptions

- The full form of the docked report reuses the current `/jobs full` layout. This feature adds no new layout for the report.
- The report is a snapshot. A toggle rebuilds it from the current job list, and the report does not refresh by itself between toggles. A toggle can move the report between the space above the editor and the full-screen view when its height changes. The jobs sheet keeps its live refresh.
- When the report or the sheet shows as an overlay with keyboard focus, it handles the expand key itself and switches the same session expansion state. The session state stays the single source for the form.
- Ctrl+O is the default key for the expand action. Users who rebind that action get the new behavior on their key.
