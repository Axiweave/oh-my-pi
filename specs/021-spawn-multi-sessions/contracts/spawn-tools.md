# Contract: `spawn_session` and the `/spawn` Kickoff

## `spawn_session` input

```ts
{
  mode: "fresh" | "fork" | "fork_handoff" | "handoff_summary" | "plan";
  text?: string;        // as today; not with plan
  cwd?: string;         // as today; not with plan
  new_worktree?: boolean;
  branch?: string;
  model?: string;
  tasks?: string[];     // plan only: one line for each task, 2 or more
}
```

`concurrency: "exclusive"`: the agent loop runs parallel calls one after another.

## `spawn_session` results

| Call | Result text | Error |
|---|---|---|
| spawn, success | `Spawned <name> in <dir> (<mode>)` | — |
| spawn, dialog declined | `Spawn declined` (this task only: go on with the next task) | — |
| spawn after a declined overview | — | `The user declined this /spawn.` |
| spawn, failure | — | the reason, as today. The window stays open. |
| plan, confirm off | `spawn.confirm is off: no overview. Spawn each task.` | — |
| plan, approved | `Approved: spawn the <N> tasks.` | — |
| plan, declined | `Overview declined: spawn nothing.` (stop: run no setup and no spawn) | — |
| plan, second call | — | `The overview already showed for this /spawn.` |

## Overview dialog

- Title: `Spawn these <N> sessions?`
- Body: one line for each task from `tasks`, in order. The first selected option is **No**, as in the one-session dialog.

## Kickoff prompt (`prompts/spawn/spawn-kickoff.md`)

New template variable: `confirm` (`spawn.confirm`), next to `askEnabled`.

The rules that the prompt gives:

1. Split the request into tasks, one for each session that it asks for. Most requests are one task. A count ("try 3 approaches") gives that many tasks.
2. Each task has its own mode, `text`, directory setup, branch, and model. A setup that the request gives to all tasks applies to each task separately. "Each in its own worktree" gives one worktree for each task.
3. `{{#if confirm}}` Two or more tasks: call `spawn_session` with `mode: "plan"` first, before any worktree tool runs. Write one line for each task: label, mode, directory setup, branch, and model. On `Overview declined: spawn nothing.`, run nothing more and report one line. `{{/if}}`
4. Handle tasks one at a time, in request order. For each task, run its worktree tool (rules from spec 018), then spawn that task.
5. A worktree tool failure or a spawn error skips only that task. Go on with the next task.
6. Branch names that the model picks are different for each task.
7. For `handoff_summary`, `text` is that task's focus. Each task gets its own summary.
8. At the end, report one short line for each task: its session name, or the reason it did not start, with the worktree path if one exists.
9. Split unclear: with `askEnabled`, ask exactly one question. Without it, pick the most likely split.

## Tool description (`prompts/tools/spawn-session.md`)

- Remove "Call exactly once: the tool goes away after the first call".
- Add: call it once for each task. Add the `plan` mode and its rules.
- Error and decline results: report that task's line and go on with the next task. Never remove a worktree you made.
