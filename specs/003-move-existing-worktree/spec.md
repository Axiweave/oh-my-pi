# Feature Specification: Move to an Existing Worktree

**Feature Branch**: None created. This specification does not require a branch change.

**Created**: 2026-09-24

**Status**: Draft

**Input**: User description: "I want a /move but with completion list of existing worktree; propose a good command name"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Select an Existing Worktree (Priority: P1)

A user enters `/wtmove` and selects an existing worktree without remembering or copying its full path.
The command name combines the existing worktree abbreviation with the existing session move action.

**Why this priority**: A worktree-specific list removes manual directory navigation while keeping `/wt` dedicated to worktree creation.

**Independent Test**: Use a repository with two linked worktrees, including one outside the default managed directory.
Open the list and select either destination.
Confirm that the session uses the selected worktree.

**Acceptance Scenarios**:

1. **Given** a repository with multiple existing worktrees, **When** the user enters `/wtmove`, **Then** the command lists available worktrees with branch labels and full paths.
2. **Given** a worktree outside the default managed directory, **When** the user opens the list, **Then** the list includes that worktree.
3. **Given** a partial branch label or path, **When** the user requests argument completion, **Then** the command offers matching existing worktrees.
4. **Given** a selected destination, **When** the user confirms it, **Then** the session moves to that worktree without creating a worktree or branch.
5. **Given** an open selection list, **When** the user cancels, **Then** the session and working directory remain unchanged.
6. **Given** destinations with mixed-case branch labels and paths, **When** the user filters with different letter case, **Then** completion returns every substring match.
7. **Given** an existing destination root, **When** the user supplies its absolute, relative, or home-relative path, **Then** each form moves the same session there.
8. **Given** a missing path, unrelated checkout, or worktree subdirectory, **When** the user supplies it, **Then** the command rejects it without moving the session.
9. **Given** multiple matching destinations, **When** the user enters a matching filter, **Then** the command requires explicit selection and never moves automatically.
10. **Given** command help or command discovery, **When** the user finds `/wtmove`, **Then** its description identifies an existing-worktree session move.
11. **Given** an active response, **When** the user invokes `/wtmove`, **Then** the command rejects relocation and leaves the session unchanged.
12. **Given** a session in a linked worktree, **When** the user opens `/wtmove`, **Then** the list includes the primary checkout.
13. **Given** a session in any directory, **When** the user invokes `/move` without arguments, **Then** the existing directory picker remains available.
14. **Given** an ordinary directory outside the repository, **When** the user selects it through `/move`, **Then** the same session moves there.
15. **Given** a repository with uncommitted changes, **When** the user invokes `/wt` with a new branch name, **Then** it creates a worktree.
    The same session moves there with its changes. Source cleanup still follows the existing setting.
16. **Given** unavailable worktrees or the current worktree, **When** the user opens `/wtmove`, **Then** none appears as a selectable destination.
17. **Given** a detached worktree, **When** the list appears, **Then** its entry shows a detached-state label and full path.
18. **Given** a worktree discovery failure, **When** the user invokes `/wtmove`, **Then** the command reports the failure and preserves the session directory.
19. **Given** an open worktree list, **When** the user navigates and confirms using only the keyboard, **Then** the selected destination receives the session.

### User Story 2 - Continue the Same Conversation (Priority: P1)

A user continues the active conversation in the selected worktree with the same history and session artifacts.
The command does not resume another session that already belongs to the destination.

**Why this priority**: The user needs the session preservation behavior of `/move`, not a new conversation.

**Independent Test**: Move a session with prior messages and an artifact into an existing worktree.
Confirm that the history and artifact remain available and that `/resume` from the destination finds that session.

**Acceptance Scenarios**:

1. **Given** an active session with history and artifacts, **When** the move succeeds, **Then** the same session retains all history and artifacts.
2. **Given** a completed move, **When** the user opens `/resume` from the destination, **Then** the moved session appears there.
3. **Given** uncommitted changes in either checkout, **When** the move succeeds, **Then** both checkouts retain their files, changes, and branches.
4. **Given** another saved session at the destination, **When** the user moves there, **Then** the command neither replaces nor resumes that other session.
5. **Given** a relocation failure, **When** the command returns, **Then** the session history remains available and the command reports failure rather than success.
6. **Given** a successful relocation, **When** the command returns, **Then** its confirmation identifies the destination.

### Edge Cases

- Outside a Git repository, the command explains that worktree selection requires a repository and leaves the session unchanged.
- With no other available worktree, the command reports that there are no destinations and creates nothing.
- The current worktree is not offered as a destination. An explicit current-worktree path produces an unchanged-session notice.
- Missing worktree directories are not selectable. A destination that disappears before confirmation produces an error without losing session history.
- Detached worktrees show a detached-state label and their full path.
- Paths with spaces remain selectable and usable as explicit destinations.
- Ambiguous branch or path matches require explicit selection. The command never chooses the first match silently.
- During an active response, the command rejects the move and asks the user to finish or abort the response.
- A failed move preserves the active session history and reports the failure without reporting success.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Omp MUST provide `/wtmove` to move the active session into an existing worktree.
- **FR-002**: With no argument, `/wtmove` MUST offer a keyboard-accessible worktree selection list that supports cancellation.
- **FR-003**: The list MUST include existing worktrees of the current repository, including its primary checkout and worktrees outside omp-managed directories.
- **FR-004**: The list MUST exclude the current worktree and unavailable directories.
- **FR-005**: Each destination MUST show its full path and branch label, or a detached-state label when no branch applies.
- **FR-006**: Argument completion MUST filter destinations by case-insensitive branch-label or path substring matches.
- **FR-007**: `/wtmove <path>` MUST accept an existing worktree path from the current repository, including absolute, relative, and home-relative paths.
- **FR-008**: Explicit paths MUST identify a worktree root. Invalid or unrelated destinations MUST produce an error without moving the session.
- **FR-009**: A successful move MUST preserve the active session identity, history, and artifacts, with the same destination resume behavior as `/move`.
- **FR-010**: The command MUST NOT create, delete, clean, merge, or change a worktree or branch, or copy checkout changes.
- **FR-011**: Cancellation, unavailable destinations, discovery failures, and active responses MUST leave the session in its original directory.
- **FR-012**: A failed relocation MUST preserve session history and report the failure. A successful relocation MUST identify the destination.
- **FR-013**: Existing `/move` directory selection and `/wt` worktree creation behavior MUST remain unchanged.
- **FR-014**: Help and command discovery MUST describe `/wtmove` as moving the current session to an existing worktree.
- **FR-015**: Selecting an ambiguous match MUST require the user to choose a specific destination.

### Key Entities *(include if feature involves data)*

- **Active session**: The current conversation, its identity, history, artifacts, and working directory.
- **Worktree destination**: An existing checkout of the current repository, identified by its full path and branch or detached state.
- **Worktree selection**: The available destinations and the user's current filter or confirmed destination.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can move to an existing worktree through one command and one selection without copying a path.
- **SC-002**: In a repository with 20 locally available worktrees, the initial list and each filter update appear within one second.
- **SC-003**: Every available destination in the current repository appears, regardless of whether omp created it or where it resides.
- **SC-004**: Successful moves preserve 100% of prior session messages and artifacts and allow the same session to resume from the destination.
- **SC-005**: All cancellation and pre-move rejection scenarios preserve the original session directory and history.
- **SC-006**: All move scenarios leave checkout contents, uncommitted changes, and branches unchanged.
- **SC-007**: A user can identify the correct destination from its displayed branch or detached state and full path without inspecting directories separately.

## Assumptions

- The command targets the interactive omp session and depends on the existing session move behavior.
- Existing worktrees means worktrees registered with the current repository, not every repository on the machine.
- The primary checkout is a valid destination when the session currently uses another worktree.
- Completion selects a worktree path. Branch labels help users find paths but do not request branch changes.
- `/wtmove` avoids changing the meaning of `/wt` and avoids the existing `/switch` model command.
- No new configuration setting, alias, automatic branch creation, or cross-repository worktree discovery is required.
