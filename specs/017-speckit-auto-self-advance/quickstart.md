# Quickstart: Validate Phase Loads by the Agent

## Prerequisites

- Bun at the version in `package.json` `packageManager`, and `bun run setup` done in this checkout.
- A project with spec-kit commands in `.omp/commands/` (this repository has them).

## 1. Automated checks

```sh
cd packages/coding-agent
bun test test/speckit-auto.test.ts                    # speckitPhaseLoad table (contracts/phase-load.md)
bun test test/interactive-mode-speckit-auto.test.ts   # run transitions (data-model.md rows 2–5)
cd ../..
bun check
```

Expected: all pass. The interactive tests drive `tool_execution_start` / `tool_execution_end` events through the session subscription and check these cases:

| Case | Expected |
|---|---|
| Run in plan, bash `specify project command speckit.tasks --json` succeeds | `run.phase = tasks`, history `plan → tasks`, notice shown, no `/speckit.tasks` parked at settle. The settle check reads `tasks`. |
| Same call with `isError: true` | Run stays in plan |
| `grep -rn speckit.tasks .specify/` | Run stays in plan |
| `read .omp/commands/speckit.plan.md` in plan | No change |
| Run in converge, agent loads implement | `convergeRounds + 1`, phase implement |
| Tasks scope, run in analyze, agent loads implement | Turn aborted, run ended "stopped before implement", nothing parked |
| Tasks scope, run already `editing`, agent loads converge | Moves to converge, no abort |
| Paused run, agent loads tasks | Phase tasks, still paused, no start after settle |
| Mode on, no run, free-text turn, agent loads plan | New run in plan, settle check runs with the free text as the request |
| Paused run, agent loads specify | New run at specify, paused |
| Run in analyze, agent loads analyze | No change, `remediationRounds` unchanged |
| `bash` `specify … speckit.tasks` with `async: true` | No change |
| Run in tasks, agent loads specify | Old run summary "stopped", new run at specify |

## 2. Manual smoke in the TUI

1. Start `omp` in this repository and run `/speckit-auto-mode` once (scope `full`).
2. Type: `Read .omp/commands/speckit.plan.md and follow it for the active feature.`
3. Watch the status bar. It shows `Speckit` with phase `plan` right after the read ends, and a notice says that the agent started plan.
4. Let the turn settle. The mode checks the plan reply and sends `/speckit.tasks`, not `/speckit.plan`.
5. Run `/speckit-auto-mode` until the scope is "stop before implement". In an analyze turn, ask the agent to read `.omp/commands/speckit.implement.md`. The turn stops after that read, and the summary says "stopped before implement".
