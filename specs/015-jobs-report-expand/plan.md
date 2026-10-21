# Implementation Plan: Expand Job Commands in the Background Jobs Report

**Branch**: `015-jobs-report-expand` | **Date**: 2026-10-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/015-jobs-report-expand/spec.md`

## Summary

The expand key (`app.tools.expand`, Ctrl+O by default) switches the Background Jobs report and the jobs sheet between cut and full commands. Both views read the session `toolOutputExpanded` flag, so one key and one state drive the transcript and the job views. The report rebuilds when the flag changes. Overlay presentations handle the key themselves because the global listener stops under overlays. Details: [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript on Bun

**Primary Dependencies**: `@oh-my-pi/pi-tui` (ReportPanel, JobsSheet, keybinding matchers), `@oh-my-pi/pi-coding-agent` (CommandController, InputController, InteractiveMode)

**Storage**: N/A (session-memory flag only)

**Testing**: `bun test` (bun:test)

**Target Platform**: Terminal TUI, text mode and native rendering

**Project Type**: CLI/TUI monorepo

**Performance Goals**: A toggle rebuilds one report. No measurable cost.

**Constraints**: No change to other reports (FR-007). No new keybinding action.

**Scale/Scope**: 5 source files, 3 test files

## Constitution Check

The constitution file is an unfilled template. Gates come from the repository rules:

| Gate | Status |
|---|---|
| Reuse existing helpers (`matchesAppToolsExpand`, `appToolsExpandKey`, `/jobs full` layout, `showCommandReport`) | Pass |
| No new abstraction: one optional `ReportPanel` option, two `JobsSheetSource` members, one boolean | Pass |
| Tests prove behavior and do not pin hint wording | Pass (see Test plan) |
| No compatibility shim: `handleJobsCommand({ full })` keeps its shape, and callers stay the same | Pass |

Post-design check: pass. No violations.

## Project Structure

### Documentation (this feature)

```text
specs/015-jobs-report-expand/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/ui-keys.md
└── tasks.md            # /speckit.tasks
```

### Source Code (repository root)

```text
packages/tui/src/overlays/
├── report-panel.ts       # optional `expand: { label, run }`: footer hint, key in handleInput, native action button
└── jobs-panel.ts         # JobsSheetSource.expanded/toggleExpanded; key, cache key, uncapped code node, text fallback command
packages/coding-agent/src/modes/
├── controllers/command-controller.ts  # #jobsReportOpen, #showJobsReport(), refreshJobsReport(); /jobs full sets state
├── controllers/input-controller.ts    # setToolsExpanded → ctx.refreshJobsReport(); hidden-activity guard skips when jobsViewOpen
├── interactive-mode.ts                # sheet source wiring; refreshJobsReport/jobsViewOpen delegates
└── types.ts                           # InteractiveModeContext: refreshJobsReport(), jobsViewOpen
packages/coding-agent/test/modes/controllers/jobs-command.test.ts
packages/tui/test/jobs-panel.test.ts
packages/tui/test/report-panel.test.ts
```

**Structure Decision**: Edit the existing files only. No new modules.

## Design

1. **`ReportPanel`** gets the optional `expand?: { label: string; run(): void }`.
   - Text footer: `${appToolsExpandKey()} ${label} · ${closeHint}`.
   - `handleInput`: when `matchesAppToolsExpand(data)`, call `run()`.
   - Native: put `actionButton(label, "expand", { keys: appToolsExpandKey() })` before Close. `handleNativeEvent` maps `expand` to `run()`.
   - Reports without `expand` stay the same.
2. **`CommandController`**
   - Split the body build out of `handleJobsCommand` into `#showJobsReport()`. `full` becomes `this.ctx.toolOutputExpanded`. Pass `expand: { label: full ? "short commands" : "full commands", run: () => this.ctx.toggleToolOutputExpansion() }`.
   - After `showCommandReport`, set `#jobsReportOpen = true`. `#clearReport`/`#closeReportSheet` set it to false when they remove a report.
   - `handleJobsCommand({ full })`: if `full`, call `ctx.setToolsExpanded(true)`. Native and not `full` opens the sheet (as today). Otherwise call `#showJobsReport()`.
   - `refreshJobsReport()`: if `#jobsReportOpen`, call `#showJobsReport()`.
   - `get jobsReportOpen()`.
3. **`InputController`**
   - `setToolsExpanded` ends with `this.ctx.refreshJobsReport()`.
   - `toggleToolOutputExpansion` guard: `if (this.ctx.hideToolActivity && !this.ctx.jobsViewOpen)`.
4. **`JobsSheet`**
   - Add `expanded()`/`toggleExpanded()` to the source.
   - `handleInput`: when `matchesAppToolsExpand`, call `toggleExpanded()`.
   - Native: put `expanded` in the cache key. In `describeDetail`, pass `preview` only when not expanded. Add the action button `expand`.
   - `render()`: when expanded, wrap the selected job's command (`detail.command ?? label` for non-task jobs) under the job list.
5. **`InteractiveMode`**: the sheet source wires `expanded: () => this.toolOutputExpanded` and `toggleExpanded: () => this.toggleToolOutputExpansion()`. Delegate `refreshJobsReport()` and `jobsViewOpen` (`#jobsSheetHandle !== undefined || commandController.jobsReportOpen`).

## Test plan

Each test proves a property, not a wording.

- **Round trip (report)**: for commands of 0, 1, and 20 lines and widths of 40, 60, and 120, two toggles restore the same report rows. The full form contains every command character (whitespace ignored), and the short form has one line for each job.
- **Presentation (report)**: a full form taller than `commandReportRows()` mounts as an overlay. A toggle back mounts in `reportContainer`.
- **Isolation**: a toggle with a non-jobs report open leaves that report unchanged, and `#jobsReportOpen` is false after another report replaces it.
- **Sheet**: with `expanded()` true, the native detail `code` node has no `preview`. The text fallback contains every command line. Row count stays the same in both forms.
- **Key routing**: `ReportPanel` with `expand` calls `run` on the bound key. A rebound key calls `run`, and Ctrl+O then does not.
- **Fix existing tests**: the `jobs-command.test.ts` mock ctx needs `toolOutputExpanded`, `setToolsExpanded`, and `toggleToolOutputExpansion`.

## Docs

- Add an entry to `packages/coding-agent/CHANGELOG.md`.
- Add a note to `UPSTREAM_DIVERGENCES.md` (repository rule for fork commits).
- If `docs/keybindings.md` describes `app.tools.expand`, add "also expands job commands in /jobs and the jobs sheet".

## Complexity Tracking

No violations.
