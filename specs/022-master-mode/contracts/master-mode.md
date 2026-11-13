# Contract: Master Mode

Three surfaces: the `/master` command, the `--master` flag, and the tool guard. Texts in code font are exact. The tests check them by property (research R11), not by a full copy.

## `/master`

A toggle with no arguments. It has a TUI handler only. The handler is `InteractiveMode.handleMasterModeCommand`.

| State when typed | Result | Message |
|---|---|---|
| Off, no blocker | Master mode turns on. The status line shows `Master`. The entry is saved. | `Master mode on: the main agent delegates work to subagents and background jobs, never waits on delegated work, and does not edit files itself.` |
| On | Master mode turns off. The guard stops from the next tool call. A running turn continues. The message is removed from the context. The entry is saved. | `Master mode off.` |
| Off, speckit-auto on | Refused. No change. | `Turn off speckit-auto mode first (/speckit-auto-mode).` |
| Off, plan mode on | Refused. | `Exit plan mode first.` |
| Off, plan mode paused | Refused. | `Plan mode is paused — run /plan again to fully exit.` |
| Off, vibe mode on | Refused. | `Exit vibe mode first.` |
| Off, `async.enabled` is off, or no async job manager | Refused. | `Master mode needs background work. Enable async.enabled.` |
| Off, goal mode or loop mode on | Allowed. Both modes continue. | as the first row |

The slash menu hint (`getTuiAutocompleteDescription`) shows `Master: on`, `Master: blocked by speckit-auto mode`, `Master: blocked by plan mode`, `Master: blocked by vibe mode`, or `Master: off`, in the order of the refusal checks.

### The other modes while master is on

| Command | Result |
|---|---|
| `/vibe` | `Exit master mode first.` The `/vibe` hint shows `Vibe: blocked by master mode`. |
| `/plan` | `Exit master mode first.` The `/plan` hint shows `Plan: blocked by master mode`. |
| `/speckit-auto-mode` | `Exit master mode first.` (from the `#speckitAutoBlocker` return value `"master"`) |
| Extension mode API, `plan` or `vibe` with `enter` | `{ code: "conflict", message: "Exit master mode first." }` |
| `/goal`, `/loop`, `/guided-goal`, `/guided-loop` | Allowed. |
| `/loop` with a reset | `Exit master mode before using reset loops. Loop mode disabled.` |

### Status line

The `mode` segment adds `Master` after the main mode (`Plan`, `Goal`, `Loop`, and so on). When no other mode shows, it shows `Master` alone. The icon is the vibe icon (`theme.icon.agents`). It shows while the state is on, and it does not show when the state is off.

### Resume

The saved entry decides. After `--continue`, `--resume`, or `/resume`, the mode is on if the latest `master-mode` entry on the branch has `enabled: true`. A target with no entry keeps the current state: after `/new`, `/clear`, or `/delete`, the mode stays on and the new session saves an entry. A target that restores plan (on or paused), vibe, implementation review (`impl_review`), or speckit-auto mode leaves master mode off. An implementation review needs `write`, which the guard refuses. This holds before the first turn, so the first turn already refuses a direct edit.

## `--master`

| Case | Result |
|---|---|
| `omp --master` in the interactive TUI | Master mode is on before the first turn and before any start prompt. |
| `omp --master "prompt"` | The prompt runs with master mode on. |
| `omp --master --goal "objective"` | Master mode starts first. The goal start prompt runs under it. |
| `omp --master` with `async.enabled` off | The TUI shows `Master mode needs background work. Enable async.enabled.` The session starts without master mode. |
| `omp --master` with a speckit-auto default on startup | Master mode wins. Speckit-auto stays off (`startupBlocker: "master"`). |
| `omp --master` with plan mode on startup (`plan.defaultOnStartup`, or a resumed plan session) | The TUI shows `Exit plan mode first.` The session starts without master mode. |
| `omp --master --plan-yolo` | The TUI shows `Master mode stays off: --plan-yolo starts plan mode.` The session starts without master mode. |
| `omp --master` on a resumed master session | No change. The mode is already on. |
| `omp --master -p`, `--mode rpc`, `--mode acp`, or any other non-interactive mode | Exit code 2 and `--master requires an interactive terminal (not --print or --mode).` No session starts. |

The flag is valueless. It appears in `omp --help` with the text `Start in master mode: the main agent delegates work to subagents and background jobs and never waits on them (interactive only)`.

## Guard: `masterRefusal(toolName, args)`

Applies only while the state is on. With the state off there is no rule.

Every refusal text ends with `Do not retry or route around this block.` Each one says `Master mode is on.` first.

| Tool call | Result |
|---|---|
| `task` (any args) | Allow at the guard. `TaskTool` may still refuse (below). |
| `bash` `{ command, async: true }` | Allow. |
| `bash` `{ command, async: true, name: "  " }` | Allow (a blank name is no name). |
| `bash` `{ command }` or `{ command, async: false }` | Refuse, `foreground-bash`. |
| `bash` `{ command, async: true, name: "dev" }` | Refuse, `service-bash`. |
| `read`, `grep`, `glob`, `find`, `todo`, `ask`, `goal`, `loop`, `spawn_session` | Allow. |
| `write` `{ path: "agent://…" }` | Allow. |
| `write` `{ path: "out://…" }` | Allow. |
| `write` `{ path: "local://notes.md" }` | Allow. |
| `write` `{ path: "proc://bg_1/kill" }` | Allow. |
| `write` `{ path: "proc://bg_1/stdin" }` | Refuse, `file-change`. |
| `write` `{ path: "src/a.ts" }` | Refuse, `file-change`. |
| `write` `{ path: "xd://edit" }` | Refuse, `file-change`. |
| `write` with a malformed selector, or no `path` | Refuse, `file-change`. |
| `edit`, `ast_edit` | Refuse, `file-change`. |
| `wait` | Refuse, `wait`. |
| `eval`, `web_search`, `browser`, `computer`, `lsp`, `debug`, `ida`, `github`, `checkpoint`, `rewind`, `new_context`, `context_notes`, `ast_grep`, `think`, memory tools | Refuse, `other`. |
| `mcp__*` names, extension tools, unknown names | Refuse, `other`. |

### Refusal texts

| Case | Text |
|---|---|
| `file-change` | ``Master mode is on. You do not change files yourself. Give the change to a subagent with `task`. Do not retry or route around this block.`` |
| `foreground-bash` | ``Master mode is on. Run shell commands as a background job: call `bash` with `async: true`. Give every file change to a subagent with `task`. Do not retry or route around this block.`` |
| `service-bash` | ``Master mode is on. A named service call can block. Call `bash` with `async: true` and no `name`. Do not retry or route around this block.`` |
| `wait` | ``Master mode is on. Do not wait. Results of subagents and background jobs arrive by themselves. End your turn after you start the work. Do not retry or route around this block.`` |
| `foreground-task` | ``Master mode is on. This `task` call would run in the foreground and block you. Use agent types that are not blocking, and keep `async.enabled` on. Do not retry or route around this block.`` |
| `other` | ``Master mode is on. The tool `<name>` is not available to the main agent. Give the work to a subagent with `task`, or run a check as a background `bash` call with `async: true`. Do not retry or route around this block.`` |

A refusal is an error tool result. The tool does not run, so a file, a process, and a job stay as they were. A repeated call gets the same text.

### `task` foreground refusal (`TaskTool`)

`TaskTool.#dispatch` returns the `foreground-task` text, with no run started, when the state is on and any of these is true:
- `async.enabled` is off.
- The session has no `asyncJobManager`.
- Any item's agent type has `blocking: true`.

`TaskTool.#startSpeculative` returns no run for the same cases.

A subagent that master mode started keeps its normal tools. Its own `task` calls, `bash` calls, and edits are not refused, because its session has no master state.

## Per-turn message

Type `master-mode-context`, hidden, rebuilt each prompt turn while the state is on, and never saved. The content states, in order:

1. Master mode is on. You coordinate. You never wait for a worker, a background job, or a foreground command (`ask` may wait for the user). You do not change files.
2. The tools you can use.
3. Plan the work and give independent parts to subagents in one `task` call.
4. After you start work, end your turn. React to each result when it arrives.
5. Use background `bash` for checks only (tests, builds, `git status`). Give every change to a subagent. This is a rule for you, and omp does not enforce it.
6. Report to the user.
