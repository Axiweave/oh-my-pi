# Implementation Plan: Move to an Existing Worktree

**Branch**: `003-move-existing-worktree` | **Date**: 2026-09-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-move-existing-worktree/spec.md`

The setup script reported the feature branch name above. Planning does not create or switch a Git branch.

## Summary

Add `/wtmove` for selecting an existing worktree while retaining the active session history and artifacts.
Use native repository worktree discovery, shared destination validation, and existing protected session relocation.
Compose the picker from `SelectList`, with branch/path substring filtering and a scrollable complete result set.
Keep `/move` and `/wt` behavior unchanged.

## Technical Context

**Language/Version**: TypeScript `^7.0.2`, Bun `>=1.3.14`.

**Primary Dependencies**: Existing `@oh-my-pi/pi-natives/vcs`, `@oh-my-pi/pi-tui`, and Node-compatible filesystem/path modules. No new dependencies.

**Storage**: Existing session files and artifact directories. Destination lists are transient. No schema migration.

**Testing**: Bun test runner, real temporary Git repositories, existing session move tests, and actual TUI smoke validation.

**Target Platform**: The existing omp terminal platforms. Host validation uses macOS arm64. Avoid platform-specific path assumptions.

**Project Type**: TypeScript monorepo with an interactive CLI and shared TUI package.

**Performance Goals**: Initial list and filter updates within one second for 20 available local worktrees.

**Constraints**: Preserve session identity/history/artifacts. Never mutate checkout contents or branches. Reject invalid roots and active-response moves.

**Scale/Scope**: Worktrees of the current repository only, including the primary checkout and destinations outside managed storage.

## Constitution Check

The constitution contains unfilled template placeholders, not adopted principles. Do not invent governance requirements.

| Gate | Before research | After design |
|---|---|---|
| Preserve specified session and checkout invariants | Pass | Pass: use the protected relocation operation |
| Reuse existing modules and dependencies | Pass | Pass: native VCS, SelectList, and session move helpers |
| Avoid changes to existing command semantics | Pass | Pass: dedicated handler and picker |
| Validate observable behavior rather than forwarding details | Pass | Pass: real repository cases and TUI smoke guide |
| Resolve technical unknowns before implementation | Pass | Pass: decisions recorded in research.md |

These are repository engineering checks, not additional constitutional rules.
No gate violation requires an exception.

## Project Structure

### Documentation (this feature)

```text
specs/003-move-existing-worktree/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── wtmove.md
└── checklists/
    └── requirements.md
```

`tasks.md` belongs to the next phase and is not created by this plan.

### Source Code (repository root)

```text
packages/coding-agent/src/
├── session/session-worktree.ts
├── slash-commands/builtin-lifecycle.ts
├── slash-commands/builtin-registry.ts
├── slash-commands/builtin-completions.ts
└── modes/
    ├── types.ts
    ├── interactive-mode.ts
    └── controllers/command-controller.ts
packages/tui/src/
├── components/select-list.ts          # reuse without semantic changes
└── overlays/worktree-selector.ts      # proposed small picker
packages/coding-agent/test/
├── sdk-move-cwd.test.ts
├── git-linked-worktree.test.ts
└── acp-builtins.test.ts
```

**Structure Decision**: Extend the existing worktree module and built-in command flow.
Add one domain-specific picker rather than changing the directory picker or introducing a service layer.
Export the picker through the existing TUI overlay convention when implementation begins.
Update the existing command documentation and package changelog with the final user-visible behavior.

## Phase 0: Research Results

See [research.md](research.md) for decisions, alternatives, and source evidence.

- Native discovery returns registered roots, branch refs, and detached state.
- Canonical root paths identify destinations. Branch labels are display and filter fields only.
- `MoveOverlay` is not a direct fit because its directory semantics and result cap conflict with the contract.
- `SelectList` supports custom filtering, scrolling, empty states, and selected-item activation.
- The existing protected relocation helper owns session persistence, rollback, and cwd resource refresh.
- The feature remains interactive. Headless invocation reports unsupported use without mutation.

## Phase 1: Design

### Discovery and validation

Extend `session-worktree.ts` with small functions for destination discovery, matching, and exact-root validation.
Resolve the current checkout from the live session cwd, not the primary checkout or startup cwd.
Canonicalize available roots, deduplicate by canonical path, and exclude the current checkout from suggestions.
Keep primary-checkout discovery through the native worktree list.
Strip `refs/heads/` for display and label detached entries explicitly.

Resolve explicit paths using the existing `/move` path-expansion and quote handling conventions.
Reject missing, unrelated, or nested paths. Treat a current-checkout path as a no-op notice.
Revalidate the selected path against fresh repository membership and directory availability before relocation.
A revalidation race must still flow into normal relocation error handling.

### Picker and completion

Discover once before opening the picker. Display a loading indication during discovery and report discovery errors separately from empty results.
Pass the complete destination list to a small `SelectList` overlay with `search: "always"`.
Use its custom `filterItems` option to share case-insensitive substring matching with argument completion.
Return only an explicitly confirmed destination path. Escape returns cancellation.
Use branch labels and wrapped full-path details so ambiguous destinations remain distinguishable.
A visible-row limit must not limit the underlying results or keyboard reachability.

Register argument completion using the live runtime session cwd.
Completion values must remain usable with spaces and quote handling. Do not insert branch names as commands.
Recheck the repository after session moves rather than retaining a startup-scoped list.

### Command and session integration

Register the lifecycle command, context method, interactive forwarding method, and controller handler.
Retain the existing interactive transition guards and streaming rejection.
After selection, enter `#withSessionMove`, revalidate, and invoke `#relocateSession`.
Report success only after that helper succeeds.
Do not call the unrestricted `/move` handler because its missing-directory path can create a directory.
Do not call worktree creation, source cleanup, or branch mutation helpers.

### Verification design

Extend behavioral tests only where they cover new invariants or uncertain boundaries.
Use generated temporary paths or small deterministic case sets rather than copied implementation assertions.
Prioritize root membership, nested-cwd exclusion, symlink equivalence, detached entries, and case-insensitive filtering.
Cover stale selections, cancellation, active responses, history conservation, and unchanged checkout contents.
Retain existing `/move` and `/wt` behavior checks. Add no source-text, description-wording, or forwarding-only tests.

Existing focused test commands:

```bash
bun test packages/coding-agent/test/sdk-move-cwd.test.ts packages/coding-agent/test/git-linked-worktree.test.ts packages/coding-agent/test/acp-builtins.test.ts
bun run --cwd packages/coding-agent check:types
```

Add the new picker and worktree-validation test files to the focused command after implementation creates them.
The existing ACP tests establish compatibility, not a new headless `/wtmove` feature.
Follow [quickstart.md](quickstart.md) for actual TUI evidence and the 20-worktree performance check.

## Design Artifacts

- [Research decisions](research.md)
- [Data model and invariants](data-model.md)
- [User command contract](contracts/wtmove.md)
- [End-to-end validation guide](quickstart.md)

## Complexity Tracking

No exceptions. No new dependency, setting, cache, service abstraction, or session schema.

## Planning Validation

The source CLI launch returned `omp/18.3.0`.
A read-only native worktree query returned the primary checkout and its branch ref.
These checks validate the proposed integration dependencies, not an implemented `/wtmove` command.
Feature tests, TUI scenarios, and performance checks remain implementation-phase validation requirements.
