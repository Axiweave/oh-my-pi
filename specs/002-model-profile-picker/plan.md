# Implementation Plan: Model Profile Picker

**Branch**: `main` | **Date**: 2026-09-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-model-profile-picker/spec.md`

## Summary

Make both profile-cycle keys open a searchable profile picker by default. Preserve forward and backward cycling behind a `modelProfileSwitchStyle: cycling` setting. Reuse the existing profile application path, a TUI input, and a list of profiles other than the active one. Leave `/model-profile` and startup-profile persistence unchanged.

## Technical Context

**Language/Version**: TypeScript on Bun (repository uses `bun@>=1.4`)

**Primary Dependencies**: Existing `@oh-my-pi/pi-tui` overlay, `SelectList`, and settings schema

**Storage**: Existing global/project YAML configuration for the style setting. Session profile state remains in the session manager.

**Testing**: Focused Bun tests for `SelectList` profile search, selection, and cancellation plus style dispatch. Validate both key paths and the unchanged slash command in the interactive TUI.

**Target Platform**: Terminal UI on supported Bun hosts

**Project Type**: Monorepo CLI with an interactive terminal UI

**Performance Goals**: Search and activation stay responsive with 20 configured profiles. A user can switch within 15 seconds.

**Constraints**: No added dependency. Picker cancellation must leave session state unchanged. A profile applies a role bundle, not just one model.

**Scale/Scope**: One configuration field, two existing profile keys, one picker surface, and no profile storage migration.

## Constitution Check

*GATE: Pass before Phase 0 and re-check after Phase 1.*

`.specify/memory/constitution.md` contains only template placeholders, not ratified principles. The constitution gate is unconfigured and not applicable in Phase 0 or after Phase 1. The design follows the repository's settings, session, and overlay patterns.

## Project Structure

### Documentation (this feature)

```text
specs/002-model-profile-picker/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── profile-switcher.md
└── checklists/
    └── requirements.md
```

`tasks.md` belongs to the later `/speckit.tasks` phase.

### Source Code (repository root)

```text
packages/coding-agent/src/
├── config/settings-schema.ts
├── modes/controllers/input-controller.ts
├── modes/controllers/selector-controller.ts
├── session/model-controls.ts
└── slash-commands/builtin-modes.ts
packages/tui/src/
├── components/select-list.ts
└── overlays/
    ├── model-picker.ts
    └── plugin-selector.ts
```

**Structure Decision**: Add the style enum beside `modelProfile` in `settings-schema.ts`. Route the existing editor callbacks by that setting. Put picker lifecycle near other overlays in `selector-controller.ts`, with a visible `Input` and a `SelectList` for other profiles. The title shows the active profile. Empty-field Tab and Shift+Tab navigate. Partial-name Tab completes a choice or selects a sole match. Neither key moves past an exact match. Keep session profile application in `model-controls.ts`; do not duplicate it.
