# Research: Spawn During Speckit-Auto Mode

## R1. How the run knows a message is a `/spawn` kickoff

- **Decision**: A message is a spawn kickoff when it is a `developer` message with `userInitiated: true` and a display text that starts with `/spawn`. `handleSpawnCommand` sets that display text when it creates the kickoff (`command.text`, or `/spawn <request>`). The session file keeps it, so the test also works after a reload. A small exported helper `isSpawnKickoff` in `src/modes/speckit-auto.ts` holds the test. It reads the display text with the existing `syntheticPromptDisplayText` (`src/session/messages.ts`).
- **Rationale**: `/spawn` is the only producer of such a message. No other slash command has a display text that starts with `/spawn`, and `/fork spawn` sends no message. The field exists today, so the change needs no new message field.
- **Alternatives considered**:
  - A new field on `DeveloperMessage` (for example `kind: "spawn"`). This changes the `ai` package type. Also, `convertToLlm` strips only `displayText` (`messages.ts:1270`), so a new field could reach provider requests. Rejected: wider change for the same result.
  - Match the kickoff content (the first line of `spawn-kickoff.md`). Rejected: it ties the run to prompt wording.
  - Remember the sent message object in a `WeakSet`. Rejected: a reload loses it, and event messages can be copies.

## R2. Where the exclusion goes

- **Decision**: `isSpeckitUserTurn` (`speckit-auto.ts:462`) returns `false` for a spawn kickoff.
- **Rationale**: All four readers of a user turn use it:
  - the live event handler (`interactive-mode.ts:4621`)
  - history replay on reload (`#replaySpeckitTurns`, line 4054)
  - `#adoptSpeckitTurn` (line 4080)
  - `speckitEarlierText` (line 472)

  One change covers all four. It also covers the held-question case. A kickoff that is not a user turn never sets `run.answering` (lines 4650-4651) and never clears a hold (line 4668). So a `/spawn` during a phase question cannot answer it (FR-005).

## R3. The live path: keep the phase reply on every route

- **Decision**: In `#handleSpeckitSessionEvent`, a spawn kickoff's `message_start` runs this, before the opener check:

  ```ts
  this.#speckitPhaseReply ??= this.session.getLastAssistantMessage();
  this.#speckitAwaitOpener = false;
  return;
  ```

  It does not abort the judge, does not clear the decided key, and saves no state.
- **Rationale**: A kickoff reaches the run on two routes:
  1. **Idle**: `session.prompt` starts a new agent run, so `agent_start` comes first, and the kickoff is the opener.
  2. **During a phase turn**: `session.followUp` injects the kickoff into the phase's own agent run. The agent loop sends follow-ups with no new `agent_start` (`agent-loop.ts:1827-1830`), and the run emits one `agent_end` (`agent.ts:2296`). `#speckitAwaitOpener` is then `false`, so the opener branch (lines 4605-4620) never runs.

  The current code fails on each route:
  - On route 2, the judge reads the spawn reply, because `#speckitPhaseReply` stays unset (review path 1).
  - On route 1 with the judge in flight, the non-side-traffic branch aborts the judge and clears the decided key (lines 4613-4618). The judge then reads the spawn reply (review path 3).

  The fix handles both routes the same way, before that branch runs. `??=` keeps a phase reply that earlier side traffic already captured. The last assistant message at the kickoff's start is the phase's last reply on both routes. A follow-up comes only after the phase's final message.
- **Alternative considered**: Add the kickoff to `isSpeckitSideTraffic` only. Rejected: that check runs only in the `#speckitAwaitOpener` branch, so route 2 stays broken.

## R4. Replay after a reload

- **Decision**: `isSpeckitSideTraffic` also returns `true` for a spawn kickoff.
- **Rationale**: `#replaySpeckitTurns` (line 4067) keeps the phase reply only for side-traffic openers. A kickoff in history comes after a finished reply on both routes (`opens` is `true`), so it is an opener. With this change, the replay keeps the phase reply, and the restored run checks the same reply as the live run (FR-008). The live path needs R3 as well, because R4 alone does not cover route 2.

## R5. The run's own start waits for the spawn turn

- **Decision**: `handleSpawnCommand` raises `this.speckitSubmitInFlight` from the moment that it opens the spawn window until its kickoff send (`session.prompt` or `session.followUp`) returns or fails. A `try`/`finally` around that part does the decrement. `#isSpeckitStartBlocked` already checks this counter (line 4340), so it needs no change.
- **Rationale**: `handleSpawnCommand` opens the spawn window, then awaits `setActiveToolsByName`, then sends the kickoff. During that gap the session is not streaming. A speckit start (a parked phase or an automatic answer) could start in the gap. The kickoff then waits behind it. The spawn window closes after a run with no `spawn_session` call. So it can close at the end of the speckit turn, and the kickoff then runs with no spawn tool. After the send, the spawn turn itself blocks starts, because the session streams or holds an admitted submission. The tick already re-arms while a start is blocked (line 4393).
- **Where the gap exists**: The Enter route raises the same counter around the whole command (`input-controller.ts:1623-1629`). So the Enter route has no gap today. The follow-up key route (`#dispatchFollowUp`, `input-controller.ts:2333`) calls the command with no counter. The gap exists there.
- **Alternative considered**: Block while `session.isSpawnWindowOpen()`. Rejected: the window stays open after a run that called `ask` and made no `spawn_session` (`sibling-spawn.ts:223`), for example after the user cancels the spawn question. The run would then wait until the user types again (FR-004).
- **Out of scope**: Loop mode has the same gap on the follow-up key route (`#isAutoSubmitBlocked`). This spec does not change loop mode.

## R5a. A cancelled spawn question

- **Decision**: No code for this case. The spawn question goes through the `ask` dialog inside the spawn turn. The answer is a tool result in that turn, so the run never sees it as a user turn.
- **Rationale**: The user can cancel the dialog. The spawn turn then ends with no spawn call, and the spawn window stays open. The spec says that a spawn turn ends "after the spawn call or after one reply". So text that the user types after that reply is a new user turn. The run treats it like any other typed text. This matches today's behavior with speckit-auto mode off: the typed text goes to the model as a normal prompt.

## R6. The `/spawn` refusal

- **Decision**: Remove `if (this.#warnSpeckitAutoBlocks()) return false;` from `handleSpawnCommand` (line 8641). Keep every other refusal (FR-007). `#warnSpeckitAutoBlocks` keeps its other callers.

## R7. Proof

- **Decision**: Add these permanent tests to `test/interactive-mode-speckit-auto.test.ts`. Each one fails before the change.
  1. A `/spawn` kickoff during a phase turn, as a follow-up with no `agent_start`: the judge (`classifySpeckitTurn`) gets the phase reply, not the spawn reply.
  2. A run on a `user` hold, then a kickoff and its reply: the hold and its reason stay, and the next typed text still answers the question.
  3. A judge in flight, then an idle kickoff with `agent_start`: the judge is not aborted, and the run applies its decision on the phase reply once.
  4. A reload with a kickoff after the phase reply in history: the restored run checks the phase reply.
  5. A direct `handleSpawnCommand` call while the tool change is still pending: the run's next phase does not start until the kickoff is sent (R5).

  One more test guards US1 AC3: a paused run stays paused after a kickoff. It can pass before the change, because a paused run already stays paused through other turns (`interactive-mode.ts:4661-4664`). It stops a later change from breaking that.

  Update the existing test that expects the speckit refusal from `/spawn`, if one exists. The interactive-mode test file already emits messages with `session.agent.emitExternalEvent`, so the tests need no new harness.
- **Smoke**: Run real `omp-dev` in zmx with speckit-auto mode on (quickstart). Make the run hold, run `/spawn list the files`, and check that the status line and the saved run state stay the same.
