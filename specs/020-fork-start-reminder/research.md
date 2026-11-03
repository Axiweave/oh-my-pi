# Research: Fork Start Reminder

## Scope and confirmed choices

The user chose a reminder for every in-scope fork, including idle forks. The user also chose a persistent hidden message.

The feature directory is independent of the Git branch. The setup script reported `020-fork-start-reminder`, but `git branch --show-current` returned `main`. This workflow does not create a branch.

## Decision: Use the existing fork launch path

**Decision:** Enable the feature through the CLI `--fork` session creation path. Do not enable it for every call to `SessionManager.forkFrom`.

**Rationale:** `main.ts:createSessionManager` resolves both session paths and session IDs through `forkFrom`. The sibling and terminal fork launchers use `--fork`. The Tern wire contract also specifies `omp --fork`.

**Evidence:**

- `packages/coding-agent/src/main.ts:1320-1344`
- `packages/coding-agent/src/modes/interactive-mode.ts:8773-8784,8842-8848`
- `packages/coding-agent/src/cli/fork-child.ts:104`
- `packages/coding-agent/src/tools/browser/tern/wire.ts:208`

**Alternatives considered:** Patching each launcher duplicates policy. Using `parentSession` alone also affects internal forks, transfers, and continuations.

## Decision: Insert once, retain as history

**Decision:** Store one hidden `fork-start-reminder` custom message for each new eligible fork. Later requests retain that entry through normal history conversion.

**Rationale:** `display: false` hides message text from chat. It does not exclude the message from model context. Persistence supports resume and request dumps without reconstructing the reminder.

**Evidence:** `packages/coding-agent/src/session/messages.ts:1216-1235` converts custom messages regardless of their display flag. `session-manager.ts:3759` stores custom messages.

**Alternatives considered:** A provider-only injection would not appear in the current `/dump` reconstruction. A fresh injection on each request would duplicate the instruction.

The setting controls creation of a new reminder. It does not delete reminders inherited from earlier forks or already saved in this fork.

## Decision: Preserve existing interrupted-tool recovery

**Decision:** Keep tool-result repair separate from reminder text. Classify the copied active branch, not the source process's current state.

**Rationale:** The source can continue after the snapshot. The child cannot know later tool outcomes or infer source liveness from the copied history.

**Evidence:** `session-manager.ts:4392-4412` repairs open tool calls for live-source forks. `exit-diagnostics.ts:289-291` describes their outcomes as unknown. Process-exit histories use a separate startup recovery path.

**Alternatives considered:** A reminder cannot repair an invalid tool-call sequence. Claiming that inherited tools never ran risks duplicate changes.

## Decision: Reuse configuration and transcript mechanisms

**Decision:** Add `fork.startReminder`, default `true`, through the existing setting registry. Use a short muted notice without exposing the full reminder text.

**Rationale:** The repository already registers boolean settings and converts hidden custom messages. No new dependency, command, protocol packet, or general hidden-message viewer is required.

**Evidence:** `packages/coding-agent/src/tools/settings.ts:887-897` shows the neighboring spawn setting. `modes/utils/ui-helpers.ts:323-397` handles custom-message display.

**Alternatives considered:** A separate notice message would add unnecessary model context. A general viewer is outside this feature.

## Decision: Validate behavior, not prompt wording

**Decision:** Test isolation, insertion count, request order, recovery, and settings. Use real-model trials to check whether the reminder redirects work.

**Rationale:** Exact prompt-string tests cannot establish that the model follows the new request. The specification requires at least nine successful trials out of ten.

**Alternatives considered:** Mock replies and source-text assertions cannot prove this behavior. They are not acceptance evidence.

## Decision: Defer insertion until the first accepted prompt

**Decision:** Record fork facts as non-context metadata in `forkFrom`. Insert the hidden reminder through `AgentSession.#promptWithMessage`.

**Rationale:** The SDK can repair a process-exit tail after fork creation. An earlier custom message could separate a tool call from its recovery result.

**Evidence:** `sdk.ts:2205-2216` and `3758-3767` perform startup recovery. `agent-session.ts:9383-9452` assembles prompt messages after startup and preflight recovery.

Construct the reminder before the initiating message. Do not consume pending state during construction because later preparation can still reject the prompt. Normal message persistence establishes the recorded state.

**Alternatives considered:** Inserting inside `forkFrom`, even after its repair step, is unsafe for the later process-exit recovery path. Provider-only injection does not satisfy persistence.

## Decision: Identify reminders by the owning fork

**Decision:** Store the owner session ID in the fork marker. Store the marker's entry ID in the reminder's `details.markerId`. Derive the pending and recorded states from saved entries when a prompt is assembled.

**Rationale:** An inherited marker is owned by an older session ID, so it cannot enable reminders in an in-place or internal fork. An inherited reminder names an older marker, so it cannot satisfy the new fork's marker or show the new fork's notice. Stored entries survive normal context compaction.

A session ID alone is not a stable owner. `SessionManager.#moveOffSessionFile` (`session-manager.ts:1279-1304`) continues the same conversation under a new session ID for three reasons: `open-elsewhere`, `replaced`, and `contested` (`session-manager.ts:856`). Copying a pending marker to the new owner in that one method keeps the reminder pending for all three. The notice depends on the marker ID, which does not change, so a sent reminder keeps its notice.

**Alternatives considered:** Searching only active model context can trigger duplicates after compaction. A cached delivered flag creates another state to synchronize across every session-switch path. Following `continuationOf` from the header covers only one hop.

## Decision: Use the existing persistence and render paths

**Decision:** Add no persistence code for the reminder and no live-render code for the notice.

**Evidence:** `emitInputMessages` in `packages/agent/src/agent-loop.ts:1148-1152` emits `message_end` for each prompt input message. `AgentSession` saves custom messages at `message_end` (`agent-session.ts:4697-4711`). `EventController.#handleMessageStart` sends custom messages to `UiHelpers.addMessageToChat` (`event-controller.ts:1279-1281`), which also renders replay.

## Directory evidence and limitations

The source header provides its recorded cwd. `moveTo` rewrites this value, but `setCwdWithoutRelocation` can change runtime cwd without updating it.

Compare recorded source cwd with target cwd. State only that the source may change shared files. Do not claim source liveness or workspace isolation.

**Evidence:** `session-manager.ts:2529-2575,3061-3075`.

## Research completion

Two independent read-only checks covered lifecycle recovery and configuration/display behavior. All design unknowns have decisions above. Runtime and model checks remain implementation acceptance work.
