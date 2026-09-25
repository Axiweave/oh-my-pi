# Research: Move to an Existing Worktree

## Discovery and repository scope

**Decision:** Use `vcs.git(liveCwd)` and `repository.worktrees()` from the existing native VCS package.
Normalize branch labels by removing `refs/heads/`. Retain detached state.
Validate each root with filesystem directory checks and canonical paths.

**Rationale:** This discovers registered worktrees outside omp-managed storage and includes the primary checkout.
The native API already supplies path, branch, detached state, and HEAD.
`repository.info().repoRoot` identifies the current checkout when the session starts in a subdirectory.

**Alternatives considered:** Scanning `~/.omp/wt` misses external worktrees and mixes repository scopes.
A new Git porcelain parser duplicates native functionality.

**Evidence:** `packages/coding-agent/src/session/session-worktree.ts:81-104`, `crates/pi-vcs/src/types.rs:107-132`, and `crates/pi-vcs/src/git/read.rs:446-490`.
A read-only Bun probe returned the primary checkout, `detached: false`, and branch `refs/heads/main` on this host.
This establishes the native discovery contract, not the future picker behavior.

## Picker choice

**Decision:** Compose a small worktree picker from the existing `SelectList` and overlay chrome.
Use `search: "always"` and `filterItems` for exact case-insensitive substring matching.
Use path values, branch labels, and full-path descriptions. Keep all results available through scrolling.

**Rationale:** `SelectListLayoutOptions` already supports custom filtering, empty-state messages, and custom row rendering.
The picker must select an exact result, show full paths, and expose every destination beyond the visible row limit.
Use wrapped full-path details when terminal width cannot show a path on one line.

**Alternatives considered:** Reusing `MoveOverlay` without changes is insufficient.
It uses a synchronous source, directory-specific wording, a 15-result limit, and raw-input submission semantics.
Changing it would risk altering `/move`. The generic hook selector uses a different search contract and returns labels.

**Evidence:** `packages/tui/src/overlays/move-overlay.ts:27-39,89-164` and `packages/tui/src/components/select-list.ts:26-40,83-100`.

## Shared discovery and matching

**Decision:** Add small exported discovery, filtering, and destination-validation functions to the existing `session/session-worktree.ts` module.
Reuse these functions for the picker, explicit-path validation, and argument completion.
Pass the live session directory explicitly. Do not use a captured startup directory.

**Rationale:** `/wt` already owns repository-worktree operations in this module.
One matching rule avoids different results between argument completion and the picker.
Discover once for an open picker, filter in memory, and revalidate the chosen path before relocation.
Argument completion may rediscover on request. Do not add persistent caches or filesystem watchers.

**Alternatives considered:** A new worktree service or repository abstraction adds no needed behavior.
Global directory scanning and branch-name selection create ambiguity.

**Evidence:** `packages/coding-agent/src/slash-commands/builtin-registry.ts:94-98` and `packages/coding-agent/src/slash-commands/builtin-completions.ts:229-291`.

## Session transition

**Decision:** Add a dedicated worktree-move controller handler and call the existing protected relocation helper after validation.
Keep `handleMoveCommand` unchanged. Never use its directory-creation path for `/wtmove`.
Retain response guards, pending-settings flush, the BTW move gate, rollback, cwd resource refresh, and todo reload.

**Rationale:** Both `/move` and `/wt` already converge on `#withSessionMove` and `#relocateSession`.
These functions preserve session storage and coordinate directory changes.
The new command must not clean the source, create branches, or create missing directories.

**Alternatives considered:** Calling only `process.chdir` loses session storage semantics.
Calling the unrestricted `/move` handler can create a directory after a destination disappears.
Copying the relocation logic introduces a second failure-handling path.

**Evidence:** `packages/coding-agent/src/modes/controllers/command-controller.ts:1175-1342` and `packages/coding-agent/src/session/session-manager.ts:1954-2109`.

## Routing and supported surface

**Decision:** Register `/wtmove` beside `/move` and `/wt` in the built-in lifecycle commands.
Add the context and interactive-mode forwarding method using existing command conventions.
Attach live-cwd argument completion in the built-in registry.
The interactive wrapper retains existing session-transition guards.
For headless invocation, return the existing unsupported-interactive-command result without mutation.

**Rationale:** The feature spec targets the interactive session. No new headless picker or ACP protocol is needed.

**Alternatives considered:** Extending `/wt` changes established creation semantics. `/switch` already selects models.

## Validation and runtime

**Decision:** Use Bun tests and real temporary Git repositories for root-validation and preservation invariants.
Exercise the actual TUI for selection, completion, scrolling, cancellation, and confirmation.
Reuse existing move tests and add only missing consumer-visible cases.

**Rationale:** Mocked forwarding tests cannot establish worktree identity or session preservation.
The fixture must include empty, single, multiple, detached, missing, nested-directory, and space-containing path cases.

**Evidence:** Existing tests include `packages/coding-agent/test/sdk-move-cwd.test.ts`, `git-linked-worktree.test.ts`, and `acp-builtins.test.ts`.
`package.json` defines the source CLI entry point. `packages/coding-agent/package.json` requires Bun `>=1.3.14`.
The workspace uses TypeScript `^7.0.2`.
The source CLI command `bun packages/coding-agent/src/cli.ts --version` returned `omp/18.3.0`.

## Resolution status

All technical unknowns have design decisions. No new dependency, setting, persistent model, or native API is required.
The constitution file contains template placeholders only. It provides no adopted additional gate.
