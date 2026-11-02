# Implementation Plan: Spawn Into a Prepared Worktree

**Branch**: `018-spawn-worktree-first` (work happens on `main`) | **Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/018-spawn-worktree-first/spec.md`

## Summary

When a `/spawn` request names a worktree tool such as `ww`, the parent runs that tool first and passes the printed path as `spawn_session.cwd`. The fix is a prompt change only (research R1). The kickoff prompt gets one closed exception to "never do the requested work": make the worktree with the named tool (R2, R3). The `spawn_session` description tells the model to report the worktree path when a spawn is declined or fails after the setup (R4). Requests with no named tool keep today's mapping (R5).

## Technical Context

**Language/Version**: Markdown prompt templates (Handlebars via `prompt.render`), consumed by TypeScript on Bun

**Primary Dependencies**: The existing `/spawn` window (`InteractiveMode.handleSpawnCommand`, `#beginSpawnWindow`, `#spawnSibling`) and the `spawn_session` tool. External: the user's worktree tool (`ww`). No new dependency.

**Storage**: N/A

**Testing**: Real-model smoke runs (quickstart rows 1–8). The existing `bun test` suites for `/spawn` mechanics must still pass. No new unit test, because a prompt-text test would pin wording (R7).

**Target Platform**: The omp interactive TUI inside zmx, on macOS and Linux

**Project Type**: CLI/TUI monorepo package (`packages/coding-agent`)

**Performance Goals**: One extra shell call (the worktree tool) before the spawn. No other cost.

**Constraints**: The parent may run only the named worktree tool, nothing else from the request. No change to the `spawn_session` schema, or to `/fork spawn`, which has no model turn.

**Scale/Scope**: 2 prompt files, plus the CHANGELOG and `UPSTREAM_DIVERGENCES.md`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the empty template. The gates come from the repository rules (`AGENTS.md`, project memory):

| Gate | Status |
|---|---|
| Reuse existing patterns, no second convention | Pass. Reuses `spawn_session.cwd` and the existing confirm dialog. No new option or setting. |
| No speculative scope | Pass. Options B (a setting) and C (a `move_session` tool) are out of scope. |
| Tests prove behavior, not wiring | Pass. Prompt behavior is proven by real-model runs. No test pins the prompt text. |
| Prompt changes get real-model smoke tests (3 or more samples) | Pass. Quickstart rows 1–3 are 3 samples for the main path. Rows 4, 5, and 8 cover a decline, a failed tool, and a missing tool. Rows 6 and 7 cover requests that name no tool. |
| Changelog and divergence notes | Pass. `packages/coding-agent/CHANGELOG.md` (Changed) and the `UPSTREAM_DIVERGENCES.md` "/spawn and /despawn sibling sessions" entry are in scope. |
| `bun check` before commit | Pass. It is in the quickstart. |

Post-design re-check: still passes. The design adds no code path.

## Project Structure

### Documentation (this feature)

```text
specs/018-spawn-worktree-first/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/spawn-prompts.md
└── tasks.md             # /speckit.tasks
```

### Source Code (repository root)

```text
packages/coding-agent/src/prompts/
├── spawn/spawn-kickoff.md      # the worktree-setup exception, branch rule, failure rule, no-worktree handoff text
└── tools/spawn-session.md      # cwd from a prepared worktree; declined/error results name the path

packages/coding-agent/CHANGELOG.md
UPSTREAM_DIVERGENCES.md         # "/spawn and /despawn sibling sessions" decision bullet
```

**Structure Decision**: No source code changes. The `/spawn` window already exposes the shell and `spawn_session.cwd`. Only the instructions that the model gets are wrong.

## Complexity Tracking

No violations.
