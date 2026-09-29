# Quickstart: Validate the Compact Todo HUD

## Prerequisites

- Run `PATH="$HOME/.cargo/bin:$PATH" bun run setup` from the repository root.
- Use a terminal with 18 rows or more, unless a step says otherwise.

## Automated checks

```sh
cd packages/coding-agent
bun test test/interactive-mode-todo-clear.test.ts test/tools/todo.test.ts test/input-controller-escape.test.ts test/acp-builtins.test.ts
```

Expected: every test passes, including the property cases in [research.md D9](./research.md#d9--what-the-tests-must-prove). A failing property prints its seed and its smallest failing input.

## Manual smoke (interactive terminal)

1. Start `omp` and ask for a plan with two phases, at least six tasks, and one blocked task.
   - Expected: the Preview tree shows, which is the default.
2. Run `/todo compact`.
   - Expected: the tree rows go away. The status row shows `TODO a/b · <current task> · 1 blocked` ([compact-summary.md](./contracts/compact-summary.md)).
3. Make the terminal narrower, to about 60 columns.
   - Expected: the line never wraps. The task text gets an ellipsis before the working text does.
4. Run `/todo expand`, then `/todo collapse`.
   - Expected: Full shows, then Preview shows.
5. Make the terminal shorter than 18 rows. Run `/todo expand`. Make the terminal taller than 18 rows again.
   - Expected: the one-line summary shows while the terminal is short. Full shows after it grows.
6. Set `todo.hud: compact` in `~/.omp/agent/config.yml`. Start a new session and create a plan.
   - Expected: the plan starts in Compact.
7. In that session, change `todo.hud` back to `preview` through `/settings`.
   - Expected: the Preview tree shows at once.
8. The non-interactive path is ACP (`handleTodoAcp`), not `omp -p`. `test/acp-builtins.test.ts` covers it. Extend the existing `/todo expand` case (`:910`) to the `compact` verb.
   - Expected: the output contains `interactive HUD` ([todo-command.md](./contracts/todo-command.md)).

## Done when

- `bun check` passes (report its exit code).
- Every manual step shows the expected result.
