# Implementation Plan: Cyber Mode

**Branch**: `001-cyber-mode` | **Date**: 2026-09-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-cyber-mode/spec.md`

## Summary

Cyber mode is a session-scoped protection that constrains every model the session
can run to an operator-declared allowlist of models that upstream providers will
not block for security work. The operator declares the list once. When cyber mode
is on, each role's configured fallback chain is filtered to its allowlisted
entries, a role that survives empty falls back to the first allowlisted model,
every affected role is reported, the active model is re-pointed if it is outside
the list, and a status-line indicator shows the state.

The technical approach reuses three mechanisms already proven in this checkout:

1. **The merged role view.** `Settings.#rebuildMerged()` composes the effective
   `modelRoles` from the global, project, overlay, and runtime layers. Cyber mode
   overlays the filtered chains there, so role resolution honors the filter.
   Background overrides, fallback traversal, and dispatch also check installed
   membership. Config writes use raw layers, so filtering cannot change saved config.
   The overlay stores the resolved allowlist only and derives the filtered values
   inside `#rebuildMerged()`, so a role layer that is replaced later, by a model
   profile switch or a config edit, is filtered against the same allowlist rather
   than against a stale map. Startup installs the overlay before the SDK resolves
   the launch role. The CLI's earlier reads are the accepted exception described
   below. The overlay is owner-guarded: protection is scoped to the
   configuration state a session runs against, as the model profile's role layer
   already is, so a session that shares settings cannot drop another session's
   protection (FR-029, FR-030).
2. **The model-switch choke point.** `ModelControls.setModel` and
   `ModelControls.setModelTemporary` are the funnel every switch routes through.
   A guard there covers the picker, the cycle keys, `/model`, plan transitions,
   extensions, ACP, RPC, the setup wizard, prewalk, and retry fallback at once.
3. **The tagged session entry.** `ModelChangeEntry` already carries a `profile`
   tag so a resume can restore the runtime role layer. Cyber state rides the same
   entry, which is what makes a resume, `/new`, `/delete`, and a session switch
   reinstate the incoming session's state, as the spec requires.

## Technical Context

**Language/Version**: TypeScript 5.x on Bun (repo `packageManager`), in the
`packages/coding-agent` workspace package.

**Primary Dependencies**: None new. Uses existing `Settings`
(`src/config/settings.ts`), `src/config/model-resolver.ts`,
`src/config/model-roles.ts`, `ModelControls` (`src/session/model-controls.ts`),
`SessionManager` (`src/session/session-manager.ts`), and the status-line
component library.

**Storage**: Two existing stores. Configuration lives in the layered YAML files
(global `~/.omp/agent/config.yml`, project `.omp/config.yml`, config overlay).
Session state lives in the session transcript as `model_change` entries, the
same record that already persists the active model profile.

**Testing**: `bun test` with the vitest-compatible API used across this package.
Tests live in `packages/coding-agent/test/`, beside the sources they cover.
Session-level behavior follows `test/agent-session-model-profiles.test.ts`, and the
shared-`Settings` regression this design answers is
`test/sdk-nested-session-shared-settings.test.ts`, which the new shared-settings
file mirrors. Command-handler behavior follows
`test/slash-commands/model-profile.test.ts`.

**Target Platform**: Cross-platform CLI (macOS, Linux, Windows) under Bun.

**Project Type**: CLI application, single package.

**Performance Goals**: Derive role filters once per settings merge and reuse
repeated raw values within that merge. Store concrete selectors in the merged
view. Role resolution checks model identity when a smaller catalog could cause
fuzzy matching to select an excluded model. It rejects that candidate and
continues the chain. Merges happen on settings mutation and profile switches.

**Constraints**: No new dependencies. No `any`. No `ReturnType<>`. No inline or
dynamic imports. ES `#private` fields, no `private`/`protected`/`public` field
keywords. Barrel exports use `export * from "./module"`. New configurable
settings MUST also gain their default values in `~/.omp/agent/config.yml`, per
the repository rule in `AGENTS.md`. Tests MUST prove properties rather than
mirror implementation, per the same file.

**Scale/Scope**: Nine built-in roles (`default`, `smol`, `slow`, `vision`,
`plan`, `commit`, `tiny`, `task`, `advisor`) plus operator-defined custom roles.
The allowlist is a handful of model selectors. No data-volume concerns.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is an unratified template: every principle
name and description is still a `[PLACEHOLDER]`. It therefore supplies no gates.
Rather than invent principles, this plan evaluates against the rules the
repository itself declares MUST-follow in `AGENTS.md`, which the project loads
as binding context.

| Gate | Source | Status |
|---|---|---|
| Reuse central utilities instead of forking logic | `AGENTS.md` → Central Utilities | Pass — the design extends `Settings`, `ModelControls`, and the status-line registry rather than adding parallel machinery |
| No new dependency for solvable work | `AGENTS.md` → Bun Over Node, Central Utilities | Pass — no dependency added |
| No `any`, no `ReturnType<>`, no inline imports | `AGENTS.md` → Code Quality | Pass — all-new types are named and top-level |
| `#private` fields, no field access keywords | `AGENTS.md` → Code Quality | Pass |
| Prompts live in `.md` files, never built in code | `AGENTS.md` → Code Quality | Pass — the feature adds no prompt |
| Configurable settings get defaults in `~/.omp/agent/config.yml` | `.omp/AGENTS.md` → Local additions | Pass — recorded as a task, see Phase 2 handoff |
| Tests prove properties, not implementation | `AGENTS.md` → Tests | Pass — see research.md D9 |

No violations. Complexity Tracking is therefore empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-cyber-mode/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output — design decisions
├── data-model.md        # Phase 1 output — entities and state transitions
├── quickstart.md        # Phase 1 output — runnable validation guide
├── contracts/           # Phase 1 output — user-facing interface contracts
│   ├── settings.md
│   ├── slash-command.md
│   ├── session-entry.md
│   └── status-line-segment.md
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

Existing layout, single package. Paths are relative to the repository root.

```text
packages/coding-agent/
├── src/
│   ├── sdk.ts                     # EDIT protect SDK launch resolution and record cyber state
│   │                              #      on the initial model_change
│   ├── main.ts                    # EDIT install once its registry exists, after accepted early reads
│   ├── config/
│   │   ├── cyber-mode.ts          # NEW  allowlist resolution, chain filter, planner, validation
│   │   ├── settings-schema.ts     # EDIT cyberModels + cyberMode keys, "cyber" segment id
│   │   ├── settings.ts            # EDIT owner-guarded cyber overlay on the merged role view, signal
│   │   ├── model-roles.ts         # EDIT validateCyberMode (startup warnings)
│   │   └── keybindings.ts         # EDIT app.model.toggleCyber action
│   ├── session/
│   │   ├── model-controls.ts      # EDIT cyber toggle, allowlist guard on both switch methods
│   │   ├── agent-session.ts       # EDIT cyberMode accessor, setCyberMode, newSession carry-over,
│   │   │                          #      switchSession restore
│   │   ├── session-entries.ts     # EDIT ModelChangeEntry.cyber
│   │   ├── session-manager.ts     # EDIT appendModelChange signature, getLastCyberMode
│   │   └── agent-session-types.ts # EDIT CyberModeResult
│   ├── modes/
│   │   ├── theme/
│   │   │   ├── symbols.ts         # EDIT "icon.cyber" key + the three preset glyphs
│   │   │   └── theme-class.ts     # EDIT expose cyber on the icon accessor
│   │   ├── components/status-line/
│   │   │   ├── segments.ts        # EDIT cyber segment + SEGMENTS registry entry
│   │   │   ├── presets.ts         # EDIT default preset left segments
│   │   │   ├── component.ts       # EDIT renderClaudeFooter renders the cyber segment
│   │   │   └── types.ts           # EDIT SegmentContext if a non-session field is needed
│   │   └── controllers/input-controller.ts  # EDIT bind app.model.toggleCyber
│   └── slash-commands/
│       ├── builtin-modes.ts       # EDIT /cyber command
│       └── builtin-completions.ts # EDIT completion for the on/off argument (optional)
└── test/
    ├── cyber-mode-session.test.ts   # NEW session-level behavior
    ├── cyber-mode-guard.test.ts           # NEW switch-guard behavior
    └── cyber-mode-shared-settings.test.ts # NEW shared-configuration regression
```

**Structure Decision**: The single-package CLI layout is kept. The feature adds
exactly one new module (`src/config/cyber-mode.ts`) and edits existing files at
the seams the design reuses. No new directory, no new package, no new abstraction
layer. The three new test files sit in `packages/coding-agent/test/`, beside the
existing `test/agent-session-model-profiles.test.ts` they mirror and
`test/sdk-nested-session-shared-settings.test.ts` whose shape the shared-settings
file follows. No CLI surface is added: the launch flag is deliberately out of
scope, per the spec's Assumptions.

## Complexity Tracking

No constitution violations and no unjustified complexity. The two new source files
are a module that owns the filter's pure logic, and one test per behavior class.
Every other change extends a mechanism that already exists for the model profile
feature, which is the closest analogue in this codebase.

## Phase 0: Outline & Research

Unknowns carried into research, each resolved in
[research.md](./research.md):

| # | Unknown | Resolution |
|---|---|---|
| D1 | Where to apply the role filter so every surface honors it | Overlay the merged role view in `Settings.#rebuildMerged()`, with an owner guard on removal (FR-029, FR-030) |
| D2 | Where to guard operator model switches | `ModelControls.setModel` and `setModelTemporary` |
| D3 | How chain entries are matched against the allowlist | Resolve declarations and raw chains with current preferences. Keep concrete identities in filtered chains and reject fuzzy retargeting in smaller catalogs |
| D4 | What "disable" does to the active model | Leaves it in place; restores the role layer only |
| D5 | How cyber state survives resume, `/new`, and deletes | `ModelChangeEntry.cyber`, read like `profile` |
| D6 | Where the fallback report is delivered | `configWarnings` at startup, then `emitNotice("warning", …)`, with a per-transcript role/model dedup set |
| D7 | Whether the guard may throw on resume | Reinstall the filter before the model restore |
| D8 | How the allowlist entries themselves are validated | Compared against the same available-model set the picker uses |
| D9 | What the tests must prove | Property-oriented tests listed in research.md D9 |
| D10 | Where the startup overlay is installed, given role resolution precedes the session | At settings bootstrap, in `sdk.ts:1425` and `main.ts:1754`, before the SDK read of `getModelRole("default")` and the launch resolution it drives. The CLI reads roles earlier, at `main.ts:1275` and `:1321`, before the registry it needs exists, and the boundary paragraph below states those two reads as accepted and unfilterable |

## Phase 1: Design & Contracts

- [data-model.md](./data-model.md) — cyber mode state, the allowlist, the role
  chain, the fallback report, and the transition matrix across resume, `/clear`,
  `/new`, delete, fork, and session switch.
- [contracts/settings.md](./contracts/settings.md) — `cyberModels` and
  `cyberMode` schema contracts.
- [contracts/slash-command.md](./contracts/slash-command.md) — the `/cyber`
  command contract, including argument forms and refusal outputs.
- [contracts/session-entry.md](./contracts/session-entry.md) — the
  `model_change.cyber` field contract and its read rules.
- [contracts/status-line-segment.md](./contracts/status-line-segment.md) — the
  `cyber` segment contract and its placement in the default preset and the
  `claude3` footer.
- [quickstart.md](./quickstart.md) — runnable end-to-end validation scenarios.

### Post-design Constitution Re-check

The gates above are unaffected by the Phase 1 detail: the design adds one module,
extends existing seams, adds no dependency, and introduces no unnamed type. The
re-check passes with the same evidence.

## Choke Point and Integration Points

Verified by exhaustive path enumeration across `packages/coding-agent/src`.

**Choke point.** Every operator-initiated model change converges on three public
methods of `ModelControls` (`src/session/model-controls.ts`):

| Method | Line | Covers |
|---|---|---|
| `setModel(model, role, options)` | 244 | `/model`, the picker's persistent scope, extensions, RPC, ACP, the setup wizard |
| `setModelTemporary(model, thinkingLevel, options)` | 302 | `/switch`, the session-only picker, plan-mode transitions, prewalk |
| `applyRoleModel(entry, options)` | 414 | Role cycling, `/model-profile`, commit and task role binding. Calls `setModel`, so it needs no separate guard |

Both guarded methods reach `this.#host.setModelWithProviderSessionReset` (lines
265 and 317), so the guard sits above that call and refuses before any provider
session is reset. One guard therefore covers all thirteen enumerated interactive
paths: the model picker, both cycle bindings, both profile bindings, `/model`,
`/switch`, `/model-profile`, plan transitions, commit and task binding, the
extension and RPC surfaces, the session-only picker, and the setup wizard. The
launch path and session restore sit outside it by design, and the two integration
points below carry their rules.

**Internal bypasses**, all non-operator and therefore deliberately outside the
guard: `agent.setModel` called directly for local-model context refresh
(`agent-session.ts:5508`), context-window reconciliation (`11758`), and the
switch failure rollback (`10341`). Advisor overrides, recovery, and primary
restoration check installed membership before they select a model. Background
completion, tiny tasks, judgment, memory, and compaction use the same rule.

**Recovery paths.** `turn-recovery.ts` moves the session outside that choke
point: the configured fallback chain (`#tryRetryModelFallback`), the usage-aware
fallback walk (`#maybeApplyUsageAwareFallback`), the Fireworks Fast degrade, and
the restore of a fallback's primary all call `setModelWithProviderSessionReset`
directly. Each one asks the guard's rule through `cyberAllowsModel` and skips an
excluded candidate, and `applyRetryFallbackCandidate` refuses a candidate that
reaches the swap anyway. None of them throw, because a fallback that lands
outside the list is skipped rather than fatal, per FR-031.

**Integration point 0 — settings bootstrap.** The overlay MUST be installed at the
earliest point where a model catalogue exists, before the SDK resolves the launch role.
The helper takes the available-model set, because resolving the allowlist needs it.
This is an ordering requirement, verified against the sources: `modelRegistry` is
created at `sdk.ts:1383-1387`, `settings.getModelRole("default")` is read at
`sdk.ts:1565`, `resolveAllowedModels` and the launch role resolution run at
`sdk.ts:1583-1592`, and `new AgentSession` is constructed at `sdk.ts:3920`. So
install at `sdk.ts:1425`, and in the CLI at `main.ts:1754`, right after the
registry it needs exists. The initial `model_change` entry is written at
`sdk.ts:3836`, before the session exists, and MUST carry the cyber state in effect. Installing from the session
constructor would be too late: a `cyberMode: true` start with no explicit model
would resolve unfiltered.

The binding constraint is the model source, not the settings instance. `Settings`
holds configuration only, so it cannot resolve an allowlist. Because the overlay
stores the resolved allowlist and derives the filter inside `#rebuildMerged()`,
installation then needs no roles.

One boundary is accepted and stated rather than hidden: `main.ts` reads roles at
`:1275` and `:1321`, and builds a role lookup at `:1399`, before its registry
exists at `:1744`. Those reads cannot be filtered. They cannot change which model
the session runs, because the startup model is resolved later at `sdk.ts:1581`
through the filtered settings.

**Integration point 1 — launch.** `findInitialModel`
(`src/config/model-resolver.ts:2181`) picks the starting model from `--model`,
`--provider`, `--models`, the restored session, or config, before interactive
mode exists. This path MUST substitute rather than refuse, per FR-010: when the
requested launch model is outside the allowlist, the session starts on the
cyber-capable resolution for the active role and reports the substitution. A
throw here would abort the launch, which the spec forbids.

The report has a handoff, because this function runs before any session exists and
therefore cannot emit a notice. Resolution MUST return the substitution alongside
its result, and the caller MUST carry it into the post-construction startup
warnings. That channel already exists: resolution output reaches
`notifs.push({ kind: "warn", message: modelFallbackMessage })` at
`main.ts:2259`, after the session is built. The substitution rides that path
rather than inventing a second one.

**Integration point 2 — session restore.** `switchSession` restores the
persisted model through a direct `agent.setModel` call
(`agent-session.ts:10202`). This bypasses the guard, so the cyber filter MUST be
installed before the restore and the restored model MUST be re-pointed when it
falls outside the allowlist. Without this, a resume could reinstate a model the
allowlist has since dropped.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| The guard throws while a resumed session restores a persisted non-cyber model | Install the cyber filter before the restore, mirroring the model profile restore at `agent-session.ts:10170`; the restore then re-points through the filtered role layer |
| The launch model is outside the allowlist | Substitution at `findInitialModel`, never a throw, per FR-010 |
| The allowlist dropped the previously active model between sessions | Re-point on restore and report the substitution, the same path as Integration point 2 |
| A new session inherits cyber state but the allowlist was since removed | Degrade to off with a warning, the documented FR-026 behavior |
| Two live sessions share one protection because they share configuration state | Accepted and scoped: FR-029. Protection is additive under sharing |
| A nested session shares the parent's live `Settings` and would drop the parent's protection | `clearCyberRoles(owner)` is a no-op for a non-owner while installing is always allowed, per FR-030. This is the regression `test/sdk-nested-session-shared-settings.test.ts` covers for profiles |
| The retry-fallback path selects a non-cyber model after a cyber model fails | Every recovery walk asks the guard and skips an excluded entry, then continues to the next covered one, per FR-031. The swap itself refuses a candidate that reaches it, so the fallback costs the session nothing |
| Internal `agent.setModel` reconciliation calls trip the guard falsely | Those calls never route through the guard, and the ones that do pass the model already in use |
| Filtering leaks into saved config | Filtering happens in `#merged` only; every save path reads the raw `#global` and `#project` layers |
| The overlay is installed after SDK launch resolution, so a `cyberMode: true` start resolves unfiltered | Install after registry creation and before the SDK's `getModelRole("default")` read. The CLI reads roles earlier, before its registry exists. Those accepted reads do not select the final launch model |
| A model profile switch replaces the role layer and leaves a role outside the allowlist | The filter is derived from the current effective roles on every merge, not stored, so a replaced layer is re-filtered. Covered by a property test in research.md D9 |
| The fallback report floods a long session | One report per role and model per session, per FR-012 |

## Phase 2 Handoff

`/speckit.tasks` derives `tasks.md` from this plan. Two items MUST appear there
and are easy to lose:

1. Append the `cyberModels` and `cyberMode` defaults to `~/.omp/agent/config.yml`
   (repository rule in `.omp/AGENTS.md`).
2. Add a `CHANGELOG.md` entry under `packages/coding-agent`, following the
   existing model profile entries.
