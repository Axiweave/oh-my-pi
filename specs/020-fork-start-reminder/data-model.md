# Data Model: Fork Start Reminder

## Fork facts

Persist an existing non-context `custom` entry with `customType: "fork-start"` during an eligible CLI fork.

| Field | Type | Meaning |
| --- | --- | --- |
| `sessionId` | string | Session ID that may send the reminder for this marker |
| `unfinished` | boolean | The copied active branch has an unfinished conversational tail |
| `sharedCwd` | boolean | The target directory matches the source's recorded directory |

The marker's entry ID identifies the marker. Its parent ID and timestamp give ordering. No new storage format or session version is required.

Only `main.ts:createSessionManager` opts into recording these facts through a `forkFrom` option. Internal task forks and transfer forks retain current behavior.

Capture `unfinished` before repair adds tool results or an abort message. Inspect the active branch, not sibling branches.

Classify unanswered requests, outstanding tool calls, and tool results awaiting a reply as unfinished. Empty history and completed replies are not unfinished. Preserve existing handling of aborted or failed turns whose tool results close the turn. Ignore display notices and metadata when identifying the conversational tail.

A source can still run after its snapshot. These facts describe the snapshot, not source-process liveness.

## Reminder message

Use the existing `custom_message` entry format.

| Field | Value |
| --- | --- |
| `customType` | `fork-start-reminder` |
| `content` | Rendered system-reminder text |
| `display` | `false` |
| `attribution` | `agent` |
| `details.markerId` | Entry ID of the `fork-start` marker this reminder answers |

Insert this message through the normal prompt persistence path, after recovery and before the first accepted model-bound prompt.

The marker ID ties a reminder to one fork event. Full reminder text stays available in model history and text dumps. The TUI shows a fixed notice only for a reminder whose `details.markerId` equals the newest `fork-start` marker on the viewed branch. Inherited reminders name an older marker, so they stay model-visible and show nothing.

## Lifecycle

| State | Condition | Transition |
| --- | --- | --- |
| Ineligible | The branch has no `fork-start` marker, or the newest marker's `sessionId` is not the current session ID | No insertion |
| Pending | The newest marker is owned by the current session ID, and no stored reminder names its entry ID | The first accepted model-bound prompt inserts the reminder |
| Recorded | A stored reminder names the newest marker | Later prompts insert nothing |

Derive the state from saved entries each time a prompt is assembled. Do not keep a cached flag in memory. Then no session-switch path (new, resume, branch, tree move, reload) can leave a stale state. Look up the reminder in stored entries, not in the active model context, so that compaction cannot reset the state.

Find the newest marker with a backward walk from the leaf along the branch. Stop at the first `fork-start` marker. This walk is bounded by the branch length and runs once per accepted prompt. The existing submission admission path serializes first-prompt work.

A rejected command, a canceled preflight, or a local slash command leaves the marker pending. A provider failure after the message is saved keeps the reminder for the retry. A resume before the first request keeps the pending state. A resume after it must not add a second reminder.

A new fork gets a new marker owned by its own session ID. An in-place fork or an internal fork gets a new session ID, so an inherited marker is not owned there and enables nothing.

### Session file continuation

`SessionManager.#moveOffSessionFile` (`session-manager.ts:1279-1304`) continues the same conversation under a new session ID. It has three reasons (`session-manager.ts:856`): `open-elsewhere` (another process holds the file, for example on resume), `replaced`, and `contested` (repeated write conflicts). When the newest marker on the branch is pending and owned by the previous session ID, append a copy of that marker owned by the new session ID before the transcript is published. Copy `unfinished` and `sharedCwd` unchanged. Do not copy a marker that already has a reminder. This keeps the reminder pending across any number of continuations, and an already-sent reminder keeps its notice, because its marker stays the newest one.

## Configuration

`fork.startReminder` is a boolean with default `true`. Read the effective child setting during fork creation. If false, record no new marker.

Changing the setting does not delete existing history or alter an already-created marker. Existing reminders copied from ancestors remain historical context.

## Directory comparison

Compare normalized target cwd with the source header's recorded cwd. Use canonical paths when both directories exist to avoid a false mismatch from symlinks.

The warning describes possible shared-file changes, not a lock or isolation guarantee. A distinct worktree directory does not receive the warning. Runtime-only source directory changes may not appear in persisted history.

## Ordering and isolation invariants

- Source history remains unchanged.
- Recovery results precede the new reminder.
- The reminder precedes the new request.
- At most one reminder names each marker.
- Metadata never becomes model context.
- Local commands cannot consume a pending reminder.
- Compaction and resume cannot create another reminder for the same fork.
