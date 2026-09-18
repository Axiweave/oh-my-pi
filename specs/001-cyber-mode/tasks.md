---

description: "Task list for Cyber Mode implementation"

---

# Tasks: Cyber Mode

**Input**: Design documents from `/specs/001-cyber-mode/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included. The repository rule in `AGENTS.md` requires property tests for
non-trivial logic, and research.md D9 names the properties. Write each test task
first and confirm it fails before the implementation task beside it.

**Organization**: Tasks are grouped by user story. US1 and US2 are both P1 and
together form the MVP. US3 and US4 are P2.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- All paths are relative to the repository root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Register the configuration keys, the segment id, and the indicator mark.

- [X] T001 Add `cyberModels` (ordered list of selector strings, default empty) and
      `cyberMode` (boolean, default `false`) to the settings registry in
      `packages/coding-agent/src/config/settings-schema.ts`. Add `"cyber"` to
      `STATUS_LINE_SEGMENT_IDS` in the same file, which widens
      `StatusLineSegmentId`. Both keys MUST read from every configuration layer,
      per `contracts/settings.md`.
- [X] T002 [P] Append `cyberModels: []` and `cyberMode: false` to
      `~/.omp/agent/config.yml` so the operator can discover them, per the local
      rule in `.omp/AGENTS.md`.

**Checkpoint**: The operator can set both keys, and the values survive a reload.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The filter's pure logic, the settings overlay, and the session record
every story builds on. **No user story work can begin until this phase is
complete.**

- [X] T003 Create `packages/coding-agent/src/config/cyber-mode.ts` holding the
      pure logic, with no session import:
      - allowlist resolution: map entries through `resolveModelRoleValue` against
        an available-model set and keep resolved model identity, not spelling;
      - `filterChain`: keep allowlisted entries in configured order;
      - `validateCyberMode`: report a non-list value, a duplicate entry, and an
        entry that matches no available model, per `data-model.md` §1.
      Acceptance: each function is pure, so a test can call it without a session.
- [X] T004 Add the cyber overlay to `packages/coding-agent/src/config/settings.ts`.
      It stores the **resolved allowlist**, not a filtered map. Extend
      `#rebuildMerged()` (near line 3227) so that, after the four-layer merge and
      only while a filter is installed, it filters the merged `modelRoles` against
      the stored allowlist and writes the result back, memoized per raw role
      value. Add `applyCyberRoles(owner, allowlist)`,
      `clearCyberRoles(owner, options?: { operator?: boolean })`, and
      `getCyberAllowlist()`. The owner list stays internal: no caller needs the
      owner id back, and the guard of FR-030 lives inside `clearCyberRoles`.
      Acceptance: deriving per merge is the point, not an optimization. A stored
      map goes stale on `applyModelProfileRoles` (`settings.ts:1475`), which
      replaces the runtime role layer wholesale, so a role the incoming profile
      names would resolve outside the allowlist. Saved config is unaffected,
      because `#global` and `#project` stay raw.
- [X] T005 [P] Add the `CyberModeResult` type to
      `packages/coding-agent/src/session/agent-session-types.ts`, carrying the new
      state, the models in effect, and the changed roles, per `data-model.md` §4.
- [X] T006 Add the optional `cyber` field to `ModelChangeEntry` in
      `packages/coding-agent/src/session/session-entries.ts`, read back by the
      same rule `profile` uses, per `contracts/session-entry.md`. It belongs here
      rather than in US4 because the startup path records it too (T012).
- [X] T007 Extend `appendModelChange` in
      `packages/coding-agent/src/session/session-manager.ts` (line 2789) with the
      trailing `cyber?: boolean` parameter, and add `getLastCyberMode()` beside
      `getLastModelProfile` (line 3001).

**Checkpoint**: The pure filter is callable, the overlay derives per merge and
guards removal, and the session record can carry the state.

---

## Phase 3: User Story 1 - Declare cyber-capable models and switch cyber mode on (Priority: P1) 🎯 MVP

**Goal**: The operator declares the list, cyber mode starts on from configuration
or is switched on at runtime, and every operator switch to a non-cyber model is
refused with cyber mode named as the reason.

**Independent Test**: Configure two models as cyber-capable, switch cyber mode
on, confirm the report names the on state and the models in effect, then switch
off and confirm the off state.

### Tests for User Story 1 ⚠️ Write first, confirm they FAIL

- [X] T008 [P] [US1] Add switch-guard property tests to
      `packages/coding-agent/test/cyber-mode-guard.test.ts`, mirroring
      `test/agent-session-model-profiles.test.ts`:
      - for each of the picker, cycle, `/model`, and `/switch` paths, a
        non-allowlisted target is refused while on and accepted while off. The
        property is "no path changes the active model outside the list", not
        "this function throws";
      - enabling with an empty or unresolvable allowlist is refused and leaves
        the state off (FR-016).
- [X] T009 [P] [US1] Add startup-order and declaration tests to
      `packages/coding-agent/test/cyber-mode-session.test.ts`:
      - *startup starts protected*: with `cyberMode: true`, a valid allowlist, and
        **no explicit model**, the first resolved model is allowlisted, and the
        initial `model_change` entry records cyber on (FR-004, FR-006). When the
        configured `default` role names an excluded model first, the substitution
        report also reaches the post-construction startup warnings (FR-010). This
        is the ordering regression, so it must run without any runtime toggle;
      - a malformed value, a duplicate entry, and an entry matching no model each
        produce a startup warning and never switch the mode on silently (FR-027).

### Implementation for User Story 1

- [X] T010 [US1] Call `validateCyberMode` from the existing validation path in
      `packages/coding-agent/src/config/model-roles.ts` so its findings join the
      `configWarnings` the startup surface already prints.
- [X] T011 [US1] Add `installStartupCyberMode(settings, availableModels)` to
      `packages/coding-agent/src/config/cyber-mode.ts`: read `cyberMode` and
      `cyberModels`, validate, resolve the allowlist against `availableModels`, and
      install the overlay owned by the configuration. It takes the model list
      because `Settings` holds configuration only and cannot resolve an allowlist.
      Call it in `packages/coding-agent/src/sdk.ts` immediately after
      `modelRegistry` is created (lines 1382-1387), and in
      `packages/coding-agent/src/main.ts` immediately after `modelRegistry` is
      created (line 1741).
      **This ordering is the requirement, not a preference**: `sdk.ts` reads
      `settings.getModelRole("default")` at line 1558 and resolves the launch role
      at `1576-1585`, while `new AgentSession` is constructed at line 3865.
      Installing from the session constructor leaves a `cyberMode: true` start
      resolved unfiltered. The helper needs no roles, because T004 derives the
      filter per merge.
      Accepted boundary, to state in the code comment rather than hide: `main.ts`
      reads roles at `:1274` and `:1322`, and builds a role lookup at `:1399`,
      before its registry exists at `:1741`. Those reads cannot be filtered. They
      cannot change which model the session runs, because the startup model is
      resolved later at `sdk.ts:1581` through the filtered settings.
- [X] T012 [US1] Record the state on the initial transcript: pass the cyber state
      to the `appendModelChange` call at `packages/coding-agent/src/sdk.ts:3787`,
      which runs before the session exists. Without this, a protected startup
      writes an entry that reads as off, and a later resume loses the state.
- [X] T013 [US1] Add `setCyberMode` to
      `packages/coding-agent/src/session/model-controls.ts`. It installs the
      overlay owned by this session, clears it with `{ operator: true }`, refuses
      when nothing resolves (FR-016), and re-points the active model when that
      model is outside the allowlist, following the active role's filtered chain
      and falling back to the primary cyber model (FR-008). The re-point MUST route
      through the existing switch methods so it is reported like any other model
      change.
- [X] T014 [US1] Add the allowlist guard to `setModel` and `setModelTemporary` in
      `packages/coding-agent/src/session/model-controls.ts`, above the call to
      `setModelWithProviderSessionReset` (lines 246 and 296), so no provider
      session is reset before the refusal. The refusal message MUST name cyber mode
      as the reason (FR-009).
- [X] T015 [US1] Make the launch path substitute instead of abort, in
      `findInitialModel` at `packages/coding-agent/src/config/model-resolver.ts:2181`.
      When the requested launch model is outside the allowlist, resolve the active
      role's cyber-capable model instead (FR-010). A throw here aborts the launch
      and is a defect.
      The report needs a handoff: this function runs before any session exists, so
      it cannot emit a notice. Return the substitution alongside the result, and
      carry it into the post-construction startup warnings at the
      `notifs.push({ kind: "warn", message: modelFallbackMessage })` site
      (`main.ts:2248`). Do not build a second warning channel. T009 asserts the
      startup report lands.
- [X] T016 [P] [US1] Add the `app.model.toggleCyber` action to
      `packages/coding-agent/src/config/keybindings.ts` and bind it in
      `packages/coding-agent/src/modes/controllers/input-controller.ts`.
- [X] T017 [P] [US1] Add the `/cyber` command to
      `packages/coding-agent/src/slash-commands/builtin-modes.ts` with the
      argument forms and refusal output from `contracts/slash-command.md`,
      including the `global` and `project` persistence forms. Add its `on`/`off`
      completion to `packages/coding-agent/src/slash-commands/builtin-completions.ts`.
      Acceptance: every invocation form in that contract behaves as written.

**Checkpoint**: Cyber mode starts on from configuration, switches at runtime, and
every operator switch surface refuses a model outside the list.

---

## Phase 4: User Story 2 - Role model chains resolve to cyber-capable models only (Priority: P1) 🎯 MVP

**Goal**: With cyber mode on, each role resolves only among allowlisted models,
surviving entries keep their configured order, a chain with no survivor lands on
the primary cyber model, the report names every role whose selection changed, and
a replaced role layer is re-filtered.

**Independent Test**: Give one role a chain of `[allowed, excluded]` and another
a chain of only excluded models, switch cyber mode on, and confirm the first
resolves to the allowed entry, the second to the primary cyber model, and both
appear in the report.

### Tests for User Story 2 ⚠️ Write first, confirm they FAIL

- [X] T018 [P] [US2] Add filter property tests to
      `packages/coding-agent/test/cyber-mode-session.test.ts`:
      - *order survives*: for a generated chain, the resolved model is the first
        allowlisted entry and the relative order of survivors matches the
        configured order. Cover empty, single, fully allowlisted, and fully
        excluded chains;
      - *empty survival substitutes*: a chain with no allowlisted entry resolves
        to the first allowlist entry;
      - *a profile switch re-filters*: with cyber mode on, switching a model
        profile leaves no role outside the allowlist, and no role masked by the
        outgoing profile's filtered value (FR-006, FR-013). This is the regression
        for the derived-per-merge design;
      - *report coverage*: the report names every role whose landed model differs
        from its unfiltered first choice, and names no role whose selection did
        not move;
      - *off is a no-op*: for the same configuration, every role resolves
        identically with cyber mode off as before the feature, while no
        protection is installed for the configuration state (FR-018). FR-030's
        over-restriction case is asserted in T029 instead, because it needs two
        live sessions.

### Implementation for User Story 2

- [X] T019 [US2] Implement the chain filter in
      `packages/coding-agent/src/config/cyber-mode.ts` against the resolved
      allowlist from T003. Resolve an alias to its target chain before filtering,
      so a chain naming another role is filtered after expansion (FR-015).
- [X] T020 [US2] Wire the filter into `#rebuildMerged()` for every known role,
      custom roles included (FR-013, FR-014), using the memo from T004. Built-in
      and operator-defined roles MUST follow the same rule.
- [X] T021 [US2] Emit the fallback report from
      `packages/coding-agent/src/session/agent-session.ts` through
      `emitNotice("warning", …)`, naming every changed role and the model it
      landed on (FR-011), with a per-session `{ role, landed }` dedup set owned by
      the session so the pair is reported once (FR-012). The report distinguishes
      `filtered` from `substituted`, per `data-model.md` §4.
- [X] T022 [US2] Make the off path restore resolution exactly: clearing the overlay
      returns the merged view to the configured values, and a role whose first
      entry is already allowlisted is untouched while on (FR-017, FR-028).

**Checkpoint**: Cyber mode protects every role, survives a profile switch, reports
what it changed, and is invisible when off.

---

## Phase 5: User Story 3 - A status line indicator shows that cyber mode is on (Priority: P2)

**Goal**: A dedicated `⚔️ Cyber` indicator appears while cyber mode is on, in the
default status layout, in the `claude3` composer footer, and as a selectable
segment for custom layouts.

**Independent Test**: Toggle cyber mode and confirm the indicator appears and
disappears in the default layout, then confirm the `claude3` footer shows it with
no operator configuration.

### Tests for User Story 3 ⚠️ Write first, confirm they FAIL

- [X] T023 [P] [US3] Add indicator tests to
      `packages/coding-agent/test/cyber-mode-session.test.ts`: the rendered
      default layout contains no cyber indicator while off and one while on, the
      `claude3` footer contains it while on, and the custom-layout path renders it
      when the segment is added (FR-019, FR-020). Assert on rendered output, not
      on segment-array internals. Include the `ascii` symbol preset case, where the
      mark MUST fall back to its text form.

### Implementation for User Story 3

- [X] T024 [US3] Add the mark to the glyph tables. In
      `packages/coding-agent/src/modes/theme/symbols.ts`, add `"icon.cyber"` to the
      `SymbolKey` union and to all three presets: `UNICODE_SYMBOLS` and
      `NERD_SYMBOLS` use the crossed-swords mark, `ASCII_SYMBOLS` uses `[C]`,
      following the file's `// pick:` / `// alt:` comment convention. Then expose
      `cyber: this.#symbols["icon.cyber"]` on the icon accessor in
      `packages/coding-agent/src/modes/theme/theme-class.ts`.
      Acceptance: the unicode preset renders `⚔️`, ascii renders `[C]`, and a
      `symbols.overrides["icon.cyber"]` entry replaces it.
- [X] T025 [US3] Add the `cyber` segment to
      `packages/coding-agent/src/modes/components/status-line/segments.ts`, using
      `withIcon(theme.icon.cyber, "Cyber")`, and its `SEGMENTS` registry entry so
      it is selectable in a custom layout. It MUST stay hidden while cyber mode is
      off (FR-019).
- [X] T026 [P] [US3] Add the segment to the default preset's left segments in
      `packages/coding-agent/src/modes/components/status-line/presets.ts`
      (FR-020).
- [X] T027 [P] [US3] Render the segment in `renderClaudeFooter` in
      `packages/coding-agent/src/modes/components/status-line/component.ts:3076`,
      beside the existing `model_profile` render and using the same dot separator,
      so the `claude3` composer footer shows it without operator configuration
      (FR-020). Extend `SegmentContext` in the neighbouring `types.ts` only if a
      field beyond the session accessor is needed.

**Checkpoint**: The operator can see at a glance whether the protection is on.

---

## Phase 6: User Story 4 - Cyber mode state follows the session lifecycle (Priority: P2)

**Goal**: The state is recorded on the session, reinstated by a resume or a
session switch, carried onto the next transcript by `/new` and `/delete`, and
never removed by a session that did not install it.

**Independent Test**: Switch cyber mode on, resume the session and confirm the
indicator still reads on, run `/new` and confirm the next session reads on, then
switch to a session created with cyber mode off and confirm that one reads off.

### Tests for User Story 4 ⚠️ Write first, confirm they FAIL

- [X] T028 [P] [US4] Add transition tests to
      `packages/coding-agent/test/cyber-mode-session.test.ts`: a resume
      reports the recorded state, `/new` carries it, `/clear` keeps it, a switch to
      another session reports that session's own state, and a session whose
      allowlist no longer exists or now resolves nothing resumes off with a warning
      (FR-024, FR-026). Assert on the reported state, not on entry internals.
- [X] T029 [P] [US4] Add the shared-configuration tests to
      `packages/coding-agent/test/cyber-mode-shared-settings.test.ts`, a file of
      its own so this task and T028 really can run in parallel. Follow the live-
      `Settings` pattern from `test/sdk-nested-session-shared-settings.test.ts`:
      - *additive*: turning protection on in either session protects both
        (FR-029, FR-030);
      - *an implicit clear cannot remove another owner's protection*: a session
        adopting a recorded off state is a no-op against protection installed by
        another session or by configuration (FR-030). This is the inversion the
        feature must never allow;
      - *an explicit operator switch-off always clears* (FR-030);
      - *over-restriction is the accepted consequence*: a parent whose own state is
        off still resolves inside the allowlist while a nested session holds
        protection, and the parent's indicator stays hidden (FR-018, FR-019).

### Implementation for User Story 4

- [X] T030 [US4] Reinstate the state on resume and session switch in
      `packages/coding-agent/src/session/agent-session.ts`: install the filter
      **before** the persisted model restore in `switchSession`. The model profile
      line at line 10093 is the precedent and its comment already states the
      intent, that this replaces the outgoing session's role layer wholesale. Then
      re-point the restored model if it is outside the allowlist (FR-024).
- [X] T031 [US4] Carry the active state onto the next transcript in `newSession`
      (line 8657) for both `/new` and `/delete`, in the same operation that records
      the inherited model and profile (FR-023).
- [X] T032 [US4] Apply the configured startup value only where there is no
      predecessor state, and degrade an on state that current configuration cannot
      support to off with a warning (FR-025, FR-026). The record is a boolean with
      no list, so this decision comes from current configuration alone.

**Checkpoint**: The state survives every transition the operator can make, and
sharing configuration can only add protection, never remove it.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T033 [P] Add a `CHANGELOG.md` entry under `packages/coding-agent`,
      following the existing model profile entries.
- [X] T034 Run every scenario in `quickstart.md` and record the observed result for
      each. The scenarios are numbered 1 through 10: declare and enable; chain
      filtering and the report; the indicator in every layout; the lifecycle
      matrix; no path around the allowlist; off is a no-op; bad configuration is
      visible; startup starts protected; a profile switch re-filters; shared
      configuration is protected and never unprotected. Any scenario that does not
      behave as written is a defect in the implementation or in the scenario, and
      both are in scope.
- [X] T035 Run `bun test` for the two new files, then
      `bun run --cwd=packages/coding-agent check:types` and
      `bun run --cwd=packages/coding-agent check` once at the end.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: T004 depends on T001, because the overlay reads the
  new keys. T007 depends on T006 for the field it threads through. Blocks every
  user story.
- **US1 (Phase 3)**: Depends on Phase 2. T011 and T012 must both land before T009
  passes. T013 and T014 both edit `model-controls.ts`, so they run in order, not
  in parallel. T015 depends on T003's allowlist resolution only.
- **US2 (Phase 4)**: Depends on Phase 2 and on T013, which installs the overlay
  US2 reads. T019 and T020 both extend T003's module, so they run in order.
- **US3 (Phase 5)**: T024 must land before T025, which reads the new icon key.
  Independent of US2.
- **US4 (Phase 6)**: Depends on T013 and on the accessor added in Phase 2. T029
  depends on T004's owner guard and clear flavors, which it exercises end to end.
- **Polish (Phase 7)**: Depends on all preceding phases. T034 and T035 run last.

### Within Each User Story

- Test tasks first, and confirmed failing before the implementation task they
  cover.
- Foundational types and pure logic before the call sites that use them.
- `packages/coding-agent/src/session/model-controls.ts` is the only file two tasks
  in the same phase both edit (T013, T014), so those two are serialized.
- `packages/coding-agent/src/session/agent-session.ts` is edited by T021, T030,
  and T031 across three phases, which is why those phases run in order.
- `packages/coding-agent/src/config/cyber-mode.ts` is edited by T003, T011, T019,
  and T020 in three phases, which is why those phases run in order.

### Parallel Opportunities

- T001 and T002 in Setup.
- T004, T005, and T006 in Foundational, since they touch different files.
- T008 and T009 together, then T016 and T017 together, in US1.
- T024 is serial before T025; T026 and T027 then run together.
- T028 and T029 together in US4, since they assert different properties.
- The two P1 stories are the only part that must land before the MVP checkpoint.
  US3 and US4 are independent of each other and can run in parallel.

---

## Parallel Example: User Story 4

```bash
# Two test-only tasks over different properties, in different files:
Task: "Transition tests in packages/coding-agent/test/cyber-mode-session.test.ts"
Task: "Shared-configuration tests in packages/coding-agent/test/cyber-mode-shared-settings.test.ts"
```

These are genuinely parallel: the shared-configuration regression lives in its own
file, mirroring `test/sdk-nested-session-shared-settings.test.ts`, precisely so it
does not collide with the session-level file.

---

## Implementation Strategy

### MVP First (US1 + US2)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational. The derived-per-merge overlay and its owner
   guard are the load-bearing part; nothing else is safe without them.
3. Complete Phase 3 (US1) and Phase 4 (US2). Both are P1, and together they are the
   feature: a declared list, a working switch that starts protected, filtered
   roles that survive a profile switch, and a report.
4. **STOP and VALIDATE**: run the US1 and US2 independent tests, then the
   `off is a no-op` and `a profile switch re-filters` properties. Together they are
   the regression guard for the whole feature.
5. The MVP is usable here. A session is protected and the operator can see what
   changed.

### Incremental Delivery

1. Setup + Foundational → the filter exists but nothing calls it.
2. US1 → cyber mode starts protected, the switch works, and it refuses what it must.
3. US2 → roles are actually protected, and the report names what moved.
4. US3 → the operator can see `⚔️ Cyber` in the status line.
5. US4 → the state survives resume, `/new`, `/delete`, and a session switch.

### Notes

- [P] means different files and no dependency. Two tasks in the same file are never
  [P].
- The files two tasks share within a phase are
  `packages/coding-agent/src/session/model-controls.ts` (T013, T014) and
  `packages/coding-agent/src/config/cyber-mode.ts` (T019, T020).
- Every test task names the property it proves. A test that restates the filter
  formula proves nothing, per the repository test rule in `AGENTS.md`.
- No CLI surface is added. The launch flag is out of scope, per the spec's
  Assumptions, so a task adding `--cyber` is a defect.
- The startup ordering in T011 is not a style preference. `sdk.ts` resolves the
  default role at line 1558 and constructs the session at line 3865, so an overlay
  installed later never sees the first resolution.
- T014's guard reads the protection installed on the configuration state, not
  the session's own flag, so a session whose own state is off is still constrained
  while a sibling holds protection (FR-029, FR-018). It is the rule every model
  switch asks, not only the operator's: the
  retry-recovery paths (`turn-recovery.ts`) move the session with
  `setModelWithProviderSessionReset` and would otherwise bypass it, so the
  configured fallback chain, the Fireworks Fast degrade, and the primary restore
  each ask the same predicate and stay put on a refusal. The session's claim on a
  shared configuration state is released on `dispose`, so a session that no
  longer exists cannot keep filtering its siblings.

## Phase 8: Convergence

- [X] T036 Skip a cyber-excluded candidate inside the usage-aware fallback walk in
  `#maybeApplyUsageAwareFallback` (`packages/coding-agent/src/session/turn-recovery.ts`), the same way
  `#tryRetryModelFallback` already does, so the walk moves to the next allowed entry instead of
  selecting a blocked candidate and dead-ending when `applyRetryFallbackCandidate` refuses it. Cover it
  with a focused test in `test/agent-session-retry-fallback.test.ts` that fails today: a depleted model
  whose usage-fallback chain lists an excluded candidate before an allowed one must recover on the
  allowed one, and must not leave the session on the depleted model. per FR-009, SC-010 (partial)
- [X] T037 Record the recovery-path guard as intended behavior in `spec.md` and `plan.md`. The four
  `cyberAllowsModel` sites in `turn-recovery.ts` (the configured fallback chain, the Fireworks Fast
  degrade, the primary restore, and the swap itself) confine automatic recovery too, while FR-009,
  SC-010, and the plan's `Internal bypasses` paragraph scope the confinement to operator paths and call
  the non-operator paths deliberately outside it. State the recovery rule in the specification and name
  the recovery touch-point in the plan, so the code and the artifacts agree instead of the code being
  stricter than both. per SC-010, plan: `Integration point 2` (unrequested)

### Phase 8 resolutions

- T036 landed as the guard in `#maybeApplyUsageAwareFallback` plus the test
  `skips usage-fallback entries cyber mode excludes, and recovers on the entry it covers`.
  That test fails without the guard (the session stays on the depleted model) and passes with it.
- T037 landed as FR-031 and the SC-010 sentence in `spec.md`, the `Recovery paths`
  paragraph and the corrected fallback risk row in `plan.md`, and the recovery
  paragraph in `docs/cyber-mode.md`. The finding was valid when this section was
  appended: at that point FR-009, SC-010, and the plan's `Internal bypasses`
  paragraph scoped confinement to operator paths, so the recovery guard was
  stricter than both artifacts.

## Phase 9: Convergence

- [X] T038 Prove the exhausted-recovery outcome. A cyber-on session whose retry walk holds no covered
  entry must keep its current model and finish the turn, which is the safe outcome SC-010 and FR-031
  name. `agent-session-retry-fallback.test.ts` proves only the two walks that find a covered entry
  (`skips fallback chain entries cyber mode excludes…` and `skips usage-fallback entries cyber mode
  excludes…`), so nothing asserts that the session stays inside the list when every entry is excluded.
  Add that case, and confirm it fails when the walk is allowed to skip its guard. per SC-010, FR-031
  (partial)
- [X] T039 Re-sync the line citations in `plan.md`, which no longer point at the code they claim. The
  choke-point table names `setModel` at 253 (now 244), `setModelTemporary` at 280 (now 302), and
  `applyRoleModel` at 390 (now 414). The `Internal bypasses` paragraph names `agent-session.ts:5487`,
  `11674`, and `10257`, which now hold a doc comment, a tool description, and a session-switch condition.
  The bootstrap ordering argument names `sdk.ts:1382-1387`, `1558`, and `1576`, which now hold a comment
  about credential events, `deferredModelPatterns`, and a `break` (only `4119` still lands on its call).
  Re-verify each anchor against the current sources and correct the numbers, so the ordering claim the
  plan rests on stays re-verifiable. per plan: `Choke Point`, `Internal bypasses`, `Integration point 0`
  (partial)

### Phase 9 resolutions

- T038 landed as `keeps the session inside the allowlist when no fallback entry is covered`. The
  mutation result is narrower than the task text assumed: removing the retry walk's check alone leaves
  the case passing, because `applyRetryFallbackCandidate` refuses the candidate the walk then selects.
  Removing both checks makes the case fail (the excluded model is requested), so the pair is what the
  case defends.
- T039 landed as 19 corrected anchors in `plan.md`. The choke-point table now reads 244, 302, and 414,
  the reset calls 265 and 317, the bypasses 5508, 11758, and 10341, the bootstrap anchors 1383-1387,
  1425, 1565, 1583-1592, 3836, and 3920, the CLI anchors 1275, 1321, 1399, 1744, and 1754, the warning
  channel 2259, the restore 10202, and the profile mirror 10170. Every one was read back from the
  source after the edit.

## Phase 10: Convergence

- [X] T040 Re-sync the line citations in the four contract files, which carry the same drift T039
  corrected in `plan.md` because that task's scope named only the plan. Verified actuals:
  `contracts/settings.md` cites `sdk.ts:1558` (now 1565), `:1581` (1583), `:3865` (3920),
  `1382-1387` (1383-1387), `main.ts:1741` (1744), `sdk.ts:3787` (3836), and `main.ts:1274` / `:1322`
  (1275 / 1321). `contracts/session-entry.md` cites `session-manager.ts:2789` (2790), `getLastModelProfile`
  at 3001 (3009), `agent-session.ts:8747-8757` (8774), `:10093` (10170), and `model-controls.ts:115` (the
  profile restore is 129 and the cyber restore 133). `contracts/slash-command.md` cites
  `builtin-modes.ts:113` for `persistModelProfile` (107, and the command itself registers at 637).
  `contracts/status-line-segment.md` cites `segments.ts:990` (1012), `component.ts:3076` (3061 for
  `renderClaudeFooter`, 3075 for the segment), and `modes/status-line/types.ts` (the file is
  `modes/components/status-line/types.ts`); its `settings-schema.ts:242` anchor is correct. per plan:
  `contracts/` (partial)
- [X] T041 Narrow the D10 claim in `plan.md`. It reads "At settings bootstrap, in `sdk.ts:1425` and
  `main.ts:1754`, before the first `getModelRole` read", but the CLI reads roles at `main.ts:1275` and
  `:1321` before its registry exists at `:1744`, and installs at `:1754`. The plan's own boundary
  paragraph already accepts those two unfilterable reads, so D10 contradicts it. Restate D10 as
  installing before the SDK's role read and the launch resolution it drives, and point at the boundary
  paragraph for the CLI exception. per plan: D10, `Integration point 0` (partial)
- [X] T042 Correct the test-file name in `research.md` D9. It names `test/cyber-mode-guard.test.ts` as
  the switch-level file, while the file the feature ships is `test/cyber-switch-guard.test.ts`
  (`test/cyber-mode-guard.test.ts` does not exist). Point the D9 bullets at the file that exists, and at
  `test/cyber-mode-shared-settings.test.ts` for the shared-state properties D9 already delegates there.
  per plan: research D9 (partial)

### Phase 10 resolutions

- T040 landed as 14 corrected anchors across `contracts/settings.md`, `contracts/session-entry.md`,
  `contracts/slash-command.md`, and `contracts/status-line-segment.md`, each read back from the source.
  `settings.md` now points the install at `sdk.ts:1425` and `main.ts:1754`, the first SDK role read at
  `:1565`, the launch resolution at `:1583`, the session construction at `:3920`, the initial entry at
  `:3836`, and the accepted CLI reads at `main.ts:1275` and `:1321` before the registry at `:1744`.
- T041 landed as a narrowed D10 that names the SDK role read and the launch resolution it drives, and
  points at the boundary paragraph for the two CLI reads that precede its registry.
- T042 landed as D9 naming `test/cyber-switch-guard.test.ts` and keeping the shared-state delegation.
- The test-rule advisory of this pass also landed: `never lands outside the allowlist for any fallback
  chain composition` enumerates every permutation of every non-empty subset of a three-entry alphabet
  plus the empty chain, proving the recovery walks over generated input. Removing the retry walk's check
  fails it on the smallest chain, `excluded, allowed`, so a failure names its own counterexample.

## Phase 11: Convergence

- [X] T043 **CRITICAL — F1** Make cyber allowlist membership, its primary, and filtered role resolution use consistent model identities in `packages/coding-agent/src/config/cyber-mode.ts` and `src/config/settings.ts`. The current primary resolver honors `modelProviderOrder`, while membership construction and `chainSurvivors` can use catalog order. With two providers offering `claude-sonnet-4-5`, an explicit Anthropic allowlist, an unqualified role, and the other provider first in `modelProviderOrder`, the filtered role resolves to the excluded provider. An unqualified allowlist also produces a primary outside its own membership set. Preserve configured preference and thinking-selector behavior without leaving a surviving selector free to resolve outside the allowlist. Add generated coverage for duplicate model IDs across providers, preference changes, aliases, and catalog subsets. Assert that the primary and every downstream role resolution remain allowlisted. Per FR-002, FR-006, FR-007, FR-013, SC-001, plan D3 (contradicts).

- [X] T044 **HIGH — F2** Complete cyber substitution reporting in `packages/coding-agent/src/session/agent-session.ts`, `src/session/model-controls.ts`, `src/config/cyber-mode.ts`, and the existing settings/startup notification integration. `#reportCyberChanges` currently runs only after `setCyberMode`, so startup filtering and later config/profile changes can substitute roles silently. A live-session probe enabled cyber mode, assigned an excluded model to `task`, and observed an allowlisted replacement with no notice event. `planCyberChanges` also skips an unresolved original chain even when filtering substitutes the primary. Report every affected role and landed model in the interaction that causes the change, including active-model substitutions. Keep the existing warning channel and reset or scope the deduplication set for each transcript, rather than retaining one set across `/new` and session switches. Verify startup, profile/config changes, unresolved chains, repeated identical substitutions, and a new transcript with observable notice assertions. Per FR-010, FR-011, FR-012, SC-003, US1/AC4, T021 (partial).

- [X] T045 **HIGH — F3** Revalidate inherited cyber protection before `newSession` records the next transcript in `packages/coding-agent/src/session/agent-session.ts`, covering both `/new` and `/delete`. The current path copies `this.cyberMode` at lines 8774–8779 without resolving the current declaration. A live-session probe enabled cyber mode, overrode `cyberModels` with an empty list, and called `newSession`: the new transcript still recorded `cyber: true`, the live state stayed on, and no warning appeared. Degrade an unsupported inherited state to off with a warning while preserving another owner's protection under FR-030. Cover empty, unresolvable, and changed-but-valid declarations at the transition boundary. Per FR-023, FR-026, FR-030, spec edge case “empties the declared list ... then runs /new”, T032 (partial).

- [X] T046 **HIGH — F4** Restore cyber state when `branch` and `navigateTree` adopt a destination branch in `packages/coding-agent/src/session/agent-session.ts`. These paths change transcript history without calling `restoreCyberMode` or reconciling the active model. A live-session probe recorded cyber on, recorded off later, then branched to a user entry after the on record: `getLastCyberMode()` returned true while `session.cyberMode` and installed protection were false. Navigating to the earlier on record produced the same mismatch. Restore the incoming branch state before subsequent model use, revalidate its declaration, and re-point an excluded active model while respecting shared ownership. Verify both on-to-off and off-to-on branch transitions and the state after resume. Per FR-021, FR-024, plan: data-model transition matrix “Fork or branch”, T030 (partial).

- [X] T047 **MEDIUM — F5** Pass the current cyber state to every recovery `appendModelChange` call in `packages/coding-agent/src/session/turn-recovery.ts`, including the candidate swap at line 1921, Fireworks Fast degrade at line 2109, and primary restore at line 2180. The session-entry contract explicitly requires every writer to record the state in effect, but these calls omit it. The reader currently scans past absent fields, so this finding does not claim that every recovery loses resume state. Verify the recorded transition state for both enabled and disabled recovery, including a shared-settings operator disable. Per plan: `contracts/session-entry.md` Write rule and invariant 1, T006–T007 (partial).

- [X] T048 **MEDIUM — F6** Report the models in effect when enabling cyber mode and requesting `/cyber status` through `packages/coding-agent/src/config/cyber-mode.ts` and the existing command/keybinding reporting paths. `cyberStateLine` currently prints only the allowlist count and active model, so a two-model allowlist never identifies its second model. Preserve concise state confirmation while making the actual allowed model identities available in the same interaction. Align `specs/001-cyber-mode/contracts/slash-command.md`, whose invocation/enabling sections require the list but whose reporting example only shows its size. Verify model identities in operator-visible output rather than pinning incidental wording. Per US1/AC1, US1 independent test, T017 and plan: slash-command contract (partial).

- [X] T049 **LOW — F7** Apply the accepted CLI startup boundary consistently throughout `specs/001-cyber-mode/plan.md`. D10 now correctly names the SDK role read, but the summary, `main.ts` source-tree annotation, Integration point 0 wording, and risk row at line 325 still imply installation before every role read. The risk row explicitly claims installation before `main.ts:1275`, although the registry exists at line 1744 and installation occurs at line 1754. Keep the accepted early CLI reads and the protected SDK launch resolution explicit in every current ordering claim. Do not rewrite historical tasks or their completion notes. Per plan D10, Integration point 0, T041 (partial).

## Phase 12: Convergence

- [X] T050 **HIGH — F1** Constrain the primary fallback in `packages/coding-agent/src/config/cyber-mode.ts` `resolveCyberTarget` to an exact allowlisted identity. The current `resolveModelFromString(allowlist.primary, availableModels)` call can retarget `anthropic/shared-model` to excluded `anthropic/shared-model-extra` when the catalog omits the primary. A live probe also returned that excluded identity from `substituteLaunchModel`, which the SDK uses at `src/sdk.ts:1657`. Reuse the protected identity rule without changing ordinary fuzzy selector behavior. Handle an unavailable primary without returning or retaining an excluded model under active protection. Cover empty and reduced catalogs, missing primary identities, fuzzy siblings, and thinking selectors through both target and launch resolution. Extend the fixed-seed generated coverage rather than relying only on the demonstrated fixture. Per FR-006, FR-010, SC-001, SC-010, plan D3, T043 (partial).

- [X] T051 **HIGH — F2** Restore outgoing cyber state, protection ownership, and report history when `switchSession` fails after target adoption in `packages/coding-agent/src/session/agent-session.ts`. The target adoption at lines 10231–10235 clears notice history and changes protection before later operations can fail. The catch block at lines 10364–10444 restores the transcript and model but not those cyber fields. An injected target-model failure restored a recorded-on transcript with `session.cyberMode === false` and no installed protection. Preserve other owners' protection and prevent uncommitted transitions from corrupting the outgoing transcript's report history. Add failure-path tests for both state directions and a shared-owner case. Per FR-021, FR-024, FR-030, plan D5/D7 and Integration point 2, T030, T044 (partial).

- [X] T052 **HIGH — F3** Carry resumed active-model substitutions into startup warnings in `packages/coding-agent/src/sdk.ts` and the existing session warning integration. The SDK calls `session.repointCyberMode()` at line 4119, after the constructor ends its warning-capture window at `src/session/agent-session.ts:1681`. The resulting notice has no startup subscriber and does not enter `configWarnings` or `modelFallbackMessage`. A memory-only recorded-on resume probe moved Sonnet to Haiku with an empty startup warning list. Its raw default role already named Haiku, so no role-substitution warning masked the missing active-model report. Keep runtime repoint notices and avoid duplicate startup warnings. Verify the SDK's returned startup warning surface with configuration cyber mode off and recorded cyber mode on. Per FR-010, FR-011, SC-003, plan D6 and Integration point 1, T044 (partial).

- [X] T053 **HIGH — F4** Apply cyber revalidation and transcript-scoped notices to `fork()` and `branchFromBtw()` in `packages/coding-agent/src/session/agent-session.ts`. Both create a new transcript without the cyber adoption block used by `branch()`. The omissions occur in the fork path at lines 8905–8946 and the side-answer branch path at lines 10657–10695. A memory-only `/btw` branch with an emptied declaration remained on, recorded on, and emitted no warning. Reuse shared restoration behavior, reconcile the active model, record degradation, and preserve foreign protection claims. Report substitutions once for each new transcript. Cover empty, unresolved, and changed valid declarations for both paths. Per FR-012, FR-024, FR-026, FR-030, plan D5/D6 and the referenced data-model transition matrix, T030, T044, T046 (partial).

- [X] T054 **MEDIUM — F5** Preserve role/model report deduplication when `reload()` calls `switchSession()` on the current transcript in `packages/coding-agent/src/session/agent-session.ts`. The unconditional clear at line 10231 repeats the startup task-to-Haiku warning on a same-file reload. A live memory-only probe observed both copies while the transcript and selected model stayed unchanged. Reset the report scope only after adopting a different transcript, consistently with the rollback fix. Test repeated same-file reloads and retain coverage that a different transcript can report the same substitution. Per FR-012, plan D6, T044 (partial).

## Phase 13: Convergence

- [X] T055 **HIGH — F1** Deliver cyber startup warnings through noninteractive diagnostic channels before the first model call.
  Update `packages/coding-agent/src/main.ts` and its print, RPC, and ACP startup consumers.
  The SDK already returns resumed substitutions through `session.configWarnings`, as plan D6 permits.
  Do not require moving those warnings to `modelFallbackMessage` or duplicating them across both collections.
  `main.ts:2258–2259` queues fallback warnings for the TUI.
  Its noninteractive stderr branch at `:2267–2279` reports them only when no model exists.
  The print handoff at `:2340–2347` omits startup diagnostics.
  `src/modes/print-mode.ts:137–183` neither consumes `session.configWarnings` nor replays notices emitted before subscription.
  The RPC handoff at `main.ts:2282–2286` also omits startup diagnostics.
  The ACP factory at `main.ts:502–543` discards the returned fallback message, and ACP bootstrap does not consume configuration warnings.
  Memory-only SDK/print probes resumed recorded-on Sonnet onto Haiku with one pending cyber warning.
  Text output contained no warning, and JSON output contained only the session header.
  Reuse existing mode-appropriate diagnostic channels and preserve JSON/RPC framing.
  Report each applicable warning once, including successful launches/resumes, changed roles, and unusable declarations.
  Cover text, JSON, RPC, and ACP consumers without model requests.
  Preserve interactive startup reporting and runtime notices.
  Per FR-010, FR-011, FR-012, FR-027, SC-003, the noninteractive edge case, plan D6 and Integration point 1, T044/T052 (partial).

## Phase 14: Convergence

- [X] T056 **HIGH — F1** Finalize ACP startup warnings only after the requested transcript is ready.
  Update the diagnostic handoff in `packages/coding-agent/src/main.ts` and the ACP startup consumers in `src/modes/acp/acp-agent.ts`.
  `main.ts:2086–2101` prints the temporary session's configuration warnings and subscribes to later cyber notices.
  ACP `#openStoredSession` and `#forkManagedSession` then adopt another transcript, whose role-report scope starts fresh.
  Memory-only probes of the current handoff and real session adoption printed the same task-to-Haiku warning twice.
  A saved profile that already chose Haiku still received the temporary session's task warning.
  Emit only applicable startup diagnostics for the final transcript, once per affected role/model, before its first model call.
  Discard role and model-substitution warnings that describe only the temporary session.
  Cover ACP new, load/resume, and fork, including configured-on resume and saved-profile overrides, without model requests.
  Preserve text/JSON/RPC warnings, unusable-configuration warnings, stdout framing, SDK diagnostic fields, interactive reporting, and runtime notices.
  Preserve legitimate reports for later transcripts rather than suppressing warnings globally.
  Per FR-010, FR-011, FR-012, US2/AC6, SC-003, plan D6 and Integration point 1, T055 (partial).

## Phase 15: Convergence

- [X] T057 **HIGH — F1** Constrain background model selection and recovery to the installed cyber allowlist.
  Update `packages/coding-agent/src/session/session-advisors.ts`, `src/eval/completion-bridge.ts`, and `src/tiny/online-candidates.ts`.
  Advisor overrides resolve outside the allowlist at `session-advisors.ts:880`.
  Advisor recovery and primary restoration also bypass membership checks at `:1535–1551` and `:1681–1691`.
  Eval completion resolves primary candidates directly at `completion-bridge.ts:223–227` and appends unchecked retry candidates at `:200–208`.
  Online tiny tasks append unchecked retry candidates at `online-candidates.ts:90–100`.
  `expandOnlineTinyModelFallbacks` also retains its supplied current model without a membership check at `:180–185`.
  The title generator consumes that current-model fallback at `src/utils/title-generator.ts:125–140`.
  Memory-only probes installed a Haiku-only allowlist and selected Sonnet through an explicit advisor override.
  Tiny candidate collection also included Sonnet, and an eval completion attempted Sonnet after a simulated Haiku failure.
  With a reduced catalog, eval completion selected `anthropic/claude-haiku-4-5-extra` although only `anthropic/claude-haiku-4-5` was allowlisted.
  Reuse the installed resolved membership rule for background primaries, explicit overrides, fallback expansion, current-model fallbacks, and primary restoration.
  Do not let a direct registry lookup restore a rejected candidate.
  Skip excluded recovery entries and continue to the next allowed candidate.
  Preserve normal exhaustion behavior without making an excluded model call.
  Honor shared protection even when the calling session's own cyber state is off.
  Preserve unprotected selection, ordinary selector matching, and launch substitution behavior.
  Add regression checks for actual advisor selections and completion attempts, not only filtered role values.
  Cover allowed candidates after excluded entries, transitive chains, aliases, thinking selectors, reduced catalogs, shared protection, and exhausted recovery.
  Use fixed generated inputs where applicable and stub provider transport so the checks make no external requests.
  Per FR-006, FR-013, FR-018, FR-030, FR-031, SC-001/SC-010, plan D1/D3 and the advisor assumption under Internal bypasses (partial).

- [X] T058 **LOW — F2** Route cyber startup validation through the planned model-role validation path.
  T010 names `packages/coding-agent/src/config/model-roles.ts` as that entry point, but it currently contains no cyber validation call.
  `src/session/agent-session.ts:1696–1701` instead calls `validateCyberMode` directly.
  Warnings already reach `configWarnings`, so this finding concerns the specified integration point, not missing warning behavior.
  Keep the pure validator in `src/config/cyber-mode.ts`, as T003 requires.
  Integrate its call through `model-roles.ts` and remove the separate direct validation call from the session constructor.
  Preserve the available-model catalog, missing-catalog handling, warning handoff, and existing diagnostic behavior.
  Use the existing malformed, duplicate, and unresolved declaration checks to verify behavior without duplicate warnings.
  Do not add a test that merely pins the validator's file location.
  Per T003/T010 and plan Source Code: `config/model-roles.ts` startup-warning integration (partial).

**T057 scope clarification:** Include `packages/coding-agent/src/judgment/index.ts:201–203`.
`OnlineChatJudge` appends `sessionModel` after collecting online tiny candidates, without checking cyber membership.
A memory-only probe with a Haiku-only allowlist reached credential lookup for the excluded Sonnet session fallback.
The probe supplied no credentials and made no provider requests.
Apply membership checks when constructing or appending background candidates, including completion primaries and the judgment session fallback.
Preserve `resolveModelRoleValue`'s explicit excluded-model lookup behavior, which lets the operator switch guard produce its cyber-specific refusal.
`test/cyber-mode.test.ts:289–290` records that intentional behavior.
This extends F1's affected paths and T057's acceptance scope, not the finding or task count.

## Phase 16: Convergence

- [X] T059 **CRITICAL — F8** Remove the eager module-scope read that the T058 integration turned into a load-order crash.
  `src/config/model-roles.ts:7` imports `validateCyberMode` from `./cyber-mode`, which imports `./model-resolver`, which reads `MODEL_ROLE_ALIAS_PREFIX` and `LEGACY_MODEL_ROLE_ALIAS_PREFIX` at module scope to build `MODEL_ROLE_ALIAS_PREFIXES` (`model-resolver.ts:1086`).
  `model-resolver` returns to `model-roles` while that module is still evaluating, so the read lands in the temporal dead zone: importing `model-roles` before `model-resolver` throws `ReferenceError: Cannot access 'MODEL_ROLE_ALIAS_PREFIX' before initialization`.
  Reproduced by importing `validateModelRoleConfiguration` from `model-roles` in a fresh test file and calling it; the process fails during module evaluation.
  Move the prefix array and its lookup inside `modelRoleAliasPrefixLength`, or otherwise drop the top-level read of a `model-roles` binding from `model-resolver`.
  Keep the single startup entry point T058 established: one `validateModelRoleConfiguration` call from the session constructor, with `validateModelProfiles` and the pure `validateCyberMode` both invoked unconditionally when a catalogue is supplied.
  Prove the fix with a fresh import of `model-roles` that evaluates the module graph and calls the entry point, since the existing suite only reaches the cycle from the `model-resolver` side.
  Per T058, plan D8 and plan `Source Code: config/model-roles.ts` startup-warning integration (contradicts).

- [X] T060 **HIGH — F9** Gate tiny role primaries with the shared membership rule.
  `collectOnlineTinyCandidates`'s `addPrimary` (`src/tiny/online-candidates.ts:123–128`) pushes every resolved role primary unconditionally, while the fallback helper added for T057 gates its own `out.push` behind `cyberAllowsModel`.
  `resolveRoleSelection` deliberately preserves an explicit excluded-model lookup, so a role configured to an excluded model reaches a background caller as a primary candidate.
  Gate the primary output the same way, while returning the traversal outcome unchanged so the excluded primary still seeds its configured fallback chain and its allowed descendants are discovered.
  Add a regression that fixes the role to an excluded model, keeps an allowed entry after it in the chain, and asserts the allowed entry is the one requested.
  Per FR-013, FR-018, T057 acceptance and the shared-membership rule (partial).

- [X] T061 **HIGH — F10** Gate context promotion's target with the shared membership rule.
  `resolveContextPromotionTarget` (`src/session/session-maintenance.ts:3177–3190`) resolves a larger-context model through `resolveContextPromotionConfiguredTarget` and returns it after a credential lookup, with no membership check, and `maybePromoteContextWindow` (`:3157–3161`) then switches the session to it.
  This is a separate path from the gated `resolveCompactionModelCandidates` chain, so a session under an installed allowlist can be moved onto an excluded larger-context model by an automatic overflow promotion.
  Apply the shared predicate before the credential lookup and return `undefined` when the candidate is excluded, leaving the session where it is.
  Cover the excluded-target case with a stubbed registry so no provider request is made, and keep the existing promotion behavior for an allowed target.
  Per FR-013, FR-031, T057 acceptance and plan `Recovery paths` (partial).

- [X] T062 **HIGH — F11** Gate the memory model's configured-role resolution.
  `resolveMemoryModel` (`src/memories/index.ts:1272–1284`) returns the resolved `smol`/`default` role model immediately, before the protected tail at `:1286–1295` that checks `cyberAllowsModel` and falls back through `resolveCyberTarget`.
  Because explicit excluded lookups are preserved in the resolver by design, a role configured to an excluded model hands memory an excluded model and skips every protected fallback.
  Gate the role result with the shared predicate and continue to the protected fallback when it is excluded, rather than changing the resolver's explicit-lookup semantics.
  Add a role-configured regression that asserts the excluded model is never returned and the protected target is.
  Per FR-013, FR-018, T057 acceptance and the shared-membership rule (partial).

- [X] T063 **HIGH — F12** Gate the remaining direct background completions on a resolved model.
  `resolveSharpshooterModel` (`src/sharpshooter/extract.ts:156–162`) resolves the explicit `sharpshooter.model` selector and returns it before falling back to the `smol` role, and `:217` completes on it; `src/edit/auto-repair.ts:294–299` resolves the `smol` role, records a credential, and completes on it.
  Neither path checks membership, so both can dispatch a background completion on an excluded model.
  Apply the shared predicate at each model-call seam: refuse the explicit selector when it is excluded and fall back to the role chain, and stop the repair path before its credential lookup when the resolved role model is excluded.
  Keep the existing no-model behavior and the debug reporting unchanged.
  Verify with stubbed transport so neither check makes a provider request.
  Per FR-013, FR-018 and T057 acceptance (partial).

- [X] T064 **HIGH — F13** Constrain the allowlist's own fallback target to an allowlisted identity.
  `resolveCyberTarget` (`src/config/cyber-mode.ts:265–279`) passes `allowlist.primary` to `resolveModelRoleValue`, and `resolveAllowlistFrom` builds that value with the declaring entry's thinking suffix (`:134–137`) while `allowlist.keys` holds bare identities.
  `resolveModelRoleValue`'s excluded-selector branch (`src/config/model-resolver.ts:1486–1490`) only suppresses a match when the selector's intended identity is allowlisted; otherwise it returns the fuzzy match, so a reduced catalogue can hand back an excluded sibling through this step.
  Compare the resolved model against `allowlist.keys` by its concrete identity, or resolve the stored selector against `allowlist.catalog` first, and return `undefined` when no allowed identity matches.
  Keep the role-chain steps and their order unchanged, and preserve the documented "no approved target remains" outcome for launch substitution.
  Per FR-010, FR-024, T057 acceptance and the reduced-catalogue rule (partial).

- [X] T065 **HIGH — F14** Gate vision model selection with the shared membership rule.
  Both `src/utils/image-question.ts:53–66` and `src/utils/image-vision-fallback.ts:114–119` resolve `@vision`, `@default`, the active model, then fall back to scanning every available vision-capable model, with no membership check, before completing on the result.
  An installed allowlist therefore does not constrain either vision path.
  Apply the shared predicate to each candidate in the scan order, so an excluded model is skipped and the next candidate is tried, and report the existing "no vision model" outcome when nothing allowed remains.
  Keep the fallback ordering and the existing user-facing notes unchanged.
  Per FR-013, FR-018 and the shared-membership rule (partial).

- [X] T066 **HIGH — F15** Carry the parent's live protection and configured roles into subagent settings.
  `createSubagentSettings` (`src/task/executor.ts:975–990`) copies every schema key through `baseSettings.get`, so the child snapshot takes `modelRoles` from the cyber-filtered merged view and only the configuration value of `cyberMode`.
  A parent that enabled cyber mode at runtime installs protection without writing `cyberMode` to configuration (`src/session/model-controls.ts:572–600` persists nothing; only `/cyber on global|project` calls `setProjectCyberMode`), so the child starts unprotected even though FR-030 requires a subagent to inherit its parent's protection.
  The filtered snapshot also becomes the child's raw role view, so releasing protection in the child restores already-filtered chains instead of the configured values (FR-028).
  Snapshot `modelRoles` from `baseSettings.getRawModelRoles()` and install the parent's installed allowlist on the child settings when one is present, keeping the unprotected snapshot unchanged when none is installed.
  Assert both halves: a child of a runtime-protected parent refuses an excluded model, and a child whose protection is released resolves its configured chain again.
  Per FR-028, FR-030, FR-001 and plan D1 (partial).

**T060 scope clarification:** The `addPrimary` guard is not needed, and adding one would be unreachable code.
The premise ("a role configured to an excluded model reaches a background caller as a primary candidate") does not hold:
`resolveRoleSelection` reads `settings.getModelRole`, which returns the cyber-filtered merged view, so a configured
excluded role arrives as the substituted allowlisted identity, and a surviving selector resolves to an allowed model
or to `undefined`. A probe with a reduced catalogue (`getModelRole("tiny")` = `p/shared-model`, catalogue =
[`p/shared-model-extra`]) produced an empty candidate list with and without the guard. The asymmetry with the fallback
walk is justified by provenance: the fallback walk resolves user-configured chain strings, which can name excluded
models, while `addPrimary` receives the filtered role resolution. `src/tiny/online-candidates.ts:127–129` now records
that invariant at the call site instead of carrying a dead guard.

**T061 scope clarification:** Gated as specified. `resolveContextPromotionTarget` now returns `undefined` for a
candidate outside the installed allowlist, before the credential lookup, so no provider request is made.
`test/compaction-cyber-candidates.test.ts` covers the excluded target (stubbed registry, no request) and keeps the
allowed-target promotion. The behavioral test in `test/advisor-context-maintenance.test.ts` that was written first did
not discriminate the gate, so it was removed rather than kept as a passing decoration.

**T062 scope clarification:** No membership check was added: the premise ("a role configured to an excluded model hands
memory an excluded model and skips every protected fallback") does not hold. `resolveMemoryModel` reads
`settings.getModelRole`, which returns the cyber-filtered merged view, so the resolver always receives an allowlisted
selector or an already-substituted identity. A property probe over every subset of an eight-model two-provider
catalogue (allowlist declaration × reduced catalogue × role value) found zero cases where a filtered role read
resolved to an excluded model, because `resolveModelRoleValue` suppresses a fuzzy sibling when the selector's intended
identity is allowlisted. Independently, both memory dispatch seams already refuse an excluded model
(`src/memories/index.ts:786`, `:934`), so an excluded model cannot reach a request even if selection returned one.
`src/memories/index.ts:1278–1280` records the invariant, and `test/memories-runtime.test.ts` pins the operator-visible
outcome: roles configured to an excluded model still land both stages on the allowed model.

**T063 scope clarification:** The sharpshooter half was a real hole and is fixed. `sharpshooter.model` is raw
configuration, not a role read, so cyber mode's role filtering never saw it; `resolveSharpshooterModel` now refuses an
excluded selector and falls through to the `smol` role chain, and `test/sharpshooter-extract.test.ts` proves an excluded
selector lands on the allowed role model (red without the gate, green with it).
The auto-repair half was refuted: `attemptEditAutoRepair` resolves through `resolveRoleSelection(["smol"], …)`, which
reads the cyber-filtered role view, and a property probe over every subset of an eight-model two-provider catalogue
(allowlist declaration × reduced catalogue × role value) found no case where it returns an excluded model. No gate was
added there, so the credential lookup and the completion remain unreachable for an excluded model.

**T064 scope clarification:** No change was made: the premise does not hold for the primary step. `allowlist.primary` is
always an allowlisted identity — the declaration must match an available model to enter the allowlist, unqualified
declarations resolve against `modelProviderOrder` into provider-qualified identities, and the thinking suffix is
stripped for `allowlist.keys` while both forms stay in the same family. `resolveModelRoleValue` (`src/config/model-resolver.ts:1486–1500`)
re-resolves a pattern whose match is outside the allowlist against `cyberAllowlist.catalog`, and suppresses the match
when that intended identity is allowlisted, which the primary always is. A property probe over every subset of a
six-model two-provider catalogue (95,256 checks across role, default, and task roles with a reduced catalogue, a
suffixed declaration, and a suffixed role value) found no case where `resolveCyberTarget` returns an excluded model.

**T065 scope clarification:** Both vision paths are gated. `resolveImageQuestionModel` skips an excluded candidate in
its pattern resolution and in both catalog scans, and `resolveVisionModel` does the same, so an excluded model is
skipped and the next candidate is tried, while the existing "no vision model" outcomes stay unchanged. Tests:
`test/utils/image-question.test.ts` (excluded-first scan lands on the allowed model, and reports the existing outcome
when only excluded vision models remain) and `test/utils/image-vision-fallback.test.ts` (an excluded vision model is
unavailable, so the no-vision note and saved artifact are produced). Both redden without the gate.

**T066 scope clarification:** The `modelRoles` half is fixed: `createSubagentSettings` snapshots
`baseSettings.getRawModelRoles()`, so the child re-derives the parent's filtered view from the configured chains and
releasing protection in the child restores the configurations rather than the parent's filtered ones (FR-028), proven in
`test/cyber-mode-shared-settings.test.ts`. The protection-inheritance half was already present — the function installs
the parent's live allowlist under the `parent` owner, and the existing nested-snapshot test covers a runtime-enabled
parent whose configuration still records `cyberMode` off.

## Phase 17: Convergence

- [X] T067 **HIGH — F16** Constrain commit-message generation to the installed cyber allowlist in
  `packages/coding-agent/src/utils/commit-message-generator.ts`. `getSmolModelCandidates` (`:44–76`) adds the
  configured `smol` role, then every `MODEL_PRIO.smol` priority match against the whole available catalog
  (`:65–69`), then every available model (`:71–73`), with no membership check, and `generateCommitMessage` walks
  that list and dispatches `completeSimple` on the first candidate holding an API key (`:106–111`).
  The path runs on live session settings: `makeIsolationCommitMessage` (`src/task/isolation-runner.ts:171`)
  passes `session.settings`, so an isolated run with `task.isolation.commits: "ai"` dispatches a background
  completion outside the allowlist whenever the allowlisted candidate is unavailable or errors. Verified by
  probe: with the allowlist `openai/gpt-5-mini`, the catalog [`anthropic/claude-haiku-4-5`,
  `openai/gpt-5-mini`], and no `smol` role configured, `completeSimple` was called with
  `anthropic/claude-haiku-4-5`.
  Skip an excluded candidate the way the gated sibling surfaces do, keep the remaining candidate order, and
  assert in a test that every dispatched model is inside the installed allowlist.
  Per FR-013, SC-010 and the shared-membership rule (missing).
  Note: `src/commit/model-selection.ts` (`resolvePrimaryModel`/`resolveSmolModel`) has the same unfiltered
  shape but is reachable only from the standalone `omp commit` and git-tui entry points, which install no
  protection; it stays out of scope unless those entry points gain a session.

- [X] T068 **MEDIUM — F17** Prove that toggling cyber mode during a streaming turn leaves the in-flight turn
  on the model it started with, and applies the re-pointed model to the next call, per the Edge Cases entry
  "The operator toggles cyber mode while a turn is streaming" and FR-008 ("MUST take effect for the next model
  call, because a streaming turn cannot change its model mid-flight"). Nothing covers this combination today,
  and the re-point runs through `setModelTemporary`, which calls `setModelWithProviderSessionReset`
  (`src/session/model-controls.ts:316–325`) and can tear down the provider session state an open stream is
  using. Add a test that starts a turn whose stream stays open, enables cyber mode, releases the stream, and
  asserts the turn completes on its original model while the following call uses the allowlisted model.
  Fix the re-point if it disturbs the open stream.
  Per FR-008, Edge Cases (partial).

- [X] T069 **MEDIUM — F18** Prove FR-022 in the `/clear` path. T028 required a `/clear` case in
  `packages/coding-agent/test/cyber-mode-session.test.ts` and none exists; `resetSessionContext`
  (`src/session/agent-session.ts:5412`) never touches cyber state, so the behavior holds by inspection alone.
  Assert that after `resetSessionContext()` the session still reports cyber mode on with its allowlist
  installed, that the indicator still renders, and that the following recorded model-change entry carries the
  state, so a later resume reads it back.
  Per FR-022, US4/AC2 (partial).

## Phase 18: Convergence

- [X] T070 **HIGH — F19** Gate the speech enhancer's model dispatch in
  `packages/coding-agent/src/tts/speech-enhancer.ts`. `SpeechEnhancer.rewrite` resolves
  `resolveModelRoleValue("@tiny", registry.getAvailable(), { settings })` (`:77`) and calls
  `completeSimple` on the result with no membership check (`:88`). The enhancer is wired with
  live session settings (`event-controller.ts:236–241` passes `session.settings`), so with
  `speech.enhanced` on and cyber mode installed, speech rewriting dispatches to a model the
  allowlist excludes.
  The `@tiny` alias is what makes this reachable: with `modelRoles.tiny` and `modelRoles.smol`
  unset (the default), `resolveConfiguredRolePattern` falls through to the role's static
  priority defaults (`src/priority.json` smol chain), which the cyber filter never rewrites
  because it filters configured role values, not role defaults.
  Verified by probe: allowlist `openai/gpt-5-mini`, catalog [`anthropic/claude-haiku-4-5`,
  `openai/gpt-5-mini`], both `resolveModelRoleValue("@tiny", …)` and
  `resolveModelRoleValue("@smol", …)` returned `anthropic/claude-haiku-4-5`.
  Return `null` when the resolved model is excluded, which is the enhancer's existing
  "no model" contract: the vocalizer already falls back to mechanical normalization
  (`vocalizer.ts`). Add a test asserting no excluded model is dispatched.
  Per FR-013, SC-010 (missing).
  Note: `resolveModelRoleValue` deliberately returns a resolved model even when the allowlist
  excludes it (`model-resolver.ts:1494–1497` only skips a pattern whose intended identity the
  allowlist covers), because launch and CLI callers resolve first and substitute or refuse
  later (FR-010, FR-024). Do not change that contract; gate the surface, as
  `utils/image-question.ts:51`, `sharpshooter/extract.ts:166`, `memories/index.ts:786` and
  `judgment/index.ts:223` already do.

## Phase 19: Convergence

- [X] T071 **HIGH — F20** Gate the advisor runtime's initial model selection in
  `packages/coding-agent/src/session/session-advisors.ts`. `#resolveAdvisorRuntimeDescriptors`
  gates the explicit `config.model` override (`:897`) but assigns the role-chain result
  ungated at `:903-915`: when `config.model` is unset, `resolveAdvisorRoleSelection` returns a
  model that is handed to `descriptors` and becomes `advisorAgent`'s `initialState.model`
  (`:1127`), which the advisor streams on through `advisorStreamFn`. Per FR-013 and SC-010 a
  background model call MUST stay inside the allowlist.
  `@advisor` is what makes this reachable: with `modelRoles.advisor` and `modelRoles.slow`
  unset, `resolveConfiguredRolePattern` falls through to the role's static priority defaults
  (`src/priority.json` slow chain), and the cyber filter rewrites configured role values only.
  Verified by probe: allowlist `openai/gpt-5-mini`, catalog [`anthropic/claude-opus-5`,
  `openai/gpt-5-mini`], `resolveAdvisorRoleSelection(settings, catalog)` returned
  `anthropic/claude-opus-5`.
  Apply the same check the three sibling sites already use (`:897`, `:1555`, `:1704`): when the
  role result is excluded, report `no_model` for that advisor rather than running it on an
  excluded model, and add a test asserting no advisor is built on an excluded model when the
  role chain falls through to the defaults.
  Per FR-013, SC-010 (missing).

## Phase 20: Convergence

- [X] T072 **MEDIUM — F21** Report cyber substitutions that land a role on the primary cyber model through a static priority chain.
  The fallback report covers only the roles the configuration names: `planCyberChanges` (`src/config/cyber-mode.ts`) iterates the configured role map (`roles[role]` present and non-empty), so `#reportCyberChanges(#planCyberReport())` cannot name a role whose chain comes from the built-in defaults. `@advisor` expands to the `slow` priority chain and `@tiny` to the `smol` chain even with no role configured, so those resolutions are substituted or refused without any notice.
  A probe (protected session, allowlist `[openai/gpt-4o-mini]`, catalogue `[anthropic/claude-opus-5, openai/gpt-4o-mini]`, `advisor` and `slow` unset) built the advisor on `openai/gpt-4o-mini` -- the static chain's `anthropic/claude-opus-5` substituted -- and collected zero notice events. `src/tts/speech-enhancer.ts` returns null for an excluded `@tiny` resolution with only a debug log.
  Report the affected role and the model it landed on through the surface's existing notice channel (the advisor host already carries the sibling no-model warning through `emitNotice(..., "advisor")`), or route the static-chain resolution through the reported role layer. Dedup per session on `{ role, landed }` so a role the toggle already named is not repeated (FR-012). Cover the advisor substitution and the `@tiny` speech fallback.
  Per FR-011, SC-003 and the fallback-report entity in `spec.md` (partial).

## Phase 21: Convergence

- [X] T073 **HIGH — F22** Hand the advisor's cyber substitution report to the startup warning channels while the session is still constructing.
  The report T072 added reaches `#reportCyberChanges`, which calls `emitNotice`, but the advisor runtime is built from the `SessionAdvisors` constructor (`src/session/session-advisors.ts:486`) when `advisor.enabled` is true in configuration, and the session has no notice listener yet. `ModelControls` already solves this for its own constructor notices (`src/session/agent-session.ts:1674-1679`: push to `configWarnings`, plus `startupCyberWarnings` for a `cyber` source) and the constructor-time role report does the same before `#emit` has listeners.
  Probe: a session built with `advisor.enabled: true`, `cyberModels: [openai/gpt-4o-mini]`, catalogue `[anthropic/claude-opus-5, openai/gpt-4o-mini]`, and `advisor`/`slow` unset built its advisor on `openai/gpt-4o-mini`, and a subscription attached immediately after construction received no cyber notice, `configWarnings` held no advisor message, and `startupCyberWarnings` held none either. The ACP reporter flushes `configWarnings` on readiness (`src/main.ts:478-500`), so it cannot recover the message either.
  Route the advisors host's `emitNotice`/`reportCyberRoleChange` through the same startup handoff the other constructor-time warnings use, so the report survives to the modes that flush `configWarnings` and to the SDK startup capture. Cover a configured-startup advisor substitution reaching the startup warning list, and keep the live runtime report arriving as a notice.
  Per FR-011, SC-003 (partial).

- [X] T074 **LOW — F23** Scope the speech rewrite's cyber report to the transcript, not the enhancer instance.
  `SpeechEnhancer.#reportedCyberTiny` (`src/tts/speech-enhancer.ts:63,76-77`) is set once and has no clearing site, while the enhancer is constructed once per interactive run (`vocalizer.setEnhancer`, `src/modes/controllers/event-controller.ts:234`). The session treats this report as per-transcript: it clears `#reportedCyberChanges` on `/new`, `/delete`, fork, branch, session switch, and reload (`src/session/agent-session.ts:8818, 8943, 10246, 10561, 10702`) with the comment "a fresh transcript also starts its own dedup set (FR-012), so a substitution already reported on the outgoing transcript is reported again here". After a transition, the operator gets no explanation for the degraded rewrite again.
  Report through the session's transcript-scoped dedup instead of an instance latch (the advisor's `reportCyberRoleChange` is the sibling seam), and cover a `/new` or session-switch case where the report appears again on the new transcript while a second spoken block in the same transcript stays silent.
  Per FR-012 (partial).
