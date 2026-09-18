# Phase 1 Quickstart: Cyber Mode

Runnable scenarios that prove the feature end to end. Each scenario names the
requirement or success criterion it validates. Shapes of user-facing text are not
pinned here, because the tests deliberately assert behavior rather than wording.

## Prerequisites

- Repository checkout of this fork, per `README.md → Install`.
- Bun at the version in `package.json` `packageManager` (`bun@>=1.4`).
- Two chat models available with working credentials, at least one of which is
  not on the cyber allowlist. The scenarios call them *allowed* and *excluded*.

Run the CLI from source:

```bash
bun packages/coding-agent/src/cli.ts
```

To isolate a scenario from your real configuration, launch with an isolated
profile:

```bash
bun packages/coding-agent/src/cli.ts --profile cyber-verify
```

## Automated checks

| Check | Command |
|---|---|
| Session-level behavior | `bun test packages/coding-agent/test/cyber-mode-session.test.ts` |
| Switch-guard behavior | `bun test packages/coding-agent/test/cyber-switch-guard.test.ts` |
| Pure resolution and filtering | `bun test packages/coding-agent/test/cyber-mode.test.ts` |
| Status-line segment | `bun test packages/coding-agent/test/status-line-cyber.test.ts` |
| Status line and `claude3` footer placement | `bun test packages/coding-agent/test/modes/components/status-line/component.test.ts` |
| Slash command | `bun test packages/coding-agent/test/slash-commands/cyber.test.ts` |
| Shared configuration (FR-029, FR-030) | `bun test packages/coding-agent/test/cyber-mode-shared-settings.test.ts` |
| Noninteractive startup diagnostics (T055, T056) | `bun test packages/coding-agent/test/main-cyber-warnings.test.ts` |
| Retry recovery (fallback chains, the Fast degrade, the primary restore) | `bun test packages/coding-agent/test/agent-session-retry-fallback.test.ts` |
| Project-scope `cyberMode` write (FR-027) | `bun test packages/coding-agent/test/settings-manager.test.ts` |
| Toggle key reaches the handler | `bun test packages/coding-agent/test/custom-editor-keybindings.test.ts` |
| Types | `bun run --cwd=packages/coding-agent check:types` |
| Lint and format | `bun run --cwd=packages/coding-agent check` |

These test files MUST pass with cyber mode off as well as on. The off case is the
regression guard for FR-018.

### Historical package-wide run (T034)

The following full-package results describe the earlier T034 run, not the
convergence pass.

One suite-level note for a reviewer who runs everything: the whole package suite
(`bun test` in `packages/coding-agent`) currently reports 230 failures. They fall
in environment-sensitive families: the full `Settings` describe (135 rows),
`Settings.reloadForCwd` (30 rows), the config CLI schema rows, the `AgentStorage`
SQLite rows, the LSP regression rows, the python cleanup rows, and a few single
rows elsewhere. Every one of those files passes in the grouped run above, and the
failing rows otherwise exercise code this feature does not touch.

The `Settings` cluster includes one test this feature added, the project-scope
`cyberMode` write in `settings-manager.test.ts`. It passes alone, in the settings
group, and in the 13-file run. The full run fails it with the rest of its file,
which is why the suite is reported as non-green here rather than as a set of
unrelated failures.

## Phase 14 verification (T056)

The startup diagnostic suite passed **23 tests**.
The affected-file run passed **335 tests across 25 files**, each in a separate Bun process.
No tests failed or skipped.

The configured-on ACP resume regression first failed with two task-role warnings instead of one.
The seven added regression cases now cover:

- One applicable role/model report through each of ACP load, resume, and fork.
- No temporary-session warnings when the saved profile and model already comply.
- An excluded launch flag on those saved-profile cases.
- Independent warning reports for two new sessions in one ACP process.

All cases use the real CLI protocol without sending model prompts.
The original text, JSON, RPC, ACP, and invalid-configuration cases still pass.

The 25-file run used the 21 files listed under Phase 13, plus:

```text
test/status-line-cyber.test.ts
test/acp-mcp-isolation.test.ts
test/sdk-model-selection.test.ts
test/sdk-session-isolation.test.ts
```

Three separate direct ACP CLI smokes passed.
An allowed saved profile produced no temporary-session warning.
A changed task role produced exactly one warning.
A duplicate allowlist declaration retained its configuration warning after adoption.
Each smoke completed the load request, preserved valid protocol frames, and exited successfully.
The temporary fixtures were removed.

Root `bun check` passed lint, formatting, workspace TypeScript checks, and Rust checks.
It reported the same five existing `unicorn(no-new-array)` warnings in `src/modes/composer.ts`.
This pass did not run the full package test suite.

## Phase 13 verification (T055)

The new CLI regression file passed **16 tests**. The broader check passed
**270 tests across 21 files**, each file in a separate Bun process.
No tests failed or skipped.

The new tests start real CLI children with fake credentials and no prompts.
They cover text, JSON, RPC, and ACP startup, including:

- Launch-model substitutions and changed-role warnings.
- Recorded-on resumes with configured cyber mode off.
- Empty, unresolved, duplicate, and malformed declarations.
- Duplicate-free diagnostics and silence while cyber mode is off.
- Response-only text output and valid JSON/RPC frames.

The text regression failed before the shared CLI warning consumer existed.
The ACP resume regression failed until its cyber-warning consumer preceded
saved-session adoption. Both regressions now pass.

The 21-file check used `bun test <file>` from `packages/coding-agent` for each:

```text
test/main-cyber-warnings.test.ts
test/cyber-mode.test.ts
test/cyber-mode-session.test.ts
test/cyber-mode-shared-settings.test.ts
test/cyber-switch-guard.test.ts
test/slash-commands/cyber.test.ts
test/headless-persistence-shutdown.test.ts
test/acp-lazy-startup.test.ts
test/acp-agent.test.ts
test/acp-stdout-hygiene.test.ts
test/main-cross-project-resume.test.ts
test/main-no-session-resume-picker.test.ts
test/main-session-resolution-error.test.ts
test/main-startup-watchdog.test.ts
test/main-host-classification.test.ts
test/main-resume-cancel-exit.test.ts
test/cli-max-time-flag.test.ts
test/print-mode-working-indicator.test.ts
test/print-mode-json-flush.test.ts
test/rpc-output.test.ts
test/rpc-malformed-input.test.ts
```

Root `bun check` passed TypeScript and Rust checks. Package `bun run check`
also passed lint, formatting, and types. Both reported five existing
`unicorn(no-new-array)` warnings in `src/modes/composer.ts`.

A separate source CLI `--print` smoke printed the changed-role report and the
Sonnet-to-Haiku substitution. It sent no model request and exited successfully.
Its temporary configuration and session files were removed.
This pass did not rerun the full package test suite.

## Phase 12 convergence verification (T050–T054)

All **37 test files passed in separate Bun processes: 978 passed, 13 skipped,
and 0 failed**. Every process exited with status zero.

The file set includes the 29 files listed in the T043–T049 command below, plus:

```text
test/agent-session-switch-prev-context.test.ts
test/agent-session-model-persistence.test.ts
test/agent-session-new-session-boundary.test.ts
test/session-fork-prompt-cache-key.test.ts
test/advisor-toggle.test.ts
test/agent-session-force-tool-choice.test.ts
test/sdk-model-selection.test.ts
test/sdk-session-isolation.test.ts
```

From `packages/coding-agent`, run `bun test <file>` separately for each listed file.
The package check, `bun run check`, also passed. It reported the same five
`unicorn(no-new-array)` warnings in the untouched `src/modes/composer.ts`.

Before the final two SDK regressions, the combined 37-file run reported
**798 passed, 178 failed, and 13 skipped**. Failures included
`SQLITE_IOERR_VNODE` during settings and advisor cleanup. The same 37 files then
passed separately. This pass does not establish a green combined run or a green
full-package suite.

Retained regressions cover:

- **T050:** Generated catalog subsets keep primary and launch targets within the
  declared identities. Empty and reduced scoped catalogs cannot reinstate an
  excluded SDK default through a later fallback.
- **T051:** Failed switches restore both on and off states, owner claims, and
  notice history. Foreign protection survives. Failed transitions publish no
  cyber notices.
- **T052:** Recorded-on resumes report active-model substitutions exactly once
  through startup warnings, with either configured startup state. Later
  substitutions use runtime notices without changing startup warnings.
- **T053:** Forks and side-answer branches revalidate empty, unresolved, and
  changed valid declarations. They preserve foreign protection, persist degraded
  off states, and report substitutions in the new transcript.
- **T054:** Three same-transcript reloads retain notice history. Different
  transcripts still receive their own notices.

The live source TUI resumed a recorded-on Sonnet transcript with configured
cyber mode off and a Haiku-only declaration. Startup showed the Sonnet-to-Haiku
warning once, selected Haiku, and displayed the Cyber indicator. Two `/cyber`
commands removed and restored the indicator without repeating that warning.

The smoke run used an isolated home, agent directory, transcript, and fake
credential. It sent no model requests. The TUI stopped successfully, and its
temporary files were removed. No implementation hooks were configured.

## Convergence verification (T043–T049)

The affected group passed with **810 passed, 13 skipped, and 0 failed** across
29 files. The convergence pass did not rerun the full package suite.

The grouped run used this command from `packages/coding-agent`:

```bash
bun test \
  test/cyber-mode.test.ts test/cyber-mode-session.test.ts \
  test/cyber-mode-shared-settings.test.ts test/cyber-switch-guard.test.ts \
  test/status-line-cyber.test.ts test/slash-commands/cyber.test.ts \
  test/agent-session-retry-fallback.test.ts test/custom-editor-keybindings.test.ts \
  test/modes/components/status-line/component.test.ts test/interactive-mode-working-accent.test.ts \
  test/settings-manager.test.ts test/turn-recovery-replay-unsafe.test.ts \
  test/config-cli.test.ts test/model-resolver.test.ts test/issue-980-bedrock-priority.test.ts \
  test/agent-session-model-profiles.test.ts test/sdk-nested-session-shared-settings.test.ts \
  test/issue-2750-subagent-runtime-fallback.test.ts test/settings-group-shadowing.test.ts \
  test/settings-reload-cwd.test.ts test/settings-stream-fn.test.ts \
  test/agent-session-bash-session-ownership.test.ts test/agent-session-prompt-dispatch-race.test.ts \
  test/agent-session-tree-navigation.test.ts test/agent-session-tree-ask-reanswer.test.ts \
  test/agent-session-btw-branch.test.ts test/agent-session-checkpoint-rewind-branch.test.ts \
  test/agent-session-tree-skill-injection.test.ts test/agent-session-branching.test.ts
bun run check
```

The package check passed lint, formatting, and types. It reported five
`unicorn(no-new-array)` warnings in the untouched `src/modes/composer.ts`.

Retained regressions cover these contracts:

- Duplicate model IDs across providers stay within the declared identities.
  Provider preferences, aliases, thinking selectors, and smaller catalogs cannot
  retarget a protected selector to an excluded fuzzy match.
- Startup warnings and live notices identify excluded and unresolved roles.
  Configuration edits, profile changes, provider preferences, and active-model
  replacements report their effects. Tree navigation does not repeat a notice
  within the same transcript.
- New transcripts revalidate empty, unresolved, and changed valid declarations.
  Branch and tree adoption record degraded off states while preserving foreign
  protection. Reopening the transcript preserves off after configuration repair.
- Candidate swaps, Fireworks Fast degradation, and primary restoration record
  the live cyber state. A sibling's operator disable changes subsequent recovery
  records, and a real file reload preserves that state.

Live source-TUI checks used an isolated directory and no model prompts:

- Enable and status output showed both allowed model identities.
- Enabling from an excluded model showed the old and new identities, role
  substitution notices, and the Cyber indicator.
- Disabling removed the indicator.
- Startup showed role-substitution warnings and the launch-model replacement.
- Resuming a recorded-on transcript with an empty declaration showed a warning
  and no Cyber indicator.

Independent SDK probes also exercised notice deduplication, session switches,
declaration changes, branch transitions, and shared ownership. Temporary smoke
configurations and transcripts were removed. No implementation hooks were
configured.

## Verification record (T034)

The checks below ran on 2026-09-17 against the working tree, each against the
scenario of the same number below. Live runs used an isolated overlay config
(`PI_CONFIG_FILES`), a `--session-dir` under `/tmp`, and the real `omp` TUI
driven on a PTY. The user's `~/.omp/agent/config.yml` was not modified.

| Scenario | Result | Evidence |
|---|---|---|
| 1 Declare, enable, see the state | Pass (live + tests) | `/cyber` autocompleted with `Cyber: on`. `/cyber status` printed `Cyber mode on — 1 models allowed, active: anthropic/claude-haiku-4-5-20251001`. The `cyber` segment rendered in the status line. `cyber-mode.test.ts` covers alias, glob, duplicate, and malformed declarations. |
| 2 Chain filtering and the fallback report | Pass (live + tests) | The startup and the toggle reported `Cyber mode changed 6 role(s): default → anthropic/claude-haiku-4-5-20251001 (substituted: no cyber-capable entry)` and the same for `slow`, `advisor`, `plan`, `task`, `reviewer`. `cyber-mode.test.ts` runs 250 generated chains asserting every survivor is allowlisted and the configured order is kept. |
| 3 The indicator in every layout | Pass (live + tests) | The indicator rendered in the default layout and in a custom `leftSegments` layout, appeared on enable, disappeared on `/cyber off`, and returned on `Alt+Shift+X`. `status-line-cyber.test.ts` covers the segment and the symbol-preset fallback (`⚔️` under `unicode` and `nerd`, `[C]` under `ascii`), and `modes/components/status-line/component.test.ts` covers its placement in the default layout and on the `claude3` footer's model line. |
| 4 Lifecycle matrix | Pass (live + tests) | Live in one session: `/clear` printed `Context reset` and the indicator stayed on, `/delete` printed `Session deleted` and the next session was on, `/session delete` returned to the session selector with the deleted session gone and a fresh session current, and that session reported on and recorded `cyber: true`, the configured startup value it has no predecessor state to override, and `/resume` onto a session recorded off dropped the indicator while `/resume` back onto a session recorded on restored it. Earlier live runs covered `/new` and `--resume` with `cyberMode: false` in the configuration. `cyber-mode-session.test.ts` covers resume with a recorded on and off state, a dropped recorded model, `/new`, and a session switch. The recorded startup value of every live session was read back from its transcript. |
| 5 No path around the allowlist | Pass (live + tests) | Live: `/switch anthropic/claude-sonnet-5` printed `Error: Cyber mode is on and anthropic/claude-sonnet-5 is not cyber-capable. Turn cyber mode off to switch to it.` and left the model on `Haiku 4.5`; assigning the same model to `default` in the `/model` hub printed the same error line and left the model on `Haiku 4.5` with no configuration written (the refusal returns before the role is persisted); `Ctrl+P` cycled `smol`, `default`, and `slow` with the model staying `Haiku 4.5`; `/model-profile sonnet` switched the profile, kept `Haiku 4.5`, and kept the indicator on; `/plan` entered plan mode (`Plan mode enabled. Plan file: local://PLAN.md`) and paused it with `Haiku 4.5` throughout, with `modelRoles.plan` pinning `anthropic/claude-sonnet-5` in the overlay so the plan role really did name an excluded model; `--model anthropic/claude-sonnet-5` did not abort the launch and reported `Cyber mode is on: anthropic/claude-sonnet-5 is not cyber-capable, so the session starts on anthropic/claude-haiku-4-5-20251001 instead.` The `Alt+P` session-only picker was not driven live, but it calls the same `setModelTemporary` that `/switch` does (`selector-controller.ts`, `#applySessionModel`), and `cyber-switch-guard.test.ts` covers `setModel`, `setModelTemporary`, both cycle paths, and the off case. |
| 6 Cyber mode off is a no-op | Pass (live + tests) | `/cyber off` printed `Cyber mode off — roles resolve from configuration`, hid the indicator, kept the active model, and restored the configured roles exactly. A config with no `cyberModels` starts off with role selection unchanged. |
| 7 Bad configuration is visible | Partial (live + tests) | Live, end to end, for the row whose entries all fail to resolve: a `cyberMode: true` config whose entries matched nothing warned `cyberModels entry 'anthropic/does-not-exist' matches no available model; ignoring it.`, warned for the second entry, then `cyberMode is on but no cyberModels entry resolves to an available model; starting with cyber mode off.` in the startup header, and the session started off, on the configured role model. The other five rows are covered at the validator, not end to end, because each needs its own process launch: `cyberMode` on with no `cyberModels` (`refuses an enable with no configured entries and with none that resolve`, `installs from configuration, degrades when nothing resolves, and stays off when unasked`), an unavailable entry beside a valid one and a duplicate entry (`treats two spellings of one model as a duplicate and reports unresolved entries`), a malformed value (`reports a malformed value instead of coercing it`, which the validator reaches through `inspectCyberModels(value: unknown, …)` rather than a coerced array), and a resumed session whose recorded list no longer resolves (`cyber-mode-session.test.ts` → `degrades a recorded on state to off when configuration can no longer support it`). Header delivery is asserted only for the row that ran live. |
| 8 Startup starts protected | Pass (live) | The session started on `Haiku 4.5` although `modelRoles.default` named the excluded model, with the roles-moved report naming `default` as substituted. The install now runs in the CLI before the session is built, so the role overrides and prewalk targets after it are filtered too (main.ts and sdk.ts). |
| 9 A model profile switch re-filters | Pass (live) | With cyber mode on, `Alt+Shift+M` cycled the profile bundles whose models are outside the list (`base`, `sonnet`, `fable`); the status line stayed on `Haiku 4.5` with the `Cyber` indicator on every switch. `cyber-mode.test.ts` covers a bundle repointing an alias target under the same spelling. |
| 10 Shared configuration is protected, never unprotected | Pass (tests) | `cyber-mode-shared-settings.test.ts` covers additivity across sessions sharing one configuration state, a foreign implicit clear as a no-op, the owner's own implicit clear, config-driven protection surviving a session's implicit clear, an operator switch-off clearing unconditionally, and the accepted over-restriction: a session whose own state is off while a sibling holds protection keeps reporting off with no indicator, still resolves its roles through the filter, and refuses a direct switch to an excluded model while allowing one inside the list, until an explicit switch-off clears it. Removing the ownership guard fails three of its four cases, and keying the switch guard back on the session's own flag fails the over-restriction case. |

Two cross-cutting paths are covered by tests rather than by a scenario, because
each needs a failing provider or an explicit teardown:

- **Retry recovery.** A configured `retry.fallbackChains` entry, the usage-aware
  fallback walk, the Fireworks Fast degrade, and the restore of a fallback's
  primary all move the session without passing the operator switch guard, so each
  asks the guard's rule and skips an excluded entry. `agent-session-retry-fallback.test.ts`
  runs a retry chain ordered excluded, excluded, allowed: the retry walks past the
  first two and recovers on the third, and it fails (the excluded models get
  requested) with the check removed. The same file covers the usage walk with a
  chain ordered excluded, allowed and a depleted chain head: the walk skips the
  excluded entry and recovers on the covered one, and it fails (the session stays
  on the depleted model) without that check. A third case walks a chain whose
  every entry is excluded: the session keeps its current model and the retry
  finishes, so an exhausted walk costs nothing. That case needs both protections
  removed to break, because the walk skips excluded entries and the swap refuses
  one that reaches it anyway. The walks are also proven over generated input
  rather than by example: `never lands outside the allowlist for any fallback
  chain composition` enumerates every permutation of every non-empty subset of a
  three-entry alphabet plus the empty chain, and asserts that no excluded model is
  ever requested, that the session lands on the first covered entry or on its own
  model when there is none, and that the turn finishes. Removing the retry walk's
  check fails it on the smallest chain, `excluded, allowed`, which lands on the
  primary instead of walking on to the covered entry.
- **Disposal release.** `dispose()` drops the claim the session installed on a
  shared configuration state, while the configured claim and any sibling's stay.
  `cyber-mode-session.test.ts` covers both halves, and the first fails with the
  release removed.

The project-scope write (`setProjectCyberMode`, FR-027) is covered by
`settings-manager.test.ts`: the project file keeps its other keys, and a fresh
load reads the value back as the startup value.

One live-run note: `/model <name>` is not an inline switch in the TUI. The
`model` command declares no `allowArgs`, so the dispatcher sends the line as a
prompt. Switch through the picker (`/model` with no argument), the cycle keys, or
`/switch <name>` to exercise the guard by hand.

## Scenario 1 — Declare, enable, and see the state (US1, SC-001, SC-009)

1. Add an allowlist to the agent config. For the isolated profile, that is
   `~/.omp/profiles/cyber-verify/agent/config.yml`. Otherwise
   `~/.omp/agent/config.yml`.
   ```yaml
   cyberModels:
     - <allowed>
   cyberMode: false
   ```
2. Start the CLI and confirm no cyber indicator is shown.
3. Set the active model to the excluded model through the picker (`/model` with
   no argument). An inline `/model <name>` is not a switch in the TUI: the
   command declares no inline arguments, so the dispatcher sends the line as a
   prompt.
4. Run `/cyber on`.

**Expected**: the command reports the on state and the models in effect. The
active model moves off the excluded model immediately. The indicator appears.
The fallback report names the role whose selection changed.

**Failure signal**: the active model stays on the excluded model, or the
indicator appears while the model does not move. Either one breaks the promise
the indicator makes.

## Scenario 2 — Chain filtering and the fallback report (US2, SC-003, SC-005)

1. Configure one role with a mixed chain, and a second role with no allowed
   entry:
   ```yaml
   modelRoles:
     default: "<excluded>, <allowed>"
     plan: "<excluded>"
   ```
2. Start the CLI, then run `/cyber on`.
3. Run `/cyber status`, then enter plan mode.

**Expected**: `default` resolves to `<allowed>`, not to the excluded entry, and
its position in the chain is what decided it. `plan` resolves to the allowlist's
first entry. The report names **both** roles, because the filter changed the model
each one lands on: `default` had an earlier non-cyber entry dropped, and `plan`
had no survivor at all. Switching cyber mode off returns both roles to the
configured values.

**Failure signal**: `default` resolves to the excluded entry, or either role is
missing from the report. A role whose selection genuinely did not move must not
appear: add a third role whose chain starts with an allowed model, and confirm it
is absent from the report.

## Scenario 3 — The indicator in every layout (US3, SC-004)

1. With cyber mode on, view the default status layout.
2. Set `composerStyle.footerMode: claude3` and restart, or launch with a shape
   that uses the `claude3` footer.
3. Switch to `statusLine.preset: custom` with `leftSegments` including `cyber`.

**Expected**: the indicator appears in all three, reading `⚔️ Cyber` under the
default symbol preset. In the `claude3` footer it appears with no extra
configuration, beside the model profile indication. With cyber mode off it is
absent from all three, and no empty separator is left behind.

**Preset check**: switch the symbol preset to `ascii` and confirm the mark falls
back to `[C]` rather than rendering a glyph the terminal cannot show. The preset
tables in `modes/theme/symbols.ts` are what make that work; a hardcoded emoji in
the segment would not.

## Scenario 4 — Lifecycle matrix (US4, SC-002, SC-008)

For each row, start from cyber mode on, perform the transition, and read the
indicator afterwards.

| Transition | Expected |
|---|---|
| `/clear` | Still on |
| `/new` | Still on, and role chains still filtered |
| `/delete` | The next session is still on |
| `/session delete` | No session remains. The next session you open from the selector follows its own record, or the configured startup value when it has none |
| Resume the same session | Still on |
| Switch to a session created with cyber mode off | Off, while the first session stays on when you switch back |
| Restart the process with `cyberMode: false` | Off |

**Failure signal**: any row reports the previous session's state where it should
report its own, or reports off where the state should have carried over. The
`/new` row is the one the feature request calls out explicitly.

## Scenario 5 — No path around the allowlist (SC-010)

With cyber mode on and the allowlist holding at least one model, try each of:

1. In the model hub (`Alt+M` or `/model`), assigning the excluded model to the
   `default` role.
2. The cycle keys (`Ctrl+P`), which walk the `cycleOrder` roles.
3. The direct catalogue cycle, where the next entry is the excluded model
   itself.
4. `/switch <excluded>`, and the session-only picker on `Alt+P` that uses the
   same setter.
5. `/model-profile <bundle>` where the bundle names only excluded models.
6. Starting with `--model <excluded>` while `cyberMode: true`.
7. Entering and leaving plan mode when the plan role names an excluded model.

**Expected**: the paths split by shape, and every one of them holds the
invariant that the active model never leaves the allowlist.

- A **direct model switch** refuses and names cyber mode as the reason, because
  the operator named one concrete model and the allowlist cannot satisfy that
  choice. The switch is rejected, so the session keeps its model. This covers
  the hub's `default` assignment (item 1), the direct cycle (item 3), `/switch`
  and the `Alt+P` picker (item 4).
- A **role-chain path** does not refuse, because the feature request asks for
  filtering rather than rejection: the path re-points a role chain, or the launch
  model, and the filter moves it inside the allowlist. This covers the
  `cycleOrder` cycle, whose entries are already filtered (item 2), a hub
  assignment to a non-`default` role, a profile bundle (item 5), `--model` at
  launch (item 6), and plan mode (item 7). Item 6 must not abort the launch: the
  session starts on an allowed model and reports the substitution.

Neither shape is silent: the status line keeps the `Cyber` indicator on, and the
launch and toggle reports name the role and the model it landed on.

**Failure signal**: any path changes the active model to the excluded model, or
item 6 aborts the launch.

## Scenario 6 — Cyber mode off is a no-op (SC-006)

With cyber mode off and the mixed configuration from Scenario 2, resolve each
role. Then remove cyber mode from the picture entirely and resolve again.

**Expected**: identical results. Cyber mode off must not change any selection,
not even the order in which a chain is attempted.

**Scope**: this holds while no session sharing the same configuration state has
installed protection. A nested session that turned protection on makes the shared
configuration more restrictive for every session on it (FR-018, SC-006, FR-030).
Scenario 10 is that case.

## Scenario 7 — Bad configuration is visible (SC-007)

Try each configuration, one at a time, and restart:

| Configuration | Expected |
|---|---|
| `cyberMode: true` with no `cyberModels` | Startup warning; the session starts with cyber mode off |
| `cyberMode: true` with `cyberModels: [no-such-model]` | Startup warning; cyber mode off |
| `cyberModels` naming an unavailable model plus a valid one | Startup warning; the valid entry still applies |
| `cyberModels` with a duplicate entry | Startup warning; duplicates ignored |
| `cyberModels: not-a-list` | Startup warning; the value is ignored |
| `cyberModels` valid, resumed session's list since removed | The session resumes with cyber mode off and a warning |

**Expected in every row**: the warning appears in the startup header, and cyber
mode never switches on silently over an unusable allowlist.

## Scenario 8 — Startup starts protected (US1, SC-001)

This is the ordering case, and it must be checked without any runtime toggle.

1. Configure `cyberMode: true` with a valid allowlist, and a `default` role that
   names an excluded model first.
2. Start the CLI with **no** `--model` flag and no restored session.
3. Read the active model and the status line before entering a prompt.

**Expected**: the session starts on an allowed model, not on the excluded model.
The substitution is reported during startup, through the same warning notice path
the fallback report uses. The indicator reads on from the first render.

**Failure signal**: the session starts on the excluded model. That is the
ordering defect this scenario exists for: role resolution happens in `sdk.ts`
around line 1558, roughly 2300 lines before `AgentSession` is constructed at line
3865, so an overlay installed from the session constructor is too late.

## Scenario 9 — A model profile switch re-filters (US2, SC-001)

1. With cyber mode on, activate a model profile whose bundle names at least one
   excluded model, and names at least one role the base configuration does not.
2. Resolve every role the bundle names, then `/model-profile off`.

**Expected**: no role resolves to an excluded model, both while the bundle is
active and after it is removed. No role shows a value left over from the outgoing
layer.

**Failure signal**: any role resolves to an excluded model after the switch. A
filter stored once per toggle fails exactly here, because
`applyModelProfileRoles` replaces the runtime role layer wholesale.

## Scenario 10 — Shared configuration is protected, never unprotected (US4, FR-029, FR-030)

Two sessions must be live on one configuration state. The SDK nested path is the
repeatable way to do this: `createAgentSession({ settings })` passing a live
parent's `Settings`, which is what `agents-hub.ts` does.

1. Parent state off, nested session turns protection on.
   **Expected**: the parent also stops resolving outside the allowlist, refuses a
   direct switch to a model outside it, and still lets it move inside the list,
   while the parent's own indicator stays hidden. The parent is more protected
   than it reports (FR-019, FR-030). An explicit `/cyber off` in the parent clears
   the protection and restores its switches.
2. Parent state on, nested session adopts a recorded off state.
   **Expected**: the parent stays protected. The nested session cannot clear
   protection it did not install.
3. Parent state on, operator runs `/cyber off` in the driving session.
   **Expected**: protection clears. An explicit operator switch-off always
   clears, because that is the operator's stated intent.

**Failure signal**: case 2 clears the parent's protection. That is the inversion
the feature must never allow, because it removes protection without the operator
asking for it.
