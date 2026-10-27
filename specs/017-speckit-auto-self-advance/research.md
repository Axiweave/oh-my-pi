# Research: Speckit-Auto Follows a Phase the Agent Starts Itself

All findings come from the current source on `main` after the `v18.13.1` merge.

## R1. Where the mode sees a tool call

- **Decision**: Read `tool_execution_start` and `tool_execution_end` in `#handleSpeckitSessionEvent` (`packages/coding-agent/src/modes/interactive-mode.ts`). The start event carries `toolName` and `args`. The end event carries only `toolCallId`, `result`, and `isError`. Keep a map `toolCallId → SpeckitPhase` for starts that look like a phase load, and apply the load at the matching end event when `isError !== true`. Drop the entry at the end event in every case.
- **Rationale**: `#handleSpeckitSessionEvent` already gets every event of `this.session` (subscription at `interactive-mode.ts` ~2844). That subscription covers only the main session. Subagent tool calls never reach it, which gives the "main session only" rule of the spec for free. The end event is the first point where the agent has the instructions (FR-003), and `isError` covers the failed-load edge case.
- **Alternatives considered**: Scan the settled turn's assistant messages for tool calls at `#speckitTick`. Rejected: the status bar would update only at settle (SC-002), the abort of FR-008 would come too late, and a paused run never reaches the tick (FR-009).

## R2. What counts as a load

- **Decision**: One pure function `speckitPhaseLoad(toolName, args): SpeckitPhase | undefined` in `packages/coding-agent/src/modes/speckit-auto.ts`. The phase set is `SPECKIT_PHASE_COMMANDS`.
  - `bash`: split `args.command` into shell segments at `;`, `&&`, `||`, `|`, and newlines. A segment counts when its first word, after an optional directory prefix, is exactly `specify`, and a later word is exactly `speckit.<phase>` or `speckit-<phase>`. This matches `specify project command speckit.tasks --json` from the user's report.
  - `read`: strip every trailing selector (`:N-M`, `:raw`, `:raw:2-4`, and similar) from `args.path`. The path counts when its last segment is `speckit.<phase>.md`, or when it ends with `speckit-<phase>/SKILL.md`, or when it is `skill://speckit-<phase>` with an optional `/SKILL.md`. The rule matches the base name in any directory. The command and skill directories differ between projects, and a file with that exact name outside them is not a realistic false positive.
- **Rationale**: The first-word rule rejects searches such as `grep -r speckit.tasks .specify/`, where `.specify` is a path and `grep` is the command (FR-002, SC-003). Reply text and written file content never reach this function, because only `bash` and `read` calls are read. The installed `specify` CLI (v1.0.4 on this host) has no `project command` subcommand, so the rule matches any `specify` subcommand that names a phase command instead of one subcommand.
- **Alternatives considered**: (a) A regex for `specify` anywhere before `speckit.<phase>`. Rejected: `.specify/` paths match it. (b) Treat `cat .omp/commands/speckit.tasks.md` in bash as a load. Rejected for now: the same path shows up in `grep` and `sed` calls that only search. The spec's assumption limits loads to the two observed forms. (c) Async bash (`async: true`). Its end event comes when the job starts, before any output, so the agent does not have the instructions yet. `speckitPhaseLoad` returns `undefined` for it. A load through an async job is not followed. (d) Wrapped calls such as `uvx … specify …`, `uv run specify …`, or `FOO=1 specify …`. The first word is not `specify`, so they are not loads. Add them when they appear.

## R3. The agent path next to the existing paths

- **Decision**: Keep the typed-command branch and the own-turn branch of `#handleSpeckitSessionEvent` (`interactive-mode.ts` ~4270–4300) as they are. Add one method `#applySpeckitPhaseLoad(phase)` for agent loads. Share only the run start: extract `#startSpeckitRun(phase)` (end the old run as `stopped`, then `newSpeckitRun`) and call it from the typed branch and the agent method. The agent method covers:
  - `specify`, or any phase with no run → `#startSpeckitRun(phase)` (FR-010, FR-010a). The new run keeps the pause of the run it replaces (FR-009).
  - The same phase as `run.phase` → no change (FR-004).
  - Another phase → `implement` while in `converge` counts a converge round (FR-005). Then the phase moves the way `#enterSpeckitPhase` moves it, but `paused` stays unchanged and `editing` stays unchanged (FR-008, FR-009).
- **Rationale**: The three paths differ on purpose. The mode's own analyze start inside analyze counts a remediation round, and a same-phase agent load must not (FR-004). A typed implement sets `editing`, and an agent move must not (FR-008). A typed command ends a pause, and an agent move must not (FR-009). One merged method would need a flag for each difference and would change the existing paths. Only the run start is the same in all paths.
- **Alternatives considered**: One method `#followSpeckitPhase(phase, by)` for all three paths. Rejected: it either drops the remediation round of the own path or counts a round for a same-phase agent load, and it moves the existing editing and pause rules.

## R4. The scope stop at the load

- **Decision**: At the top of `#applySpeckitPhaseLoad`: when a run exists, is not paused, `speckitRunScope(run, this.#speckitScope) === "tasks"`, and the loaded phase is outside the tasks scope (`implement` or `converge`), then do the steps below. A run that exists at this point existed before the load, so a run that the load starts never hits this rule (FR-010).
  1. Call `#bumpSpeckitGeneration()` so that no parked step survives.
  2. Call `#finishSpeckitRun(run, "planned", note)`. It prints "stopped before implement" with the note "The agent started /speckit.<phase>, so the turn stopped." on the same line. `showStatus` replaces a status line that comes right after another one, so two calls would leave only one of them.
  3. Call `void this.session.abort({ reason: USER_INTERRUPT_LABEL })` when `this.session.isStreaming`. Every mode abort uses this reason, and it stops any automatic resume of the turn.
- **Rationale**: `planned` is the existing result for "stopped before implement" (`RESULT_TEXT`). `/speckit-auto next` already uses `session.abort({ reason })` to stop a running turn (`interactive-mode.ts` ~4012). `AgentSession` delivers `tool_execution_end` to its listeners synchronously (`#emitSessionEvent`), and `abort()` calls `agent.abort()` before its first `await`. So the abort signal is set inside the end-event handler. The agent loop checks the signal before it starts the next batch and before each later tool of the batch. Tool calls of the same parallel batch that already started can still finish (SC-004).
- **Alternatives considered**: Block the tool call at `tool_execution_start`. Rejected: the spec defines the load as a successful call, and the abort after the load is enough because loading the instructions edits nothing.

## R5. The notice and the status bar

- **Decision**: On each move by the agent, call `showStatus("Speckit auto: the agent started <phase>.")`, then `#saveSpeckitAutoState()` and `#updateSpeckitAutoStatus()`. A run that the load starts uses the same notice. When the load ends an old run (a specify load), the notice joins the old run's summary through the `note` argument of `#finishSpeckitRun`, because back-to-back status lines replace each other.
- **Rationale**: These are the calls that every other run change uses. `run.history` already holds every phase in order, so the summary of FR-011 needs no change.
- **Alternatives considered**: A persistent transcript entry. Deferred: clarify left this item as low impact, and status notices are the mode's existing channel.

## R6. The settle check after a move

- **Decision**: No change. `#speckitTick` already calls `classifySpeckitTurn(run.phase, …)`, and `run.phase` holds the moved phase at settle (FR-006). The user's free text in a no-run turn is already saved in `#speckitRequest` at `message_start`.
- **Rationale**: The move happens before settle, so the existing check reads the reply as a reply of the new phase.

## R7. A paused run

- **Decision**: `#applySpeckitPhaseLoad` changes the phase without touching `run.paused`. A specify load into a paused run starts the new run paused, because the user drives that turn. The tick returns early for a paused run, as it does today (FR-009). The abort of R4 skips a paused run for the same reason.
- **Rationale**: A paused run must resume from the phase that the agent last loaded (spec edge case, SC-005). The run state is saved on each move.

## R8. Documentation that the change touches

- **Decision**: Add a `packages/coding-agent/CHANGELOG.md` entry under Unreleased/Changed. Extend the "Speckit-auto mode" entry of `UPSTREAM_DIVERGENCES.md` with one decision line and its check. No setting is added, so `~/.omp/agent/config.yml` needs no change (FR-012).
