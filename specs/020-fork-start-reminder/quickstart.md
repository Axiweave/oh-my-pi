# Quickstart: Validate Fork Start Reminder

This guide describes validation after implementation. These scenarios have not run as part of planning.

## Prerequisites

- Use the repository's supported Bun runtime, `>=1.4.4`.
- Install workspace dependencies and the native addon through the normal repository setup.
- Use working provider credentials for model trials.
- Use a disposable repository for tests that let either session modify files.
- Use zmx and the existing IDE integration for the primary fork action.

## Focused checks

Run the existing fork and transcript tests after adding the planned coverage:

```sh
bun test packages/coding-agent/test/session/session-manager-fork.test.ts
bun test packages/coding-agent/test/modes/utils/render-initial-messages.test.ts
bun test packages/coding-agent/test/spawn-command.test.ts
```

Run the new prompt-lifecycle test file selected during implementation. Its required properties are defined in [data-model.md](data-model.md).

Run the repository check once after the implementation is complete:

```sh
bun run check
```

## Start the actual program

From the repository root:

```sh
bun run dev
```

Use the existing session tools to identify the source session file. To test CLI entry points directly:

```sh
bun run dev --fork /absolute/path/to/source-session.jsonl
```

The path above is an input placeholder, not a supplied fixture. Use a real disposable source session.

## Primary mid-turn scenario

1. Start a bounded task in session A that requires several tool calls.
2. Trigger the IDE `fork-spawn` action while A works.
3. Confirm that A continues and B waits for input.
4. Run `/model` in B without sending a model request.
5. Send B an unrelated request without a fork preface.
6. Confirm that B handles the new request rather than continuing A's task.
7. Confirm that B shows one collapsed `Fork reminder` card, with the facts in its header.
8. Confirm that the collapsed card does not show the reminder text, and that Ctrl+O shows it.
9. Send a second request in B.
10. Confirm that B adds no second reminder or notice.

Use `/dump` to inspect the persisted reminder. The dump is not an exact capture of the final provider request. Use a temporary provider-stream capture when validating final message ordering, and remove it after the smoke run.

## Required scenario matrix

| Scenario | Expected result |
| --- | --- |
| Completed source turn | Base fork reminder, no unfinished-work claim |
| Unanswered copied request | Unfinished-work instruction accompanies the new request |
| Pending tool result in a live-source snapshot | Existing recovery pairs the call before the reminder |
| Source exited with a pending tool | Startup recovery results and abort precede the reminder |
| Source active but copied tail completed | Base reminder only, no false unfinished-work claim |
| Same recorded directory | Shared-file warning present |
| Separate worktree directory | Shared-file warning absent |
| `fork.startReminder: false` before creation | No new marker, reminder, or notice |
| Local command before first prompt | Reminder remains pending |
| Close and resume before first prompt | First accepted prompt still receives the reminder |
| Resume after first prompt | No duplicate insertion |
| Fork of a fork | One new reminder for the new marker, plus inherited history. Only the new reminder shows a notice |
| In-place fork, rewind, fresh session | No new reminder |
| Rejected preparation or missing credentials | Reminder remains pending |
| Provider failure after message persistence | Retry reuses the saved reminder |
| Compaction after insertion | No new reminder appears |
| Explicit request to continue source work | B may continue the requested work |

Test `/fork spawn`, `/fork pane`, `/fork window`, Tern, and manual `--fork` where their host integrations are available. Test `/spawn` with both `fork` and `fork_handoff` modes. Record an unavailable host integration as untested, not passed.

## Source isolation

For deterministic tests, compare the source file before and after child creation. It must remain byte-identical.

For a live source, A naturally writes new messages. Check that only A's own work changes its history. The child must add no reminder or notice to A.

## Real-model acceptance

Run ten trial forks with distinguishable source and child tasks. Use only harmless tasks in the disposable repository.

A trial passes when B answers the new request without continuing the copied task. At least nine trials must pass, as required by SC-004.

Also test an explicit continuation request separately. Verify that the reminder does not block the user's instruction to continue.

Record the model, scenario, observed result, and pass count in the implementation report. Do not substitute mocked replies for these trials.

## Completion evidence

Report only checks actually exercised. Include the notice observation, ordering result, source-isolation result, and real-model pass count. Remove temporary captures and scripts after validation.
