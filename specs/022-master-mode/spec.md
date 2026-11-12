# Feature Specification: Master Mode

**Feature Branch**: `main`

**Created**: 2026-11-10

**Status**: Draft

**Input**: User description: "I want a 'master mode' (not just the master agent we have now in cc-ide) that forces subagents and background tasks." (Context: the cc-ide Master Session is an ordinary omp session. Only a text rule in its `AGENTS.md` asks it not to do work itself, and it keeps every tool. The `orchestrate` keyword and vibe mode steer the agent toward delegation, but nothing in omp stops the main agent from editing files or from running long commands in the foreground. The user wants a mode in which the main agent cannot do the work itself and must hand it to subagents and background jobs.)

## Clarifications

### Session 2026-11-10

- Q: Can the main agent in master mode look at project files itself? → A: Yes. It can read files and search them by name and by content. It cannot change them.
- Q: How does the user turn master mode on? → A: With a toggle command in any session, and with a start option, so that a session (for example the cc-ide Master Session) starts in master mode.
- Q: Can the main agent run shell commands as background jobs, or must every check go through a subagent? → A: It keeps background shell jobs, so checks (tests, builds, `git status`) stay cheap. Nothing stops a background job from changing files, so "give every change to a subagent" is a prompt rule. The enforced contract is narrower than "force subagents": no direct file-change tool and no foreground work in the main agent. The strict variant (no shell for the main agent, checks through subagents) was offered and declined.
- Q: What is the main goal of master mode? → A: A central orchestrator that never blocks on delegated work. The main agent does not wait for a worker, a background job, or a foreground command. It can still wait for the user when it asks a question. It stays free to talk to the user and to react to results. Workers (subagents and background jobs) do the work. Refusing file-change tools and foreground work serves this goal. It is not a security boundary.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The main agent does no direct or foreground work (Priority: P1)

A user turns master mode on and asks for a change, for example "add a retry to the upload client and update its tests". The main agent reads the code it needs in order to plan. Then it gives the edits to subagents and runs the tests as a background job. It does not use a tool that changes a file, and it never blocks on work in the foreground. When the main agent tries to edit a file or run a command in the foreground, omp refuses the call. The refusal tells the agent how to delegate the work.

**Why this priority**: This is the request. A prompt rule alone does not stop the agent from editing files or from blocking on long commands. The cc-ide Master Session shows that an agent with every tool does the work itself.

**Independent Test**: Turn master mode on. Ask the agent to fix a one-line typo. The agent gives the fix to a subagent. Then ask it directly to "edit the file yourself". The edit call is refused, the file stays the same, and the refusal names the delegation tools.

**Acceptance Scenarios**:

1. **Given** master mode is on, **When** the main agent calls a file-change tool (an edit, or a write to a project file), **Then** omp refuses the call, the file does not change, and the agent gets a refusal that names the subagent tool and the background job option. A background shell job is not a file-change tool (see "Scope of the guarantee").
2. **Given** master mode is on, **When** the main agent runs a shell command in the foreground, **Then** omp refuses the call and tells the agent to run it as a background job.
3. **Given** master mode is on, **When** the main agent runs the same shell command as a background job, **Then** the command runs.
4. **Given** master mode is on, **When** the main agent reads a project file or searches files by name or content, **Then** the call runs.
5. **Given** master mode is on, **When** the main agent starts a subagent, **Then** the subagent starts in the background and has its normal tools, including file edits and foreground commands.
6. **Given** master mode is off, **When** the main agent calls any tool, **Then** omp applies no master-mode rule.

**Scope of the guarantee**: master mode enforces two things: no direct file-change tool and no foreground work in the main agent. It does not enforce that every project change goes through a subagent. A background shell job can still change files, because omp cannot tell a check command from a change command. The instructions tell the main agent to use background jobs only for checks (tests, builds, `git status`) and to give every change to a subagent. That part is a prompt rule, not a hard rule.

---

### User Story 2 - The user can talk to the main agent while work runs (Priority: P1)

A user in master mode starts a large task. The main agent sends out three subagents and a background test run, then ends its turn. The user can send messages while the work runs, for example to ask about progress or to add a request. When a subagent or a background job finishes, its result comes to the main agent without a user message, and the main agent reacts to it: it checks the result, sends follow-up work, or reports to the user.

**Why this priority**: A main agent that blocks until its workers finish cannot talk to the user, and this removes the main value of a coordinator. omp already delivers background results to the main agent when they finish, so the mode must use that and not a blocking wait.

**Independent Test**: Turn master mode on. Ask for two independent tasks that each take more than a minute. The agent's turn ends within seconds after it starts the work. Send "status?" and get an answer while the work runs. Each result then starts a new turn in the main agent without user input.

**Acceptance Scenarios**:

1. **Given** master mode is on, **When** the main agent calls a tool that blocks until background work finishes, **Then** omp refuses the call and tells the agent that results arrive by themselves.
2. **Given** master mode is on, **When** the main agent asks for a subagent that runs in the foreground, **Then** omp refuses the call and tells the agent to start it in the background.
3. **Given** the main agent started background work and ended its turn, **When** the user sends a message, **Then** the main agent answers it while the work continues.
4. **Given** the main agent started background work and ended its turn, **When** a piece of that work finishes, **Then** the result reaches the main agent and starts a turn without user input.
5. **Given** master mode is on, **When** the main agent wants to stop a running worker or send it a message, **Then** it can do so.

---

### User Story 3 - The mode is visible, persistent, and easy to leave (Priority: P2)

A user turns master mode on with one command and turns it off with the same command. While it is on, the status line shows it. When the user resumes the session later, master mode is still on. After the user turns it off, the main agent has the same tools it had before.

**Why this priority**: The user must know why an edit was refused and must be able to leave the mode at once when a small task is faster to do directly.

**Independent Test**: Run the toggle command. The status line shows master mode. Quit and resume the session. The status line still shows it, and an edit by the main agent is still refused. Run the toggle again. The status line no longer shows it, and the main agent can edit files again.

**Acceptance Scenarios**:

1. **Given** master mode is off, **When** the user runs the toggle command, **Then** master mode turns on, the status line shows it, and a message states the rule in one sentence.
2. **Given** master mode is on, **When** the user runs the toggle command, **Then** master mode turns off and the main agent has the tools it had before master mode.
3. **Given** master mode is on, **When** the user quits and resumes the session, **Then** master mode is on.
4. **Given** master mode is on and a turn is running, **When** the user turns the mode off, **Then** the change applies from the next tool call.

---

### User Story 4 - A session can start in master mode (Priority: P2)

A user or a program starts omp with a start option, so that the session is in master mode from its first message. The cc-ide Master Session can use this option in place of its `AGENTS.md` rule.

**Why this priority**: The cc-ide Master Session is the place where the user wants this rule most. The rule there today depends on the model's choice to obey a text file.

**Independent Test**: Start omp with the master option and the prompt "edit README.md to add a line". The first turn delegates the edit, and no direct edit call succeeds.

**Acceptance Scenarios**:

1. **Given** omp starts with the master option, **When** the first turn runs, **Then** master mode is on for that turn.
2. **Given** omp starts with the master option and a start prompt, **When** the start prompt runs, **Then** the master-mode rules apply to it.
3. **Given** omp starts with the master option in a setup where master mode cannot turn on (background work off, or another mode that excludes it), **When** the session starts, **Then** omp shows why and the session starts without master mode.
4. **Given** omp starts with the master option in a mode with no interactive session (print, RPC, or ACP), **When** it parses the options, **Then** it stops with a usage error, as it does for the goal option.

---

### Edge Cases

- Background work is turned off in the settings. Master mode cannot work without it, so the toggle refuses and names the setting.
- The user turns on a mode that cannot run together with master mode (vibe mode, plan mode, or speckit-auto mode). omp refuses the second mode and names the mode that is already on. Goal mode and loop mode can run together with master mode.
- The agent calls a tool from an extension or an MCP server. omp refuses it in master mode, because omp cannot know whether that tool changes files. A subagent can still call it.
- The agent retries a refused call several times. Each call is refused with the same message, and no call has an effect.
- The agent writes files through a shell command that it runs in the background, for example `sed -i`. The command runs. This breaks the prompt rule, not a hard rule (see "Scope of the guarantee" in User Story 1).
- A subagent finishes after the user turned master mode off. Its result still reaches the main agent.
- The user types a direct request such as "just edit it yourself" while master mode is on. The edit is still refused. The user must turn the mode off.
- The main agent writes to an internal address of omp, for example to send a message to a worker, to stop a job, or to save a plan note. The call runs, because it changes no project file.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: omp MUST have a master mode that the user turns on and off with one toggle command.
- **FR-002**: omp MUST have a start option that starts a session in master mode.
- **FR-003**: In master mode, omp MUST refuse each main-agent tool call that is not on the master allowlist. A refused call MUST have no effect.
- **FR-004**: The master allowlist MUST contain: start a subagent in the background, run a shell command as a background job, read a file, search files by name, search files by content, keep the task list, ask the user a question, read the output of a worker or a job, send a message to a worker, and stop a worker or a job.
- **FR-005**: In master mode, a file write by the main agent MUST be allowed only to internal omp addresses (for example a worker message, a job stop, or a session note), and MUST be refused for every project file.
- **FR-006**: In master mode, omp MUST refuse a shell command that the main agent runs in the foreground, and MUST allow the same command as a background job. A named long-running service MUST be refused, because a service start can block.
- **FR-007**: In master mode, omp MUST refuse a subagent that runs in the foreground and any call that blocks until background work finishes.
- **FR-008**: Each refusal MUST say that master mode is on, name the allowed way to do the work, and tell the agent not to work around the refusal.
- **FR-009**: Master-mode rules MUST apply only to the main agent of the session. Subagents and background jobs MUST keep their normal tools.
- **FR-010**: In master mode, the main agent MUST get instructions on each turn: plan, delegate the work in parallel, end the turn after it starts the work, react to each result when it arrives, check the work through background jobs, and report to the user.
- **FR-011**: Results of subagents and background jobs MUST reach the main agent and start a turn without user input, as they do outside master mode.
- **FR-012**: While background work runs, the user MUST be able to send messages to the main agent and get answers.
- **FR-013**: The status line MUST show when master mode is on.
- **FR-014**: Master mode MUST stay on when the user resumes the session.
- **FR-015**: When master mode turns off, the main agent MUST get back the tools it had before master mode turned on.
- **FR-016**: The toggle MUST refuse to turn master mode on when background work is turned off in the settings, and MUST name the setting.
- **FR-017**: Master mode MUST NOT run together with vibe mode, plan mode, or speckit-auto mode. omp MUST refuse to turn on the second mode and name the mode that is on.
- **FR-018**: Master mode MUST run together with goal mode and loop mode.
- **FR-019**: Inside zmx, master mode MUST let the main agent start a new top-level session by itself (`spawn_session`) while the mode is on. The per-turn instructions MUST send bounded work to subagents and a new feature that needs the user's steering to a spawned session with a new worktree. The spawned session MUST start with spec-kit only when the user asks for it, or for a non-trivial feature in a project that already uses spec-kit (a `.specify/` directory in the session directory or a parent). A global spec-kit command alone MUST NOT count, and fixes, investigations, and small work MUST NOT get it.
- **FR-020**: A session that a master-mode session spawns or forks MUST start without master mode, and a session spawned while master mode is on MUST carry the zmx label `cci-origin=master`, so that the editor does not move the focus to it.

### Key Entities

- **Master mode state**: on or off for one session. It is saved with the session, so a resumed session keeps it.
- **Master allowlist**: the fixed set of main-agent actions that master mode allows (FR-004, FR-005). Everything else is refused.
- **Refusal**: the tool result that the main agent gets for a refused call. It names the allowed way and has no effect on files or processes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In master mode, 0 project files change through a main-agent call to a file-change tool or a foreground command, in a test that tries each non-allowed tool once.
- **SC-002**: In master mode, a request with two independent tasks ends the main agent's first turn in less than 30 seconds after the user sends it, while the tasks continue in the background.
- **SC-003**: While background work runs, a user message gets an answer without waiting for the work to finish.
- **SC-004**: Each finished subagent or background job starts a main-agent turn within 5 seconds after it finishes, with no user input.
- **SC-005**: After the user turns master mode off, the main agent's tool set is the same as before the mode turned on.
- **SC-006**: A resumed session that was in master mode refuses a direct edit in its first turn.

## Assumptions

- omp already delivers background results to the main agent and starts a turn for them. A running background job does not make the session busy. This feature uses that behavior and adds none.
- Background work (`async.enabled`) is on by default. Master mode needs it.
- Web search, browser, desktop control, and code evaluation are work, not coordination. Master mode refuses them for the main agent, and the main agent gives them to subagents.
- Extension and MCP tools are refused for the main agent, because omp cannot know whether they change files. A later feature can add a per-tool exception if the user needs one.
- A background shell job can still change files. Master mode limits the main agent's own actions. It is not a sandbox.
- No new setting is added. The allowlist is fixed.
- The cc-ide and Intake changes that start the Master Session with the master option are out of scope. This feature only adds the option.
- Worker slot limits, heartbeats, and typed worker reports from the reference projects are out of scope. omp's existing subagent limits apply.
