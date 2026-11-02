Create one new top-level omp session in its own zmx session, from a `/spawn` request. Exists only while that request runs. The user talks to the new session directly; nothing comes back here.

`mode` (required), chosen from the request:
- `fresh`: new conversation. `text` (required): self-contained opening prompt written from the request. The new session starts work on it at once.
- `fork`: copy of this whole conversation. The new session waits for the user. `text` MUST be empty.
- `fork_handoff`: same copy plus `text` (required) as a handoff note. The new session starts work on the note at once.
- `handoff_summary`: new conversation that starts from a summary of this one, which OMP writes. `text`: optional focus for the summary.

Optional fields:
- `cwd`: absolute path of an existing directory on this host. Default: this session's directory. After you made a worktree with a tool the request names, `cwd` is the path that tool printed.
- `new_worktree`: `true` starts the new session in a new branch and worktree made from the current commit, with a copy of the uncommitted changes. Only when the request asks for a new worktree and names no tool. NEVER with `cwd`. When the new session needs a clean tree, say so in `text`.
- `branch`: branch name for `new_worktree` only. Default: a generated name.
- `model`: `provider/id`. Set ONLY when the request names a model other than this session's.

Call exactly once: the tool goes away after the first call, whatever its result. NEVER do the requested work yourself.

Results:
- Error → report the reason in one short line and end your turn. The user can run `/spawn` again. If you made a worktree first, the line also names its path; it stays.
- Spawn declined → the user said no. If you made a worktree first, report its path in one short line; it stays. End your turn.
- NEVER remove a worktree you made for this call.
- Spawned → report the name in one short line and end your turn.
