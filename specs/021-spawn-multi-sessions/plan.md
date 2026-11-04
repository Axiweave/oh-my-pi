# Implementation Plan: Spawn More Than One Session From One Request

**Branch**: `021-spawn-multi-sessions` (work happens on `main`) | **Date**: 2026-11-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/021-spawn-multi-sessions/spec.md`

## Summary

One `/spawn` request can now start one session for each task that it names. Each task gets its own mode, directory setup, branch, and summary. The spawn window no longer closes at the first `spawn_session` call. It stays open for the whole spawn run and closes at `agent_end`. The close check covers only the messages after the kickoff, which also fixes the stale-window bug. A kickoff that is still on its way to the queue keeps the window open. A kickoff that is dropped from the queue before it runs closes the window (R1, R2). Parallel calls run one after another (R3). With `spawn.confirm` on, a new `plan` mode on `spawn_session` shows one overview before any worktree setup (R4). A second default branch with the same name in one window gets a suffix, and the first one keeps today's name (R5). The kickoff and tool prompts describe the work for each task (R6, R7).

## Technical Context

**Language/Version**: TypeScript on Bun. Markdown prompt templates (Handlebars through `prompt.render`).

**Primary Dependencies**: The existing `/spawn` window in `InteractiveMode` and `SpawnSessionTool`. The agent loop tool `concurrency` flag. No new dependency.

**Storage**: N/A. The state lives in memory for one window.

**Testing**: `bun test` (`test/spawn-command.test.ts`), with the `vi` spies that the file already uses. Real-model smoke runs (quickstart rows 1–11) for the prompt behavior.

**Target Platform**: The omp interactive TUI inside zmx, on macOS and Linux.

**Project Type**: CLI/TUI monorepo package (`packages/coding-agent`).

**Performance Goals**: Each task costs the same time as one `/spawn` today. Tasks run one after another.

**Constraints**: No new setting and no new tool registration. `/fork spawn` does not change. Single-task requests keep their results (SC-005).

**Scale/Scope**: 2 source files, 2 prompt files, 1 test file, plus the CHANGELOG and `UPSTREAM_DIVERGENCES.md`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the empty template. The gates come from the repository rules (`AGENTS.md`, project memory):

| Gate | Status |
|---|---|
| Reuse existing patterns, no second convention | Pass. Reuses `spawnWindowShouldClose`, `isSpawnKickoff`, `showHookConfirm`, the tool `concurrency` flag, and `randomSiblingSuffix`. |
| No speculative scope | Pass. No task limit, no separate dialog for each task inside the overview, no new tool. |
| Clean cutover | Pass. `#spawnRunUsed`, the close at each call, and the "already ran in this turn" error are removed. The tests that pin the one-call limit are removed. |
| Tests prove behavior, not wiring | Pass. The tests check session counts, window state across runs, dialog counts, and branch uniqueness. No test pins prompt text. |
| Prompt changes get real-model smoke runs (3 or more samples) | Pass. Quickstart rows 1–3 are 3 samples for the main path. |
| Changelog and divergence notes | Pass. `packages/coding-agent/CHANGELOG.md` (Changed, Fixed) and the `UPSTREAM_DIVERGENCES.md` "/spawn and /despawn sibling sessions" entry are in scope. |
| `bun check` before commit | Pass. It is in the quickstart. |

Post-design re-check: still passes. The `plan` mode goes on the existing tool, so the change adds no registration points.

## Project Structure

### Documentation (this feature)

```text
specs/021-spawn-multi-sessions/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/spawn-tools.md
└── tasks.md             # /speckit.tasks
```

### Source Code (repository root)

```text
packages/coding-agent/src/
├── tools/spawn-session.ts          # plan mode, tasks field, validation, concurrency = "exclusive"
├── modes/interactive-mode.ts       # window closes at agent_end only (sliced after kickoff, kickoff flags, queue check);
│                                   # #spawnPlan; drop #spawnRunUsed and the per-call close; default branch suffix only on a same-window collision
├── prompts/spawn/spawn-kickoff.md  # tasks, setup per task, overview when confirm, one report line per task
└── prompts/tools/spawn-session.md  # once per task, plan mode, continue after a task error

packages/coding-agent/test/spawn-command.test.ts
packages/coding-agent/CHANGELOG.md
UPSTREAM_DIVERGENCES.md
```

**Structure Decision**: Keep the change inside the existing `/spawn` files. `spawnWindowShouldClose` in `session/sibling-spawn.ts` changes so that only a last `ask`/`spawn_session` call that is an `ask` keeps the window open (found at implement time). The slice after the kickoff happens at its one call site in `InteractiveMode`.

## Complexity Tracking

No violations.
