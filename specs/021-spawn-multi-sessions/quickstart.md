# Quickstart: Spawn More Than One Session From One Request

## Prerequisites

- `ww` on `PATH` (`ww --help-agent` works).
- omp from this checkout, running inside a zmx session (`ZMX_SESSION` set).
- `spawn.confirm` off, except in rows 7–9.

## Setup

1. Create a throwaway repository: `git init /tmp/spawn-multi`, add one file, and commit it on `main`.
2. Create a branch `taken` and check it out in a second worktree: `git -C /tmp/spawn-multi worktree add /tmp/spawn-multi-taken taken`.
3. Start omp from this checkout in `/tmp/spawn-multi`.

## Runs

| # | Input | Expected |
|---|---|---|
| 1–3 | `/spawn A and B each in its own ww worktree, C in this directory; A lists files, B prints the date, C shows git status` (3 times, each in a new parent session) | Two `ww create` calls on two different branches, one before each matching spawn. Three `spawn_session` calls. A and B use `cwd` = the `ww` path. C has no `cwd`. A report with three lines. `/despawn` lists three sessions. (SC-002, FR-005–FR-008, FR-012) |
| 4 | `/spawn A in a new ww worktree, B in a new worktree, C here; each lists its files` | One `ww create`. B has `new_worktree: true`. C has no `cwd`. (SC-003) |
| 5 | `/spawn A in a new ww worktree on branch taken, B in a new ww worktree on branch feat/multi-b; each lists files` | The `ww` call for A fails and A has no spawn. B spawns. The report names the error for A and the session for B. (SC-004, FR-009, FR-010) |
| 6 | `/spawn try 3 approaches to speeding up the test suite, each fresh` | Three fresh spawns. Each opening text has a different approach. (US1-4) |
| 7 | `spawn.confirm` on: `/spawn A and B each in its own ww worktree; each lists files`, then answer **Yes** | The first call is `spawn_session` `plan` with 2 lines. It runs before any `ww` call. No dialog shows for each task. Two sessions start. (FR-011) |
| 8 | `spawn.confirm` on: same as row 7, then answer **No** | There is no `ww` call and no spawn. The report is one line. (FR-011) |
| 9 | `spawn.confirm` on: `/spawn in a new ww worktree, list files` | No `plan` call. Today's one-session dialog shows the `ww` path. (FR-002, FR-011) |
| 10 | `/spawn A and B as handoff summaries, A about the tests, B about the docs` | Two "Writing the handoff summary" loaders. The two opening documents have different focuses. (FR-004a) |
| 11 | During a long turn, type `/spawn list files` as a follow-up, and let it finish. After `agent_end`, type `/spawn print the date`. | The second `/spawn` is accepted and spawns. (SC-006, FR-015) |

For each row, check the tool calls and their order in the parent session file (`~/.omp/agent/sessions/…/*.jsonl`).

## Cleanup

1. End each spawned session with `/despawn`, or with `zmx kill <name>`.
2. Remove each `ww` worktree with `ww remove <branch>`, run from `/tmp/spawn-multi`.
3. Delete `/tmp/spawn-multi` and `/tmp/spawn-multi-taken`.

## Repository checks

From `packages/coding-agent`: `bun test test/spawn-command.test.ts test/session/sibling-spawn.test.ts`. From the repository root: `bun check`.
