# Contract: Speckit-Auto Mode

This file defines what the user sees and types. The types are in [data-model.md](../data-model.md).

## Slash commands

| Input | Mode off | Mode on, no run | Mode on, run active |
|---|---|---|---|
| `/speckit-auto-mode` | Check FR-006 and FR-007. On success, turn on and show "Speckit-auto mode on. Run /speckit.specify <feature> to start." | Turn off. | Turn off. Drop the pending decision and start. A running turn finishes. Show the run summary with the result "stopped". |
| `/speckit-auto <description>` | Turn on (same checks), then submit `/speckit.specify <description>`. | Submit `/speckit.specify <description>`. | Submit `/speckit.specify <description>`. The old run ends as "stopped" when the new specify turn starts. |
| `/speckit-auto resume` | "Speckit-auto mode is off." | "No speckit-auto run is active." | Paused: resume (FR-029). Not paused: "The run is not paused." |
| `/speckit-auto next` | "Speckit-auto mode is off." | "No speckit-auto run is active." | Stop a running turn, then start the successor phase (FR-003). After converge, end the run as "stopped". |
| `/speckit-auto` | Usage and state. | Usage and state. | Usage and state. |

Both commands are builtin TUI commands in `slash-commands/builtin-modes.ts`. `/speckit-auto` has the subcommands `resume` and `next`, `allowArgs: true`, and the inline hint `<feature description> | resume | next`.

**Refusal messages** (shown with `showWarning`, mode stays off):

- Missing commands: "Speckit-auto mode needs these commands: /speckit.plan, /speckit.converge." (the missing ones, in phase order)
- Another mode: "Exit loop mode first." / "Exit goal mode first." / "Exit plan mode first." / "Exit vibe mode first." / "Finish the guided goal interview first." A paused plan or goal mode uses the existing paused wording.

**Exclusion message** (other mode refused while speckit-auto is on): "Turn off speckit-auto mode first (/speckit-auto-mode)."

## Autocomplete descriptions

| Command | Text |
|---|---|
| `/speckit-auto-mode` | `Speckit auto: off`, `Speckit auto: on (waiting)`, `Speckit auto: on (<phase>)`, `Speckit auto: paused (<phase>)`, or `Speckit auto: blocked by <mode> mode` |
| `/speckit-auto` | the same text |
| `/loop`, `/plan`, `/debate`, `/goal`, `/guided-goal`, `/vibe` while the mode is on | `<Mode>: blocked by speckit-auto mode` |

## Status bar

The mode uses the `mode` segment, the same slot as plan, goal, and loop mode. Format: `Speckit auto · <phase> · <state>`. With no run: `Speckit auto · waiting`.

| State | Text | Color |
|---|---|---|
| waiting | `waiting` | accent |
| running | `running` | accent |
| next (check runs or start parked) | `next phase due` | accent |
| user | `your turn` | accent |
| needs-you | `needs you: <short reason>` | accent |
| paused | `paused` + pause icon | warning |

## Messages the mode submits

Each one goes through `startPendingSubmission({ text })` and shows as a user row. The prompt texts live in `packages/coding-agent/src/prompts/speckit-auto/` (`answer.md`, `continue.md`, `remediation.md`). The judge questions live in `judge.md` in the same directory.

| Action | Text |
|---|---|
| start | `/speckit.<phase>` |
| answer | `Yes, proceed with your recommended option.` |
| remediate | See below. |
| continue (resume after an interrupted turn) | `Continue the /speckit.<phase> step from where it stopped.` For remediation: `Continue the remediation from where it stopped.` |

**Remediation message**:

```text
Fix the CRITICAL findings from the analyze report above. Change only documents in the feature directory (spec.md, plan.md, tasks.md, research.md, data-model.md, contracts/, quickstart.md). Do not change application code. Keep every accepted requirement, success criterion, and user decision. If a fix needs a new decision, ask me and stop. When you finish, list the files you changed, and end with the line "Remediation complete."
```

## Notices (chat status lines)

- HIGH only: "Speckit auto: analyze found N HIGH findings. Continuing to implement."
- Hold: "Speckit auto holds in <phase>: <reason>. Reply, or run /speckit-auto next to advance."
- Session switch: "Speckit-auto mode stopped: the session changed."
- Run end summary: "Speckit auto run <result>. Phases: specify → clarify → … Remediation rounds: R/2. Converge rounds: C/N." The result is `complete`, `ended with open tasks`, or `stopped`.

## Desktop notifications

- Suppressed while a run is active and not paused: the per-turn completion notification and the error notification.
- Sent by the mode, exactly once per event: each hold ("Speckit auto needs you", body: the reason, including a provider error or output limit) and each run end ("Speckit auto finished", body: the result). The `completion.notify` setting and the Warp gate apply.

## Setting

| Key | Type | Default | Range | UI |
|---|---|---|---|---|
| `speckitAuto.convergeRounds` | number | `3` | integer ≥ 0, other values clamp | tab `interaction`, group `Input`, presets 0, 1, 2, 3, 5 |

## Session entry

`{ type: "custom", customType: "speckit-auto", data: SpeckitAutoState }`. The entry is not part of the model context. The latest entry on the branch wins.
