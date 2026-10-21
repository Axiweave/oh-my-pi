# Research: Expand Job Commands in the Background Jobs Report

All facts below come from the current source. Unverified points carry `[INFERENCE]`.

## R1. How the expand key reaches the job views

- **Decision**: Two paths. When the report shows above the editor, the existing global `app.tools.expand` input listener handles the key (no change). When a job view is an overlay with focus (full-screen report, native report sheet, jobs sheet), the view handles the key in its own `handleInput` and calls `ctx.toggleToolOutputExpansion()`.
- **Rationale**: The global listener returns early while any overlay shows (`input-controller.ts:462`). The key then goes to the focused component. Both paths end in the same toggle, so the session state stays the single source.
- **Alternatives considered**: Remove the `hasOverlay()` early return. Rejected, because that would toggle tool output under every overlay (agent hub, model picker, transcript viewer), and those overlays rely on the early return.

## R2. Report form source

- **Decision**: The report form always equals `ctx.toolOutputExpanded`. `/jobs full` first calls `setToolsExpanded(true)` and then opens the report.
- **Rationale**: If `/jobs full` forced the full form while the state stayed off, the first key press would turn the state on and the report would stay full. The user would see no change. A form that always equals the state removes this case.
- **Alternatives considered**: A separate form flag for each report. Rejected, because the user chose one shared state (clarification Q1). A flag also needs a sync rule.

## R3. How a toggle updates the open report

- **Decision**: `InputController.setToolsExpanded` calls a new `ctx.refreshJobsReport()`. `CommandController` keeps `#jobsReportOpen`. If the flag is true, it rebuilds the report through `showCommandReport`.
- **Rationale**: The report is a static `Text` snapshot. A rebuild through `showCommandReport` chooses the presentation again from the new height (`command-controller.ts:270-287`). A tall full form therefore moves to the full-screen view, and a short form moves back above the editor (spec edge case).
- **Flag lifetime**: `#clearReport` and `#closeReportSheet` set the flag to false when they remove a report. Every other report goes through `showCommandReport`, which calls both of them first. So a later report can never inherit the flag.
- **Alternatives considered**: Make the report body a live component that reads the state on each render. Rejected, because the height (and so the presentation) is chosen only once, in `showCommandReport`.

## R4. Jobs sheet update

- **Decision**: `JobsSheetSource` gets `expanded(): boolean` and `toggleExpanded(): void`. The sheet reads `expanded()` on each frame. The native `describe` cache key includes it.
- **Rationale**: The sheet already reads the session on each frame, and a timer renders it (`interactive-mode.ts:8882`). `setToolsExpanded` also calls `requestRender(true)`. So no extra notice is necessary.
- **Native detail pane**: `code(command, { preview: { lines: 4 } })` caps the command. In the full form the call drops `preview`. `[INFERENCE]` A `code` node with no `preview` shows all lines. The quickstart includes a check for this.
- **Text fallback**: Today `render()` shows no command in the detail lines. In the full form it adds the wrapped command of the selected job above the facts line. The short form stays the same (FR-012).

## R5. Hidden tool activity

- **Decision**: `toggleToolOutputExpansion` keeps its refusal while tool activity is hidden, except when a job view is open. `ctx.jobsViewOpen` is true when the jobs sheet handle exists or `#jobsReportOpen` is true.
- **Rationale**: The refusal exists because expansion of hidden tool rows has no visible effect. With a job view open, the toggle has a visible effect. Without this exception, Ctrl+O would fail on job views for users with hidden tool activity (SC-001).

## R6. Key match and hints

- **Decision**: Overlay views match the key with `matchesAppToolsExpand` (`keybinding-matchers.ts:22`). They show the key with `appToolsExpandKey()`. The report footer shows `<key> full commands` or `<key> short commands` before the close hint. Native sheets get an action button (act `expand`, `keys: appToolsExpandKey()`), and `handleNativeEvent` routes it to the same toggle.
- **Rationale**: These helpers already exist and follow user rebinds (FR-006). The pattern is the same one that the agent transcript viewer uses (`agent-transcript-viewer.ts:566`, `:766`).

## R7. Constitution

`.specify/memory/constitution.md` is an unfilled template. The gates come from the repository rules (`AGENTS.md`): smallest diff, reuse of existing helpers, tests that prove behavior and do not pin wording, and no backward-compatibility shims.
