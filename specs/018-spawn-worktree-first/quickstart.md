# Quickstart: Spawn Into a Prepared Worktree

## Prerequisites

- `ww` on `PATH` (`ww --help-agent` works).
- omp from this checkout, running inside a zmx session (`ZMX_SESSION` set). `/spawn` refuses without it.
- `spawn.confirm` on for row 4, and off or answered "Yes" for the other rows.

## Setup

1. Create a throwaway repository: `git init /tmp/spawn-smoke`, add one file, and commit it on branch `main`.
2. Create a branch `taken` and check it out in another worktree (`git -C /tmp/spawn-smoke worktree add /tmp/spawn-smoke-taken taken`) for row 5.
3. Start omp from this checkout with `/tmp/spawn-smoke` as the working directory.

## Runs

| # | Input | Expected |
|---|---|---|
| 1–3 | `/spawn create a new worktree using ww for it; add a NOTES.md that says hi` (repeat 3 times, with a new session each time) | The parent transcript shows a `ww create` shell call before `spawn_session`. `spawn_session.cwd` equals the path that `ww` printed. The result line reads `Spawned … in <that path>`. The child's handoff text does not mention making a worktree. The parent's shell calls are only `ww` calls (`--help-agent`, `list`, `create`), and `/tmp/spawn-smoke` has no `NOTES.md` (the parent did not do the child's work). (SC-001, SC-002, FR-003) |
| 4 | `/spawn using ww, branch smoke-decline, write a README`, then answer **No** | The confirm `Directory:` shows the `ww` path. The parent reports the decline and the worktree path. `ww list` still shows `smoke-decline`. (FR-009) |
| 5 | `/spawn using ww on branch taken, fix nothing` | `ww create` fails. No `spawn_session` call. One short line names the error. (SC-003) |
| 6 | `/spawn in a new worktree, list the files` | No shell call before `spawn_session`. `new_worktree: true`. (SC-004) |
| 7 | `/spawn in /tmp/spawn-smoke-taken, list the files` | No shell call before `spawn_session`. `spawn_session.cwd` is `/tmp/spawn-smoke-taken`, and `new_worktree` is unset. (SC-004, FR-007) |
| 8 | `/spawn create a new worktree using wwx for it, list the files` (`wwx` is not installed) | The tool call fails. No `spawn_session` call. One short line says that `wwx` is missing. (SC-003, FR-005) |

Check each row in the parent session file (`~/.omp/agent/sessions/…/*.jsonl`): the tool calls and their order.

## Cleanup

1. End each spawned zmx session with `/despawn` in the parent, or with `zmx kill <name>`.
2. Remove each `ww` worktree with `ww remove <branch>`, run from `/tmp/spawn-smoke`. Remove the `/spawn in a new worktree` worktree through `/despawn`.
3. Delete `/tmp/spawn-smoke` and `/tmp/spawn-smoke-taken`.

## Repository checks

From `packages/coding-agent`: `bun test test/spawn-command.test.ts test/session/sibling-spawn.test.ts`. From the repository root: `bun check`.
