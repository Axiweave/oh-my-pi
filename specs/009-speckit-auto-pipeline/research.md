# Research: Speckit-Auto Mode

All paths are relative to `packages/coding-agent/src/` unless a path starts with `packages/` or `docs/`. Line numbers are from the tree at `6bf8b58531`.

## R1. Where the feature lives

- **Decision**: One pure module `modes/speckit-auto.ts`, static prompt files in `prompts/speckit-auto/`, and wiring in `InteractiveMode` beside loop and goal mode.
- **Rationale**: Loop mode (`handleLoopCommand` 3175, `#scheduleLoopAutoSubmit` 2888, `#submitLoopPromptWhenReady` 2995) and goal mode (`#scheduleGoalContinuation` 2914) live in `interactive-mode.ts` and use private seams that the mode also needs: `onInputCallback`, `#isAutoSubmitBlocked` (2991), `#pendingSubmittedInput`, `#reconcileModeFromSession` (4898), and `#clearTransientModeState` (4820). The decision rules are pure and need many test cases, so they go in their own module.
- **Alternatives considered**: An extension (rejected by the user, FR-034). A `SpeckitAutoController` class in `modes/controllers/` (rejected: it needs about ten new public members on `InteractiveModeContext` only to reach private seams, which is a second convention for one mode).

## R2. When a turn is settled

- **Decision**: One predicate, `#isSpeckitStartBlocked()`. The mode checks it before a decision and again just before a submit:
  - `#isAutoSubmitBlocked()`: `session.isStreaming || session.isCompacting || session.hasPostPromptWork`.
  - `session.hasAdmittedSubmission` (agent-session.ts 3178), `session.queuedMessageCount > 0` (9245), `compactionQueuedMessages.length > 0` (ui-helpers.ts 1152, not counted by the session), `session.isRetrying` (11183).
  - `session.hasPendingAsyncWork()` (3173). It is true while a background job can wake the turn.
  - `#pendingSubmittedInput !== undefined`.
  - `#speckitSubmitInFlight > 0`: a new counter. The editor submit handler increments it before its first `await` and decrements it in a `finally` (input-controller.ts, the `onSubmit` body that starts at about 1060). The editor clears its text before it calls `onSubmit`, and the handler awaits input hooks (1106-1118) before it creates a pending submission. Without the counter, the grace timer could submit in that window (review finding 4). A local command such as `/model` ends the handler, so the counter returns to 0 and the parked start continues.
  - Draft: `editor.getText().trim() !== ""` or `editor.pendingImages.length > 0`.
  - Local interaction: `ui.hasOverlay()` (packages/tui/src/tui.ts 1310), `ui.getFocused() !== editor`, or `editorContainer.children[0] !== editor`. The last check catches the ask dialog and hook selectors, which swap the editor slot and are not overlays.
- **Rationale**: FR-010. The existing `#isAutoSubmitBlocked` does not cover all of FR-010, so the mode adds the rest. The shutdown check (interactive-mode.ts 7325-7340) and `rpc-session-settle.ts` 45-50 use the same set of session fields. A background wake that lands in the grace period makes `hasPendingAsyncWork()` true or starts a stream, and the second check catches it.
- **Alternatives considered**: Listen for `agent_end` with `isTerminal` only. Rejected: `#flushPendingAgentEnd` (agent-session.ts 1503) can re-tag an end as non-terminal, and a cancelled wake sends no terminal end.

## R3. The tick: decide once, start when the guard clears

- **Decision**: One self-arming timer, `#speckitTick()`, at 800 ms. It runs while the mode is on, a run is active, the run is not paused and has no hold, and there is an undecided turn or a parked start. Arm it from `getUserInput()` (2874-2890, next to the loop and goal schedulers) and from every session `agent_end` event, so background wakes and inline skill turns that do not resolve the input waiter still arm it (review finding 6). Each tick does one of these:
  1. If the guard blocks: re-arm and return.
  2. If a parked start exists: submit it with `#speckitSubmit()` (FR-012, no new decision).
  3. If the latest turn key differs from `#speckitDecidedKey`: set `turnOpen = false` (the turn settled), then classify, decide, and act. The decision itself does not submit. A start becomes a parked start, and the next tick (800 ms later) submits it. This tick gap is the grace period of FR-011.
  A tick that finds the guard clear also clears a stale `#speckitOwnTurn` (R4).
- **Turn key**: the `timestamp` of `session.getLastAssistantMessage()`. A session entry id is not a valid key, because the mode's own `custom` entry moves the leaf.
- **Rationale**: No close event exists for selectors or the editor slot (`focusActiveEditorArea` is not called by every closer), so a short poll is the simplest correct choice. The loop mode uses the same 800 ms re-defer (`#deferLoopAutoSubmit` 2898).

## R4. The user comes first

- **Decision**: A generation counter `#speckitGeneration`. Every judge call, parked start, own-turn marker, and `next` continuation stores the generation when it starts and drops itself when the counter changed. These events increment the counter: a user turn starts, Esc pauses the run, the mode turns off, `next`, `resume`, a new run, and a session switch. The judge call also gets an `AbortController` that these events abort.
- **User turn detection**: Listen on the session `message_start` event, the same as `#handleGoalSessionEvent` (4677). A message is a turn start when its role is `user`, or its role is `developer` with `userInitiated: true` (the `.` and `c` continue shortcuts, input-controller.ts 1085-1096, review finding 5). When the mode submits, it sets `#speckitOwnTurn = { text, phase, generation }`. A `message_start` is the mode's own turn when `#speckitOwnTurn` exists, its generation is current, and the text (or `promptTemplateInput`) equals `#speckitOwnTurn.text`. The match clears the marker. Any other turn start is a user turn.
- **Marker cleanup**: Every generation increment clears `#speckitOwnTurn`. A tick that finds the guard clear also clears it: a settled session means the own submission either started (and matched) or failed before `message_start` (for example a credential error in preflight, agent-session.ts 8052-8080). So a stale marker cannot match a later user turn (review round 2, finding 3).
- **Rationale**: `message_start` is the real turn start for every submission path: idle text, steering, follow-ups, compaction-queued messages, slash commands that return a prompt, and file commands. A command such as `/model` that ends without a turn never reaches `message_start`, so it keeps the parked start (FR-026).
- **Identical text**: A live marker exists only between the mode's own submit and its `message_start`. In that window no parked start or decision exists, because the submit consumed it, and the R2 counter blocks any new mode submit while a user Enter runs. If the user's identical text starts first, the mode counts it as its own. Both turns run the same command, and the generation still bumps at the next non-matching turn start.
- **Alternatives considered**: Thread a generated-turn id through `SubmittedUserInput`, `main.ts` `submitInteractiveInput`, `session.prompt`, and the queue to the message (review finding 5). Rejected: the generation binding and the cleanup above close the reported sequence, and the id would touch the prompt pipeline in four files.

## R5. Phase changes at the turn start

- **Decision**: At `message_start`, read `message.promptTemplateInput` (the raw typed line, packages/ai/src/types.ts 1096-1099) and fall back to the message text. Parse it with `^/speckit\.([a-z]+)(?:\s|$)`. A phase name changes the phase, clears the hold and the pause (FR-029), and sets `turnOpen`. `specify` always starts a new run. A command that is not a phase (`/speckit.checklist`) is a user turn and keeps the phase. The mode's own remediation, answer, and continue turns take their phase from `#speckitOwnTurn.phase`.
- **Rationale**: FR-005 requires the change at the turn start, not at queue time. The transcript stores the expanded template as the message text, but `promptTemplateInput` keeps the typed line (agent-session.ts 7512-7518, 7667-7679, and the queued path 8630-8669).

## R6. Turn verdict

- **Decision**: Deterministic parts from text, then one judge call, then a text-only fallback for the judged parts.
  - **Failure**: last assistant `stopReason` is `error`, `length`, or `aborted` → `failed`. An Esc pause or `next` never reaches classification for its aborted turn (R11, R12), so `aborted` here means an abort from elsewhere.
  - **Analyze report** (text only): the report is readable when the message has the `## Specification Analysis Report` heading and either (a) a findings table whose header row has a `Severity` column, or (b) an explicit zero-findings report ("no issues" or "0 issues" or "no findings") together with `Critical Issues Count: 0`. A metric without a table or a zero-findings report is not enough (review round 2, finding 1). Counts: table rows whose Severity cell is `CRITICAL` or `HIGH`. If the metric exists, the critical count is the larger of the two values. Otherwise the report is `unreadable`.
  - **Converge result** (text only): `/✅\s*Converged/` → `complete`. The reported outcome `tasks_appended` (converge.md 242 requires the outcome name in the session), or a count report such as "appended 3 tasks" with `Phase N: Convergence` (converge.md 226), → `added`. Neither the `## Convergence Findings` table nor a bare `## Phase N: Convergence` header is proof, because converge prints the table before it writes, and an agent can mention the header in its plan (review finding 2). If both the complete cue and an added cue appear, or neither appears, the result is `none`, and row 19 holds.
  - **Judge**: one `judge.judge({ state: { phase, message }, questions })` call with four yes/no questions: `completed` (the phase reports that it finished its work, with no error, no failed step, and no early stop; a stop only to ask a question is not an error), `waits` (the message ends with a question for the user or waits for an answer; for analyze, the closing offer to suggest remediation edits does not count), `routine` (the only open question asks permission to proceed with the agent's own recommendation, needs no new scope or requirement decision, and the message reports no error or failed step), and `ready` (clarify only: the report recommends `/speckit.plan` or finds no critical ambiguity, and no high-impact item is left unasked). Threshold `>= 0.5`. `state.message` is the last 6000 characters of the message. The question text lives in `prompts/speckit-auto/judge.md`.
  - **Fallback** (no judge model, error, or timeout). Each value needs positive proof. Otherwise it is `undefined`, and the decision table holds.
    - `waits`: true when the tail matches a question cue: a line that ends with `?`, `**Question:**`, `Your choice`, `You can reply`, `Format: Short answer`, `Wait for user response`, or `(yes/no)`. For analyze, the mode removes the remediation offer paragraph first. False when no cue matches.
    - `routine`: true only when the tail has the implement checklist gate text "Do you want to proceed with implementation anyway? (yes/no)" and no error cue (see `completed` below). False otherwise, so a reported error with a "proceed?" question holds at row 4 (review round 3, finding 8).
    - `completed`: false when the tail matches an error cue (`ERROR`, `Error:`, `failed`, `failure`, `blocked`). `STOP` is not a cue, because the implement checklist gate can print it next to a routine question. True only when no question cue and no error cue match and the phase report cue matches. Otherwise `undefined`. The report cues are past-tense reports, not file mentions:
      - specify: the spec report names `spec.md` and the readiness line names `/speckit.clarify` or `/speckit.plan`.
      - plan: a line that reports `plan.md` as written, created, generated, or complete.
      - tasks: a line that reports `tasks.md` as written, created, generated, or complete.
      - implement: "all tasks" with complete, completed, or done.
      - remediation: the line "Remediation complete." The remediation prompt asks the agent to end with this line.
    - `ready` (clarify): `undefined` when a `Deferred` coverage row does not say that the item is deferred to planning, because text cannot tell its impact. `Outstanding` rows do not block: clarify defines Outstanding as low impact (clarify.md 278). Otherwise true when the message has "No critical ambiguities detected", or when its suggested next command is `/speckit.plan` and it does not suggest `/speckit.clarify` again. Otherwise `undefined`. The judge path can tell high-impact items apart through the `ready` question.
  - **Normal-text errors**: A phase can report an error as normal text with `stopReason: "stop"` (plan with a constitution gate failure, analyze with a missing artifact, implement with a failed task). The judge `completed` question and the fallback error cues both give `completed: false`. Row 5 of the decision table holds for every phase when `completed === false` (review finding 1).
- **Rationale**: FR-013 to FR-024. The counts and the converge result must not depend on a model. One judge call with several questions is the `judgeRules` precedent (export/ttsr.ts 75-92) and bills the shared state once. The tail keeps the call under the Jev limit (about 33k tokens, ttsr.ts 49-53). With no judge role configured, `withSessionFallback` (judgment/index.ts 150-167) uses the session model, so the fallback runs mainly on errors and timeouts.
- **Deadline**: The mode owns a 15 s `AbortController` timeout, as turn-recovery owns its 4 s timeout (turn-recovery.ts 93, 1089-1117). 15 s plus the 800 ms tick stays under the 30 s bound in SC-007.
- **Alternatives considered**: Judge-only (rejected: counts must be exact). Text-only (rejected: question and completion cues in free text are weak, and FR-024 requires the existing judge).

## R7. Decision function

- **Decision**: `decideSpeckitStep(run, verdict)` returns one action: `start` (phase command), `answer`, `remediate`, `hold` (user or needs-you, with reason), `notice` (then an action), or `end` (result). See the decision table in [data-model.md](data-model.md).
- **Rationale**: One pure function makes SC-002, SC-004, and SC-008 testable with generated verdict sequences and no UI.

## R8. Notifications

- **Decision**: While `ctx.speckitAutoRunActive` is true (the mode is on, a run is active, and it is not paused), both `sendCompletionNotification` (event-controller.ts 2818) and `sendErrorNotification` (2770) return early. The mode sends exactly one notification for each hold and each run end, through `TERMINAL.sendNotification`, gated by `completion.notify` and the Warp check (2819-2826). The body names the reason, including error and length failures.
- **Rationale**: FR-031 and SC-006. `sendErrorNotification` uses `error.notify` and fires only for `stopReason: "error"`, so it cannot stand in for the hold notification (review finding 10). Classification runs after `agent_end`, so the suppression must not depend on the verdict. `#finishAgentEnd` (2327-2328) is the only caller of both methods.

## R9. Save, restore, and session switch

- **Decision**:
  - Save: append `sessionManager.appendCustomEntry("speckit-auto", state)` on every change of the saved fields (see data-model.md).
  - Restore: in `#reconcileModeFromSession`, before the plan and goal branches with early returns, read the latest `speckit-auto` entry from `sessionManager.getBranch()` (scan backwards, the `getContextNotes` shape in session/context-notes.ts 38-47). If `enabled`, turn the mode on. If a run exists, set `paused = true`. Do not classify, park, or submit.
  - Stop: `#clearTransientModeState` (4820) and `prepareSessionSwitch()` (7996) clear the in-memory mode state, increment the generation, abort the judge call, and clear the timer. They do not append an entry, so the old session keeps its saved state.
  - New session: `AgentSession.newSession` does not call the reconciler (agent-session.ts 9940-10020), so the mode stays off after `prepareSessionSwitch()` cleared it.
  - Branch: `branch` calls `prepareSessionSwitch()` first (extension-ui-controller.ts 270, 495), and `AgentSession` then runs the session-switch reconciler (agent-session.ts 2971). So a branch restores the mode from the latest `speckit-auto` entry on the new branch path, with the run paused, the same as a session resume.
- **Rationale**: FR-033 and FR-035. A `custom` entry needs no reducer and does not touch the single `mode_change` slot that plan, goal, and vibe mode own. Every `appendModeChange("none")` would erase a `mode_change` value.
- **Alternatives considered**: `appendModeChange("speckit_auto", …)` (rejected: other modes' exit paths overwrite it).

## R10. Mutual exclusion

- **Decision**: Add `#warnSpeckitAutoBlocks()` next to `#warnPlanModeBlocks` (5302). Call it in `handleLoopCommand` (after the disable branch), `handlePlanModeCommand` (5993, covers `/plan` and `/debate`), `#enterPlanMode` (5038), `handleGoalModeCommand` (6316, covers set, resume, and the menu), `handleGuidedGoalCommand` (6360), `#enterGoalMode` (5308), `handleVibeModeCommand` (6077), and `#enterVibeMode` (6194). The reverse check, in mode-on and `/speckit-auto <description>`, refuses when `loopModeEnabled`, `planModeEnabled || planModePaused`, `goalModeEnabled || goalModePaused`, `vibeModeEnabled`, a vibe entry in progress, or a guided-goal interview is active. It names the blocking mode.
- **Rationale**: FR-007. Debate is plan mode with a debate workflow, so the plan checks cover it. A paused loop keeps `loopModeEnabled`.
- **Restore order**: A session cannot hold both a saved speckit run and an active plan or goal mode through normal use. If a hand-edited session has both, the mode restores speckit first, and the plan or goal restore refuses through `#enterPlanMode`/`#enterGoalMode`.

## R11. Esc pause

- **Decision**: In the Esc handler (input-controller.ts about 499-623), add one block after the popup dismissers and before the compaction, handoff, and retry cancellation (520-533): when `ctx.speckitAutoActing` is true, call `ctx.pauseSpeckitAuto()`, and if the session streams, call `#abortStreamingTurn()`. Do not return. The normal Esc flow then continues and stops compaction, retry, or speech, as it does today. `speckitAutoActing` is true when a run is active, not paused, has no hold, and a run turn streams, a check runs, or a start is parked.
- **Rationale**: FR-028. The earlier draft put the branch next to the loop branch (540-555), after several early returns, so Esc during compaction, retry, or speech playback would not pause (review finding 7). Speech playback can overlap a streaming turn and returns before the stream abort at 594-595, so the block aborts the stream itself (review round 2, finding 4). The later abort at 594-595 then finds no stream and does nothing.

## R12. `/speckit-auto next`, resume, and interruption

- **Decision**:
  - `turnOpen` (saved): true when a run turn starts (`message_start`, R5). False when the tick first sees that turn settled, before the judge call (R3). An Esc pause during a stream leaves it true. An Esc pause during a check leaves it false, because the turn already settled (review round 2, finding 5).
  - `next`: compute the successor from a fixed `Record` successor map. Increment the generation, store it as `g`, and set `#speckitNextInFlight` (the tick does nothing while it is set). Clear the hold and the pause. If a turn streams, `await session.abort({ reason: USER_INTERRUPT_LABEL })` (agent-session.ts 9762). After the await, clear `#speckitNextInFlight`. If the generation is not `g` or the mode or run changed, stop. Else mark the latest turn key as decided, set `turnOpen = false`, and call `#speckitSubmit()` at once. It submits when the FR-010 guard is clear, and parks the start for the tick when the guard blocks. No grace period applies (FR-003, review round 2, finding 7). After converge, end the run as "stopped" (review finding 8).
  - `resume`: clear the pause. If `turnOpen` is true, park the continue message for the phase. Else clear `#speckitDecidedKey` so the tick decides about the latest turn.
- **Rationale**: FR-003 and FR-029. `turnOpen` marks an interrupted phase even when the abort left no assistant message, or when omp quit during a turn (review finding 9). The `stopReason` of the last assistant message cannot tell this, because it can belong to the previous phase. Awaiting the abort avoids a busy-agent error. The user-interrupt reason keeps the advisor from resuming the turn on its own.
- **Shared submit**: `#speckitSubmit(start)` is the only submit path. It checks the generation and the FR-010 guard, sets `#speckitOwnTurn`, and calls `this.onInputCallback(this.startPendingSubmission({ text }))`, as loop mode does (2995-3006). When the guard blocks or no input waiter exists, it parks the start.

## R13. Status bar

- **Decision**: Add `speckitAuto: { phase?: string; state: "waiting" | "running" | "next" | "user" | "needs-you" | "paused"; reason?: string } | null` to `SegmentContext` (packages/tui/src/status-line/types.ts 95-118), a `setSpeckitAutoStatus` setter on the component (copy `setLoopModeStatus`, component.ts 1047-1059), and one branch in `modeSegment` render and describe (segments.ts 547-625), after vibe and before loop. Paused uses the `warning` color and the pause icon, the same as plan mode (549-558). A running check and a parked start both show `next`.
- **Rationale**: FR-030 puts the mode in the same segment as plan, goal, and loop. `setHookStatus` renders in a different segment and cannot color the paused state.

## R14. Setting

- **Decision**: `cfgSpeckitAutoConvergeRounds = register({ id: "speckitAuto.convergeRounds", type: "number", default: 3, ui: { tab: "interaction", group: "Input", … options 0, 1, 2, 3, 5 } })` in `modes/settings.ts` beside `loop.conditionTimeoutMs` (891). The UI options are presets only. `config.yml` accepts any whole number of 0 or more. The mode reads the value once at run start, normalizes it, and stores it on the run: a non-finite value gives the default 3, and any other value becomes `Math.max(0, Math.floor(value))`.
- **Rationale**: FR-036 and the existing number setting pattern. `docs/settings.md` line 1002 lists setting prefixes, so `speckitAuto.*` goes there.

## R15. Remediation limit

- **Decision**: A constant `SPECKIT_REMEDIATION_ROUNDS = 2` in the module. No setting.
- **Rationale**: FR-017 fixes the value, and FR-034 allows only one setting.

## R16. Prompt text

- **Decision**: Static Markdown files in `prompts/speckit-auto/`, imported with `with { type: "text" }` and rendered with `prompt.render` where a phase name is dynamic: `remediation.md`, `continue.md` (`{{phase}}`), `answer.md`, and `judge.md` (the four question instructions, `{{phase}}`). The phase commands themselves (`/speckit.<phase>`) are command lines, not prompts.
- **Rationale**: AGENTS.md: "Prompts live in static `.md` files" (review finding 11).
