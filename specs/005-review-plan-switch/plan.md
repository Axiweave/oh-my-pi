# Implementation Plan: Review Plan-Model Switch

**Branch**: `005-review-plan-switch` | **Date**: 2026-09-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-review-plan-switch/spec.md`

## Summary

A session switch makes every reference to the `reviewer` model role resolve to
the plan model of the active profile. The user can save the switch to the
global or project config. The session records the state, the same way it
records cyber mode. A bottom-bar segment shows the switch while it is on.

The live state is per session. `Settings` holds only the saved default. The
design has four parts:

1. **Session role lookup.** While the switch is active, the session resolves
   `reviewer` as `plan` (`reviewPlanLookup`). The role identity also becomes
   `plan`, so the plan retry chain applies. The lookup is used at subagent
   spawn, in main-session retry, and in eval completion fallback.
2. **Agent selection.** `resolveEffectiveAgentModelSelection` gives review
   agents `@reviewer` while the switch is active. This covers the built-in
   `reviewer` agent (frontmatter `@slow`) and saved fixed-model overrides.
3. **Tagged session entry.** `ModelChangeEntry.reviewPlan` carries the state
   through resume, `/new`, and branch navigation. Subagent sessions inherit
   the parent's value.
4. **Status segment.** A copy of the `cyber` segment that reads its own
   session's state.

## Technical Context

**Language/Version**: TypeScript on Bun, in `packages/coding-agent` and `packages/tui`.

**Primary Dependencies**: None new.

**Storage**: Layered YAML config (`reviewUsesPlan`) and session transcript
`model_change` entries (`reviewPlan`).

**Testing**: `bun test` in `packages/coding-agent/test/`. The templates are the
cyber mode tests listed in [research.md D9](./research.md#d9--what-the-tests-must-prove).

**Target Platform**: Cross-platform CLI under Bun.

**Project Type**: CLI application, monorepo packages.

**Performance Goals**: The remap copies two values per settings merge. There is no hot-path cost.

**Constraints**: No `any`, no `ReturnType<>`, no inline imports, `#private`
fields, as `AGENTS.md` requires. The new setting default goes into
`~/.omp/agent/config.yml`. Tests prove properties.

**Scale/Scope**: One role (`reviewer`), three built-in review agents, one setting.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is an unfilled template. It supplies no
gates. This plan uses the MUST rules in the repository `AGENTS.md` files.

| Gate | Source | Status |
|---|---|---|
| Reuse existing seams | `AGENTS.md` → Central Utilities | Pass. The design extends the cyber merge step, the model-change entry, and the segment registry. |
| No new dependency | `AGENTS.md` | Pass |
| Code quality rules | `AGENTS.md` → Code Quality | Pass. All new members are named and typed. |
| Prompts in `.md` | `AGENTS.md` | Pass. No prompt change. |
| Setting default in `~/.omp/agent/config.yml` | `.omp/AGENTS.md` | Pass. This is a task. |
| Tests prove properties | `~/.omp/agent/AGENTS.md` → Tests | Pass. See research D9. |
| Fork divergence recorded | `UPSTREAM_DIVERGENCES.md` convention | Pass. This is a task. |

No violations.

## Project Structure

### Documentation (this feature)

```text
specs/005-review-plan-switch/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── model-resolution.md
│   ├── settings-and-session.md
│   ├── slash-command.md
│   └── status-line-segment.md
├── checklists/requirements.md
└── tasks.md             # /speckit.tasks, not created here
```

### Source Code (repository root)

```text
packages/coding-agent/
├── src/
│   ├── config/
│   │   ├── model-settings.ts        # EDIT cfgReviewUsesPlan
│   │   ├── settings.ts              # EDIT setProjectReviewUsesPlan (saved default only)
│   │   └── model-resolver.ts        # EDIT reviewPlanRole, reviewPlanLookup,
│   │                                #      agentName + reviewPlanActive options
│   ├── task/structured-subagent.ts  # EDIT pass agentName + reviewPlanActive
│   ├── task/executor.ts             # EDIT pass parent reviewPlan to the child session
│   ├── vibe/runtime.ts              # EDIT pass agentName + reviewPlanActive
│   ├── eval/completion-bridge.ts    # EDIT session role lookup in the retry context
│   ├── session/
│   │   ├── session-entries.ts       # EDIT ModelChangeEntry.reviewPlan
│   │   ├── session-manager.ts       # EDIT appendModelChange param, getLastReviewPlan
│   │   ├── model-controls.ts        # EDIT #reviewPlan, set, restore order
│   │   ├── turn-recovery.ts         # EDIT session role lookup in the retry context
│   │   └── agent-session.ts         # EDIT accessors, host hook, /new carry-over, resume
│   ├── sdk.ts                       # EDIT reviewPlan option, initial model_change
│   ├── modes/interactive-mode.ts    # EDIT pass reviewPlanActive to the status line
│   └── slash-commands/
│       ├── builtin-modes.ts         # EDIT /review-plan
│       └── builtin-completions.ts   # EDIT scope completion
└── test/
    ├── review-plan-switch.test.ts          # NEW role view + precedence properties
    ├── review-plan-switch-session.test.ts  # NEW lifecycle
    ├── status-line-review-plan.test.ts     # NEW indicator
    └── slash-commands/review-plan.test.ts  # NEW command
packages/tui/src/
├── status-line/{segments,schema,presets,component,host}.ts  # EDIT review_plan segment
└── theme/{symbols,theme-class}.ts                           # EDIT icon.reviewPlan
docs/settings.md, docs/review-plan.md, packages/coding-agent/CHANGELOG.md,
UPSTREAM_DIVERGENCES.md                                      # EDIT/NEW docs
```

**Structure Decision**: Existing layout. No new source module. The logic is
two helpers in the model resolver and one session field.

## Complexity Tracking

Empty. No violations.

## Phase 0: Outline & Research

All unknowns are resolved in [research.md](./research.md):

| # | Unknown | Resolution |
|---|---|---|
| D1 | Where the live state lives | Per session, in `ModelControls`. `Settings` holds only the saved default. |
| D2 | Where `@reviewer` resolves to plan | Session role lookup at spawn, retry, and eval fallback |
| D3 | Which retry chain a reviewer uses | Role identity `plan`, so the plan chain |
| D4 | Fixed-model overrides and the `@slow` reviewer agent | Review-agent branch in `resolveEffectiveAgentModelSelection` |
| D5 | Recording and restore | `ModelChangeEntry.reviewPlan`. Order: recorded, inherited, config. |
| D6 | Command shape and save scope | `/review-plan`, a copy of `/cyber` |
| D7 | Indicator | `review_plan` segment, a copy of `cyber` |
| D8 | No plan model | Notice. The switch stays on but inactive. |
| D9 | Test properties | Seven properties, including two sessions on one `Settings` |

## Phase 1: Design & Contracts

- [data-model.md](./data-model.md): state, derived view, and transitions.
- [contracts/model-resolution.md](./contracts/model-resolution.md): role view and agent precedence.
- [contracts/settings-and-session.md](./contracts/settings-and-session.md): setting, Settings API, and session entry.
- [contracts/slash-command.md](./contracts/slash-command.md): `/review-plan`.
- [contracts/status-line-segment.md](./contracts/status-line-segment.md): the `review_plan` segment.
- [quickstart.md](./quickstart.md): validation scenarios.

### Post-design Constitution Re-check

Phase 1 adds no module, dependency, or unnamed type. The gates pass with the
same evidence.

## Risks

- **Role-wide remap (clarification Q2).** A custom agent that names
  `@reviewer` for non-review work also moves to the plan model. The spec
  accepts this in Edge Cases.
- **Role readers outside the session.** Only session-owned resolution follows
  the switch (research D2). A future feature that expands `@reviewer` from
  `Settings` alone would not follow it. Such code must use `reviewPlanLookup`.
