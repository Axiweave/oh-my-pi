# `/wtmove` Command Contract

## Interface

```text
/wtmove
/wtmove <path>
```

The command moves the active session into an existing worktree of the current repository.
It does not create a worktree, change a branch, copy checkout changes, or resume another session.
No new configuration setting or alias is required.

## Selection and completion

- With no argument, open a keyboard-accessible selection list.
- List available registered worktree roots, including the primary checkout when it is not the current checkout.
- Include worktrees outside the omp-managed directory.
- Exclude missing directories and the current checkout, including when the session starts in its subdirectory.
- Show a branch label or detached-state label and the full destination path.
- Filter by case-insensitive substring matches in the branch label or full path.
- Completion inserts a destination path, not a branch name.
- Confirm only the destination the user selects. Filtering alone never triggers a move.
- Escape cancels and leaves the active session unchanged.
- Report an empty destination list without creating anything.

## Explicit paths

Accept absolute, relative, and home-relative paths. Resolve relative paths against the live session directory.
Support paths with spaces and the same outer-double-quote handling as `/move`.
A path must identify a registered worktree root in the current repository.
Reject unrelated repositories, ordinary directories, worktree subdirectories, and unavailable paths.
A path that resolves to the current checkout produces an unchanged-session notice.
Canonical path comparison must treat symlink aliases of the same root as one destination.
A partial filter or branch label is not a substitute for an explicit destination path when submitting the command.

## Session transition

1. Reject the command while a response is active.
2. Resolve the current repository from the live session directory.
3. Discover destinations and obtain an explicit selection or path.
4. Revalidate membership and directory availability before relocation.
5. Use the existing protected session relocation operation.
6. Report the destination only after successful relocation.

The move preserves session identity, history, and artifacts.
The moved session appears in `/resume` from the destination.
The command leaves other saved sessions untouched.

## Failure contract

Cancellation and failures before relocation preserve the original session directory and history.
Discovery failures and invalid destinations produce an actionable message, not an empty success response.
A relocation failure uses the existing rollback behavior and never reports success.
History must remain available even if relocation or rollback fails.
There is no directory-creation fallback and no source-cleanup operation.

## Compatibility

`/move` remains the general directory move command, including its no-argument directory picker.
`/wt` remains the worktree creation command and retains its existing source-cleanup setting.
The new command targets interactive sessions. Headless invocation must not open a picker or mutate the session.
Help must identify the command as an existing-worktree session move.
