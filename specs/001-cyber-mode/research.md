# Phase 0 Research: Cyber Mode

All unknowns carried out of the plan's Technical Context are resolved below.
Each entry records the decision, why it was chosen, and what was rejected.

## D1 — Where the role filter is applied

**Decision**: Derive the filtered chains from the merged role view inside
`Settings.#rebuildMerged()` (`packages/coding-agent/src/config/settings.ts:3227`).
The overlay stores the resolved allowlist, not a filtered map. After the
four-layer merge produces `#merged`, and only while a filter is installed,
`#rebuildMerged()` filters `#merged.modelRoles` against that allowlist and writes
the result back, memoized per raw role value.

**Deriving per merge is required, not an optimization.** A stored filtered map
goes stale the moment the runtime role layer is replaced:
`applyModelProfileRoles` (`settings.ts:1475`) replaces that layer wholesale and
re-runs `#rebuildMerged()`. A frozen map spread over the new view would mask the
roles the incoming profile names, while roles the profile newly introduces would
have no filtered entry at all and would resolve outside the allowlist. That
breaks FR-006 and FR-013, which are the feature's core promise. Deriving from the
current effective roles on every merge cannot go stale, because every path that
changes the role layer re-merges.

The filter is installed through an **owner-guarded** pair, not a bare setter:

```ts
/** Install protection for the owning session, or for the configuration. */
applyCyberRoles(owner: string, allowlist: ResolvedCyberAllowlist): void;
/** Clear protection. Implicit callers clear only what they installed. */
clearCyberRoles(owner: string, options?: { operator?: boolean }): void;
```

An explicit operator switch-off passes `{ operator: true }` and always clears.
The implicit path, a session adopting a recorded state, passes only its owner and
therefore cannot remove protection another session or the configuration
installed (FR-030).

**Rationale**: Every role-resolution surface reads roles through
`settings.get("modelRoles")` or `settings.getModelRole(role)`, both of which
resolve against `#merged`. Filtering there satisfies FR-013 as a structural
property rather than as a list of call sites to remember. The same seam already
carries the model profile's runtime role layer, so this is an existing pattern.
`#merged` is also not a persistence source: saves write the raw `#global` and
`#project` layers, so filtered values cannot reach `config.yml`.

**Scope, and why the filter is not per-session-isolated.** A nested
`createAgentSession()` shares *the same live `Settings` instance* with an
already-running parent. This is not hypothetical: it is asserted by
`packages/coding-agent/test/sdk-nested-session-shared-settings.test.ts`, whose
own comment records that `agents-hub.ts` passes `settings: this.#settings`
straight through.

One merged role view cannot hold two different cyber states at once. Rather than
pretend otherwise, the requirement is scoped to match the mechanism, as the
active model profile already is: protection belongs to the configuration state a
session runs against, and sessions that share that state share one protection
(FR-029). Two rules keep sharing safe:

- **Installing is always allowed** (FR-030). A session that turns protection on
  protects every session sharing its configuration.
- **Removing requires ownership.** `clearCyberRoles(owner)` is a no-op unless the
  caller installed the filter. A nested session therefore cannot silently drop
  its parent's protection, which would be the exact inversion of the feature's
  promise.

The visible consequences are therefore: a nested session inherits its parent's
protection, and enabling protection in a nested session also protects the parent.
Both directions add protection. Neither removes it. The price is that cyber state
is not isolated per session instance; the return is one choke point instead of
twenty.

**Alternatives considered**:
- *Route every role-resolution boundary through a session-scoped lookup* —
  rejected as disproportionate, not as unsafe. It is the only route to true
  per-session isolation, but the boundary list spans roughly twenty call sites:
  `main.ts`, `sdk.ts`, `commit/model-selection.ts`, `edit/auto-repair.ts`,
  `memories/index.ts`, `mnemopi/backend.ts`,
  `extensibility/extensions/model-api.ts`, `eval/completion-bridge.ts`,
  `modes/components/{model-hub,model-browser,agents-hub}.ts`,
  `modes/controllers/selector-controller.ts`, and
  `session/{model-controls,role-models,session-maintenance}.ts`. Missing one
  silently breaks FR-013, the requirement that matters most.
- *Filter inside `resolveModelRoleValue` per call* — rejected: it is the hot path,
  it would re-resolve the allowlist on every role lookup, and it still misses
  consumers that read `getModelRoles()` directly.
- *Filter by installing runtime overrides via `overrideModelRoles`* — rejected:
  the runtime layer is wholesale replaced by `applyModelProfileRoles`, so any
  profile switch would silently drop the filter. Deriving the filter inside
  `#rebuildMerged()` is downstream of that replacement, so it survives it.
- *Persist the on state as a configuration value* — rejected: it would write
  protection into `config.yml` and change the operator's saved configuration,
  contradicting the session persistence the feature requires.

## D10 — Where the startup overlay is installed

**Decision**: Install the overlay at settings bootstrap, in both entry points, at
the earliest point where a model source exists and before the first role read. The
helper takes the available-model set, because resolving the allowlist needs it.

- `sdk.ts`: immediately after `modelRegistry` is created at `sdk.ts:1382-1387`,
  and before `settings.getModelRole("default")` at `sdk.ts:1558`. This is the
  authoritative startup path, and it covers the CLI too, because the CLI calls
  `createAgentSession` with the same settings instance.
- `main.ts`: immediately after `modelRegistry` is created at `main.ts:1741`.
- The initial `model_change` entry written at `sdk.ts:3787` carries the cyber
  state in effect.

**Rationale**: role resolution precedes the session. `createAgentSession` reads
`settings.getModelRole("default")` at `sdk.ts:1558` and resolves the launch role at
`:1576-1585`, while `new AgentSession` is constructed at `:3865`. Installing from
the session constructor would leave a `cyberMode: true` start resolved unfiltered,
which breaks FR-006 on the first turn.

**The model source is the binding constraint, not the settings instance.**
`Settings` holds configuration only, and the filter compares resolved model
identity, so the allowlist cannot be resolved without a model catalogue. That is
why the install point is tied to `modelRegistry` rather than to `settings`.

**Known boundary in the CLI**: `main.ts` reads roles at `:1274` and `:1322`, and
builds a role lookup at `:1399`, all before the registry exists at `:1741`. Those
reads cannot be filtered, because no model source exists yet. The consequence is
bounded: the startup model itself is resolved later, at `sdk.ts:1581`, through the
filtered settings, and an explicit launch model is covered by the substitution in
T015. What the early reads can still affect is the CLI's scoped thinking-level
seed, not which model the session runs. This is recorded as an accepted boundary
rather than papered over.

**Alternatives considered**:
- *Install in the `AgentSession` constructor* — rejected: too late, per the
  ordering above. This was the original design and it was wrong.
- *Create the registry earlier in `main.ts` so the CLI install can precede
  `:1274`* — rejected as disproportionate: it reorders CLI initialization, which
  has its own reasons for its current order, to close a gap that cannot change
  which model the session runs.
- *Install lazily at the first role read* — rejected: it spreads the install
  across every read path and reintroduces the call-site enumeration D1 exists to
  avoid.
- *Store the allowlist unresolved and resolve it at merge time* — rejected: the
  merge has no model source either, which is the same constraint one level down.

## D2 — Where operator model switches are guarded

**Decision**: Guard `ModelControls.setModel` (`model-controls.ts:253`) and
`ModelControls.setModelTemporary` (`model-controls.ts:280`), above the
`#host.setModelWithProviderSessionReset` call. `applyRoleModel` needs no guard
because it calls `setModel`.

**Rationale**: Exhaustive enumeration of all fifteen operator-facing paths found
a single convergence: the picker, both cycle bindings, both profile bindings,
`/model`, `/switch`, `/model-profile`, plan transitions, commit and task binding,
extensions, RPC, ACP, the setup wizard, and prewalk all route through one of
these methods. A guard here satisfies FR-009 with one implementation. Placing it
above the provider-session reset means a refusal costs nothing and leaves no
partial state.

**Alternatives considered**:
- *Guard each command handler* — rejected: fifteen call sites to keep in sync,
  and a new surface added later would silently bypass the protection.
- *Guard in the UI pickers only* — rejected: the pickers are not the only entry
  point. RPC, ACP, and extension surfaces would stay open.

## D3 — How a chain entry is matched against the allowlist

**Decision**: Resolve both sides to concrete models with the existing resolver,
then compare model identity. An allowlist entry is resolved once per toggle via
`resolveConfiguredModelPatterns` + `resolveModelRoleValue` against the available
model set, producing a set of concrete models. A chain entry is resolved the same
way, and survives when its resolved model is in that set.

**Rationale**: Chain entries are not plain strings. They may be globs, aliases
such as `@slow`, or carry a thinking suffix such as `:high`, and the allowlist
may name an alias while a chain names a dated build. String comparison would
mismatch all of these, and FR-013 (role aliases resolve before filtering)
requires expansion anyway. Going through the existing resolver means the filter
agrees with the selection logic by construction instead of by a parallel
reimplementation.

**Alternatives considered**:
- *String equality on the raw selectors* — rejected: breaks on aliases, globs,
  thinking suffixes, and dated-versus-alias spellings of the same model.
- *Compare `provider/id` only* — rejected: it ignores `modelProviderOrder` and
  equivalent-provider preferences that the resolver applies, so the filter and
  the selector could disagree about which concrete model a selector means.

## D4 — What disabling cyber mode does to the active model

**Decision**: Disabling restores the configured role resolution and leaves the
active model in place.

**Rationale**: FR-028 requires that disabling restores role resolution exactly,
and it says nothing about re-pointing the model. The active model at that moment
is one the operator explicitly allowed, so it is a valid choice to keep. A
surprise model flip on disable would be worse than leaving a model the operator
chose. Any subsequent role resolution or manual switch follows config again.

**Alternatives considered**:
- *Re-point back to the configured role model on disable* — rejected: it makes a
  mode toggle also a model switch, which is a second effect the operator did not
  ask for, and it would discard a deliberate manual selection.

## D5 — How cyber state survives session transitions

**Decision**: Add an optional `cyber?: boolean` to `ModelChangeEntry`
(`src/session/session-entries.ts:108`), pass it through
`SessionManager.appendModelChange` (`session-manager.ts:2789`), and read it back
with a new `SessionManager.getLastCyberMode()` that mirrors
`getLastModelProfile()` (`session-manager.ts:3001`). `newSession` re-appends the
active state onto the new transcript, mirroring the model profile line at
`agent-session.ts:8747-8757`. The constructor and `switchSession` restore it
through `ModelControls` beside `restoreModelProfile`.

**Rationale**: The existing `profile` field on the same entry already solves the
identical problem, and it is what makes `/new` and the delete paths inherit while
a session switch does not leak. Reusing it keeps one mechanism for "what the next
transcript carries". Because the check at `agent-session.ts:8747` runs after the
new transcript exists, cyber state rides the same commit point as the model, so
the state and the model can never disagree.

**Alternatives considered**:
- *Store cyber state as a `mode_change` entry like plan mode* — rejected: plan
  mode is a tool-surface mode with its own state blob. Cyber mode is a property
  of model selection, and its restore must be ordered with the model restore,
  which the `model_change` entry guarantees.
- *Persist in settings* — rejected: FR-023 scopes the startup value to the first
  session of a process, and a settings write would leak the runtime toggle into
  every future session.

## D6 — Where the fallback report is delivered

**Decision**: Emit through `AgentSession.emitNotice("warning", message, "cyber")`
(`agent-session.ts:2755`), which reaches the operator through the existing notice
event and `#handleNotice` (`modes/controllers/event-controller.ts:1219`). Dedup
with a per-session set keyed by role and model, per FR-012.

**Rationale**: `emitNotice` is the established path for runtime session warnings
and already routes to warning styling in the TUI. FR-011 requires the report to
name every affected role, and the notice body carries the full list. The dedup
set prevents a long session from repeating an unchanged report.

**Alternatives considered**:
- *`configWarnings`* — rejected: that array is populated once at construction and
  rendered in the startup header. It cannot carry a runtime report.
- *Status-line message only* — rejected: a status line is transient and would
  drop the role list the requirement demands.

## D7 — Guard behavior on session restore

**Decision**: Install the cyber filter before the model restore in
`switchSession`, and re-point the restored model when it falls outside the
allowlist, reporting the substitution.

**Rationale**: `switchSession` restores the persisted model through a direct
`agent.setModel` call (`agent-session.ts:10120`), which bypasses the `ModelControls`
guard. Ordering the filter first means the resume path resolves through filtered
roles. Without this, a resume could reinstate a model the allowlist has since
dropped, which is the exact failure FR-009 forbids. This mirrors the ordering
comment already present for the model profile at `agent-session.ts:10093`.

**Alternatives considered**:
- *Let the restore reinstate any persisted model* — rejected: it defeats FR-009
  on the resume path, which is the path a security operator uses most.
- *Refuse the restore and abort the resume* — rejected: an abort loses the
  session. A re-point preserves it.

## D8 — Validating the allowlist itself

**Decision**: Add `validateCyberMode(settings, availableModels, warn)` in
`src/config/cyber-mode.ts`, keeping it pure, and call it from
`validateModelRoleConfiguration` in `src/config/model-roles.ts` beside
`validateModelProfiles` (`model-roles.ts:116`). A session constructor calls that
one entry point (`agent-session.ts:1691`). The check reports a non-list value,
duplicate entries, and an entry matching no available model (FR-027), and it
skips itself when the host cannot enumerate a catalogue.

**Rationale**: The validation seam, the warning callback, and the header render
at `interactive-mode.ts:6243` all exist. Reusing them gives FR-027 the same
visibility the model profile warnings already have, for a fraction of the code.

**Alternatives considered**:
- *Validate inline at enable time only* — rejected: FR-027 requires startup
  reporting, and a bad list must be visible before the operator relies on it.

## D9 — What the tests prove

**Decision**: Two test files, each asserting an observable property rather than
implementation copy.

`test/cyber-mode-session.test.ts` (session level, mirroring
`test/agent-session-model-profiles.test.ts`):
- *Filtering preserves order*: for a generated chain mixing allowlisted and
  non-allowlisted entries, the resolved model is the first allowlisted entry, and
  the relative order of survivors matches the configured order. Covers the empty,
  single, fully allowlisted, and fully excluded cases.
- *Empty survival substitutes*: a chain with no allowlisted entry resolves to the
  first allowlist entry.
- *Off is a no-op*: for the same configuration, every role resolves identically
  with cyber mode off as it did before the feature (FR-018). This holds while no
  session sharing the configuration state has installed protection; FR-030's
  over-restriction case is asserted in the shared-settings file instead. This is
  the regression guard.
- *Transitions*: `/new` carries the state; a session switch keeps each session's
  own state; `/clear` keeps it. Asserted on the reported state, not on entries.
- *Protection is additive under sharing*: with two sessions on one configuration
  state, the session that did not install the filter cannot remove it, and
  turning protection on in either session protects both (FR-029, FR-030). Shrink
  the counterexample to a nested session clearing its parent's filter.
- *Removed allowlist degrades*: a session whose list is gone resumes off, with a
  warning.
- *Startup starts protected*: with `cyberMode: true` and no explicit model, the
  first resolved model is allowlisted and the initial `model_change` entry
  records cyber on (FR-004, FR-006).
- *A profile switch re-filters*: with cyber mode on, switching a model profile
  leaves no role outside the allowlist, and no role masked by the outgoing
  profile's filtered value (FR-006, FR-013).

`test/cyber-switch-guard.test.ts` (switch level), with the shared-state properties in
`test/cyber-mode-shared-settings.test.ts`:
- *The guard holds across entry points*: for each of the picker, cycle, `/model`,
  and `/switch` paths, a non-allowlisted target is refused while on, and the same
  target is accepted while off. The property is "no path changes the active model
  outside the list", not "this function throws".
- *The report names every changed role*: with several roles forced to substitute,
  the emitted report names all of them and none of the untouched ones.

The failing case is printed by the generators so a failure reproduces. Both files
use the existing fixed-model fixtures (`sonnet45`, `haiku`, and friends) so runs
are deterministic.

**Rationale**: These assert the properties the requirements name: ordering,
substitution, no-op-when-off, transition inheritance, and closure over the
allowlist. None mirrors a function body or pins a message string beyond the role
names the requirement itself demands.

**Alternatives considered**:
- *Assert the filtered role record directly* — rejected: it would pass for any
  implementation that produced the right record while leaving a bypass open,
  and it copies the implementation's shape.
