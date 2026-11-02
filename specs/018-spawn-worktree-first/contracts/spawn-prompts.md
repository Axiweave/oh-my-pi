# Contract: `/spawn` prompts

The feature changes the contract between `/spawn` and the parent model. The tool schema does not change.

## Kickoff (`prompts/spawn/spawn-kickoff.md`)

| Request names | Parent action before `spawn_session` | `spawn_session` fields |
|---|---|---|
| a worktree tool (for example "using ww") | Run that tool once to make the worktree. Follow the tool's own skill or help. Use the request's branch name, or pick a short descriptive one. | `cwd` = the absolute path that the tool printed. No `new_worktree` or `branch`. `text` does not ask for a worktree. |
| a worktree tool and an existing directory | Same as the row above. The tool wins (spec edge case). The tool runs in the current checkout, not in the named directory. | `cwd` = the path that the tool printed, not the named directory. |
| "new worktree" with no tool | none | `new_worktree: true`, `branch` when one is named |
| an existing directory | none | `cwd` |
| none of these | none | no directory field |

Every other part of the request remains data for the new session. The parent runs nothing else.

When the setup fails, or no absolute path results, the parent does not call `spawn_session`. It reports the reason in one short line.

## Tool description results (`prompts/tools/spawn-session.md`)

| Result | Parent report |
|---|---|
| `Spawned <name> in <dir> (<mode>)` | one short line with the name, as today |
| `Spawn declined` | one short line. After a setup, the line includes the worktree path, which stays. |
| error | one short line with the reason. After a setup, the line includes the worktree path, which stays. |
