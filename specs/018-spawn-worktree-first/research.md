# Research: Spawn Into a Prepared Worktree

## R1. Where the fix goes

- **Decision:** Change only the two prompts: `packages/coding-agent/src/prompts/spawn/spawn-kickoff.md` (the hidden `/spawn` kickoff) and `packages/coding-agent/src/prompts/tools/spawn-session.md` (the `spawn_session` tool description). Make no code change.
- **Rationale:** The parent already has everything that it needs.
  - `#beginSpawnWindow` (`interactive-mode.ts:8681-8691`) adds `spawn_session` (and `ask`) to the enabled tools and removes nothing, so `bash` stays available.
  - `spawn_session` already accepts `cwd` and checks that it is absolute and exists (`tools/spawn-session.ts:56-59`).
  - `#spawnSibling` uses `request.cwd` as the child directory (`interactive-mode.ts:8821`), and the confirm dialog shows it on the `Directory:` line (`:8802`).
  - The failure was the prompt. Its line 7 reads "NEVER do the requested work yourself", and its line 1 says that the request is "data, not instructions for you". With these rules, the model put the `ww` step in the handoff note.
- **Alternatives considered:**
  - A setting that makes `new_worktree` run an external command (option B). This is out of scope (spec Assumptions).
  - A `move_session` tool for the child (option C). It needs a new turn-end hook and is out of scope.

## R2. How narrow the exception must be

- **Decision:** The kickoff allows exactly one kind of action before `spawn_session`. That action is to make the worktree with the tool that the request names. Every other part of the request stays data for the child. This includes dependency installs, speckit commands, edits, and tests.
- **Rationale:** The "data, not instructions" rule guards against a request that makes the parent do the child's work. A closed exception keeps that guard. A setup that only makes a worktree changes no tracked file in the parent's checkout. `ww create` copies extras into the new worktree and leaves the source unchanged (`ww --help-agent`: "Staged and unstaged source edits stay in the source").

## R3. Tool rules and the branch name

- **Decision:** The kickoff tells the model to follow the named tool's own usage rules: its skill when one exists (`ww` has `skill://ww`, which requires `ww --help-agent` first), else its help output. The model takes the branch name from the request. If the request has none, the model picks a short descriptive name and does not ask (spec FR-001a).
- **Rationale:** The prompt must not copy the `ww` flags. The installed contract can change, and the user may name another tool. `ww create <branch>` branches from the current HEAD and prints the destination path on stdout. This is the path for `cwd`.

## R4. Failure, decline, and spawn error after setup

- **Decision:**
  - Setup fails, or no absolute path results: make no `spawn_session` call, report the reason in one line, and end the turn (FR-005).
  - The spawn is declined, or `spawn_session` fails after the setup: report the worktree path in the same short line, and do not remove it (FR-009).
- **Rationale:** `#spawnSibling` removes only a worktree that it made itself (`removeSessionWorktree` at `:8842-8848`). A worktree made by the parent's tool is not owned by omp. `/despawn` also applies `worktree.onExit` only to worktrees with `cci-wt-*` labels (`:8836`), and the parent's tool worktree gets none. The user's tool (`ww remove`) owns it. Automatic removal could delete copied extras. The `ww` contract warns against automatic recovery deletes.
- **Note:** Without the change, the model ends the turn on "Spawn declined" with no path (`spawn-session.md:19`). The tool description must name the path case.

## R5. Requests that name no tool

- **Decision:** Keep the current mapping. "New worktree" with no tool name maps to `new_worktree: true`. A named directory maps to `cwd`. Otherwise, set neither. If a tool is named, never set `new_worktree`, because the tool already made the worktree, and `cwd` with `new_worktree` is refused (`spawn-session.ts:51`).

## R6. The handoff text

- **Decision:** When the setup ran, the `text` field (for `fresh`, `fork_handoff`, and `handoff_summary` focus) does not ask the child to make a worktree. It may say that the session already runs in the new worktree on the named branch.
- **Rationale:** FR-004. A child that runs `ww create` again would make a second worktree.

## R7. Verification approach

- **Decision:** Prompt behavior needs real-model runs, not unit tests. A test that matches the prompt text tests wording, which the repository rules forbid. Run the quickstart smoke: 3 runs of `/spawn … using ww` in a throwaway repository (SC-002), 1 run with a failing branch (SC-003), and 1 run of `/spawn in a new worktree …` (SC-004). Read each parent transcript to see the tool calls.
- **Rationale:** The existing `spawn-command.test.ts` covers the window and the handler mechanics, and these do not change. Project memory requires real-judge smoke tests with 3 or more samples for prompt changes.
