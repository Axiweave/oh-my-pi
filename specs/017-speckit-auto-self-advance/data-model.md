# Data Model: Speckit-Auto Follows a Phase the Agent Starts Itself

No saved shape changes. The session `custom` entry `speckit-auto` and `SpeckitRun` (see `specs/009-speckit-auto-pipeline/data-model.md`) keep their fields.

## Phase load (new, in memory only)

| Field | Type | Source |
|---|---|---|
| `toolCallId` | string | `tool_execution_start` event |
| `phase` | `SpeckitPhase` (one of `SPECKIT_PHASE_COMMANDS`) | `speckitPhaseLoad(toolName, args)` |

- Lives in `InteractiveMode#speckitPendingLoads: Map<string, SpeckitPhase>` from the start event to the end event of its tool call.
- Recorded only while the mode is on. Removed at the end event in every case, also when the mode is off by then, so no other clear point is needed.
- Applied only when the end event has `isError !== true` and the mode is on.

## Run transitions on an applied agent load

These rows apply only to agent loads (`#applySpeckitPhaseLoad`). The typed-command branch and the mode's own-turn branch keep their current rules (research R3). Rows are checked in order. The first match wins.

| # | Condition | Effect | Spec |
|---|---|---|---|
| 1 | Mode off | Nothing | — |
| 2 | Run exists, not paused, `speckitRunScope(run, scope) = tasks`, `phase` is `implement` or `converge` | Bump the generation, show the scope notice, end the run as `planned` ("stopped before implement"), abort the streaming turn. The run does not move. | FR-008 |
| 3 | `phase = specify`, or no run | `#startSpeckitRun(phase)`: end the old run as `stopped` (if any), then `newSpeckitRun(phase, convergeRounds)`. The new run copies `paused` from the old run. `editing` follows `newSpeckitRun`, the same as a typed command with no run. | FR-009, FR-010, FR-010a |
| 4 | `phase = run.phase` | Nothing | FR-004 |
| 5 | Otherwise | `implement` while in `converge` adds 1 to `convergeRounds`. Then `phase = phase`, append to `history`, `autoAnswered = false`. `paused` and `editing` stay unchanged. | FR-003, FR-005, FR-008, FR-009 |

After rows 3 and 5: bump the generation (pending steps of the old phase no longer apply), set `turnOpen = true` and `hold = undefined`, show "Speckit auto: the agent started <phase>.", save the state, and update the status bar (FR-007, SC-002). When row 3 ends an old run, the notice joins the old run's summary line, because a second status line right after it would replace the summary.

## Validation rules

- `speckitPhaseLoad` returns `undefined` for every tool other than `bash` and `read`, for `bash` with `async: true`, and for any argument shape it does not expect (non-string `command` or `path`).
- A phase name outside `SPECKIT_PHASE_COMMANDS` (for example `speckit.checklist`) is not a load.
