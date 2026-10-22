# Research: Speckit-Auto Startup Default

All Technical Context unknowns are resolved below. Line numbers refer to the code at plan time.

## R1. Setting shape and place

- **Decision**: Register `cfgSpeckitAutoDefaultOnStartup = register({ id: "speckitAuto.defaultOnStartup", type: "enum", values: ["off", "full", "tasks"] as const, default: "off", ui: { tab: "interaction", group: "Input", label: "Speckit auto on startup", options: off / full / tasks } })` in `packages/coding-agent/src/modes/settings.ts`, next to `cfgSpeckitAutoConvergeRounds` (978).
- **Rationale**: The name follows `plan.defaultOnStartup` (`plan-mode/settings.ts:24`), which does the same job for plan mode. The values match the existing `SpeckitAutoScope` (`"full" | "tasks"`) plus `"off"`, so the value maps to the mode state without translation. The registry already merges the project layer (`.omp/config.yml`) over the global layer, so FR-002 needs no new code.
- **Alternatives considered**: `speckitAuto.default` (unclear next to plan's name). A boolean plus a second scope setting (two settings for one choice).

## R2. Bad values (FR-007)

- **Decision**: Use the registry behavior. An enum value that is not in `values` reads as the default (`"off"`), and `registry.ts:650` logs "Settings: ignoring invalid value, using the default" once per setting.
- **Rationale**: Every enum setting works this way. A visible startup warning for this one setting would be a second convention. The spec was changed to match (FR-007).
- **Alternatives considered**: A config warning in the header (new code for one setting).

## R3. What counts as a brand-new session (FR-003, FR-004, clarification A)

- **Decision**: The default applies only when **all** of these are true:
  1. The mode is off. This covers `/new` and `/delete`, where `#newSessionKeepingSpeckitAuto` (9594) already carried an on mode across.
  2. `sessionManager.buildSessionContext().messages.length === 0`. The session has no conversation.
  3. The branch has no `custom` entry of type `SPECKIT_AUTO_ENTRY`. An empty session that the operator already toggled keeps its own state.
- **Rationale**: This is the "brand-new" test that `shouldEnterPlanModeOnStartup` (702) uses, with the speckit entry in place of `mode_change`. A resumed session with a conversation fails test 2. So rule A ("a resumed session never gets the default") holds without a resume flag. `omp --continue` that finds no session and makes a fresh one gets the default, as plan mode does.
- **Alternatives considered**: Pass a `resuming` flag from `main.ts` (does not cover `/new`). Check `agent.state.messages` as model profile does (`model-controls.ts:579`). Both work, but `buildSessionContext()` is the plan-mode precedent in the same file.

## R4. Where the default applies

- **Decision**: Add `#applySpeckitAutoDefault(startupBlocker?)` to `InteractiveMode` and call it from three places:
  1. `init`, right after `#applyPlanModeDefault()` (2812).
  2. `handleNewCommand` (9573), after `#applyPlanModeDefault()`.
  3. `handleDeleteCommand` (9588), after the new session starts. Use the same session-id check as `handleNewCommand`.
- **Rationale**: These are the plan-mode default's seams. Internal resets (plan approval → execution handoff, loop resets) call `handleClearCommand` directly, so they never get the default. That is correct, because a run in progress must not turn the mode on. Clarification A names `/delete`, and plan mode does not apply its default there, so `/delete` gets one extra call.
- **Alternatives considered**: Put the call in `#reconcileModeFromSession` (6004). That also runs on session switch and resume, which breaks rule A.

## R5. Blocking modes at startup (FR-006)

- **Decision**: `#applySpeckitAutoDefault` checks `#speckitAutoBlocker()` (3830) before it turns the mode on. If a blocker is active, the method shows one status, "Speckit-auto mode stays off: <mode> mode is on.", and returns. A `--goal` objective starts after `init` (`main.ts:814`), and `startGoalAtStartup` awaits the whole first turn. So `init` gets a new option `startsGoal?: boolean` in `InteractiveModeInitOptions` (`modes/types.ts:~94`), and `main.ts` passes `startsGoal: startupGoal !== undefined`. With the option set, the method uses `"goal"` as the blocker.
- **Rationale**: The explicit mode wins. Without the option, the default would turn the mode on first, and `#enterGoalMode` would then refuse the `--goal` objective with "Turn off speckit-auto mode first". `plan.defaultOnStartup` runs earlier in `init`, so the blocker check already sees it.
- **Alternatives considered**: Make `--goal` plus a non-off default a CLI usage error, the way `--goal` plus `plan.defaultOnStartup` is (`cli/args.ts:188`). That is too harsh for a global default. Apply the default after the goal turn instead. That fails because `startGoalAtStartup` awaits the whole turn.

## R6. Missing speckit commands (FR-005)

- **Decision**: If any `speckit.<phase>` from `SPECKIT_PHASE_COMMANDS` is missing in `this.fileSlashCommands`, return with no message. Run the same check that `#turnOnSpeckitAuto` (3838) runs, before calling it.
- **Rationale**: A global default must stay quiet in projects without spec-kit. `#turnOnSpeckitAuto` warns in this case, so the default checks first.

## R7. Turning the mode on

- **Decision**: Set `this.#speckitScope = scope`, then call `#turnOnSpeckitAuto()`. If it returns false, reset the scope to `"full"`. Do not call `#adoptSpeckitTurn()`, because a brand-new session has no phase turn to adopt.
- **Rationale**: `#turnOnSpeckitAuto` already saves the state entry, updates the status line, and shows "Speckit-auto mode on. Run /speckit.specify <feature> to start." The saved entry makes a later resume of this session keep its own state (R3, test 3).
- **Known edge**: The `custom` entry is not "draft-only metadata" (`session-manager.ts:492`). If the operator quits a session with only an editor draft, clears the draft later, and quits again, the empty session file stays. A manual toggle has the same effect today. Leave it.

## R8. Setting the mode to a value from the command (FR-008, FR-009)

- **Decision**: Add a public `setSpeckitAutoMode(target: "off" | SpeckitAutoScope): boolean` to `InteractiveMode` and `InteractiveModeContext` (`modes/types.ts`). Move the body of `toggleSpeckitAutoMode` (3864) into it:
  - off → `full`/`tasks`: set the scope, then `#turnOnSpeckitAuto()` and `#adoptSpeckitTurn()`.
  - `full` → `tasks`: the current second branch, including the parked-start end.
  - `tasks` → `full`: set the scope, show "Speckit-auto mode on.", save, and update the status.
  - on → `off`: the current third branch.
  - target equals the current state: show the current state and change nothing.
  `toggleSpeckitAutoMode()` becomes `setSpeckitAutoMode(next)`, with next = off→full, full→tasks, tasks→off. The return value is true when the mode is in the target state at the end.
- **Rationale**: One code path for each change. The cycle keeps its exact behavior (FR-009). A loop of toggles would stop a run on the way from `tasks` to `full`, which is wrong.

## R9. Command arguments

- **Decision**: In `builtin-modes.ts`, add `resolveSpeckitAutoModeArg(args)`, built like `resolveCyberArg` (235):
  - no tokens → `{ kind: "cycle" }`
  - `off|full|tasks` → `{ kind: "set", value }`
  - `off|full|tasks global|project` → `{ kind: "set", value, scope }`
  - anything else → `undefined`, which shows the usage `/speckit-auto-mode [off|full|tasks] [global|project]`

  Give `/speckit-auto-mode` `allowArgs: true` and `inlineHint: "[off|full|tasks] [global|project]"`. The handler calls `ctx.setSpeckitAutoMode(value)`. It saves the value only when that call returns true. A refused turn-on (blocker or missing commands) saves nothing.
- **Rationale**: This is the `/cyber` and `/model-profile` pattern that the user named. Unlike cyber, `off` with a scope is valid, because a project `off` must be able to override a global `full`.

## R10. Saving to the project config

- **Decision**: Replace the three special-case project setters in `config/settings.ts` (`setProjectCyberMode` 1867, `setProjectReviewUsesPlan` 1878, `setProjectModelProfile` 1889) and their three `#modifiedProject*` booleans with one generic method. `setProjectValue(setting: AnySetting, value: unknown)` calls `assertWritable`, writes `this.#project` at `setting.segments`, adds the setting to `#modifiedProjectSettings: Set<AnySetting>`, bumps the generation, rebuilds, and fires the change. `#saveProjectNow` (4110) loops over the set, and on failure puts it back. Migrate the three callers in `builtin-modes.ts` (224, 259, 297) and the two tests (`settings-manager.test.ts:433`, `settings-reload-cwd.test.ts:345`).
- **Rationale**: A fourth copy of the same 8-line method and flag is the slop the repository rules warn about. One generic method removes code. The three existing uses keep the same behavior: same path, same flush, same failure restore.
- **Alternatives considered**: Add `setProjectSpeckitAutoDefault` as a fourth copy. This makes the diff smaller but leaves four copies.
- Global scope uses `cfgSpeckitAutoDefaultOnStartup.set(settings, value)`, as `persistCyberMode` does.

## R11. Non-interactive modes

- **Decision**: No change. Speckit-auto mode lives only in `InteractiveMode`. Print mode, RPC, and ACP never read the setting.
