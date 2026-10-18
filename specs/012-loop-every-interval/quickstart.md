# Quickstart: validate `/loop every`

Grammar, results, and messages: [contracts/loop-command.md](contracts/loop-command.md). State: [data-model.md](data-model.md).

## Prerequisites

1. Work from the repo root.
2. Run `bun install` if dependencies are missing.

## Automated checks

1. Run the parser tests:
   ```sh
   bun test packages/coding-agent/test/loop-limit.test.ts
   ```
   Expected: every row in the contract "Parse results" table holds.
2. Run the schedule tests:
   ```sh
   bun test packages/coding-agent/test/interactive-mode-loop.test.ts packages/coding-agent/test/interactive-mode-loop-teardown.test.ts packages/coding-agent/test/input-controller-loop.test.ts
   ```
   Expected: the start-to-start gap equals the interval, one run after an overrun, the draft does not change, and replace works.
3. Run the status line tests:
   ```sh
   bun test packages/tui/test/status-line-loop.test.ts
   ```
4. Run the smoke test:
   ```sh
   omp --smoke-test
   ```

## Manual checks (real TUI)

Use a cheap model. Use a prompt that ends fast, for example `say the time in one word`.

| # | Do | Expect |
|---|---|---|
| 1 | `/loop every 1m say the time in one word` | The turn runs at once. During the turn, the status line shows `every 1m` and no `next`. After the turn ends, it shows `next HH:MM`, one minute after the turn started. |
| 2 | Wait | The second run starts at the shown time, plus or minus 2 s. |
| 3 | Type `draft text` and do not send it. Wait for the next run. | The run starts. `draft text` is still in the input box. |
| 4 | `/loop every 2m` | `Loop updated.` The prompt stays. `next` moves to the last start plus 2 min. |
| 5 | `/loop every 1.5h` | An error shows. The loop and `next` do not change. |
| 6 | Press Esc during the wait | The loop shows paused. No run starts at the old `next` time. |
| 7 | `/loop` | `Loop mode disabled.` The status segment is gone. |
| 8 | `/loop 2 every 1m say hi` | 1 turn plus 2 runs at 1-minute starts, then `Loop limit reached. Loop mode disabled.` |
| 9 | `/loop 5 say hi` (no interval) | Same as before this feature: the runs follow each other with about 0.8 s between them. |
