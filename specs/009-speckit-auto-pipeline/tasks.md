---

description: "Task list for Speckit-Auto Mode"
---

# Tasks: Speckit-Auto Mode

**Input**: Design documents from `specs/009-speckit-auto-pipeline/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/speckit-auto.md, quickstart.md

**Tests**: Included. The plan gates require property tests (AGENTS.md). The decision tests use a fixed, printed seed. Do not add tests that check prompt wording or wiring.

**Organization**: Tasks are grouped by user story. US1 and US2 are P1. US3 and US4 are P2. US5 is P3. Line numbers are from `6bf8b58531` and can drift. Find the named function first.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an open task)
- **[Story]**: The user story the task belongs to (US1 to US5)

## Path Conventions

- Coding agent: `packages/coding-agent/src/`, tests in `packages/coding-agent/test/`
- TUI: `packages/tui/src/`, tests in `packages/tui/test/`
- Run each command from the repository root unless the task says otherwise.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Record a baseline, so a later failure can be compared with the state before the change.

- [X] T001 Run `bun test packages/coding-agent/test/interactive-mode-loop.test.ts packages/coding-agent/test/input-controller-escape.test.ts packages/coding-agent/test/interactive-mode-plan-paused-guard.test.ts packages/tui/test/status-line-loop.test.ts` and `cd packages/coding-agent && bun run check:types`, and record the results before any edit (no file change). Baseline: 59 pass, 0 fail, types clean

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The types, the setting, the prompts, the saved-state parser, and the status-bar slot that every story uses.

**⚠️ CRITICAL**: Finish this phase before you start any user story.

- [X] T002 [P] In `packages/coding-agent/src/modes/settings.ts`, beside `cfgLoopConditionTimeoutMs` (about line 891), register `cfgSpeckitAutoConvergeRounds` with `id: "speckitAuto.convergeRounds"`, `type: "number"`, `default: 3`, and `ui: { tab: "interaction", group: "Input", label: "Speckit auto converge rounds", description: "Extra implement and converge rounds after converge adds tasks", options: 0, 1, 2, 3, 5 }` (string values, as the loop setting uses)
- [X] T003 [P] Create `packages/coding-agent/src/prompts/speckit-auto/answer.md` ("Yes, proceed with your recommended option."), `continue.md` (with `{{phase}}`, text from contracts/speckit-auto.md "Messages the mode submits", and the remediation wording when the phase is remediation), `remediation.md` (the remediation message from the contract, ending with the line "Remediation complete."), and `judge.md` (the four question instructions `completed`, `waits`, `routine`, `ready` from research.md R6, with `{{phase}}`; one section per question so the module can read each instruction)
- [X] T004 Create `packages/coding-agent/src/modes/speckit-auto.ts` with the types from data-model.md (`SpeckitPhase`, `SpeckitHold`, `SpeckitRun`, `SpeckitAutoState`, `SpeckitVerdict`, `SpeckitAction`), the constants `SPECKIT_PHASE_COMMANDS` (the seven command phases in order), `SPECKIT_REMEDIATION_ROUNDS = 2`, `SPECKIT_AUTO_ENTRY = "speckit-auto"`, a `Record<SpeckitPhase, SpeckitPhase | undefined>` successor map (research R12), `parseSpeckitPhaseCommand(text)` with `^/speckit\.([a-z]+)(?:\s|$)` that returns `{ name, phase? }`, `newSpeckitRun(phase, convergeLimit)` (the reset rule in data-model.md), `normalizeConvergeRounds(value)` (research R14: non-finite → 3, else `Math.max(0, Math.floor(value))`), and `parseSpeckitAutoState(data)` (data-model.md "Validation"; no restore side effects)
- [X] T005 [P] In `packages/tui/src/status-line/types.ts`, add `speckitAuto: { phase?: string; state: "waiting" | "running" | "next" | "user" | "needs-you" | "paused"; reason?: string } | null` to `SegmentContext` (beside `loopMode`, about lines 95-118). In `packages/tui/src/status-line/component.ts`, add `#speckitAutoStatus` beside the other mode fields (about 673-676), a `setSpeckitAutoStatus(status | undefined)` setter copied from `setLoopModeStatus` (about 1047-1059), and `speckitAuto: this.#speckitAutoStatus` in the context object (about 2398-2407)
- [X] T006 In `packages/tui/src/status-line/segments.ts` `modeSegment` (about 547-625), add a `speckitAuto` branch after vibe and before loop in both `render` and `describe`. Text: `Speckit auto · <phase> · <state text>` or `Speckit auto · waiting`, with the state texts from contracts/speckit-auto.md "Status bar". Paused uses the `warning` color and the pause icon suffix, the same as plan mode (about 549-558). Other states use the accent color
- [X] T007 [P] Add `speckitAuto: null` to every `SegmentContext` literal: `packages/coding-agent/src/cli/gallery-fixtures/segments.ts` (about 45-49, plus one paused and one running gallery state near 122-133), `packages/coding-agent/test/ide-selection-segment.test.ts`, `packages/coding-agent/test/status-line-overflow.test.ts`, `packages/coding-agent/test/status-line-time-spent.test.ts`, `packages/tui/test/status-line-loop.test.ts`, `packages/tui/test/status-line-model.test.ts`, and `packages/tui/test/status-line-path.test.ts`
- [X] T008 In `packages/coding-agent/src/modes/types.ts` `InteractiveModeContext` (fields about 211-216, methods about 609-616), add `speckitAutoEnabled: boolean`, `speckitAutoActing: boolean` (getter), `speckitAutoRunActive: boolean` (getter), `speckitSubmitInFlight: number`, `toggleSpeckitAutoMode(): void`, `handleSpeckitAutoCommand(args: string): string | undefined`, `pauseSpeckitAuto(): void`, and `getSpeckitAutoDescription(): string`

**Checkpoint**: `bun run check:types` in `packages/coding-agent` fails only on the missing `InteractiveMode` members from T008. This is expected until US1.

---

## Phase 3: User Story 1 - Turn on the mode, use the normal spec-kit commands, and let the rest run (Priority: P1) 🎯 MVP

**Goal**: `/speckit-auto-mode` and `/speckit-auto <description>` turn the mode on. A typed `/speckit.<phase>` starts a run. Each settled phase turn starts the next phase in the order specify → clarify → plan → tasks → analyze → implement → converge, and converge "✅ Converged" ends the run.

**Independent Test**: quickstart.md section 2 (fake phase commands): after `/speckit-auto-mode` and `/speckit.specify demo`, the transcript shows the six later phase rows with no user input, and the run ends with the summary. The mode stays on.

### Tests for User Story 1

- [X] T009 [P] [US1] Create `packages/coding-agent/test/speckit-auto.test.ts` with: (a) a seeded generator (fixed seed, printed on failure, plus the failing sequence) that drives `decideSpeckitStep` over random verdict sequences from a fresh run and applies each action to the run as the interactive layer does (phase change, counters, `autoAnswered`). Assert these invariants: no `start`, `answer`, or `remediate` after a verdict with `failed` or `completed === false` (except row 3, the routine answer); no automatic action in specify or clarify when `waits !== false`; at most 1 clarify start per run; at most 1 answer per phase run. (b) The happy path: each phase with a clean verdict gives the next phase, and converge `complete` gives `end complete`. (c) `parseSpeckitPhaseCommand` for `/speckit.plan`, `/speckit.plan args`, `/speckit.planx`, `/speckit.checklist`, and text that does not start with `/`. (d) `parseSpeckitAutoState`: a valid state round-trips, a run with an unknown phase or a negative count is dropped and `enabled` stays, garbage gives `undefined`. (e) `normalizeConvergeRounds` for `NaN`, `-1`, `2.7`, `0`, and `3`
- [X] T010 [P] [US1] In the same file, add text-cue tests for `readSpeckitTextVerdict` (T012): the clarify ready cues (including "No critical ambiguities detected"); the converge cues (`✅ Converged` → complete, `tasks_appended` → added, a bare `## Phase 4: Convergence` header → none, a `## Convergence Findings` table alone → none, both cues → none); the fallback `completed` cues for plan, tasks, implement, and remediation (past-tense report → true, a file mention such as "I will create plan.md" → undefined, `ERROR: constitution gate failed.` → false)

### Implementation for User Story 1

- [X] T011 [US1] In `packages/coding-agent/src/modes/speckit-auto.ts`, implement `decideSpeckitStep(run, verdict): SpeckitAction` with every row of the data-model.md decision table, in order (rows 1-23). Keep it pure: it returns the action and does not change `run`
- [X] T012 [US1] In the same file, implement `readSpeckitTextVerdict(phase, message)` from research.md R6: `failed` from `stopReason` (`error`, `length`, `aborted`), the analyze report rule and counts, the converge result rule, and the fallback values for `waits`, `routine`, `completed`, and `ready`. Work on the last 6000 characters of the assistant text, except the analyze table scan, which reads the whole message
- [X] T013 [US1] In the same file, export `classifySpeckitTurn(phase, assistantMessage, deps)`, where `deps` has the `ClassifyUnexpectedStopDeps` shape and carries `signal`. It makes one judge call with the call shape of `packages/coding-agent/src/session/unexpected-stop-classifier.ts` (lines 66-97): `resolveJudge({ settings, registry, sessionModel, sessionId, metadataResolver, purpose: "speckit-auto", onUsage, telemetry, cache: sharedJudgmentCache() })`, then `judge.judge({ state: { phase, message: tail }, questions }, { signal })` with the four `noul` questions from `judge.md` (send `ready` only for clarify), threshold `>= 0.5`. It merges the deterministic parts of `readSpeckitTextVerdict` with the judge answers, uses the text fallback values on any judge error, never throws, and skips the judge when `failed` is set. The judge call stays inline: a separate `judgeSpeckitTurn` would have one caller
- [X] T014 [US1] In `packages/coding-agent/src/modes/interactive-mode.ts`, add the mode fields (`speckitAutoEnabled`, `#speckitRun`, and the transient fields from data-model.md) beside the loop and goal fields (about 1238-1250). Add `#saveSpeckitAutoState()`, which calls `this.sessionManager.appendCustomEntry(SPECKIT_AUTO_ENTRY, state)`, and `#updateSpeckitAutoStatus()`, which calls `this.statusLine.setSpeckitAutoStatus(...)` and `this.ui.requestRender()` (copy `#syncLoopModeStatus`, about 3111-3121). Call both after every change to the saved fields
- [X] T015 [US1] In `interactive-mode.ts`, implement `toggleSpeckitAutoMode()`. On: refuse with the contract messages when a phase command is missing (`this.fileSlashCommands.has("speckit.<phase>")` for each of the seven) or when loop, plan (on or paused, covers debate), goal (on or paused), vibe (on or entering), or a guided-goal interview is active. Else turn on, show the on message, save, and update the status. Off: increment the generation, abort the judge call, clear the timer and the parked start, show the summary with result `stopped` if a run is active, clear the run, save `{ enabled: false }`, and clear the status
- [X] T016 [US1] In `interactive-mode.ts`, implement `handleSpeckitAutoCommand(args)` for the no-argument and description forms. With no argument, show the usage and the state, and return `undefined`. Any other text except `resume` and `next`: turn the mode on if it is off (return `undefined` on a refusal), then return `/speckit.specify <args>` so the normal submit flow sends it (the `handleLoopCommand` precedent, about 3175). T029 adds the `resume` and `next` branches
- [X] T017 [US1] In `interactive-mode.ts`, add `#warnSpeckitAutoBlocks()` beside `#warnPlanModeBlocks` (about 5302) with "Turn off speckit-auto mode first (/speckit-auto-mode)." and call it in `handleLoopCommand` (after the disable branch), `handlePlanModeCommand` (about 5993), `#enterPlanMode` (about 5038), `handleGoalModeCommand` (about 6316), `handleGuidedGoalCommand` (about 6360, inside the try), `#enterGoalMode` (about 5308), `handleVibeModeCommand` (about 6077), and `#enterVibeMode` (about 6194)
- [X] T018 [US1] In `interactive-mode.ts`, add the `message_start` handling to the session listener next to `#handleGoalSessionEvent` (about 4677): detect a turn start (role `user`, or role `developer` with `userInitiated: true`), match the own-turn marker (research R4), and apply the phase rules from research R5 and data-model.md ("Run start and reset", "Phase turn start", "User turn start"). Read the phase from `message.promptTemplateInput`, then the message text. Read `convergeLimit` with `normalizeConvergeRounds(cfgSpeckitAutoConvergeRounds.get(this.settings))` when a run starts
- [X] T019 [US1] In `interactive-mode.ts`, implement the tick from research R3: `#armSpeckitTick()` (800 ms `setTimeout`, one timer at a time), `#speckitTick()`, and the shared `#speckitSubmit(start)` from research R12 (generation check, guard check, set the own-turn marker, `this.onInputCallback(this.startPendingSubmission({ text }))`, else park). The tick classifies with `classifySpeckitTurn` (deps from `this.session`, `journalJudgmentUsage(this.sessionManager)`, a 15 s `AbortController` timeout stored in `#speckitJudgeAbort`), checks the generation after the await, calls `decideSpeckitStep`, and acts: `start`, `answer` (render `answer.md`), `remediate` (render `remediation.md`), `notice` (show the text, then act on `after`; the field is not named `then`, so an action is never a thenable), `hold` (store the hold, show the hold notice), and `end` (show the summary, clear the run, keep the mode on). Implement `#isSpeckitStartBlocked()` with every check from research R2: `#isAutoSubmitBlocked()`, `session.hasAdmittedSubmission`, `session.queuedMessageCount > 0`, `this.compactionQueuedMessages.length > 0`, `session.isRetrying`, `session.hasPendingAsyncWork()`, `#pendingSubmittedInput`, `speckitSubmitInFlight > 0`, editor text or pending images, `ui.hasOverlay()`, `ui.getFocused() !== editor`, and `editorContainer.children[0] !== editor`. While it is true, the tick re-arms. On the first clear tick, the tick submits a parked start with no new classification (FR-012). Arm the tick from `getUserInput()` (about 2874-2890) and from every session `agent_end` event
- [X] T020 [US1] In `packages/coding-agent/src/slash-commands/builtin-modes.ts`, add `/speckit-auto-mode` (`handleTui` calls `ctx.toggleSpeckitAutoMode()`, `getTuiAutocompleteDescription` returns `ctx.getSpeckitAutoDescription()`) and `/speckit-auto` (`allowArgs: true`, inline hint `<feature description> | resume | next`, subcommands `resume` and `next`, `handleTui` calls `ctx.handleSpeckitAutoCommand(args)` and returns `{ prompt }` when it returns text, as `/loop` does at about 591-617). Implement `getSpeckitAutoDescription()` in `interactive-mode.ts` with the autocomplete texts from the contract. In the `/loop`, `/plan`, `/debate`, `/goal`, `/guided-goal`, and `/vibe` autocomplete functions, return `<Mode>: blocked by speckit-auto mode` while the mode is on

**Checkpoint**: T009 and T010 pass. With the fake commands from quickstart.md section 2, a full run completes with no user input.

---

## Phase 4: User Story 2 - The mode never runs ahead of the user (Priority: P1)

**Goal**: The mode starts a phase only after the turn settled with every FR-010 guard clear. A question in specify or clarify holds. A user turn start drops every pending decision and start. A local command such as `/model` keeps the parked start.

**Independent Test**: The interactive test in T021 passes, and quickstart.md section 3 rows "Question holds", "Answer continues", "Draft parks start", and "Selector parks start" behave as written.

### Tests for User Story 2

- [X] T021 [US2] Create `packages/coding-agent/test/interactive-mode-speckit-auto.test.ts` with the scaffold from `packages/coding-agent/test/interactive-mode-loop.test.ts` (real `InteractiveMode`, fake timers, `Object.defineProperty` busy flags, `getUserInput()` result collection). Stub `classifySpeckitTurn` with `vi.spyOn` to return fixed verdicts. Cover: (a) a settled clean plan turn submits `/speckit.tasks` after one tick and not before; (b) for each FR-010 guard (streaming, compacting, queued message, retrying, pending async work, pending submission, submit in flight, draft text, pending image, open overlay), no submit while the guard is set, and a submit with no new classification after it clears (assert the stub call count stays 1); (c) a user `message_start` while a start is parked drops the start, and no submit happens before that user turn settles; (d) a clarify verdict with `waits: true` submits nothing and sets the hold; (e) the own-turn marker clears when the guard is clear after a failed own submit, so a later user `/speckit.plan` counts as a user turn

### Implementation for User Story 2

- [X] T022 [US2] In `packages/coding-agent/src/modes/controllers/input-controller.ts`, in the editor `onSubmit` handler (starts at about 1060), increment `this.ctx.speckitSubmitInFlight` before the first `await` and decrement it in a `finally` that covers every return path
- [X] T023 [US2] In `interactive-mode.ts`, make every generation increment (user turn start, Esc pause, mode off, `next`, `resume`, new run, session switch) also abort `#speckitJudgeAbort`, clear `#speckitParked`, and clear `#speckitOwnTurn`
- [X] T024 [US2] In `interactive-mode.ts`, make `#speckitTick()` clear a stale `#speckitOwnTurn` when the guard is clear (research R4 "Marker cleanup")

**Checkpoint**: T021 passes. US1 still passes.

---

## Phase 5: User Story 3 - Pause, steer, skip, and turn off at any time (Priority: P2)

**Goal**: Esc pauses while the mode acts. `/speckit-auto resume` continues. `/speckit-auto next` stops a running turn and starts the successor with no grace period. `/speckit-auto-mode` turns the mode off. The mode state survives a session resume as a paused run, and a new session starts with the mode off.

**Independent Test**: quickstart.md section 3 rows "Esc pause", "next", "Mode off", "Restore", and "New session" behave as written. T025 and T026 pass.

### Tests for User Story 3

- [X] T025 [P] [US3] In `packages/coding-agent/test/input-controller-escape.test.ts`, add Esc cases with the fake context: when `speckitAutoActing` is true and the session streams, Esc calls `pauseSpeckitAuto` once and aborts with `USER_INTERRUPT_LABEL`, also when speech playback or a retry is active (the earlier-return paths); when `speckitAutoActing` is false, Esc keeps its normal behavior and does not call `pauseSpeckitAuto`
- [X] T026 [US3] In `packages/coding-agent/test/interactive-mode-speckit-auto.test.ts`, add: (a) pause during a parked start, then no submit for any number of ticks; (b) `resume` with `turnOpen: true` submits the continue message, and with `turnOpen: false` classifies the latest turn; (c) `next` while streaming awaits the abort and then submits the successor in the same call when the guard is clear (no tick needed); (d) a `next` whose generation changed during the abort submits nothing; (e) restore from a saved entry turns the mode on with the run paused and submits nothing until `resume`; (f) `prepareSessionSwitch()` clears the in-memory mode and appends no entry; (g) the mutual exclusion in both directions, with the `vi.spyOn(mode, "showWarning")` pattern from `interactive-mode-plan-paused-guard.test.ts`; (h) a user `message_start` during a running implement turn (steering) keeps the phase `implement` (FR-027); (i) a `/speckit.tasks` that waits in the queue keeps the current phase, and its own `message_start` moves the run to `tasks` (FR-005, US3 scenario 7); (j) the mode refuses to turn on and lists the missing names when `fileSlashCommands` lacks `speckit.converge` (FR-006); (k) with the mode off, a settled turn after `/speckit.plan` submits nothing (FR-008); (l) the end summary after converge `complete` names the phases that ran, `R/2`, `C/N`, and the result `complete` (FR-032)

### Implementation for User Story 3

- [X] T027 [US3] In `interactive-mode.ts`, implement `pauseSpeckitAuto()` (increment the generation, set `paused`, save, update the status) and the `speckitAutoActing` and `speckitAutoRunActive` getters from data-model.md
- [X] T028 [US3] In `input-controller.ts`, add the Esc block from research R11 after the popup dismissers and before the compaction, handoff, and retry cancellation (about 520-533): when `this.ctx.speckitAutoActing`, call `this.ctx.pauseSpeckitAuto()` and, if the session streams, `this.#abortStreamingTurn()`. Do not return
- [X] T029 [US3] In `interactive-mode.ts`, add the `resume` and `next` branches to `handleSpeckitAutoCommand` with the full behavior from research R12 and the contract table: the "mode is off" and "no run" messages, "The run is not paused." for `resume` without a pause, and `next` after converge ends the run with result `stopped`. `next` captures the generation before `await this.session.abort({ reason: USER_INTERRUPT_LABEL })`, sets `#speckitNextInFlight` (the tick returns at once while it is set), and checks the generation and the run after the await
- [X] T030 [US3] In `interactive-mode.ts`, add the restore to `#reconcileModeFromSession` (about 4898), before the branches with early returns: scan `this.sessionManager.getBranch()` backwards for the latest `custom` entry with `customType === SPECKIT_AUTO_ENTRY` (the `getContextNotes` shape in `packages/coding-agent/src/session/context-notes.ts`, lines 38-47), parse it, turn the mode on, set `paused = true` on a run, and update the status. Add the in-memory reset (no entry) to `#clearTransientModeState` (about 4820) and to `prepareSessionSwitch()` (about 7996), with the session-switch notice from the contract when the mode was on

**Checkpoint**: T025 and T026 pass. US1 and US2 still pass.

---

## Phase 6: User Story 4 - Bounded self-correction after analyze and converge (Priority: P2)

**Goal**: CRITICAL analyze findings start at most 2 remediation rounds. HIGH-only findings show a notice. Converge adds tasks at most `convergeLimit` times, then the run ends with the open-tasks notice.

**Independent Test**: quickstart.md section 3 rows "CRITICAL loop", "HIGH only", and "Converge limit" behave as written. T031 and T032 pass.

### Tests for User Story 4

- [X] T031 [P] [US4] In `packages/coding-agent/test/speckit-auto.test.ts`, extend the seeded sequence test with the SC-004 bounds for each run: at most 3 analyze turns, at most 2 remediation rounds, and at most `1 + convergeLimit` implement turns, for `convergeLimit` values 0, 1, 3, and 7. Add the boundary cases from spec US4 scenarios 9 and 10: limit 0 ends at the first added result, limit 1 ends after the second, limit 3 ends after the fourth
- [X] T032 [P] [US4] In the same file, add analyze report tests for `readSpeckitTextVerdict`: a report with zero findings and `Critical Issues Count: 0` → readable with 0/0; one `CRITICAL` row → 1 critical; a `Critical Issues Count` larger than the row count wins; a heading with the metric but no table and no zero-findings line → unreadable; no heading → unreadable; the closing remediation offer is not a question

### Implementation for User Story 4

- [X] T033 [US4] In `interactive-mode.ts`, make the tick apply the counter changes for `remediate` (`remediationRounds + 1`) and for the converge `start implement` action (`convergeRounds + 1`) before it saves, and show the HIGH-only notice text from the contract for the `notice` action. Make sure the end summary reports `R/2` and `C/N` from the run

**Checkpoint**: T031 and T032 pass.

---

## Phase 7: User Story 5 - The user knows where the run is without watching (Priority: P3)

**Goal**: The status bar shows the mode, phase, and state in all cases. omp sends no per-turn notification while the mode continues, and exactly one notification for each hold and each run end.

**Independent Test**: T034 passes. A full fake run with notifications on sends one notification at the end and none for the automatic phases (quickstart.md section 2).

### Tests for User Story 5

- [X] T034 [P] [US5] Create `packages/tui/test/status-line-speckit-auto.test.ts` with the pattern of `packages/tui/test/status-line-loop.test.ts`: render and describe the mode segment for each of the six states and for no run. Assert the phase and state text, the warning color only for `paused`, and that the mode segment shows nothing when `speckitAuto` is `null`
- [X] T035 [US5] In `packages/coding-agent/test/interactive-mode-speckit-auto.test.ts`, add: while a run is active and not paused, `sendCompletionNotification` and `sendErrorNotification` send nothing; a hold sends exactly one mode notification (spy on `TERMINAL.sendNotification`); `completion.notify: "off"` sends none; a `length` failure hold sends exactly one

### Implementation for User Story 5

- [X] T036 [US5] In `packages/coding-agent/src/modes/controllers/event-controller.ts`, return early from `sendCompletionNotification` (about 2818) and `sendErrorNotification` (about 2770) when `this.ctx.speckitAutoRunActive` is true
- [X] T037 [US5] In `interactive-mode.ts`, add `#notifySpeckitAuto(title, body)` with the `completion.notify` and Warp gates from `sendCompletionNotification` (about 2819-2826), and call it once for each hold and each run end, with the titles from the contract. Make `#updateSpeckitAutoStatus()` map the mode to the six states: `waiting` (no run), `paused`, `user` and `needs-you` (hold kind and reason), `next` (check running or start parked), and `running`

**Checkpoint**: T034 and T035 pass. All stories work.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T038 [P] In `docs/settings.md` line 1002, add `speckitAuto.*` to the "Agent behavior and safety" prefix list
- [X] T039 [P] In `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]` → `### Added`, add one entry: the speckit-auto mode (`/speckit-auto-mode`, `/speckit-auto <description>|resume|next`), what it automates after clarify, the status-bar label "Speckit auto", the notification behavior, the exclusion with loop, goal, plan, debate, and vibe mode, and the setting `speckitAuto.convergeRounds` (default `3`)
- [X] T040 [P] In `packages/tui/CHANGELOG.md` under `## [Unreleased]`, add an entry for the new `speckitAuto` status-line mode state
- [X] T041 [P] In `UPSTREAM_DIVERGENCES.md`, append a "Speckit-auto mode" entry in the existing format (Decision, Why, Key paths, Checks), with the key paths from plan.md and the three new test files as checks
- [X] T042 [P] Append `speckitAuto.convergeRounds: 3` to `~/.omp/agent/config.yml` (as a `speckitAuto:` block with `convergeRounds: 3`, matching the file's style), without changing other keys
- [X] T043 Run `cd packages/coding-agent && bun run check:types` and `bun run check` at the root, and fix every error in the touched files
- [X] T044 Run the commands in quickstart.md section 1 and compare with the T001 baseline
- [X] T045 Run the TUI smoke in quickstart.md sections 2 and 3 with the real `omp` in `/tmp/speckit-smoke`, record the result of each row, then delete `/tmp/speckit-smoke`. Observed: full run to `complete`, question hold, answer continues, normal-text error hold, `/plan` exclusion, restore paused, `resume` of a restored held run (fixed and regression-tested), `next`, Esc pause, `/new` mode off, mode off with a `stopped` summary (fixed so the summary stays visible). Unit tests only: draft and selector parking, CRITICAL loop, HIGH notice, converge limit, routine answer

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Phase 1. Blocks every story.
- **US1 (Phase 3)**: depends on Phase 2.
- **US2 (Phase 4)**: depends on US1 (T019 tick and T018 listener).
- **US3 (Phase 5)**: depends on US1. It can run in parallel with US2, except T029, which needs T023.
- **US4 (Phase 6)**: depends on US1 (T011, T012, T019).
- **US5 (Phase 7)**: T034 and T036 depend only on Phase 2. T035 and T037 depend on US1.
- **Polish (Phase 8)**: T038-T042 can start after Phase 2. T043-T045 need all earlier tasks.

### User Story Dependencies

- **US1**: needs T002-T008.
- **US2**: needs T018 and T019.
- **US3**: needs T014-T019. T029 also needs T023.
- **US4**: needs T011, T012, and T019.
- **US5**: T034 needs T005-T006. T035-T037 need T019.

### Within Each User Story

- Tests first. They fail until the implementation tasks of the story are done.
- In US1: T011 and T012 before T013, T014 before T015-T019, T019 after T018.
- `interactive-mode.ts` tasks run in sequence (one file).

### Parallel Opportunities

- T002, T003, T005, and T007 run in parallel (different files). T004 and T005 also run in parallel.
- T009 and T010 run in parallel with T011-T013 when one agent owns `speckit-auto.ts` and another writes the tests.
- T025 (`input-controller-escape.test.ts`), T031-T032 (`speckit-auto.test.ts`), and T034 (`packages/tui`) run in parallel.
- T038-T042 run in parallel (five files).

---

## Parallel Example: Foundational

```text
Task: "T002 Register cfgSpeckitAutoConvergeRounds in packages/coding-agent/src/modes/settings.ts"
Task: "T003 Create the four prompt files in packages/coding-agent/src/prompts/speckit-auto/"
Task: "T005 Add speckitAuto to SegmentContext and the component setter in packages/tui/src/status-line/"
Task: "T007 Add speckitAuto: null to the seven SegmentContext literals"
```

## Parallel Example: After US1

```text
Agent A: T021 → T022 → T023 → T024        (US2: submit counter in input-controller.ts, generation cleanup in interactive-mode.ts)
Agent B: T031 → T032 → T033               (US4: speckit-auto.test.ts, then the counters in interactive-mode.ts after Agent A)
Agent C: T034 → T036                      (US5: packages/tui test, event-controller.ts)
```

`interactive-mode.ts` has one owner at a time. Agent B waits for Agent A before T033.

---

## Implementation Strategy

### MVP First

1. Finish Phase 1 and Phase 2.
2. Finish US1 and US2 together. Both are P1. The T019 guard reads `speckitSubmitInFlight`, but only T022 increments it, so US1 alone can race a user Enter that is still in flight.
3. Stop and run T043, T044, and quickstart.md section 2.

### Incremental Delivery

1. Phase 1 + Phase 2 → types, setting, prompts, status slot.
2. US1 + US2 → the automatic run with safe starts (MVP).
3. US3 → pause, next, resume, restore, session switch.
4. US4 → remediation and converge limits.
5. US5 → notifications and the status state detail.
6. Polish → docs, changelogs, divergence record, config default, smoke.

---

## Notes

- Write no prompt text in TypeScript. Import the `.md` files with `with { type: "text" }` and render them with `prompt.render`.
- Inline a function whose whole body is one expression. Use `Record` for the successor map.
- Do not add tests that check prompt wording, the autocomplete strings, or that a function forwards a call.
- Do not commit until the user asks. Then use the smart-commit skill.

---

## Phase 9: Convergence

- [X] T046 In `#handleSpeckitSessionEvent` (`packages/coding-agent/src/modes/interactive-mode.ts`), treat a role `custom` message for which `isUserTurnInitiator` is true (user-invoked `/skill:` or collab prompt) as a user turn start, so it drops the pending decision and parked start, per FR-026 (partial)
- [ ] T047 In `#handleSpeckitSessionEvent`, skip role `user` messages with `attribution === "agent"`, and make the tick drop a parked start when a newer assistant message that the mode did not start appeared after the decision, so the mode never decides on an omp-internal turn, per FR-026 (partial)
- [X] T048 Make the `#speckitSubmit` call from `/speckit-auto next` and `/speckit-auto resume` ignore the in-flight count of its own slash-command submit, so the start happens in the same call with no tick delay, and add a test that runs `next` through the real editor `onSubmit` wrapper, per FR-003 (partial)
- [X] T049 Run the quickstart.md section 3 rows "Draft parks start", "Selector parks start", "CRITICAL loop", "HIGH only", "Converge limit", and the routine-answer row in the real TUI with fake commands, and record the result of each row, per T045 (partial)
- [X] T050 Make `speckitAutoActing` true for a live run with an undecided settled turn and while the session compacts or retries, so Esc pauses in those windows, per FR-028 (partial)
- [X] T051 Count `remediationRounds` and `convergeRounds` when the own remediation or converge-implement turn matches at `message_start`, not when the start parks, per FR-017 (partial)
- [X] T052 In `#finishSpeckitRun`, send a readable result text instead of the raw result key as the notification body, per FR-031 (partial)

## Phase 10: Convergence

- [X] T053 In `interactive-mode.ts`, record the last assistant reply of the phase and decide on it instead of `getLastAssistantMessage()`: a turn that opens while the session is idle with a `custom` message whose `customType` is not `ASYNC_RESULT_MESSAGE_TYPE` or `LAUNCH_COMPLETION_MESSAGE_TYPE` (for example `isAdvisorCard`, `irc:incoming`, `lsp-late-diagnostic`) is side traffic, and its reply does not replace the phase reply; add a regression test with an advisor turn after a settled phase turn, with and without a parked start, per FR-026 (partial)
- [ ] T054 In `#updateSpeckitAutoStatus`, show the `next` state when the turn has settled and its check waits for the start guard, not `running`, per FR-030 (partial)
