# Master mode

Master mode makes the top-level interactive session a central orchestrator. The main agent never waits on delegated work. It starts subagents and background jobs, ends its turn, and reacts to each result when it arrives. The only tool that can wait is `ask`, which waits for the user.

The mode does not change the active tool set. A guard refuses calls at run time. The guard is not a security boundary (see [The limit](#the-limit)).

## Enabling and disabling

Toggle it with the `/master` slash command, or start with `--master`:

```text
/master               # enter master mode
/master               # run again to exit
omp --master          # start in master mode (interactive only)
```

- Entering shows `Master mode on: …` and a `Master` indicator in the status line.
- Exiting shows `Master mode off.` The guard stops from the next tool call. A running turn continues. The per-turn message is removed from the context.
- `/new` turns the mode off.
- Entering needs `async.enabled`. If it is off, `/master` shows `Master mode needs background work. Enable async.enabled.`

## Exclusion with other modes

Master mode is mutually exclusive with vibe mode, plan mode (active or paused), and speckit-auto mode. Each command refuses with a short message:

| Command | Refusal |
| --- | --- |
| `/master` while speckit-auto is on | `Turn off speckit-auto mode first (/speckit-auto-mode).` |
| `/master` while plan mode is on | `Exit plan mode first.` |
| `/master` while plan mode is paused | `Plan mode is paused — run /plan again to fully exit.` |
| `/master` while vibe mode is on | `Exit vibe mode first.` |
| `/vibe`, `/plan`, `/speckit-auto-mode` while master is on | `Exit master mode first.` |

Goal mode and loop mode work with master mode. `/goal`, `/loop`, `/guided-goal`, and `/guided-loop` stay allowed. A `/loop` with a reset is refused: `Exit master mode before using reset loops. Loop mode disabled.`

## Enforced rules

While the mode is on, the guard runs before every main-agent tool call. A refused call returns an error result. The tool does not run.

| Call | Result |
| --- | --- |
| `task` | Allowed. `TaskTool` refuses a call that would run in the foreground. |
| `bash` with `async: true` and no `name` | Allowed. |
| `bash` without `async: true` | Refused (`foreground-bash`). |
| `bash` with a non-blank `name` | Refused (`service-bash`). |
| `read`, `grep`, `glob`, `find`, `todo`, `ask`, `goal`, `loop` | Allowed. |
| `write` to `agent://`, `out://`, `local://`, or `proc://<id>/kill` | Allowed. |
| `write` to any other target | Refused (`file-change`). |
| `edit`, `ast_edit` | Refused (`file-change`). |
| `wait` | Refused (`wait`). |
| Any other tool, MCP tool, or extension tool | Refused (`other`). |

`TaskTool` refuses with the `foreground-task` text when any of these is true:

- `async.enabled` is off.
- The session has no async job manager.
- An agent type of the call has `blocking: true`.

A subagent that master mode starts keeps its normal tools. Its own `task`, `bash`, and edit calls are not refused.

## Refusal behavior

Every refusal starts with `Master mode is on.` and ends with `Do not retry or route around this block.` The text names the allowed way: a `task` call, or a background `bash` call with `async: true`. A repeated call gets the same text.

## The limit

The guard does not stop a background `bash` job from changing files. The rule "give every change to a subagent" is a prompt rule only. The per-turn message tells the model this rule, and omp does not enforce it. Master mode is not forced delegation.

## Per-turn message

While the mode is on, each prompt turn gets a hidden `master-mode-context` message. It tells the agent to:

1. Coordinate, never wait for workers, and not change files.
2. Use only the allowed tools.
3. Plan the work and give independent parts to subagents in one `task` call.
4. End the turn after it starts work, then react to each result.
5. Use background `bash` for checks only, and give every change to a subagent.
6. Report to the user.

omp does not save this message in the transcript.

## `--master`

`--master` has no value. It starts the interactive session in master mode before the first turn.

- `omp --master "prompt"` runs the prompt with the mode on.
- With `--goal`, master mode starts first and the goal start prompt runs under it.
- With `--print`, `--mode rpc`, `--mode acp`, or any non-interactive mode, omp exits with code 2: `--master requires an interactive terminal (not --print or --mode).`
- With `async.enabled` off, startup plan mode, or `--plan-yolo`, the session starts without master mode and shows the reason.
- With a speckit-auto startup default, master mode wins and speckit-auto stays off.
- On a resumed master session, nothing changes. The mode is already on.

## Resume

omp saves each change as a `master-mode` session entry with `{ enabled }`. After `--continue`, `--resume`, or `/resume`, the mode is on when the latest `master-mode` entry on the branch has `enabled: true`. The mode is on before the first turn, so the first turn already refuses a direct edit.
