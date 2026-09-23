# Research: Model Profile Picker

## Profile key entry

**Decision**: Route `app.model.cycleProfileForward` and `app.model.cycleProfileBackward` to the picker for the default `picker` style, and retain their present directional calls for `cycling`.

**Rationale**: `input-controller.ts` binds these keys to `cycleModelProfile`. The clarification names these keys, not the slash command, as the new entry point.

**Alternatives considered**: Changing `/model-profile` without arguments would break its current status response. Changing named commands would break direct selection and save scopes.

## Style configuration

**Decision**: Add `modelProfileSwitchStyle` as a two-value enum (`picker`, `cycling`) with default `picker` in the central settings schema.

**Rationale**: The schema already declares enumerated user preferences and optional settings UI choices. The style is independent of `modelProfile`, which identifies the startup bundle.

**Alternatives considered**: A separate keybinding preset would not expose the requested configuration field. Reusing `modelRoleStorage` would conflate unrelated choices.

## Searchable picker

**Decision**: Use the existing `SelectList` in a bottom-anchored overlay. Set `search: "always"`, preselect the active profile by value, and use its built-in no-match and cancellation behavior. Present configured profile names as entries.

**Rationale**: `SelectList` supports filtering, preselection, cancel, and a no-match message. `selector-controller.ts` already hosts a bottom-anchored model picker with overlay cleanup and focus restoration. No model registry search is needed for names already in configuration.

**Alternatives considered**: Reusing `ModelPickerComponent` directly would select concrete models and carry unrelated provider, role, and context behavior. A new search engine would duplicate `SelectList`.

## Applying a selection

**Decision**: Call the existing `session.applyModelProfile(name, role)` with `plan` in plan mode and `default` otherwise. Refresh the status line and editor border and show the existing unresolved-model notice.

**Rationale**: `model-controls.ts` installs the whole bundle, resolves the role, and records a profile model change when a model is available. The existing cycle and slash command use this path. A picker must not call a direct model-switch API.

**Alternatives considered**: Applying only the picked profile's concrete model would leave other model roles on the old bundle.

## Validation

**Decision**: Validate picker select/cancel/search and legacy cycling in the terminal UI with two or more configured profiles. Confirm slash status and named selection separately.

**Rationale**: These are the user-visible branches of the change. A broad suite does not prove the overlay appears or preserves focus.

**Alternatives considered**: Source-text or mock-forwarding tests would not prove the interactive contract.
