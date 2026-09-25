# Data Model: Move to an Existing Worktree

No new persistent model, database, or session format is required.

## Worktree destination

| Field | Meaning | Validation |
|---|---|---|
| `path` | Absolute canonical checkout root and selection value | Existing directory registered with the current repository |
| `branch` | Display branch name, or absent for detached state | Display only, never a branch-switch instruction |
| `label` | Branch name or detached-state label | Always present in the selection list |

The canonical path identifies a destination. Deduplicate destinations by this path.
A branch label does not identify a destination because detached worktrees have no branch label.
The destination belongs to the repository discovered from the current live session directory.
The primary checkout and linked worktrees share this relationship.

Exclude the current checkout root from selectable destinations, even when the session uses a nested directory.
Exclude unavailable directories. Revalidate a selected root before the session transition.
A symlink alias that resolves to a registered root identifies the same destination.

## Worktree selection

| Field | Meaning |
|---|---|
| Query | User-entered branch or path substring |
| Destinations | Available destinations discovered for this interaction |
| Selected path | Exact destination selected by the user, or absent |

Filtering uses a case-insensitive substring comparison against branch labels and full paths.
It does not select the first match automatically.
The list is transient. Do not add a persistent worktree cache.

## Active session

Reuse the existing session identity, history, artifact storage, working directory, and session storage location.
The command changes the working directory and relocates existing session storage through the current move operation.
It neither forks the conversation nor loads a destination session.

## State transitions

```text
Idle -> Discovering -> Selecting -> Revalidating -> Relocating -> Idle at destination
Idle -> Resolving explicit path -> Revalidating -> Relocating -> Idle at destination
Selecting -> Cancelled -> Idle at source
Discovering/Resolving/Revalidating -> Rejected -> Idle at source
Relocating -> Failed -> Existing relocation rollback and error reporting
```

An active response prevents entry into the transition.
The existing session move gate owns relocation and coordination with concurrent session activity.
The destination may disappear after discovery. Revalidation reduces this race but does not replace relocation error handling.

## Invariants

- Successful moves conserve session identity, history, and artifacts.
- Cancellation and pre-move rejection conserve session state and directory.
- Selection contains only available registered roots other than the current checkout.
- Every move leaves Git branches, tracked files, and untracked files unchanged.
- Existing destination sessions retain their identities and stored contents.
- An unavailable or ambiguous destination never causes an implicit alternate move.
