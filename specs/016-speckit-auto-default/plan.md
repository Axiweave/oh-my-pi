# Implementation Plan: Speckit-Auto Startup Default

**Branch**: `016-speckit-auto-default` (work happens on `main`) | **Date**: 2026-10-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/016-speckit-auto-default/spec.md`

## Summary

Add the setting `speckitAuto.defaultOnStartup` (`off` | `full` | `tasks`, default `off`). It turns speckit-auto mode on in brand-new interactive sessions. The project config overrides the global config through the existing settings layers. `/speckit-auto-mode` takes an optional value and an optional `global|project` scope word, like `/cyber` and `/model-profile`, and saves the startup default. The default follows the `plan.defaultOnStartup` seams (`init`, `/new`) plus `/delete`. It never touches a resumed session. It stays quiet in projects without spec-kit, and it gives way to plan mode, goal mode, and `--goal`. One generic `Settings.setProjectValue` replaces three copied project setters.

## Technical Context

**Language/Version**: TypeScript on Bun

**Primary Dependencies**: The existing settings registry (`config/registry.ts`, `config/settings.ts`), `InteractiveMode`, and the builtin slash commands. No new dependency.

**Storage**: YAML config layers (`~/.omp/agent/config.yml`, `<cwd>/.omp/config.yml`). The session `custom` entry `speckit-auto` is unchanged.

**Testing**: `bun test` (vitest-style API) in `packages/coding-agent/test`

**Target Platform**: The omp interactive TUI on macOS and Linux

**Project Type**: CLI/TUI monorepo package (`packages/coding-agent`)

**Performance Goals**: No measurable cost. The check runs one `buildSessionContext()` and one branch scan at session start.

**Constraints**: The cycle behavior of `/speckit-auto-mode` with no arguments must not change. Resumed sessions must not change. No new config warning surface.

**Scale/Scope**: About 6 source files and 3 test files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the empty template. The gates come from the repository rules (`AGENTS.md`, project memory):

| Gate | Status |
|---|---|
| Reuse existing patterns, no second convention | Pass. The plan-mode default seams (R3, R4), the `/cyber` argument pattern (R9), and registry enum handling (R2) are reused. R10 removes three copies and adds no fourth. |
| No speculative scope | Pass. No CLI flag and no new warning surface. |
| Tests prove behavior, not wiring | Pass. New tests cover the brand-new/resumed rule, the project-over-global rule, blocker precedence, and the saved off. |
| Changelog and divergence notes | Pass. `packages/coding-agent/CHANGELOG.md` (Added) and the `UPSTREAM_DIVERGENCES.md` speckit-auto entry are in scope. |
| New config default appended to `~/.omp/agent/config.yml` | Pass. Append `defaultOnStartup: off` under the existing `speckitAuto:` block. |
| `bunx oxfmt --check` before commit | Pass. It is in quickstart section 1. |

Post-design re-check: still passes. The generic project setter (R10) is a cleanup in the mechanism this feature extends. It is not an unrelated change.

## Project Structure

### Documentation (this feature)

```text
specs/016-speckit-auto-default/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/speckit-auto-default.md
└── tasks.md             # /speckit.tasks
```

### Source Code (repository root)

```text
packages/coding-agent/src/
├── modes/
│   ├── settings.ts                 # cfgSpeckitAutoDefaultOnStartup (beside convergeRounds)
│   ├── interactive-mode.ts         # #applySpeckitAutoDefault, setSpeckitAutoMode, toggle → setter, init/new/delete calls
│   └── types.ts                    # InteractiveModeInitOptions.startsGoal, InteractiveModeContext.setSpeckitAutoMode
├── config/
│   └── settings.ts                 # setProjectValue + #modifiedProjectSettings replace 3 setters/flags
├── slash-commands/
│   └── builtin-modes.ts            # resolveSpeckitAutoModeArg, /speckit-auto-mode args; migrate 3 project-setter callers
└── main.ts                         # init({ startsGoal: startupGoal !== undefined })

packages/coding-agent/test/
├── interactive-mode-speckit-auto.test.ts   # default rule cases
├── settings-manager.test.ts                # setProjectCyberMode → setProjectValue
└── settings-reload-cwd.test.ts             # setProjectModelProfile → setProjectValue

packages/coding-agent/CHANGELOG.md
UPSTREAM_DIVERGENCES.md
~/.omp/agent/config.yml                     # speckitAuto.defaultOnStartup: off
```

**Structure Decision**: No new module. The default logic is about 20 lines in `InteractiveMode`, next to `#applyPlanModeDefault` and the other speckit-auto methods, because it needs `#turnOnSpeckitAuto`, `#speckitAutoBlocker`, and `#speckitScope`, which are private.

## Complexity Tracking

No violations.
