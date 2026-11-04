# Feature Specification: Spawn More Than One Session From One Request

**Feature Branch**: `main`

**Created**: 2026-11-03

**Status**: Draft

**Input**: User description: "yes allow tat; and each A, B, C might need different worktree based on how I type the command; take that into consideration" (Context: today one `/spawn <request>` starts at most one new session. The prompt asks for one spawn call, the spawn tool goes away after its first call, and a second call in the same turn fails. The user wants one `/spawn` request to start one new session for each task that it names, for example A, B, and C. Each task can need its own directory setup: a worktree that a named tool makes, the built-in new worktree, a named directory, or the current directory.)

## Clarifications

### Session 2026-11-03

- Q: When one `/spawn` request splits into two or more tasks, should omp show the task list before it makes any worktree or session? → A: Only when the confirm setting is on. Then one overview of all tasks replaces the dialogs for each task. With the setting off, no dialog shows.
- Q: When two or more tasks ask for a session that starts from a summary of this chat, does each task get its own summary or do they share one? → A: Each task gets its own summary, focused on that task.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One request starts one session for each named task (Priority: P1)

A user wants three tasks to run in parallel, each in its own top-level session. The user types one command, for example `/spawn A: fix the login bug; B: add the export button; C: update the docs`. The current session starts three new sessions, one for each task. Each new session gets only its own task in its opening message.

**Why this priority**: This is the request. Without it, the user must type `/spawn` three times and wait for each one to finish.

**Independent Test**: In a zmx session, run `/spawn three fresh sessions: A lists the files, B prints the date, C shows the git status`. Three new sessions start. Each one does only its own task. `/despawn` lists all three.

**Acceptance Scenarios**:

1. **Given** a `/spawn` request that names three tasks, **When** the current session handles it, **Then** three new sessions start, one for each task.
2. **Given** three new sessions started from one request, **When** each one reads its opening message, **Then** the message has its own task and not the tasks of the other two.
3. **Given** a request that names one task, **When** the current session handles it, **Then** exactly one new session starts, as today.
4. **Given** the request states a count, for example "try 3 approaches to the cache bug", **When** the current session handles it, **Then** it starts that number of sessions, each with a different approach in its opening message.
5. **Given** the tasks ask for different session kinds, for example "A as a fork of this chat, B fresh", **When** the sessions start, **Then** each one gets the kind that the request gives it.
6. **Given** all the new sessions started, **When** the user runs `/despawn`, **Then** each one shows as a separate entry that the user can end alone.

---

### User Story 2 - Each task gets the directory that the request gives it (Priority: P1)

A user types different directory setups for different tasks in one request. Examples:

- `/spawn A in a new ww worktree, B in a new ww worktree on branch feat/b, C here`
- `/spawn each of A, B, C in its own worktree using ww`
- `/spawn A in ~/src/other-repo, B in a new worktree`

Each new session starts in the directory that the request gives its task. A setup that the request gives to all tasks ("each in its own worktree") makes one separate worktree for each task, not one shared worktree.

**Why this priority**: Parallel sessions in one checkout change the same files. A separate worktree for each task is the main reason to start parallel sessions.

**Independent Test**: In a repository with `ww` installed, run `/spawn A and B each in its own ww worktree, C in this directory; each one lists its files`. Two new worktrees exist on two different branches. A and B start in their own worktrees. C starts in the current directory.

**Acceptance Scenarios**:

1. **Given** a request that names a worktree tool for a task, **When** the current session handles that task, **Then** it runs that tool for that task before it starts that task's session, and the session starts in the printed path.
2. **Given** a request that asks for a new worktree for a task but names no tool, **When** that task's session starts, **Then** it starts in a new worktree that the built-in option made.
3. **Given** a request that names an existing directory for a task, **When** that task's session starts, **Then** it starts in that directory, and no worktree setup runs for that task.
4. **Given** a request that gives a task no directory setup, **When** that task's session starts, **Then** it starts in the current session's directory.
5. **Given** a request that gives one worktree setup to all tasks, **When** the sessions start, **Then** each task has its own new worktree on its own branch.
6. **Given** the request names a branch for a task, **When** that task's worktree is made, **Then** it uses that branch name. **Given** no branch name, **Then** the current session picks a short name for each task, and the names are all different.
7. **Given** the confirm setting is on and the request has two or more tasks, **When** the current session has split the request, **Then** one overview dialog lists each task with its session kind, directory setup, and branch, before any worktree setup runs. **Given** the user approves, **Then** all tasks continue. **Given** the user declines, **Then** no worktree is made and no session starts.
8. **Given** the confirm setting is on and the request has one task, **When** the dialog shows, **Then** it is today's one-session dialog, after the worktree setup, with the prepared directory.
9. **Given** the confirm setting is off, **When** the request has any number of tasks, **Then** no dialog shows.

---

### User Story 3 - A failure in one task does not hide or stop the others (Priority: P2)

A worktree setup can fail for one task, for example when its branch already exists. The other tasks still start. At the end, the current session reports the result of each task.

**Why this priority**: The user must know which tasks run and which did not. A silent gap is worse than an error.

**Independent Test**: Run `/spawn A in a new ww worktree on branch <existing branch>, B in a new ww worktree on branch feat/new-b`. The setup for A fails. B starts in its worktree. The report names A with the tool's error and B with its session name.

**Acceptance Scenarios**:

1. **Given** the worktree setup for one task fails, **When** the current session handles the request, **Then** that task starts no session, and the other tasks still start.
2. **Given** the request finished, **When** the current session reports, **Then** the report has one short line for each task: the session name, or the reason it did not start.
3. **Given** a task made a worktree but its session did not start, **When** the current session reports, **Then** that task's line names the worktree path, and the worktree stays.
4. **Given** the spawn itself fails for one task after its setup worked, **When** the current session continues, **Then** the other tasks still start.

---

### Edge Cases

- The request names a worktree tool for one task and an existing directory for the same task. The tool wins, as it does today for one session.
- Two tasks name the same branch. The second worktree setup fails, because the branch already exists. User Story 3 applies to the second task.
- The request explicitly puts two tasks in the same directory, for example "A and B both in ~/src/x". Both sessions start there. The current session does not make extra worktrees that the request did not ask for.
- The request does not make clear how many tasks it has. When questions are on, the current session asks one question. When questions are off, it picks the most likely split.
- The user runs a second `/spawn` while the first one still runs. The second one is refused, as today.
- A `/spawn` typed while a turn runs joins that turn as a queued kickoff. It ends when that turn ends, also when the turn had `spawn_session` or `ask` calls before the kickoff. Only the calls after the kickoff count. The next `/spawn` is accepted, and the spawn tool is not left on for later turns. Before this change, this case left the spawn tool on, and the next `/spawn` was wrongly refused as "already running".
- A `/spawn` whose kickoff never runs, for example because the queued message was dropped when the turn stopped, ends at the next turn end. The spawn tool is then off, and the next `/spawn` is accepted. A `/spawn` whose kickoff is still on its way to the queue when a turn ends stays open, and its kickoff still gets the spawn tool.
- The current session stops in the middle of a request, for example because the user interrupts it. Sessions that already started keep running. Worktrees that already exist stay.
- A request with tasks that need setup steps beyond the worktree, such as "install dependencies". Those steps stay the work of each new session, as today.
- `/fork spawn` still opens exactly one pure fork. This feature does not change it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: One `/spawn` request MUST be able to start one new session for each task that it names.
- **FR-002**: A request that names one task MUST start exactly one new session, as today.
- **FR-003**: Each new session's opening message MUST have only its own task, written so that it can start with no other context.
- **FR-004**: Each task MUST get its own session kind (fresh, fork, fork with a handoff note, or handoff summary) from the request.
- **FR-004a**: Each task that asks for a session that starts from a summary MUST get its own summary of this chat, focused on that task. Tasks MUST NOT share one summary.
- **FR-005**: Each task MUST get its own directory setup from the request: a worktree from a named tool, a built-in new worktree, a named directory, or the current directory.
- **FR-006**: A directory setup that the request gives to all tasks MUST apply to each task separately. A "new worktree for each" setup MUST make one worktree for each task.
- **FR-007**: Worktree branch names that the current session picks MUST be different for each task in one request.
- **FR-008**: For each task that names a worktree tool, the current session MUST run that tool once for that task, before it starts that task's session.
- **FR-009**: A failed setup or a failed spawn for one task MUST NOT stop the other tasks.
- **FR-010**: After all tasks, the current session MUST report one short line for each task: its session name, or the reason it did not start. A worktree that exists for a task with no session MUST appear in that task's line and MUST stay.
- **FR-011**: With the confirm setting on, a request with two or more tasks MUST show one overview dialog before any worktree setup. The overview lists each task with its session kind, directory setup, and branch. A decline MUST make no worktree and start no session. A one-task request MUST keep today's one-session dialog. With the setting off, no dialog shows.
- **FR-012**: Each new session MUST show in `/despawn` as its own entry.
- **FR-013**: The current session MUST NOT do the tasks itself. Its only work is the worktree setups and the spawns.
- **FR-014**: A second `/spawn` while one still runs MUST stay refused.
- **FR-015**: Every `/spawn` MUST end when the turn that runs its kickoff ends, also when that turn started earlier and had `spawn_session` or `ask` calls before the kickoff. After it ends, the spawn tool MUST be off and the next `/spawn` MUST be accepted. One exception: when the last `ask` or `spawn_session` call after the kickoff is an `ask` with no answer (no result, an error result, or a "chat about this" result), the `/spawn` stays open for the user's reply turn and ends when that turn ends.

### Key Entities

- **Spawn request**: The text after `/spawn`. It names one or more tasks, and it can give each task a session kind, a directory setup, a branch, and a model.
- **Task**: One part of the request that gets one new session. It has its own opening message, session kind, and directory setup.
- **Directory setup**: How a task gets its directory: a worktree from a named tool, a built-in new worktree, a named directory, or the current directory.
- **Task result**: For each task, the session name, or the reason it did not start and the worktree path if one exists.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: To start three parallel sessions, the user types one command. Today the user types three and waits for each one.
- **SC-002**: In 3 of 3 real runs of a three-task request with one `ww` worktree for each task, each new session starts in its own worktree on its own branch.
- **SC-003**: In 3 of 3 real runs of a mixed request (one tool worktree, one built-in worktree, one current directory), each session starts in the directory that the request gave it.
- **SC-004**: In 100% of runs where one task's setup fails, the other tasks still start, and the report names the failed task and its reason.
- **SC-005**: Single-task requests give the same result as before the change in 100% of checked cases.
- **SC-006**: In 100% of checked runs where a `/spawn` joins a turn that already spawned and starts no session itself, the next `/spawn` is accepted after the turn ends.

## Assumptions

- No fixed limit on the number of tasks in one request. The user controls the count with the text. Add a limit if real requests start too many sessions by mistake.
- The tasks start one after another in the order of the request, not at the same time. Each spawn takes a few seconds, so three tasks finish well inside one turn.
- The overview for two or more tasks shows the planned setup ("new ww worktree on branch feat/b"), not a path, because it shows before any worktree exists. A yes or no for each task inside the overview is out of scope.
- The rules from the earlier worktree-first feature stay for each task: the current session follows the tool's own usage rules, does not try another tool after a failure, and never removes a worktree it made.
- `/spawn` during speckit-auto mode keeps its current behavior. The spawn turn does not change the run, also when it starts more than one session.
