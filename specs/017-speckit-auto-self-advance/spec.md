# Feature Specification: Speckit-Auto Follows a Phase the Agent Starts Itself

**Feature Branch**: `main`

**Created**: 2026-10-27

**Status**: Draft

**Input**: User description: "For speckit-auto can you catch phase when model advance to next phase itself? like the above stuff agent run" and "spec it first to fill the gap". (Context: inside a phase turn, the agent ran `specify project command speckit.tasks --json` and printed the tasks command text. The agent then did the tasks phase in the same turn, without the mode starting `/speckit.tasks`.)

## Clarifications

### Session 2026-10-27

- Q: In a "stop before implement" run, if the agent starts implement or converge itself in the middle of a turn, should the mode stop that turn right away? → A: Yes. Abort the turn at once when the agent loads implement or converge. End the run as "stopped before implement", and show a notice that the agent tried to start that phase.
- Q: When speckit-auto mode is on but no run is active, and the agent loads a phase's instructions itself in a free-text turn, should the mode start a run from that phase? → A: Yes. Start a run in that phase and continue on its own when the turn settles, the same as a typed phase command.
- Q: When a run is active and the agent loads the `speckit.specify` instructions itself, should the mode treat it as a new feature? → A: Yes. Same as a typed `/speckit.specify`: end the current run as "stopped" (with its summary) and start a new run at specify.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The run follows the phase that the agent started (Priority: P1)

The mode runs a phase, for example plan. Before the turn ends, the agent loads the instructions of the next phase itself and does that phase too, for example tasks. Today the mode does not see this. It still records plan, checks the reply as a plan reply, and then starts `/speckit.tasks`, which runs tasks a second time. Or the check does not find a plan report in a reply that ends with a tasks report, and the mode holds with no clear reason.

With this feature, the mode sees that the agent loaded the tasks instructions. The run moves to tasks, the status bar shows tasks, and the settled reply is checked as a tasks reply. The mode then starts the phase after tasks (analyze).

**Why this priority**: This is the gap that the user found. A repeated phase costs tokens and time, and it can overwrite the output of the phase that the agent already did. A wrong hold stops an unattended run for no reason.

**Independent Test**: Turn the mode on and start a run at plan. In the plan turn, let the agent run the spec-kit command that prints the tasks instructions, and let it write `tasks.md`. When the turn settles, the status bar shows tasks, no `/speckit.tasks` message is sent, and the next message that the mode sends is `/speckit.analyze`.

**Acceptance Scenarios**:

1. **Given** a run in plan, **When** the agent runs a spec-kit command that prints the `speckit.tasks` instructions in the same turn, **Then** the run moves to tasks at once and the status bar shows tasks.
2. **Given** the run moved to tasks inside the plan turn, **When** the turn settles with a tasks report, **Then** the mode checks the reply as a tasks reply and starts analyze, not tasks.
3. **Given** a run in plan, **When** the agent reads the `speckit.tasks` command file in the same turn, **Then** the run moves to tasks, the same as for the spec-kit command.
4. **Given** a run in plan, **When** the agent loads the `speckit.plan` instructions again, **Then** the run stays in plan.
5. **Given** a run in plan, **When** the agent loads the tasks instructions and then the analyze instructions in the same turn, **Then** the run moves to tasks and then to analyze, and the run's phase list records both.
6. **Given** the mode is on with no run, **When** the user types free text and the agent loads the `speckit.plan` instructions, **Then** a run starts in plan, and when the turn settles the mode checks the reply as a plan reply and continues on its own, the same as after a typed `/speckit.plan`.

---

### User Story 2 - The user can see that the agent moved the phase (Priority: P2)

The user reads the transcript later, or watches the status bar. The user must know that the agent, not the mode, started the phase. Otherwise a missing `/speckit.tasks` message looks like a skipped phase.

**Why this priority**: The run works without the notice. The notice only explains what happened.

**Independent Test**: Repeat the test of User Story 1. A status notice says that the agent started tasks itself. The run summary at the end lists tasks.

**Acceptance Scenarios**:

1. **Given** a run in plan, **When** the run moves to tasks because the agent loaded the tasks instructions, **Then** omp shows one status notice that names the new phase and says that the agent started it.
2. **Given** a run that moved by itself one or more times, **When** the run ends, **Then** the summary lists every phase that ran, including the phases that the agent started.

---

### User Story 3 - A tasks-scope run stays out of code edits (Priority: P2)

The run scope "stop before implement" exists so that a run does not edit code while other agents work. If the agent starts implement itself in such a run, the mode must not continue the implement and converge loop.

**Why this priority**: The scope is a promise to the user. Implement edits code from its first steps, so a stop when the turn settles comes too late. The mode must stop the turn as soon as the agent loads the instructions.

**Independent Test**: Set the scope to "stop before implement". In the analyze turn, let the agent load the implement instructions. The turn stops before the next tool call, the run ends as "stopped before implement", and the mode starts nothing.

**Acceptance Scenarios**:

1. **Given** an active, not paused run with the scope "stop before implement", **When** the agent loads the implement or converge instructions, **Then** the mode aborts the turn when the load ends, so the agent starts no new tool call after it.
2. **Given** that abort, **When** the turn ends, **Then** the run ends with the result "stopped before implement", the mode starts nothing, and one notice says that the agent tried to start implement (or converge) itself.
3. **Given** that run, **When** the agent loads the implement instructions, **Then** the run does not become a user-started editing run. Only a phase command that the user types sets that flag.
4. **Given** a run with the scope "stop before implement" that the user already moved into editing with a typed `/speckit.implement`, **When** the agent loads the converge instructions, **Then** the run follows the full scope: it moves to converge and the turn goes on.

---

### Edge Cases

- The agent mentions another phase command only in its reply text, for example "Next: run `/speckit.tasks`". This is not a phase start. The existing handoff rules apply, and the run does not move.
- The agent writes a file whose content names another phase command, for example a `plan.md` that says "run `/speckit.tasks` next". This is not a phase start. Only a tool call that loads the phase instructions counts.
- The agent searches the repository for the text `speckit.tasks`, for example with `grep`. This is not a phase start, because the call does not load the instructions of the phase.
- The agent loads the implement instructions in a converge turn. The run moves to implement, and this counts as one converge round, the same as when the mode starts implement after converge.
- The agent loads the instructions of a phase that comes before the current phase in the run order, for example plan in a tasks turn. The run moves to that phase. The mode then continues from that phase in run order.
- The agent loads the specify instructions inside a run. This is a new feature, the same as a typed `/speckit.specify`: the current run ends as "stopped" with its summary, and a new run starts at specify.
- The run is paused, and the user's own turn makes the agent load another phase. The run moves to that phase but stays paused. `/speckit-auto resume` and `/speckit-auto next` then continue from the new phase. A specify load in that turn starts the new run paused for the same reason.
- The mode is on with no run, and the agent loads a phase in a free-text turn. A run starts in that phase, the same as for a typed `/speckit.<phase>` command, and the mode continues on its own when the turn settles. The free text stays the user's request for the settle check.
- The mode is on with no run and the scope "stop before implement", and the agent loads implement in a free-text turn. The new run follows the rules of a typed `/speckit.implement` with no run. The abort of FR-008 applies only to a run that was active before the load.
- The tool call that loads the phase fails, for example the spec-kit command is unknown or the file does not exist. The run does not move, because the agent did not get the instructions.
- A subagent loads a phase. The run does not move. Only tool calls of the main session count.
- The session resumes after a restart. The saved run already holds the phase it moved to, because the move is saved like any other phase change.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: While speckit-auto mode is on, the system MUST detect when a successful tool call of the main session loads the instructions of a `speckit.<phase>` command. A load is one of: (a) a spec-kit command-line call that prints the instructions of that command, or (b) a read of that command's file (`speckit.<phase>.md`, or the `speckit-<phase>` skill file), in any directory.
- **FR-002**: The system MUST NOT count reply text, written file content, or a search for the command name as a load.
- **FR-003**: When a load names a phase other than the run's current phase, the system MUST move the run to that phase when the tool call ends. The move MUST add the phase to the run's phase list and save the run state, the same as a phase start by the mode.
- **FR-004**: A load of the run's current phase MUST NOT change the run.
- **FR-005**: A move MUST follow the round rules of a phase start by the mode. An implement load in converge MUST count one converge round.
- **FR-006**: When the turn settles, the system MUST check the reply as a reply of the phase that the run holds at that time, and MUST decide the next step from that phase.
- **FR-007**: On each move, the system MUST show one status notice that names the new phase and says that the agent started it.
- **FR-008**: A move by the agent MUST NOT change whether the run is a user-started editing run. (A run that an agent load starts follows FR-010 instead.) When an active, not paused run follows the scope "stop before implement" and the agent loads the implement or converge instructions, the system MUST abort the turn when the load ends, end the run with the result "stopped before implement", and show one notice that names the phase that the agent tried to start. The run MUST NOT move to that phase.
- **FR-009**: A move MUST apply to a paused run without ending the pause. A specify load into a paused run MUST start the new run paused. The mode MUST NOT act on a paused run until the user resumes or advances it.
- **FR-010**: When the mode is on with no active run, a load MUST start a run in the loaded phase, the same as a typed `/speckit.<phase>` command with no run. When the turn settles, the mode MUST check the reply and continue on its own. The abort of FR-008 MUST NOT apply to a run that the load itself started.
- **FR-010a**: When the agent loads the specify instructions while a run is active, the system MUST end the current run with the result "stopped" and show its summary, then start a new run at specify, the same as a typed `/speckit.specify`. This rule MUST take precedence over the move of FR-003.
- **FR-011**: The run summary MUST list the phases that the agent started, in the order they ran.
- **FR-012**: The feature MUST NOT add a setting. It is part of the existing speckit-auto mode.

### Key Entities

- **Phase load**: A successful tool call in the main session that gives the agent the instructions of one `speckit.<phase>` command. It names one phase.
- **Run** (existing): The current phase, the phase list, the round counts, the scope flags, and the pause flag. A phase load changes the current phase and the phase list.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of test turns where the agent does the next phase itself, the mode sends zero repeated starts of that phase.
- **SC-002**: The status bar shows the new phase before the next tool call of the same turn starts.
- **SC-003**: In 100% of test turns where a phase command name appears only in reply text, written file content, or a search, the run phase stays the same.
- **SC-004**: In a "stop before implement" run where the agent loads the implement or converge instructions, the mode requests the abort before the load's end event returns, no tool call of that turn starts after that, and the mode sends zero further phase starts.
- **SC-005**: After a restart, a resumed run shows the phase that the agent last started in 100% of test cases.

## Assumptions

- The agent gets another phase's instructions in one of two ways: a spec-kit command-line call that prints the command (as in the user's example, `specify project command speckit.tasks`), or a read of the command file (`.omp/commands/speckit.<phase>.md` for this project, or the matching skill file). Other ways are out of scope until they appear.
- A loaded phase means that the agent does that phase. The mode does not check whether the agent finished it. The settle check of FR-006 decides that, the same as for a phase start by the mode.
- The mode does not interrupt the agent's turn when it starts another phase, except for the scope stop of FR-008. It follows the turn and decides when the turn settles.
- The existing rules of the mode stay the same: handoff sentences, the judge, holds, round limits, and the run scope.
