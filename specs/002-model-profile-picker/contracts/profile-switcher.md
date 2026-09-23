# Profile Switcher Contract

## Configuration

- `modelProfileSwitchStyle: picker | cycling` controls the two profile-switch keys. An absent field means `picker`.
- `modelProfiles` remains the source of available bundles. `modelProfile` remains the startup bundle. No profile definition format changes.

## Profile keys

- In `picker` style, either profile-switch key opens the same searchable list of other configured profile names. The title shows the active profile with the package icon.
- A visible search field narrows the list. With an empty field, Tab and Shift+Tab cycle through choices. With a partial name, Tab completes the highlighted choice or selects a sole match. Both keys stop when the field matches that choice. Enter selects a match. Escape cancels without changing session state.
- Search matches literal name prefixes without case sensitivity. Punctuation remains significant: `sol-` matches `sol-low`, not `sol`. Filtered choices sort by name. Text edits highlight the first match again.
- Selecting a profile installs its entire role bundle for the session and activates `plan` in plan mode or `default` otherwise, using existing fallback behavior.
- In `cycling` style, the forward key advances and the backward key retreats through configured profiles. The current cycle track and feedback remain.
- With no configured profiles, show the existing configuration guidance and do not open an empty picker.
- If no configured role resolves to an available model, retain the installed bundle and show the unresolved-model notice.

## Direct command

- `/model-profile` without arguments reports the current profile and available names.
- `/model-profile <name>` installs the named bundle for the session.
- `/model-profile <name> global|project` also saves the startup profile in the requested scope.
- These command forms work under either style and do not open the picker.
