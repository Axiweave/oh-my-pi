# Quickstart: validate master mode

## Prerequisites

1. Work from the repo root.
2. Run `bun install` if dependencies are missing.
3. Make sure `async.enabled` is on (the default).

## Automated checks

1. Run the new tests:
   `bun test packages/coding-agent/test/master-mode-guard.test.ts packages/coding-agent/test/task/master-task-refusal.test.ts packages/coding-agent/test/interactive-mode-master.test.ts packages/coding-agent/test/cli-master-flag.test.ts packages/tui/test/status-line-master.test.ts`
2. Run the tests of the files that the change touches, so the new refusal cases do not break the old ones:
   `bun test packages/coding-agent/test/interactive-mode-vibe-toggle.test.ts packages/coding-agent/test/interactive-mode-plan-paused-guard.test.ts packages/coding-agent/test/interactive-mode-speckit-auto.test.ts packages/coding-agent/test/interactive-mode-loop.test.ts packages/coding-agent/test/cli-goal-flag.test.ts packages/coding-agent/test/slash-commands/mode-attachments.test.ts`
3. Run the existing status line tests of the TUI package: `bun test packages/tui/test/status-line-loop.test.ts packages/tui/test/status-line-native.test.ts`.
4. Run `bun check:ts`.
5. Run `omp --smoke-test`.

The seeded property in `master-mode-guard.test.ts` prints its seed. Re-run with the printed seed to repeat a failure.

## Manual checks (real TUI)

Use a cheap model, for example `--model anthropic/claude-haiku-4-5`. See [contracts/master-mode.md](contracts/master-mode.md) for the exact texts.

| # | Do | Expect |
|---|---|---|
| 1 | Run `/master`. | `Master mode on: …` shows. The status line shows `Master`. |
| 2 | Ask: `add a comment line to the top of README.md and run git status`. | The agent calls `task` for the edit and a background `bash` for `git status`. Its first turn ends before the subagent finishes. |
| 3 | While the subagent runs, send `what are you doing?`. | The agent answers at once. The subagent keeps running. |
| 4 | Wait. | The result arrives and starts a turn with no input from you. The agent reads the file and reports. |
| 5 | Ask: `edit README.md yourself, no subagent`. | The `edit` call is refused with `Master mode is on. You do not change files yourself. …`. The file does not change. |
| 6 | Ask: `run sleep 5 in the foreground`. | The `bash` call is refused with `Master mode is on. Run shell commands as a background job …`. |
| 7 | Ask the agent to call `wait`. | The refusal says that results arrive by themselves. |
| 8 | Run `/vibe`, then `/plan`, then `/speckit-auto-mode`. | Each one shows `Exit master mode first.` |
| 9 | Run `/master` to turn it off, then `/vibe`. Exit vibe. Run `/master` again. | Vibe turns on. After you exit vibe, master turns on. While vibe is on, `/master` shows `Exit vibe mode first.` |
| 10 | Turn master on, then `/goal set check the tests`. | Goal mode starts. The status line shows `Master` beside the goal label. The goal turns run under the rules. |
| 11 | Quit with master on. Run `omp --continue`. | The status line shows `Master` before any turn. A direct edit request is refused in the first turn. |
| 12 | Run `omp --master`. | `Master` shows in the status line before the first turn. |
| 13 | Run `omp --master "list the files in src"`. | The first turn runs under the rules: it uses `glob` or `read`, and it does not call foreground `bash`. |
| 14 | Run `omp --master -p "hi"`. | Exit code 2 with `--master requires an interactive terminal (not --print or --mode).` |
| 15 | Set `async.enabled: false`, then run `/master` and `omp --master`. | `/master` shows `Master mode needs background work. Enable async.enabled.` `omp --master` shows the same text and starts without the mode. |
| 16 | With master on, run `/master` while a turn runs. | The turn is not aborted. The next tool call has no master rule. |
