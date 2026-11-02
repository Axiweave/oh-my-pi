---

description: "Task list for spawning during speckit-auto mode"
---

# Tasks: Spawn During Speckit-Auto Mode

**Input**: Design documents from `specs/019-spawn-during-speckit-auto/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/spawn-in-speckit-run.md, quickstart.md

**Tests**: Yes. Research R7 asks for permanent tests, and the repository rules ask for tests that fail before the fix. Each test checks the run's observable state: the judge input (`classifySpeckitTurn` arguments), the hold, the submissions, and the saved run entry. Write each test first, and see it fail before you make the change. The tasks come in that order: each story's tests come before the code that makes them pass. The shared helper is therefore in US1, not in a foundational phase.

**Organization**: Tasks are grouped by user story. All tests go in one file, so test tasks do not run in parallel. Line numbers are from plan time. Find each target by its text before you edit.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an open task)
- **[Story]**: US1, US2 from spec.md

## Test harness notes

`packages/coding-agent/test/interactive-mode-speckit-auto.test.ts` already has these helpers: `start`, `startRun`, `turnStarts`, `turnSettles`, `tick`, `saved`, `statusState`, `reload`, and `classify` (a spy on `classifySpeckitTurn`). To make a spawn kickoff in a test, emit this message with `session.agent.emitExternalEvent({ type: "message_start", message })`:

```ts
{ role: "developer", content: [{ type: "text", text: "spawn kickoff" }], synthetic: true, userInitiated: true, displayText: "/spawn list the files", attribution: "user", timestamp: ++clock }
```

For the idle route, emit `{ type: "agent_start" }` first. For the route during a phase turn, emit no `agent_start`. A spawn reply is an assistant message after the kickoff. Set `reply` to it, because the harness mocks `getLastAssistantMessage` to return `reply`.

## Phase 1: Setup

- [X] T001 Record a baseline: run `cd packages/coding-agent && bun test test/interactive-mode-speckit-auto.test.ts test/spawn-command.test.ts` and note any failure that exists before the change

---

## Phase 2: Foundational

No foundational tasks. Both stories need the `isSpawnKickoff` helper. It is in US1 (T004), after the US1 tests that it makes pass. US2 depends on US1.

---

## Phase 3: User Story 1 - Spawn a session while the speckit run waits (Priority: P1) 🎯 MVP

**Goal**: `/spawn` runs with speckit-auto mode on in every run state. The spawn turn leaves the run's phase, hold, and next step unchanged.

**Independent Test**: The T002 and T003 tests pass. Quickstart smoke rows 1 and 3 pass.

### Tests for User Story 1

- [X] T002 [US1] In `packages/coding-agent/test/interactive-mode-speckit-auto.test.ts`, add a test: "a /spawn turn neither answers nor clears a held phase question". Steps:
  1. Bring a run to a `user` hold. Reuse an existing test that reaches `hold.kind === "user"` as the pattern.
  2. Emit an idle kickoff (`agent_start`, then the kickoff `message_start`), and settle a spawn reply.
  3. Run `tick(3)`.

  Expect:
  - `saved()?.run` equals the value from before the kickoff (phase, hold with the same reason, `answering`).
  - `statusState()` is the same.
  - `classify` has no new call.
  - `submitted` has no new entry.

  Then type an answer with `turnStarts("yes")`, and expect that the run treats it as the answer, as the existing answer test does.

  In the same file, add a second test: "a /spawn turn leaves a paused run paused". Steps:
  1. Start a run, and pause it with `mode.pauseSpeckitAuto()`.
  2. Emit an idle kickoff, settle a spawn reply, and run `tick(3)`.

  Expect: `saved()?.run?.paused` is still `true`, `statusState()` is `"paused"`, and `submitted` has no new entry.

  Run both tests, and see the first one fail. Before T004, the kickoff counts as the user's answer. The paused test can already pass, because a paused run stays paused through other turns today (`interactive-mode.ts:4661-4664`). It guards US1 AC3 (FR-002, FR-005, US1 AC2, AC3)
- [X] T003 [US1] In the same file, add a test: "the run's own start waits until /spawn has sent its kickoff". Steps:
  1. Set `process.env.ZMX_SESSION` for the test, and restore it after the test. `handleSpawnCommand` refuses outside zmx.
  2. Start a run, and settle a phase reply whose verdict advances the run. Do not tick yet.
  3. Stub `session.setActiveToolsByName` with a promise that stays pending until the test resolves it. Stub `session.prompt` to resolve at once.
  4. Call `mode.handleSpawnCommand("list the files")` without `await`, then run `tick(3)`. Expect no new entry in `submitted`.
  5. Resolve the pending promise, await the `handleSpawnCommand` result, and run `tick(3)`. Expect `session.prompt` to have one call with `displayText` `/spawn list the files`. Expect the phase start to come after that call.

  Run it, and see it fail. Before T005, the speckit refusal stops the spawn. Before T006, the direct call, like the follow-up key route, raises no submit counter (FR-004, FR-006, research R5)

### Implementation for User Story 1

- [X] T004 [US1] In `packages/coding-agent/src/modes/speckit-auto.ts`, add an exported helper `isSpawnKickoff(message: AgentMessage): boolean`. It is true for a `developer` message with `userInitiated === true` whose display text matches `/^\/spawn(\s|$)/`. Check `message.role === "developer"` first. That check narrows the type before the call to `syntheticPromptDisplayText(message)`, which takes a `Message`. That function is in `../session/messages`, which this file already imports from. Then make `isSpeckitUserTurn` (line 462) return `false` when `isSpawnKickoff(message)` is true. Update its doc comment: a `/spawn` kickoff is not a user turn of the run. After this task, a kickoff no longer counts as a user turn in the live handler, the history replay, `#adoptSpeckitTurn`, or `speckitEarlierText` (research R1, R2)
  Done as: a table test "isSpawnKickoff" in `packages/coding-agent/test/speckit-auto.test.ts` covers no display text, empty text, bare `/spawn`, `/spawn` with a request, `/spawnx`, another command, a kickoff that is not user-initiated, and a user message. For each kickoff row it also checks that `isSpeckitUserTurn` is `false`.
- [X] T005 [US1] In `packages/coding-agent/src/modes/interactive-mode.ts` `handleSpawnCommand` (line 8641), remove the line `if (this.#warnSpeckitAutoBlocks()) return false;`. Keep every other refusal (FR-001, FR-007, research R6)
- [X] T006 [US1] In `packages/coding-agent/src/modes/interactive-mode.ts` `handleSpawnCommand`, raise `this.speckitSubmitInFlight` just before `await this.#beginSpawnWindow()`. Lower it in a `finally` that covers the whole `try`/`catch`, including the kickoff send. Add a one-line comment: "A speckit start before the kickoff would run first and close the spawn window." Do not change `#isSpeckitStartBlocked`. It already checks the counter (FR-006, research R5)
- [X] T007 [US1] Run the T002 and T003 tests and the whole `test/spawn-command.test.ts`. All new tests must pass. If a `/spawn` test expects the speckit refusal, update it to expect that the spawn runs

**Checkpoint**: `/spawn` runs with the mode on, a held question survives, a paused run stays paused, and the run's start waits until `/spawn` has sent its kickoff.

---

## Phase 4: User Story 2 - The judge checks the phase reply, not the spawn reply (Priority: P1)

**Goal**: On both routes (idle, and during a phase turn) and after a reload, the judge reads the phase's last reply from before the kickoff. A judge in flight is not aborted.

**Independent Test**: The T008, T009, and T010 tests pass.

### Tests for User Story 2

Run each test after you write it, and see it fail. After US1, these tests still fail for these reasons:
- T008: no opener branch runs during a phase turn, so the judge reads the spawn reply.
- T009: the idle kickoff is an opener that is not side traffic, so it aborts the judge.
- T010: the replay resets the phase reply at that opener.

- [X] T008 [US2] In `packages/coding-agent/test/interactive-mode-speckit-auto.test.ts`, add a test: "a /spawn during a phase turn leaves the phase reply for the judge". Steps:
  1. Start a run with `startRun("/speckit.plan")`. Set `reply` to the phase reply (timestamp A).
  2. With no `agent_start`, emit the kickoff `message_start`. This is the follow-up route.
  3. Set `reply` to a spawn reply (timestamp B), and settle the turn with `waitForInput()`.
  4. Run `tick(3)`.

  Expect:
  - `classify` is called once, and its reply argument (the second argument) has timestamp A, not B.
  - The request in its fourth argument (`classify.mock.calls.at(-1)?.[3].request`) is `"/speckit.plan"`, as with no spawn turn.
  - `saved()?.run` read just before the kickoff equals `saved()?.run` read just after the kickoff's `message_start`.

  (FR-002, FR-003, SC-002, US2 AC3, research R3 route 2)
- [X] T009 [US2] In the same file, add a test: "an idle /spawn does not abort a judge in flight". Steps:
  1. Settle a phase reply.
  2. Make `classify` return a promise that stays pending until the test resolves it.
  3. Run `tick()` until `classify` has one call.
  4. Emit `agent_start` and the kickoff `message_start`, and settle a spawn reply.
  5. Resolve the pending promise with a verdict that advances the run.
  6. Run `tick(3)`.

  Expect:
  - The signal of the first judge call is not aborted (`classify.mock.calls[0][2].signal.aborted` is `false`). The signal is `deps.signal`, the third argument (`interactive-mode.ts:4439`).
  - `classify` has exactly one call, and its request (`classify.mock.calls[0][3].request`) is the phase command.
  - The run submits the next phase once, after the spawn turn ends.

  (FR-002, US2 AC1, AC2, research R3 route 1)

  Done as: T008 and T009 are rows of one table test, "leaves the run as with no spawn turn: <state>". It covers six run states: user hold, needs-you hold, paused, parked start, judge in flight, and phase turn running. Each row checks the same invariant. The saved run does not change at the kickoff. Every judge call reads the phase reply, is not aborted, and has no request from the kickoff. The run makes the same starts as with no spawn turn. The test name prints the failing state.
- [X] T010 [US2] In the same file, add a test: "a reload keeps the phase reply across a /spawn turn". Steps:
  1. Use `reload(...)` with this history: a phase command user message, a phase reply (timestamp A, `stopReason: "stop"`), the kickoff developer message, and a spawn reply (timestamp B).
  2. Save a run entry for that phase before the reload, as other reload tests do.
  3. Resume the run with the mode toggle that existing tests use.
  4. Run `tick(3)`.

  Expect: `classify` checks the reply with timestamp A (FR-008, research R4)

### Implementation for User Story 2

- [X] T011 [US2] In `packages/coding-agent/src/modes/interactive-mode.ts`, make `isSpeckitSideTraffic` (line 1484) also return `true` for `isSpawnKickoff(message)`, and import the helper. Update its doc comment so that it names the `/spawn` kickoff (research R4)
- [X] T012 [US2] In `packages/coding-agent/src/modes/interactive-mode.ts` `#handleSpeckitSessionEvent`, in the `message_start` part, add a branch before the `#speckitAwaitOpener` block (line 4605):

  ```ts
  // A /spawn kickoff (idle, or as a follow-up inside a phase run) is not part of the run: the phase reply stays.
  if (isSpawnKickoff(message)) {
  	this.#speckitPhaseReply ??= this.session.getLastAssistantMessage();
  	this.#speckitAwaitOpener = false;
  	return;
  }
  ```

  The branch does not abort the judge, does not clear the decided key, and saves no state (FR-002, FR-003, research R3)
- [X] T013 [US2] Run the T008, T009, and T010 tests. All three must pass. Also run the whole `test/interactive-mode-speckit-auto.test.ts`, and compare the result with T001

**Checkpoint**: All contract rows in contracts/spawn-in-speckit-run.md hold.

---

## Phase 5: Polish & Cross-Cutting Concerns

- [X] T014 [P] In `packages/coding-agent/CHANGELOG.md` `[Unreleased]`, add a "Changed" bullet: `/spawn` now works while speckit-auto mode is on. The spawn turn does not change the run. The judge still checks the phase reply, a held question stays held, and the run's next step waits for the spawn turn. Before, `/spawn` refused with "Turn off speckit-auto mode first"
- [X] T015 [P] In `UPSTREAM_DIVERGENCES.md`, add a Decision bullet in the speckit-auto entry and a short note in "/spawn and /despawn sibling sessions":
  - Speckit-auto mode ignores a `/spawn` kickoff. `isSpawnKickoff` finds it by its `/spawn` display text.
  - Speckit starts wait while `/spawn` opens its window and sends its kickoff. `handleSpawnCommand` holds `speckitSubmitInFlight` for that time.
- [X] T016 Run `cd packages/coding-agent && bun test test/interactive-mode-speckit-auto.test.ts test/spawn-command.test.ts test/guided-loop.test.ts test/extension-session-modes.test.ts` and compare with T001. Then run `bun check` from the repository root without a pipe, and check that the exit code is 0
- [X] T017 Run quickstart smoke rows 1–3 with real `omp-dev` in zmx. For row 2, compare the last `speckit-auto` entry in the parent session `.jsonl` before and after the spawn
- [X] T018 Clean up per quickstart "Cleanup": end the child and parent zmx sessions, and delete `/tmp/spawn-speckit`

---

## Dependencies & Execution Order

- **Setup (T001)** comes first.
- **US1 (T002–T007)**: tests T002 and T003 come first, then T004 → T005 → T006, then T007. T005 and T006 both edit `handleSpawnCommand`.
- **US2 (T008–T013)** depends on US1, because T011 and T012 use the T004 helper. Tests T008–T010 come first, then T011 → T012, then T013. T012 edits `#handleSpeckitSessionEvent`.
- All tests share one file, so no test task runs in parallel.
- **Polish**: T014 and T015 [P] can run at any time after the stories. T016 → T017 → T018 come last, in that order.

## Parallel Example

```text
After T013:
  T014 CHANGELOG.md
  T015 UPSTREAM_DIVERGENCES.md
```

## Implementation Strategy

1. **MVP (US1)**: T001–T007. `/spawn` works with the mode on. Held questions, paused runs, and the run's next start stay safe.
2. **US2**: T008–T013. The judge reads the right reply on both routes and after a reload. Ship US1 and US2 together: with US1 alone, a `/spawn` during a phase turn can still give the judge the spawn reply.
3. **Last**: the docs, the checks, the smoke run, and the cleanup.

## Phase 6: Convergence

- [X] T019 In `specs/019-spawn-during-speckit-auto/quickstart.md` Runs row 3, replace "`/speckit-auto-mode` until the run is paused" with "press Esc during a phase turn to pause the run (`pauseSpeckitAuto`)", because `/speckit-auto-mode` only cycles off, full, and tasks per plan: real smoke run gate, T017 (partial)
- [X] T020 In `specs/019-spawn-during-speckit-auto/quickstart.md` Setup step 2, replace the bare `specify init --here` with `specify init --here --integration omp`, because the default integration is Copilot and only `omp` writes `.omp/commands/speckit.*.md` per plan: real smoke run gate, T017 (partial)

## Phase 7: Convergence

- [X] T021 In `specs/019-spawn-during-speckit-auto/quickstart.md` Setup step 1, add `git -C /tmp/spawn-speckit commit --allow-empty -m init` after `git init -b main /tmp/spawn-speckit`, so the repository has the one commit that the step names, per plan: real smoke run gate, T017 (partial)

## Phase 8: Convergence

- [X] T022 In `specs/019-spawn-during-speckit-auto/quickstart.md` "Unit tests", add `test/speckit-auto.test.ts` to the `bun test` command, because the `isSpawnKickoff` table test is in that file, and change "except the paused guard" to "except the paused guards" per T004, plan: tests prove behavior (partial)
