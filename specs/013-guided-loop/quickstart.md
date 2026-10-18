# Quickstart: validate `/guided-loop`

## Prerequisites

1. Work from the repo root.
2. Run `bun install` if dependencies are missing.

## Automated checks

1. Run the new and changed tests:
   `bun test packages/coding-agent/test/tools/loop-tool.test.ts packages/coding-agent/test/guided-loop.test.ts packages/coding-agent/test/input-controller-keybindings.test.ts packages/coding-agent/test/interactive-mode-speckit-auto.test.ts`
2. Run the guided-goal and loop tests that must not change (SC-005):
   `bun test packages/coding-agent/test/goals/guided-goal.test.ts packages/coding-agent/test/slash-commands/guided-goal.test.ts packages/coding-agent/test/interactive-mode-loop.test.ts packages/coding-agent/test/loop-limit.test.ts packages/coding-agent/test/mcp/ide-state.test.ts`
3. Run `bun check:ts`.
4. Run `omp --smoke-test`.

## Manual checks (real TUI)

Use a cheap model, for example `--model anthropic/claude-haiku-4-5`. See [contracts/guided-loop.md](contracts/guided-loop.md) for the exact texts.

| # | Do | Expect |
|---|---|---|
| 1 | `/guided-loop check that the README has a title` | The agent asks one question and does nothing else. |
| 2 | Answer: every 1 minute, stop after 2 runs. | The agent asks only for missing parts, then the `Start this loop?` dialog shows one `/loop 2 every 1m …` line with a full prompt. |
| 3 | Choose **No**. | No loop starts. The agent asks what to change. |
| 4 | Ask for no change, then choose **Yes**. | The `/loop …` line and `Loop mode enabled. …` show in the transcript. The prompt runs once at once. The status line shows `every 1m next HH:MM`. |
| 5 | Wait 2 minutes. | 2 more runs, 1 minute apart, then `Loop limit reached. Loop mode disabled.` |
| 6 | `/loop every 2m say hi`, wait for the turn, then `/guided-loop` and answer `c`. | The status line shows the loop paused. `c` goes to the agent as an answer, and no run of the old loop starts. |
| 7 | Say "never mind". | The agent ends the interview with no new loop. The old loop stays paused. |
| 8 | Run `/guided-loop` again, then `/guided-goal`. | `Finish the guided loop interview first.` |
