# Quickstart: Validate the Model Profile Picker

See [profile-switcher contract](contracts/profile-switcher.md) for the key and command behavior. See [data model](data-model.md) for session and startup state.

## Prerequisites

- Install repository dependencies with `bun install` if needed.
- Have two available models and credentials for them. The picker lists configured bundles even when a model is unavailable.
- Set distinct `base`, `sol`, `sol-low`, `sonnet`, and `luna` profiles in a disposable config overlay. Keep your normal config unchanged. Use the project's config overlay mechanism (`--config` or `PI_CONFIG_FILES`) when starting the CLI.
- Check the bound forward and backward profile keys in the local keybindings configuration.

## Run

1. Start the interactive CLI with `bun run dev --config <overlay-path>` and omit `modelProfileSwitchStyle`.
2. Press either profile-switch key. Confirm that the title names the active profile and that the choices omit it.
3. With an empty field, press Tab and Shift+Tab to move through choices. Type `so` with `sol`, `sol-low`, and `sonnet` available. Press Tab and confirm that the field becomes `sol` with `sol` and `sol-low` remaining. Press Tab and Shift+Tab again and confirm that `sol` stays highlighted. Append `-` and confirm that only `sol-low` remains. Delete `-` and confirm that `sol` returns as the first highlighted choice. Type a non-match and confirm that Enter cannot change the active profile.
4. Press Escape. Run `/model-profile` and confirm that the active profile did not change.
5. Open the picker again, type `lu` with `luna` as the sole match, and press Tab to select it. Run `/model-profile` and confirm the selected name. Check that the session model follows the active role and other configured roles use the new bundle.
6. In an isolated agent config, set exactly one active profile. Confirm that the picker names it and shows no other profiles, then cancel. Confirm that the active profile stays the same.
7. Set `modelProfileSwitchStyle: cycling` in the overlay, restart, and press each profile key. Confirm forward and backward cycling and the cycle track.
8. In each style, run `/model-profile <name>`. Confirm direct selection without a picker. Check `/model-profile` without arguments for status. Save to a disposable scope only if you intend to test persistence.
9. Remove all profile definitions from an isolated agent config and restart. Press a profile key. Confirm configuration guidance appears instead of an empty picker.

## Expected result

The default key action opens the picker. The `cycling` style keeps the old key action. Picker cancellation changes nothing. Both actions install a full profile bundle. The slash command keeps its existing forms.
