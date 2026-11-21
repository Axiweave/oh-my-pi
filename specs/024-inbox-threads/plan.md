# Implementation Plan: Inbox Threads

**Branch**: `024-inbox-threads`. The work happens on `main`. | **Date**: 2026-11-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/024-inbox-threads/spec.md`

## Summary

The 023 session inbox answers a request with the target's last text when its turn ends, and the agent cannot reply itself. This feature makes the inbox work like a chat. `send` opens a two-session thread and returns its id. Both sides answer with a new `reply` op, and `progress: true` marks an "on it" note. omp sends the last answer automatically only for messages from the thread opener, and only when the receiver sent no reply without progress in that turn (clarification B). A failure or interrupt always sends a notice to the opener. All peer text is escaped, which fixes the 023 request text that was not escaped.

The design keeps both 023 delivery paths and changes only what decides which path a message takes and when an answer goes back:

| Need | Reused part (research) |
|---|---|
| Message from the opener: steer or after the turn, never closes a dialog | `promptCustomMessage` + `collab-prompt` (R3) |
| Message to the opener: job-result style, held after the user's interrupt | YieldQueue `inbox-reply` kind (R3) |
| "When did the turn that carried this message end, and how" | `RpcPromptResults` tickets, one decision for each thread (R4) |
| Escaping of peer text | `escapeHarnessTags` (R6) |
| A turn that a conversation change cut | the existing session change callback + `abortOpen` (R7). Threads stay open. |
| Master mode allowance | `ALLOWED_TOOLS` already lists `session_inbox` (R9) |

## Technical Context

**Language/Version**: TypeScript on Bun 1.4.x

**Primary Dependencies**: the workspace packages that 023 uses. No new dependency.

**Storage**: none new. Threads live in the memory of each `InboxHost` (research R1).

**Testing**: `bun test` in `packages/coding-agent/test/`, with the 023 two-host harness in `test/inbox/host.test.ts` (real IPC on temp dirs, mock model). Then `bun check`, the local build, and `omp --smoke-test`.

**Target Platform**: macOS, Linux, and Windows, the same as 023.

**Project Type**: CLI/TUI application (monorepo package).

**Performance Goals**: a reply shows in an idle peer within 1 s (SC-004). An automatic answer leaves within 2 s after the turn ends, the same as the 023 reply.

**Constraints**:
- Message text is 256 KiB at most. An automatic answer is 16 KiB at most. A frame is 2 MiB at most (023 research R10).
- Clean cutover: the wire format changes in place at `v: 1`, with no version bump and no old path (research R8).
- FR-011 (clarification B): threads belong to the session window and stay open across `/new`. A conversation change only aborts the open tickets (research R7).

**Scale/Scope**: a few to a few dozen sessions. Each one has a few to a few hundred threads for the life of its window.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template, so it sets no gates. The plan checks itself against the repo's standing rules:

| Rule | Status |
|---|---|
| Reuse before new code | PASS. Every need reuses an existing 023 part (table above). The new code is two maps and one decision function in the host, plus one tool op. |
| No backward-compatibility shims or versioning | PASS. The format changes in place at `v: 1`. The `reply` wire op, `unknown_id`, and `kind: "request"` are removed. |
| Remove means remove | PASS. The 023 per-request reply path (`#pending`, `#replyTo`, `parseReply`, `#acceptReply`) is deleted (FR-019). |
| No hashing or evidence ceremony | PASS. The thread id is a random handle. |
| Tests prove properties | PASS (planned). The tests check: one decision for each thread for each turn (a run and its tail run are one turn), nothing automatic after a reply to the opener, send order, the thread checks, and escaping for every kind. |
| Fork feature → `UPSTREAM_DIVERGENCES.md` + `CHANGELOG.md` | PLANNED. Update the 023 entries. The inbox is not released, so there is no second entry. |

**Post-design re-check:** PASS. No new class or module. `Thread` is a plain record in the host.

## Project Structure

### Documentation (this feature)

```text
specs/024-inbox-threads/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── inbox-ipc.md
│   └── session-inbox-tool.md
├── checklists/requirements.md
└── tasks.md             # /speckit.tasks
```

### Source Code (repository root)

```text
packages/coding-agent/src/
├── inbox/host.ts          # thread + ticket maps, path choice, auto/failure decision, reply(); remove the request-reply maps
├── session/
│   ├── inbox-reply.ts     # notice for messages to the opener: thread id, kind, footer, escaped
│   ├── harness-tags.ts    # unchanged; reused
│   └── agent-session.ts   # queueInboxReply takes the new notice type
├── tools/session-inbox.ts # op reply, thread/progress fields, result texts
└── prompts/
    ├── tools/session-inbox.md          # thread rules (FR-018)
    └── system/master-mode-active.md    # the child answers in the thread

packages/coding-agent/test/
├── inbox/host.test.ts       # thread behavior (quickstart §1)
├── inbox/registry.test.ts   # wrong-token send with a thread message
├── inbox/tool.test.ts       # reply validation and result texts
└── session/inbox-reply.test.ts

docs/session-inbox.md, docs/master-mode.md, packages/coding-agent/CHANGELOG.md, UPSTREAM_DIVERGENCES.md
```

**Structure Decision**: The feature changes the files that 023 created, and it adds no file. `rpc-prompt-results.ts` and `session-advisors.ts` do not change.

**Work partitions** (for `/speckit.tasks`). The two contracts fix the interface, so these parts run in parallel, each with its own files:

| Part | Files | Needs |
|---|---|---|
| (a) Docs and prompts | `prompts/tools/session-inbox.md`, `prompts/system/master-mode-active.md`, `docs/session-inbox.md`, `docs/master-mode.md`, `CHANGELOG.md`, `UPSTREAM_DIVERGENCES.md` | the tool contract only |
| (b) Core, the critical path | `inbox/host.ts`, `session/inbox-reply.ts`, the `agent-session.ts` glue | both contracts |
| (c) Tool | `tools/session-inbox.ts` | the `InboxHost` method signatures, fixed in tasks |
| (d) Tests | `test/inbox/*`, `test/session/inbox-reply.test.ts` | the FR list. The tests state the invariants first and run beside (b). |

## Complexity Tracking

No violations.
