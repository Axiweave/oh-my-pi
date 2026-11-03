# Implementation Plan: Fork Start Reminder

**Branch**: `main` (actual Git branch) | **Date**: 2026-11-02 | **Spec**: [spec.md](spec.md)

**Feature directory**: `specs/020-fork-start-reminder`

The setup script reported `020-fork-start-reminder` as its feature identifier. No branch hook exists, and this workflow did not create a branch.

## Summary

Add `fork.startReminder`, default `true`. Eligible CLI forks record non-context fork facts. Their first accepted model-bound prompt inserts one persistent hidden reminder.

The reminder makes the new request authoritative over unfinished copied work. It preserves explicit requests to continue that work. The TUI shows one fixed muted notice without exposing the prompt text.

The reminder must follow startup tool recovery. Later requests retain the saved reminder as history rather than inserting it again.

## Technical Context

**Language/Version**: TypeScript, workspace TypeScript catalog `^7.0.2`, Bun `>=1.4.4`.

**Primary Dependencies**: Existing coding-agent, agent-core, TUI, setting registry, and prompt renderer. No new packages.

**Storage**: Existing session JSONL custom metadata and custom-message entries. No new session format version.

**Testing**: Existing Bun tests, a source CLI smoke run, TUI observation, and ten real-model trials.

**Target Platform**: Existing OMP CLI platforms. The primary workflow uses the IDE action and zmx on macOS.

**Project Type**: Terminal coding assistant in a TypeScript monorepo.

**Performance Goals**: No additional model call, confirmation, or source-session synchronization. Derive fork state each time a prompt is assembled: one backward branch walk that stops at the newest fork marker, plus one scan of stored entries for a reminder that names it. Both scans grow with history length and run once per accepted prompt. Keep no cached state.

**Constraints**: Preserve tool-call/result ordering, source isolation, resume behavior, and fork-of-fork identity. Keep full reminder text hidden in chat.

**Scale/Scope**: One marker and one reminder per eligible fork. No changes to the terminal packet grammar or internal subagent fork policy.

## Constitution Check

The constitution file contains unfilled template fields, not adopted project principles. Do not treat its examples as requirements.

| Gate | Before research | After design |
| --- | --- | --- |
| Reuse existing session storage and configuration | Pass | Pass |
| Avoid new dependencies and speculative interfaces | Pass | Pass |
| Keep source history unchanged | Pass | Pass |
| Validate behavior through public session flows | Pass | Pass |
| Preserve recovery before model-facing insertion | Requires research | Pass: first-prompt insertion follows recovery |
| Update user documentation and local config with implementation | Planned | Planned |

There are no unresolved design gates. Runtime validation remains work for implementation, not evidence claimed by this plan.

## Project Structure

### Documentation for this feature

```text
specs/020-fork-start-reminder/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/fork-reminder.md
└── checklists/requirements.md
```

`tasks.md` belongs to the next phase and is not created here.

### Source changes

| Path | Planned change |
| --- | --- |
| `packages/coding-agent/src/tools/settings.ts` | Register `cfgForkStartReminder` as `fork.startReminder`, default true |
| `packages/coding-agent/src/main.ts` | Pass the effective setting into both CLI fork resolution paths |
| `packages/coding-agent/src/session/session-manager.ts` | Record owned fork facts before the new session is saved |
| `packages/coding-agent/src/session/fork-start-reminder.ts` | New small module for marker lookup, snapshot facts, and reminder creation |
| `packages/coding-agent/src/session/agent-session.ts` | Insert the reminder through first-prompt assembly and normal persistence |
| `packages/coding-agent/src/prompts/system/fork-start-reminder.md` | New prompt template for confirmed reminder meaning |
| `packages/coding-agent/src/modes/utils/ui-helpers.ts` | Render only a fixed notice for this hidden custom type |
| `packages/coding-agent/src/session/exit-diagnostics.ts` | Reuse or narrowly extract conversational-tail classification if needed |

No launcher-specific behavior change is needed. Existing terminal and sibling launchers converge on `--fork`.

### Validation and documentation changes

Extend `packages/coding-agent/test/session/session-manager-fork.test.ts` for snapshot and isolation properties. Cover prompt lifecycle with a focused test beside existing agent-session tests. Extend `packages/coding-agent/test/modes/utils/render-initial-messages.test.ts` for notice visibility and replay.

Update `docs/settings.md`, the existing session operations guide, `packages/coding-agent/CHANGELOG.md`, and `UPSTREAM_DIVERGENCES.md` during implementation. Append the default to `~/.omp/agent/config.yml` without replacing unrelated settings. This planning phase changes no runtime configuration.

## Phase 0: Research Results

See [research.md](research.md).

1. CLI fork creation is the shared eligible entry point.
2. Hidden custom messages remain model context on later requests.
3. Fork-time tool repair does not cover all process-exit recovery.
4. Non-context metadata must precede first-request reminder insertion.
5. The fixed notice can reuse transcript rendering without exposing full text.
6. Directory facts come from persisted source state, not guaranteed live process state.

## Phase 1: Design

See [data-model.md](data-model.md) and [contracts/fork-reminder.md](contracts/fork-reminder.md).

### Creation and recovery

Add an opt-in `forkFrom` option used only by `main.ts:createSessionManager`. Leave its default disabled for other callers.

Compute snapshot facts from the active copied branch before repair. Record a non-context marker owned by the new session ID. Do not append a model-facing reminder in `forkFrom`.

When `SessionManager.#moveOffSessionFile` continues a conversation under a new session ID, copy a pending newest marker to the new owner. See [data-model.md](data-model.md#session-file-continuation).

Preserve both SDK recovery passes. They can append tool results and an abort record after the fork file already exists.

### First prompt

Use `AgentSession.#promptWithMessage` when it assembles messages around the incoming prompt. Both ordinary prompts and custom start prompts reach this method.

Push the reminder directly before the initiating message, after `xdevMountNoticeIndex` is computed. Then a later xdev notice splice goes before the reminder, and the reminder stays directly before the request. Preparation may still fail, so the push must not mark the reminder as recorded.

Derive the pending state from saved entries each time `#promptWithMessage` assembles messages. Do not cache it. The pending marker is the newest `fork-start` marker on the branch when its owner is the current session ID and no stored reminder names its entry ID. A reminder names its marker through `details.markerId`. Existing admission serialization prevents two accepted first prompts from creating two reminders.

The agent loop emits `message_start` and `message_end` for each prompt input message (`packages/agent/src/agent-loop.ts:1148-1152`). `AgentSession` saves custom messages at `message_end` (`agent-session.ts:4697-4711`). So the normal persistence path records the reminder with no extra code.

Local commands and rejected preparations do not consume the marker. Provider retries reuse saved history. Compaction must not reset insertion state.

### Display

Add a custom-type case before the ordinary `message.display` guard in `UiHelpers.addMessageToChat`. Render fixed notice text only when `details.markerId` equals the newest `fork-start` marker on the viewed branch. Do not use the ordinary custom-message renderer for the reminder content.

The live event path needs no change. `EventController.#handleMessageStart` sends custom messages to `addMessageToChat` (`event-controller.ts:1279-1281`), and replay uses the same method. Keep the existing live-event signature deduplication. Validate both paths.

### Validation

The primary invariants are source isolation, one insertion per fork marker, and recovery-before-reminder-before-request ordering. Generate combinations of empty, completed, unanswered, pending-tool, and repaired-tool histories.

Use a fixed printed seed for generated tests. Check state across resume, compaction, fork-of-fork, canceled preflight, and disabled configuration. Do not assert exact prompt wording or copied implementation formulas.

Exercise the actual CLI and TUI, including the IDE action during a running turn. Run ten real-model trials under the criteria in [quickstart.md](quickstart.md).

## Complexity Tracking

No justified violations are needed. Use two existing entry types and one boolean setting. Do not add a delivery service, request capture system, or general hidden-message viewer.
