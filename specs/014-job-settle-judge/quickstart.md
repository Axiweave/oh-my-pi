# Quickstart: Judge Whether a Turn Needs the User While Background Jobs Run

## Automated checks

```sh
cd packages/coding-agent
bun test test/modes/controllers/event-controller-ide-state.test.ts
bun test test/modes/controllers/event-controller-abort-guard.test.ts
bun test test/unexpected-stop-classifier.test.ts
bun test test/interactive-mode-speckit-auto.test.ts
bun test test/agent-session-todo-reminder-async-jobs.test.ts
```

All tests pass. The abort-guard and todo-reminder suites prove that the session events do not change (FR-010, SC-005).

## Manual check (needs a configured `judge` model role)

Run `omp` in a terminal that shows the title. If you can, connect an IDE that shows the `ide` session state.

1. **Needs input (SC-001).** Send: `Run "sleep 600" as a background job. Then ask me if you must continue, and end your turn.`
   - Expected: within 15 seconds after the reply, the "Working…" loader stops, the completion notification fires, and the IDE shows `needs-input`. `read proc://` still lists the job as running.
2. **Approval at the end of a status report (FR-001a).** Send: `Start "sleep 600" in the background. Then reply exactly with the status report and the approval request from specs/014-job-settle-judge/spec.md Clarifications, and end your turn.`
   - Expected: the same result as step 1.
3. **Agent waits only (SC-002).** Send: `Start "sleep 120" in the background. End your turn with: "Next action: when the first E6 Runs finish, I will check their cost and their errors."`
   - Expected: the title and the IDE stay `working`, and no notification fires. When the job ends, its result wakes the agent.
4. **Stale verdict (FR-007).** Repeat step 1, and type a reply at once, before the verdict arrives.
   - Expected: the new turn owns the status, and no `needs-input` appears for the old turn.
5. **No judge (SC-003).** Set the `judge` role to a model without credentials, and repeat step 1.
   - Expected: the behavior of today. The status stays `working` until the job ends.
6. **Speckit-auto (FR-011a).** Turn on speckit-auto. In a phase, make the agent start a background job and ask a blocking question.
   - Expected: speckit-auto holds ("needs you"), and the IDE shows `needs-input` while the job runs.

## Smoke

```sh
omp --smoke-test
```
