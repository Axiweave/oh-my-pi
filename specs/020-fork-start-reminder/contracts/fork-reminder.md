# Contract: Fork Start Reminder

## Configuration

```yaml
fork:
  startReminder: true
```

The default is `true`. Existing configuration precedence applies. The setting controls new forks, not deletion of existing history.

The implementation must add the setting to the central registry and document it in `docs/settings.md`. It must also append the default to `~/.omp/agent/config.yml` without replacing unrelated values.

## Entry points

Eligible starts are `omp --fork <path-or-id>` and launchers that use it:

- `/fork spawn` and the IDE `fork-spawn` action.
- `/fork pane`, `/fork window`, and its `/fork tab` alias.
- The Tern pane fork.
- `/spawn` with `fork` or `fork_handoff` mode.

The terminal action packet remains unchanged:

```text
ESC _ pi:action;fork-spawn ESC \
```

No packet fields, launch confirmation, or model turn are added. The source session continues under existing behavior.

In-place `/fork`, `/branch`, rewind, fresh sessions, internal task forks, and transfers do not create a reminder marker. Resume preserves the existing marker rather than creating one. A session file continuation (`open-elsewhere`, `replaced`, or `contested`) keeps a pending reminder pending under the new session ID.

## First request

1. Finish existing startup recovery.
2. Accept the first model-bound prompt through normal admission.
3. Insert the saved hidden reminder before that prompt.
4. Show one advisor-style `Fork reminder` card. The collapsed card is a header with the facts. Ctrl+O shows the reminder text.

Local slash commands do not consume the reminder. Automatically supplied fork-handoff start text counts as the first prompt.

A failed preflight leaves the reminder pending. A provider failure after persistence does not cause another insertion on retry.

## Reminder meaning

The reminder must establish these facts without claiming that the source process is still alive:

- This conversation is a fork of a separate session.
- Copied history supplies context, not an instruction to continue the source task.
- The new user request controls this session's work.
- An explicit request to continue copied work takes precedence over the default new-task interpretation.

If the copied tail is unfinished, the reminder must prohibit resuming or retrying that work solely because it appears unfinished. It must not claim inherited tools never ran.

If the fork uses the source's recorded directory, warn that the source may still change files there. Do not give that warning for a distinct worktree directory.

Exact prose belongs in the implementation's prompt template. Acceptance checks validate meaning and behavior, not exact wording.

## Persistence and display

Insert one reminder per fork marker. Later requests retain that entry as history, subject to normal compaction. Forking again creates a new marker and a new reminder for the new fork.

The full text remains hidden in chat. The fixed notice appears only for the reminder that names the newest fork marker on the viewed branch, at its history position, during live display and replay. Inherited reminders name an older marker and render no notice. Replay must not duplicate the notice.

Text session dumps include the persisted reminder. This contract does not make `/dump` an exact provider-request capture. HTML export retains its current hidden-message policy.

Disabling the setting creates no new reminder or notice. It does not erase notices or reminders inherited from earlier forks.

## Scope limits

This feature does not cancel source work, transfer tool ownership, lock shared files, or alter fork snapshot timing. It does not expose all hidden reminders.
