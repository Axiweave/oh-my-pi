# Quickstart: Validate the Job Command Expansion

## Prerequisites

1. Run `bun install` in the repository root.
2. Start omp from source in a terminal 100 columns wide: `bun packages/coding-agent/src/cli.ts`.

## Setup: make a long-running job with a long command

Ask the agent to run this command as an async bash job with `timeout: 0`:

```sh
for r in benchmarks benchmarks-multi-full benchmarks-multi-lite benchmarks-single; do echo "$r"; sleep 600; done
```

## Scenario A: report above the editor (US1, US3)

1. Make sure that tool output expansion is off. If the status line shows "enabled", press Ctrl+O.
2. Type `/jobs`. Expected: the report shows the cut command with `…`. The footer names Ctrl+O and full commands.
3. Press Ctrl+O. Expected: the report shows the full command. The status line shows `Tool output expansion: enabled`, and the transcript tool blocks expand.
4. Press Ctrl+O. Expected: the report goes back to the cut form.
5. Press Ctrl+O, Esc, then type `/jobs`. Expected: the report opens in the full form.

## Scenario B: full-screen view (FR-001, edge case)

1. Start a job with a heredoc command that is taller than the space above the editor.
2. Type `/jobs` with expansion off, then press Ctrl+O. Expected: the report opens as a full-screen view with the full commands.
3. Press Ctrl+O. Expected: the short report goes back above the editor.

## Scenario C: `/jobs full` (FR-004)

1. Make sure that expansion is off. Type `/jobs full`. Expected: the full form. The status shows that expansion is on.
2. Press Ctrl+O. Expected: the short form.

## Scenario D: jobs sheet (US2)

1. Open the jobs sheet: click the jobs pill (native) or type `/jobs` with native rendering.
2. Select the job with the long command. Expected: the detail pane shows at most 4 command lines.
3. Press Ctrl+O. Expected: the detail pane shows every line. The rows stay one line each.
4. Select another job. Expected: its full command shows.
5. Without the native surface, open the sheet and press Ctrl+O. Expected: the full command shows in the detail lines under the job list.

## Scenario E: rebound key and hidden tool activity (FR-006, R5)

1. Bind `app.tools.expand` to another key in `keybindings.yml`. Expected: that key toggles the job views, and Ctrl+O does not.
2. Hide tool activity, then open `/jobs` and press the expand key. Expected: the report toggles.
3. With no job view open, press the expand key. Expected: the existing "Tool activity is hidden" message.

## Automated checks

```sh
bun test packages/coding-agent/test/modes/controllers/jobs-command.test.ts packages/tui/test/jobs-panel.test.ts packages/tui/test/report-panel.test.ts
```

Then run `bun check` from the repository root.
