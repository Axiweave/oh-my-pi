# Feature Specification: Spawn During Speckit-Auto Mode

**Feature Branch**: `019-spawn-during-speckit-auto`

**Created**: 2026-11-02

**Status**: Draft

**Input**: User description: "yes change it" (Context: `/spawn` refuses with "Turn off speckit-auto mode first (/speckit-auto-mode)." The user asked why. The cause: the `/spawn` request runs as a turn in the current session, and speckit-auto mode counts every user turn as part of its run. Its judge would read the spawn reply as the phase reply and could hold the run or start the next phase. The proposed change: speckit-auto mode ignores the `/spawn` turn, as it ignores advisor notes and messages from other agents, and `/spawn` stops refusing.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Spawn a session while the speckit run waits (Priority: P1)

A user has speckit-auto mode on. The run is between turns, holds for the user, or is paused. The user runs `/spawn` with a request, for example "fix the typo in README". A new session starts as it does with speckit-auto mode off. The speckit run does not notice the spawn turn. Its phase, its hold, and its next step stay as they were.

**Why this priority**: This is the reported failure. Today the user must turn speckit-auto mode off, run `/spawn`, and turn the mode on again.

**Independent Test**: Turn speckit-auto mode on, let the run reach a hold, and run `/spawn fix the typo in README`. A new session starts. The status line shows the same phase and the same hold as before the spawn.

**Acceptance Scenarios**:

1. **Given** speckit-auto mode is on, **When** the user runs `/spawn` with a request, **Then** no "Turn off speckit-auto mode first" warning shows, and the spawn runs as it does with the mode off.
2. **Given** the run holds for the user, **When** a `/spawn` turn ends, **Then** the run still holds with the same reason, and it starts no phase.
3. **Given** the run is paused, **When** a `/spawn` turn ends, **Then** the run stays paused.
4. **Given** the run waits between phases, **When** a `/spawn` turn ends, **Then** the run's next step is the step that it would take with no spawn turn.

---

### User Story 2 - The judge checks the phase reply, not the spawn reply (Priority: P1)

The speckit judge decides the run's next step from the reply of the current phase. When a `/spawn` turn comes after that reply, the judge still reads the phase reply. It never reads the spawn turn's messages, for example "Spawned cci-omp-… in …".

**Why this priority**: A judge that reads the spawn reply can hold the run for no reason, or start the wrong phase. The run would then do work that the user did not ask for.

**Independent Test**: Let a phase finish with a reply that asks to run the next phase. Run `/spawn` before the judge decides. The judge's input is the phase reply, and the run goes on to the next phase.

**Acceptance Scenarios**:

1. **Given** a phase reply that the judge has not checked yet, **When** a `/spawn` turn runs and ends, **Then** the judge checks the phase reply, and the decision is the same as with no spawn turn.
2. **Given** a phase reply that the judge has already decided, **When** a `/spawn` turn runs and ends, **Then** the judge does not decide again, and the run does not repeat its step.
3. **Given** a phase turn is still running, **When** the user runs `/spawn`, **Then** the spawn request waits for that turn, and the judge reads the phase's last reply from before the spawn request, not the spawn reply.

---

### Edge Cases

- The run holds for the user's answer to a phase question. A `/spawn` turn is not that answer. The hold stays, and the next text that the user types still answers the question.
- The spawn turn asks the user one question (spawn mode unclear) in the `ask` dialog. The user answers it in that dialog. Speckit-auto mode does not answer it, and the run does not count it. If the user cancels the dialog, the spawn turn ends with its reply. Text that the user types after that is a new user turn, as it is with the mode off.
- The spawn turn fails, or the user declines the spawn. The run is unchanged, as after a successful spawn.
- The user runs a speckit phase command while the spawn window is open. The phase command is a user turn, and the run treats it as today.
- Speckit-auto mode still refuses other modes: loop, goal, plan, and the guided interviews. Only `/spawn` changes.
- `/spawn` keeps its other refusals: outside zmx, with an API key on the command line, during a guided interview, and while another `/spawn` runs.
- The session reloads after a `/spawn` turn. The restored run has the same phase and hold as before the spawn turn.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `/spawn` MUST NOT refuse because speckit-auto mode is on, in any run state: active, holding, or paused.
- **FR-002**: A `/spawn` turn MUST NOT change the speckit run: its phase, hold, paused state, round counts, pending user request, and the reply that the judge checks.
- **FR-003**: The judge MUST NOT read the messages of a `/spawn` turn as a phase reply.
- **FR-004**: After a `/spawn` turn, the run MUST take the same next step that it takes with no spawn turn. It MUST NOT start a phase, repeat a step, or check a decided reply again because of the spawn turn.
- **FR-005**: A `/spawn` turn MUST NOT count as the user's answer to a phase question.
- **FR-006**: The run's own next turn MUST NOT start while a `/spawn` turn runs.
- **FR-007**: Every other speckit-auto refusal and every other `/spawn` refusal MUST stay as it is today.
- **FR-008**: The saved speckit run state after a `/spawn` turn MUST equal the state before it, so a reload restores the same run.

### Key Entities

- **Spawn turn**: The turn that `/spawn` starts in the current session. It has a hidden opening prompt and ends after the spawn call or after one reply.
- **Speckit run**: The speckit-auto mode state. It has a phase, an optional hold, a paused flag, round counts, and the reply that the judge checks.
- **Phase reply**: The last reply of the current phase. The judge reads it to decide the run's next step.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With speckit-auto mode on, 0 of the checked `/spawn` requests show the "Turn off speckit-auto mode first" warning.
- **SC-002**: In 100% of checked cases (run holding, paused, waiting between phases, and with a phase turn running), the speckit run state after a `/spawn` turn equals the state before it.
- **SC-003**: In 100% of checked cases, the judge's decision after a `/spawn` turn is the same as with no spawn turn.
- **SC-004**: The user turns speckit-auto mode off and on 0 times to start a sibling session. Today the user does it once for each spawn.

## Assumptions

- Speckit-auto mode already ignores some turns that omp starts on its own, for example advisor notes and messages from other agents. The spawn turn follows that same rule, so the change needs no new kind of run state.
- A `/spawn` request sent while a turn runs waits for that turn, as it does today with speckit-auto mode off.
- The spawn turn stays visible in the transcript as today. Only the speckit run ignores it.
- `/fork spawn` needs no change. It starts no turn in the current session, so speckit-auto mode never sees it.
- Spec 018 (worktree tool before the spawn) is unchanged. A spawn turn that runs a worktree tool is still a spawn turn.
