# Research: Judge Whether a Turn Needs the User While Background Jobs Run

The Technical Context has no open items. Each section below records one design decision with its reason and the alternatives.

## R1. Where the fixed rule lives today

- **Finding**: `AgentSession` (`agent-session.ts`, `agent_end` branch near line 5194) ends a clean stop with `willContinue: true, awaitingAsyncWork: true` when `#hasPendingAsyncWake()` is true. That is `hasRunningAsyncJobs() || hasPendingAsyncDelivery()` for the agent's own jobs. The TUI (`event-controller.ts` `#handleAgentEnd`) then keeps `working` and starts `#finishWhenRunSettles`. That watch runs the idle teardown (`#finishAgentEnd`: loader stop, notifications, IDE publish) only after the jobs drain with no wake. Four other TUI sites also publish `working` while `hasPendingAsyncWork()` is true: `extension-ui-controller.ts` `#publishDialogState`, `interactive-mode.ts` `#hidePlanReview`, `session-focus-controller.ts` attach, and `interactive-mode.ts` `#updateSpeckitAutoStatus`. The fork divergence "Working state during background-job waits" in `UPSTREAM_DIVERGENCES.md` records this rule.
- **Decision**: Keep the session layer as it is (FR-010, clarification answer B). Put the judgment in the TUI event controller, after the `awaitingAsyncWork` `agent_end`.
- **Rationale**: Option B keeps the event contract. Only the TUI shows the status, the title, the IDE state, and the notification (FR-008). RPC, ACP, print mode, and subagents have no `EventController`, so FR-008 holds by construction.
- **Alternatives considered**: Judge inside `AgentSession` before it sends `agent_end`. Rejected by clarification answer B: it delays the event up to 15 seconds for every client.

## R2. The judge call

- **Decision**: Add one question file `src/prompts/judge/needs-user.json` with one yes/no question `needsUser`. Add `classifyNeedsUser(turn, deps)` to `src/session/unexpected-stop-classifier.ts`. It shares the module's judge setup with `classifyUnexpectedStop`: `resolveJudge` with the `judge` role chain, `sharedJudgmentCache()`, `onUsage` for the session ledger, and the same 0.5 threshold. It reuses the `UnexpectedStopTurn` input shape (`message`, `request`) and the `ClassifyUnexpectedStopDeps` deps. The purpose label is `needs-user`. It returns `true`, `false`, or `undefined` when no judge answers.
- **Rationale**: FR-009 needs the existing `judge` role and the ledger. The module already holds the same pattern for a yes/no question about a final reply. A private helper that takes the purpose and the question removes the copy.
- **Alternatives considered**: (a) Reuse the speckit `waits` question. Rejected: its text is about a spec-kit phase. (b) A text heuristic such as `isAwaitingUserAnswer` in `todo-tracker.ts`. Rejected: the TODO asks to replace a fixed rule with a model judgment. The user's two examples need judgment, because both are long status reports.
- **Question text**: The message is the agent's final reply, and the agent's own background jobs still run. Yes when the reply asks the user a question, asks for a decision or an approval, or asks the user to do something before the agent can go on. A request at the end of a long status report still counts. No when the reply only reports status, promises to report later, or states the agent's own next step after the jobs end. The criteria hold the two examples from the spec clarifications.

## R3. Judge input (FR-006)

- **Decision**: `message` is the visible text of the last assistant message of the `agent_end` event. `request` is the newest `operatorTitleText(...)` value from `session.messages`, cut to 2000 characters, as `#latestOperatorRequest` in `turn-recovery.ts` does.
- **Rationale**: This is the same input as the unexpected-stop judge, so the judge sees no full transcript.
- **Alternatives considered**: Only the reply. Rejected by FR-006. The request helps with replies such as "keep going without me".

## R4. When the controller asks (FR-002, FR-008)

- **Decision**: In `#handleAgentEnd`, in the `isTerminal === false` branch, ask only when all of these hold:
  - `event.awaitingAsyncWork === true`.
  - The last assistant message has `stopReason === "stop"` and no tool call.
  - `session.hasRunningAsyncJobs()` is true and `session.hasPendingAsyncDelivery()` is false.
  - `ctx.viewSession === ctx.session` and `!ctx.speckitAutoRunActive`.
- **Rationale**: `awaitingAsyncWork` already excludes OMP-scheduled continuations (reminders, retries, compaction). `AgentSession` also sets it for an error stop, so the stop reason check is needed. A pending delivery means that a wake turn starts now (spec edge case 1).
- **Alternatives considered**: Ask for every non-terminal end. Rejected: it gives judge calls for retries and reminders (SC-004).

## R5. What a yes verdict does (FR-003, FR-010)

- **Decision**: The controller records `#needsInputEpoch = epoch` for the run epoch that asked. Then, under `#runSerialized`, it runs the same teardown as a settled stop with no job: `setRunStatus(this.#settledRunStatus(event))` and `#finishAgentEnd({ ...event, isTerminal: true })`. `#publishIdeTurnState` reads `awaitingReply = ctx.interviewActive || this.#needsInputEpoch === this.#runEpoch`, so the IDE state is `needs-input`. When the jobs later drain with no wake, `#finishWhenRunSettles` sees that the epoch already finished and does nothing. This keeps `needs-input` (spec edge case "keeps `needs-input` until the user replies") and sends no second notification.
- **Mapping of "needs-input" to each surface**: The OSC 7501 run status and the title have no `needs-input` state. A question during a guided interview or a speckit-auto hold shows `done` there (title idle) and `needs-input` in the IDE state (`interactive-mode.ts` `#updateSpeckitAutoStatus`). The yes verdict uses the same mapping. The desktop notification is the one that a stop with no job sends (`sendCompletionNotification`). Stop hooks stay deferred because `AgentSession` does not change.
- **Rationale**: `#finishAgentEnd` is the one teardown for a settled turn. A reuse keeps the loader, recap, and notification rules in one place.
- **Alternatives considered**: (a) Add a `needs-input` RunStatus or the `blocked:question` OSC state. Rejected: `blocked` means a live prompt (an `ask` or an approval), and a shell prompt drops it on suspend. A new state would also differ from guided interviews. (b) Change only the IDE state and send the notification, and keep the loader. Rejected: a spinner next to a question looks like work in progress.

## R6. Dropping a stale verdict (FR-007)

- **Decision**: Capture `epoch = this.#runEpoch` and `session = this.ctx.session` before the call. After the call, use the verdict only when the epoch, the session, and `!session.isStreaming` still match. `agent_start` bumps the epoch, and a user message or a job wake starts a new run. An `AbortController` with a 15-second timer bounds the call (FR-005). `#handleAgentStart` (the `#runEpoch` bump site) also aborts the call, so a stale call stops sooner.
- **Rationale**: This is the same guard that `#finishWhenRunSettles` uses (`superseded()`).

## R7. Other sites that publish `working` while jobs run

- **Decision**: Add `readonly jobWaitNeedsInput: boolean` to `InteractiveModeContext`. `EventController` exposes it (true while `#needsInputEpoch === #runEpoch`), and `InteractiveMode` forwards it. Each site that today maps `hasPendingAsyncWork()` to `working` uses `hasPendingAsyncWork() && !ctx.jobWaitNeedsInput`. Each site that calls `ideTurnState(messages, ctx.interviewActive)` passes `ctx.interviewActive || ctx.jobWaitNeedsInput`. The sites are `extension-ui-controller.ts` `#publishDialogState`, `interactive-mode.ts` `#hidePlanReview`, and `session-focus-controller.ts` (`busy`).
- **Rationale**: Without this, the IDE goes back to `working` after a dialog closes or a subagent view closes, while the agent still waits for the user.
- **Alternatives considered**: Fold the verdict into `interviewActive`. Rejected: guided interviews own that flag and clear it on goal and loop transitions.

## R8. Speckit-auto (FR-011a)

- **Finding**: `decideSpeckitStep` returns `hold("user", …)` when the existing judge answers `waits` yes (`speckit-auto.ts` line 212). The fixed job wait in `#speckitTick` (`interactive-mode.ts` near line 3935) changes only `needs-you` holds into a job wait. Those holds come from a `waits` answer of no or no answer. So the decision part of FR-011a already holds: no second judge call and no change to `decideSpeckitStep`. A `user` hold already calls `#notifySpeckitAuto`.
- **Gap**: `#updateSpeckitAutoStatus` publishes the held state only when `!session.hasPendingAsyncWork()`. A hold while a phase job runs leaves the title, OSC, and IDE at `working`.
- **Decision**: Publish the settled state when `run?.hold !== undefined`, even while async work is pending. Keep the job-wait branch in `#speckitTick` as it is, because it is the "no or no answer" case of FR-011a. Update its comment to name the judge answer.
- **Alternatives considered**: Ask `needsUser` in speckit-auto too. Rejected by FR-011a (no second judge call).

## R9. Tests

- **Decision**:
  - `test/modes/controllers/event-controller-ide-state.test.ts` gets a table over verdict × job state. The verdict is yes, no, or undefined (judge failure). The jobs either run or drain later with no wake. The test stubs `classifyNeedsUser` with `vi.spyOn` on the module namespace. Properties:
    - A yes verdict publishes `needs-input` once and sends one notification.
    - A no or undefined verdict keeps `working` until the drain, as today (SC-003).
    - A verdict that arrives after `agent_start` changes nothing (FR-007).
    - A drain after a yes verdict keeps `needs-input`.
  - The same test checks that a non-terminal end without `awaitingAsyncWork`, an error stop, or a pending delivery never calls the judge (SC-004).
  - `test/unexpected-stop-classifier.test.ts` gets one case that checks that the `needsUser` question goes to the judge with the `needs-user` purpose and maps the 0.5 threshold. The test stubs `ai.completeSimple` with `vi.spyOn`, as the existing cases do.
  - `test/interactive-mode-speckit-auto.test.ts` gets one case: a `user` hold while a phase job runs publishes `needs-input`.
- **Rationale**: These are the consumer-visible transitions. No test checks the prompt text. The judge quality check is manual in quickstart (SC-001, SC-002), because it depends on the model.

## R10. Docs

- **Decision**:
  - Update `CHANGELOG.md` (FR-012).
  - Amend the `UPSTREAM_DIVERGENCES.md` entry "Working state during background-job waits": a judge yes ends the wait display with `needs-input`.
  - Add a sentence to the speckit-auto entry about holds while a job runs.
  - Add no setting, so `~/.omp/agent/config.yml` does not change (FR-011).
