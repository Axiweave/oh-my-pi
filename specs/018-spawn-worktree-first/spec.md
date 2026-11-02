# Feature Specification: Spawn Into a Prepared Worktree

**Feature Branch**: `main`

**Created**: 2026-11-02

**Status**: Draft

**Input**: User description: "ok do A" (Context: the user ran `/spawn will do A; create a new worktree using ww for it; use speckit workflow`. The current session did not make the worktree. It spawned the new session in its own directory and told the new session, in the handoff note, to make the worktree with `ww`. The new session then works from the wrong directory, and the user must move it by hand with `/wtcd`. Option A: when a `/spawn` request names a worktree setup, the current session runs that setup first, then starts the new session in the directory that the setup made.)

## Clarifications

### Session 2026-11-02

- Q: When a `/spawn` request names a worktree tool but no branch name, how does the current session pick the branch? → A: It picks a short branch name from the request, for example `feat/deploy-llm`, with no extra prompt. A branch name in the request wins.
- Q: With the spawn confirm setting on, does the worktree tool run before or after the user approves the spawn? → A: Before. The current session asks for no extra approval. If the user declines, the worktree stays, and the current session reports its path.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The new session starts in the worktree that the request names (Priority: P1)

A user works in a session on one branch. The user runs `/spawn` with a request that does work in a new worktree and names the tool that makes it, for example "create a new worktree using ww for it". The current session runs that tool first. The new session then starts with that worktree as its directory. It does its work there with no manual move.

**Why this priority**: This is the reported failure. Without it, the new session works in the wrong checkout until the user moves it by hand.

**Independent Test**: In a repository with `ww` installed, run `/spawn create a new worktree using ww for it, then list the files`. The confirm dialog shows the new worktree path as the directory. The new session's directory is that worktree, and the user runs no move command.

**Acceptance Scenarios**:

1. **Given** a `/spawn` request that names a worktree tool, **When** the current session handles the request, **Then** it runs that tool once, before it creates the new session.
2. **Given** the worktree tool succeeded and printed the new worktree path, **When** the current session creates the new session, **Then** the new session's directory is that path.
3. **Given** the new session started in the prepared worktree, **When** it reads its opening note, **Then** the note does not tell it to make a worktree again.
4. **Given** the confirm setting is on, **When** the confirm dialog shows, **Then** its directory line shows the prepared worktree path.

---

### User Story 2 - A failed worktree setup starts no session (Priority: P1)

The worktree tool can fail: the tool is missing, the branch name already exists, or the repository refuses the operation. The user must see the reason, and no new session must start in the wrong directory.

**Why this priority**: A session that starts in the wrong checkout after a failed setup repeats the reported problem, and the user may not notice.

**Independent Test**: Run `/spawn create a new worktree using ww on branch <existing branch>`. The current session reports the tool's error in one short line. No new session starts.

**Acceptance Scenarios**:

1. **Given** the worktree tool fails, **When** the current session sees the failure, **Then** it reports the reason in one short line, starts no new session, and ends its turn.
2. **Given** the worktree tool is not installed, **When** the current session tries to run it, **Then** it reports that the tool is missing and starts no new session.

---

### User Story 3 - Requests without a named tool keep today's behavior (Priority: P2)

Some requests do not name a worktree tool. "Do it in a new worktree" uses the built-in new-worktree option, as it does today. A request with no worktree at all starts the new session in the current directory, as it does today.

**Why this priority**: The change must not alter requests that already work.

**Independent Test**: Run `/spawn in a new worktree, fix the typo in README`. The new session starts in a worktree that the built-in option made, and the current session runs no shell command first.

**Acceptance Scenarios**:

1. **Given** a request that asks for a new worktree but names no tool, **When** the current session handles it, **Then** it uses the built-in new-worktree option and runs no setup command.
2. **Given** a request with no worktree and no directory, **When** the current session handles it, **Then** the new session starts in the current directory.
3. **Given** a request that names an existing directory, **When** the current session handles it, **Then** the new session starts in that directory and no setup runs.

---

### Edge Cases

- The user declines the spawn in the confirm dialog. The worktree tool already ran, because the confirm dialog comes after it, so the worktree stays. The current session reports its path so that the user can use it or remove it. The current session does not remove it and asks for no approval before the tool runs.
- The worktree tool prints more than the path, for example progress lines. The current session uses the path of the new worktree, which the tool's own documentation names. If no path can be found, the setup counts as failed (User Story 2).
- The request names a worktree tool and also an existing directory. These conflict. The current session follows the worktree tool, because that is the explicit setup step, and makes the worktree from the current checkout.
- The request asks for setup steps beyond the worktree, such as "install dependencies" or "run the speckit workflow". Those steps are the requested work. The new session does them, not the current session.
- The request names a worktree tool but no branch. The current session picks a short branch name from the request and asks nothing. If that branch already exists, the tool fails, and User Story 2 applies.
- The worktree tool has its own usage rules, for example `ww` asks the agent to read `ww --help-agent` before the first use. The current session follows those rules when it runs the tool.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When a `/spawn` request names a worktree tool or command, the current session MUST run that tool to make the worktree before it creates the new session.
- **FR-001a**: When the request gives a branch name, the current session MUST use it. When the request gives none, the current session MUST pick a short branch name that describes the request, and MUST NOT ask the user for one.
- **FR-002**: The current session MUST start the new session with the prepared worktree path as its directory.
- **FR-003**: The current session MUST treat the worktree setup as preparation, not as the requested work. All other work in the request MUST go to the new session.
- **FR-004**: The opening note for the new session MUST NOT ask it to make the worktree again.
- **FR-005**: When the worktree setup fails, or no worktree path results, the current session MUST start no new session and MUST report the reason in one short line.
- **FR-006**: A request that asks for a new worktree without a named tool MUST keep today's behavior, the built-in new-worktree option.
- **FR-007**: A request with no worktree setup MUST keep today's behavior: the named directory, or the current directory.
- **FR-008**: The current session MUST run the worktree tool at most once for each `/spawn` request.
- **FR-009**: When the user declines the spawn after the worktree exists, the current session MUST report the worktree path and MUST NOT remove the worktree.

### Key Entities

- **Spawn request**: The text after `/spawn`. It describes the work for the new session, and it can name a directory, a model, or a worktree setup.
- **Worktree setup**: A step in the request that makes a new worktree with a named tool, for example `ww`. It produces one directory path.
- **New session**: The top-level session that `/spawn` starts. Its directory is set when it starts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a `/spawn` request that names a worktree tool, the user runs zero move commands before the new session works in the worktree. Today the user runs one.
- **SC-002**: In 3 of 3 real `/spawn … using ww` runs, the new session's directory is the worktree that the tool printed.
- **SC-003**: In 100% of runs where the worktree setup fails, no new session starts.
- **SC-004**: Requests without a named worktree tool give the same directory as before the change in 100% of checked cases.

## Assumptions

- The current session has its normal tools, including the shell, while `/spawn` runs. Today the `/spawn` window adds the spawn tool to the existing tool set and removes nothing.
- The worktree tool branches from the current checkout's commit, which is that tool's default. For the reported case, this is the current branch.
- Uncommitted changes in the current checkout follow the worktree tool's own rules. `ww` copies untracked and ignored extras but not tracked edits. The feature does not change that.
- The change needs no new spawn option. The existing directory option of the spawn tool already starts a new session in any existing directory.
- A setting that always uses an external worktree tool for the built-in new-worktree option is out of scope. Add it later if users want it without naming the tool in each request.
