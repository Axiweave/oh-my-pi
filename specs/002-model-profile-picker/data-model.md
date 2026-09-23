# Data Model: Model Profile Picker

## Model profile

- **Identity**: A unique name in the configured `modelProfiles` mapping.
- **Fields**: Name and model-role selectors. Cycling and the unfiltered picker follow configured profile order. Prefix-filtered choices sort by name.
- **Relationship**: One active profile name per session when a bundle has been installed. The profile supplies all model roles, not just the visible model.
- **Validation**: A picker entry must name a configured profile other than the active one. Empty configuration opens no picker. With only the active profile configured, the picker shows no other choices.

## Profile-key style

- **Field**: `modelProfileSwitchStyle` with values `picker` and `cycling`.
- **Default**: `picker` when absent.
- **Relationship**: Changes only the action of the two profile-switch keys. It does not set the active or startup profile.
- **Validation**: The settings schema accepts only the two enum values.

## Startup profile

- **Field**: Existing `modelProfile` name, optional.
- **Relationship**: Names the profile to install at session start; global or project save scope remains under `/model-profile`.
- **Transition**: A picker selection changes the session's active profile but does not save a new startup profile.

## Session transitions

| Event | Active profile | Profile-key style | Startup profile |
|---|---|---|---|
| Open picker | Unchanged | Unchanged | Unchanged |
| Type a filter or reach no match | Unchanged | Unchanged | Unchanged |
| Cancel picker | Unchanged | Unchanged | Unchanged |
| Select a configured profile | Selected bundle installed; active role resolves through existing rules | Unchanged | Unchanged |
| Cycle with `cycling` style | Next or previous configured bundle installed | Unchanged | Unchanged |
| Save with `/model-profile name global\|project` | Selected bundle installed | Unchanged | Saved in requested scope |

When a selected profile cannot resolve an available model, its role bundle remains installed and the user sees the existing notice.
