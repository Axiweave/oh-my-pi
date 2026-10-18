# Implementation Plan: Judge Whether a Turn Needs the User While Background Jobs Run

**Branch**: `014-job-settle-judge` (the work happens on `main`) | **Date**: 2026-10-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/014-job-settle-judge/spec.md`

## Summary

Today a turn that ends while the agent's own background job runs always shows `working` until the job ends. A question to the user in that reply stays hidden. With this feature, the TUI event controller makes one `judge` call after the `awaitingAsyncWork` `agent_end`: does the reply need the user? On yes, the TUI runs the normal settled teardown. The loader stops, the IDE shows `needs-input`, and the completion notification fires. The job continues to run. On no, or with no answer, nothing changes. The session events and the stop hooks stay as they are. Speckit-auto already holds for a question through its existing `waits` judge answer. It only needs to publish that hold while a job runs.

## Technical Context

**Language/Version**: TypeScript on Bun 1.4.2

**Primary Dependencies**: Workspace packages `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-ai` (judgment API). No new dependency.

**Storage**: N/A. The verdict is in memory only.

**Testing**: `bun:test`. Controller tests use a table of verdicts and job states.

**Target Platform**: The interactive TUI of `omp`. RPC, ACP, print mode, and subagents do not change (FR-008).

**Project Type**: CLI/TUI application in a monorepo.

**Performance Goals**: One judge call for each settle with running jobs, and none for other settles (SC-004). The verdict arrives within 15 seconds, or OMP drops it (FR-005).

**Constraints**:
- The wire events do not change (FR-010).
- A no verdict or no answer gives the behavior of today (SC-003).
- A stale verdict changes nothing (FR-007).

**Scale/Scope**: About 7 source files change, plus 1 new prompt file and changes in 3 test files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template, so it defines no gates. These gates come from the repo rules (`AGENTS.md`):

| Gate | Status |
|---|---|
| No backward-compatibility shims. | Pass. The fixed rule goes. The design adds no flag and no alias. |
| No over-engineering. | Pass. The design reuses `resolveJudge`, the unexpected-stop module, `#finishAgentEnd`, and the run-epoch guard. The new parts are one question file, one exported function, one epoch field, and one context getter (R2, R5, R7). |
| Tests prove properties. | Pass. R9 plans a verdict × job-state table with transition properties, and no test of the prompt text. |
| Each feature that a user can configure gets its default in `~/.omp/agent/config.yml`. | N/A. There is no new setting (FR-011). |
| Update `CHANGELOG.md`. Record fork-only behavior in `UPSTREAM_DIVERGENCES.md`. | Planned (R10). |

The check after Phase 1 also passes. The design adds no setting, no persistence, and no new module.

## Project Structure

### Documentation (this feature)

```text
specs/014-job-settle-judge/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── job-settle-judge.md   # judge question, classifier, context getter, surface table
└── tasks.md                  # /speckit.tasks
```

### Source Code (repository root)

```text
packages/coding-agent/
├── src/prompts/judge/needs-user.json                    # NEW yes/no question with the spec examples
├── src/session/unexpected-stop-classifier.ts            # classifyNeedsUser, shared private judge helper
├── src/modes/controllers/event-controller.ts            # judge after awaitingAsyncWork settle, #needsInputEpoch, teardown reuse
├── src/modes/types.ts                                   # jobWaitNeedsInput on InteractiveModeContext
├── src/modes/interactive-mode.ts                        # forward jobWaitNeedsInput, #hidePlanReview, speckit hold publish
├── src/modes/controllers/extension-ui-controller.ts     # #publishDialogState honors the verdict
├── src/modes/controllers/session-focus-controller.ts    # busy honors the verdict
├── test/modes/controllers/event-controller-ide-state.test.ts
├── test/unexpected-stop-classifier.test.ts
├── test/interactive-mode-speckit-auto.test.ts
└── CHANGELOG.md
UPSTREAM_DIVERGENCES.md
```

**Structure Decision**: Keep the judge next to the other final-reply judge in `unexpected-stop-classifier.ts`. Keep the verdict state in `EventController`, which owns the run epoch and the settled teardown.

## Design Notes

These notes refer to [research.md](research.md) and [contracts/job-settle-judge.md](contracts/job-settle-judge.md).

1. **Judge (R2, R3).** `classifyNeedsUser` uses the same judge setup as `classifyUnexpectedStop`, through one private helper that takes the purpose and the question. The input is the reply text and the newest operator request.
2. **Trigger (R4).** In `#handleAgentEnd`, in the `isTerminal === false` branch, after `setRunStatus({ state: "working" })`, call `void this.#judgeJobWait(event)` when the rules in data-model.md hold.
3. **Verdict (R5, R6).** `#judgeJobWait` captures the epoch and the session, and runs the judge with a 15-second abort. `#handleAgentStart` aborts it. On a current `true`, it sets `#needsInputEpoch`, and under `#runSerialized` it runs `setRunStatus(#settledRunStatus(event))` and `#finishAgentEnd({ ...event, isTerminal: true })`. `#publishIdeTurnState` passes `awaitingReply` when the epoch matches.
4. **Drain (R5).** `#finishWhenRunSettles` returns before its teardown when `#needsInputEpoch === epoch`.
5. **Other surfaces (R7).** `ctx.jobWaitNeedsInput` changes the `working` checks and the `ideTurnState` calls in the dialog, plan-review, and focus sites.
6. **Speckit-auto (R8).** `#updateSpeckitAutoStatus` publishes when `run?.hold` exists, even while async work is pending. The job-wait branch in `#speckitTick` stays, with a comment that names the judge answer.

## Risks

| Risk | Mitigation |
|---|---|
| A false yes sends a notification for a reply that only waits. | The question criteria hold the user's "Next action" example. The cost is one notification (spec assumptions). Quickstart step 3 checks it. |
| The verdict lands after a wake turn started. | The epoch guard drops it, and `agent_start` aborts the call (R6). The table test covers it. |
| `#finishAgentEnd` runs twice: at the verdict and at the drain. | `#finishWhenRunSettles` skips its teardown for a `needs-input` epoch (R5). |
| `#finishAgentEnd` schedules idle compaction while a job runs. | `AgentSession.runIdleCompaction` already returns while `#hasPendingAsyncWake()` is true. |
| A subagent view hides the main settle, so the judge never runs. | Accepted. The behavior of today stays for that settle. Mark it with a `ponytail:` comment. |

## Complexity Tracking

No gate violations.
