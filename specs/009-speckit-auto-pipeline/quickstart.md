# Quickstart: Validate Speckit-Auto Mode

## Prerequisites

- The repo at `/Users/fuyu0425/agents/oh-my-pi` with the feature built in. The `omp` launcher runs the source directly.
- A model with credentials for the session. A judge model is optional (the fallback path runs without one).

## 1. Automated checks

```sh
cd packages/coding-agent
bun test test/speckit-auto.test.ts test/interactive-mode-speckit-auto.test.ts
bun test test/input-controller-escape.test.ts test/interactive-mode-plan-paused-guard.test.ts
bun run check:types
cd ../tui && bun test test/status-line-speckit-auto.test.ts test/status-line-loop.test.ts
```

Expected: all pass. `speckit-auto.test.ts` prints its seed. A failure prints the seed and the shortest failing verdict sequence.

What the tests prove:

| Test | Property |
|---|---|
| decision, seeded sequences | SC-004 bounds. No start after a failed turn (SC-008). No start in specify or clarify while `waits` is true (SC-002). At most one automatic answer per phase run. |
| decision, converge limit 0, 1, 3 | FR-021 and FR-036 boundaries. |
| text cues | Analyze counts with zero rows, CRITICAL rows, a larger `Critical Issues Count`, and no report. The converge cues. Normal-text errors give `completed: false` in the fallback. The analyze edit offer is not a question. |
| saved state | A restored run is paused. Garbage data gives "mode off". |
| interactive | A settled turn submits the next phase after the grace period. Draft text parks the start, and clearing it submits with no new decision (FR-012). A user turn start drops the start (SC-003). Esc pauses (SC-005). The other modes refuse while the mode is on, and the reverse. |

## 2. TUI smoke run with fake phase commands

Make a scratch project whose phase commands answer with fixed text, so the run is fast and repeatable.

1. Create the scratch project:

   ```sh
   mkdir -p /tmp/speckit-smoke/.omp/commands && cd /tmp/speckit-smoke && git init -q
   ```

2. Write seven files `.omp/commands/speckit.<phase>.md` for specify, clarify, plan, tasks, analyze, implement, and converge. Each body says: "Do not use tools. Reply with exactly this text:" and then the cue text for that phase:
   - specify: `Spec written to specs/001-demo/spec.md. Ready for /speckit.clarify.`
   - clarify: `No critical ambiguities detected worth formal clarification. Suggested next command: /speckit.plan`
   - plan: `Plan written to specs/001-demo/plan.md.`
   - tasks: `Tasks written to specs/001-demo/tasks.md.`
   - analyze: a `## Specification Analysis Report` heading, a table with one `LOW` row, and `Critical Issues Count: 0`.
   - implement: `All tasks are complete. tasks.md updated.`
   - converge: `✅ Converged — the implementation satisfies the spec, plan, and tasks.`
3. Start `omp` in `/tmp/speckit-smoke`.
4. Run `/speckit-auto-mode`.
5. Run `/speckit.specify demo`.

Expected:

- The status bar shows `Speckit · on` after step 4.
- After step 5, the transcript shows the user rows `/speckit.clarify`, `/speckit.plan`, `/speckit.tasks`, `/speckit.analyze`, `/speckit.implement`, and `/speckit.converge` in this order. You type nothing.
- The run ends with the summary and the result `complete`. The status bar shows `Speckit · on`.

## 3. Hold, pause, and control scenarios

Change one fake command for each scenario, then repeat steps 3-5.

| Scenario | Change | Expected |
|---|---|---|
| Question holds (US2-1) | clarify replies `**Question:** Which format? Your choice:` | Status `Speckit · clar · you`. No phase starts. One desktop notification. |
| Answer continues (US2-2) | same as above, then type `CSV` and make clarify reply the ready text | The run continues to plan after the answer turn settles. |
| Draft parks start (US2-5) | type text in the editor before plan starts | No start while the text is there. Clear the editor, and plan starts. |
| Selector parks start (US2-4) | run `/model` during the grace period | No start while the selector is open. Pick a model, and the phase starts with it. |
| CRITICAL loop (US4-4) | analyze always reports one `CRITICAL` row | Remediation, analyze, remediation, analyze, then hold with "1 CRITICAL finding remains". |
| HIGH only (US4-7) | analyze reports one `HIGH` row | Notice with the HIGH count, then implement starts. |
| Converge limit (US4-9, US4-10) | converge always appends `## Phase 3: Convergence` with one task. Set `speckitAuto.convergeRounds` to 1. | One extra implement and converge, then the run ends with "open tasks remain". |
| Normal-text error (SC-008) | plan replies `ERROR: constitution gate failed.` | Hold with the reason. tasks does not start. |
| Esc pause (US3-1) | make implement slow ("Count to 200 slowly") and press Esc | The turn stops. Status `paused` in the warning color. `/speckit-auto resume` sends the continue message. |
| next (US3-4) | press `/speckit-auto next` during plan | The plan turn stops, and tasks starts. |
| Mode off (US3-5) | run `/speckit-auto-mode` during plan | Plan finishes. Nothing else starts. The status bar no longer shows the mode. |
| Exclusion (FR-007) | run `/plan` while the mode is on | "Turn off speckit-auto mode first (/speckit-auto-mode)." |
| Restore (FR-035) | quit omp during plan, then `omp --resume` the session | Mode on, run paused at plan. Nothing starts until `/speckit-auto resume`. |
| New session (FR-033) | run `/new` while a run is active | The new session has the mode on with no run (`Speckit · on`). `/resume` of the old session brings back its run, paused. |

## 4. Cleanup

```sh
rm -rf /tmp/speckit-smoke
```
