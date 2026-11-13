Create one new top-level omp session in its own zmx session, from a `/spawn` request or, in master mode, by your own choice. Outside master mode it exists only while that request runs. The user talks to each new session directly; nothing comes back here.

`mode` (required), chosen from the request:
- `fresh`: new conversation. `text` (required): self-contained opening prompt written from the request. The new session starts work on it at once.
- `fork`: copy of this whole conversation. The new session waits for the user. `text` MUST be empty.
- `fork_handoff`: same copy plus `text` (required) as a handoff note. The new session starts work on the note at once.
- `handoff_summary`: new conversation that starts from a summary of this one, which OMP writes. `text`: optional focus for the summary.
- `plan`: shows the user one overview of all tasks before any setup. ONLY when the `/spawn` instructions ask for it. ONLY with `tasks` (one line per task, 2 or more); no other field.

Optional fields:
- `cwd`: absolute path of an existing directory on this host. Default: this session's directory. After you made a worktree with a tool the request names, `cwd` is the path that tool printed.
- `new_worktree`: `true` starts the new session in a new branch and worktree made from the current commit, with a copy of the uncommitted changes. Only when the request or the `/spawn` instructions ask for a new worktree and the request names no tool. NEVER with `cwd`. When the new session needs a clean tree, say so in `text`.
- `branch`: branch name for `new_worktree` only. REQUIRED with `new_worktree`: a short kebab-case name for the topic (`feat/<topic>`), with the issue ID first only when the request names one (`feat/<id>-<topic>`). NEVER a date or a generic name. A name that exists gets a `-2`, `-3`, … suffix.
- `model`: `provider/id`. Set ONLY when the request names a model other than this session's.
- `speckit`: `true` makes the new session start with `/speckit.specify`, with `text` (or the summary for `handoff_summary`) as the feature description. Write `text` (also a `fork_handoff` note) as that description: the new session follows the spec-kit workflow, so NEVER ask it to edit code or implement directly. NEVER with `fork`. The new session's directory has no `/speckit.specify` → it starts without it.

Call it once per task of the request, one call at a time. NEVER do the requested work yourself.

Results:
- Spawned → note the name; go on with the next task. `spec-kit skipped: …` at the end → name that in the task's line.
- Error → note the reason; go on with the next task. If you made a worktree first, the line also names its path; it stays.
- Spawn declined → the user said no to this task. Note it, plus any worktree path; go on with the next task.
- `Approved: spawn the <N> tasks.` → spawn each task; their own dialogs do not show.
- `spawn.confirm is off: no overview. Spawn each task.` → spawn each task.
- `Overview declined: spawn nothing.` or `The user declined this /spawn.` → run nothing more.
- NEVER remove a worktree you made for this request.
- After the last task, report one short line per task and end your turn.
