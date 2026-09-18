# Feature Specification: Cyber Mode

**Feature Branch**: `001-cyber-mode`

**Created**: 2026-09-17

**Status**: Draft

**Input**: User description: "I want a cyber mode: (1) I can specify a list of model is cyber capable that will not be blocked by upstream provider; (2) when I enable cyber mode, all roles that include non-compliance models will be replaced by the cyber model (default to the first one in the list); we still can specify multiple model in fallback order in the roles; but do the filtering; (3) a status line component (added to claude3 too) to indicate that; like model profile; should be persisted after resume; /new; /drop or what else. Also a warning when we fallback to approved list of cyber model because of current model in any roles is not in the list (list all roles fallback)."

## Clarifications

### Session 2026-09-17

- Q: Does cyber mode state reset to the configured startup value when the operator runs `/new`, or carry over to the next session? → A: It carries over. The request says the state is "persisted after resume; /new; /drop", and the new-session transition already records the outgoing active model profile onto the new transcript, so the configured startup value applies only to the first session of a process.
- Q: What does the delete path do to the cyber mode state? → A: `/delete` follows the same next-transcript transition as `/new`, so the next session inherits the active state rather than resetting. `/session delete` differs: it removes the session and returns to the session selector, so no state is carried, and the next session opened follows its own record or the configured startup value.
- Q: When the operator switches cyber mode on while the session's active model is not on the cyber-capable list, should the session move to a cyber-capable model right away? → A: Yes. The switch re-points the active model, taking effect for the next model call because a streaming turn cannot change mid-flight. The change is reported like any other model change and appears in the fallback report.
- Q: While cyber mode is on, should the tool also block a manual switch to a model that is not on the cyber-capable list? → A: Yes. Every operator model switch is constrained, including the picker and the cycle keys. Each refusal names cyber mode as the reason. The launch path is the one exception: a launch model that is not cyber-capable does not abort the launch, and the session starts on the cyber-capable resolution instead. Turning cyber mode off is the way to reach those models.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Declare cyber-capable models and switch cyber mode on (Priority: P1)

An operator names the models that their upstream providers will not block for
security work. The operator then switches cyber mode on for the running session,
or sets it to start on. The tool reports which models are now in effect.

**Why this priority**: Nothing else in this feature works until the operator can
name the cyber-capable models and control the switch. This story alone still
delivers value: the operator can see the declared list and the reported state.

**Independent Test**: Configure two models as cyber-capable, switch cyber mode
on, and confirm the tool reports the on state together with the declared list.
Switch it off again and confirm the off state is reported.

**Acceptance Scenarios**:

1. **Given** a configuration that names at least one cyber-capable model,
   **When** the operator switches cyber mode on, **Then** the tool reports cyber
   mode as on and names the models now in effect.
2. **Given** cyber mode is on, **When** the operator switches it off, **Then**
   the tool reports cyber mode as off and model selection returns to the
   configuration as written.
3. **Given** a configuration that names no cyber-capable model, **When** the
   operator switches cyber mode on, **Then** the switch is refused, the reason
   is shown, and cyber mode stays off.
4. **Given** a session whose active model is not cyber-capable, **When** the
   operator switches cyber mode on, **Then** the session moves to a
   cyber-capable model, the move is reported like any other model change, and
   the affected role appears in the fallback report.
5. **Given** cyber mode on, **When** the operator picks a non-cyber model from
   the model picker or cycles to one, **Then** the switch is refused and the
   refusal names cyber mode as the reason.
6. **Given** cyber mode on from configuration and a launch model that is not
   cyber-capable, **When** the session starts, **Then** it starts on the
   cyber-capable resolution for the active role and reports the substitution.

---

### User Story 2 - Role model chains resolve to cyber-capable models only (Priority: P1)

An operator keeps several models in fallback order on each role. With cyber mode
on, every role resolves only to models on the cyber-capable list. Fallback order
among the surviving models is unchanged, so a role that keeps two cyber-capable
models still falls back from the first to the second.

A role whose chain holds no cyber-capable model falls back to the primary cyber
model, the first entry on the declared list. That substitution is never silent.
The tool warns and lists every role it changed.

**Why this priority**: This is the reason the feature exists. A turn that lands
on a blocked model loses the work, so the filter is what protects the session.

**Independent Test**: Give a role a fallback chain of one cyber-capable model
followed by one non-cyber model, switch cyber mode on, and confirm the role
resolves to the cyber-capable entry. Then give a second role a chain of only
non-cyber models and confirm that role resolves to the primary cyber model and
appears in the warning list.

**Acceptance Scenarios**:

1. **Given** a role chain of `[cyber-capable, non-cyber-capable]` and cyber mode
   on, **When** the role resolves, **Then** it picks the cyber-capable entry.
2. **Given** a role chain that holds no cyber-capable model and cyber mode on,
   **When** the role resolves, **Then** it picks the primary cyber model, the
   first entry on the declared list.
3. **Given** two roles with different fallback orders and cyber mode on,
   **When** both resolve, **Then** each keeps its own relative order among the
   cyber-capable entries.
4. **Given** three roles whose chains hold no cyber-capable model and cyber mode
   on, **When** the operator switches cyber mode on, **Then** the warning names
   all three roles and the model each one landed on.
5. **Given** a role chain of `[non-cyber-capable, cyber-capable]` and cyber mode
   on, **When** the role resolves, **Then** it picks the cyber-capable entry and
   the warning names that role, because the filter changed the model it landed
   on.
6. **Given** a role chain whose first entry is already cyber-capable, **When**
   the role resolves, **Then** the warning does not name that role, because the
   filter changed nothing about its selection.
7. **Given** cyber mode off, **When** a role resolves, **Then** every entry of
   its chain stays eligible and selection is unchanged from today.

---

### User Story 3 - A status line indicator shows that cyber mode is on (Priority: P2)

The status line shows a dedicated cyber indicator while cyber mode is on. The
indicator disappears when cyber mode is off, matching how the active model
profile indicator behaves. The `claude3` composer footer shows the same
indicator without extra configuration.

**Why this priority**: The operator must never guess whether the protection is
active, because a wrong guess wastes a turn on a blocked model.

**Independent Test**: Toggle cyber mode and confirm the indicator appears and
disappears, in the default status layout and in the `claude3` composer footer.

**Acceptance Scenarios**:

1. **Given** the default status layout and cyber mode off, **When** the status
   line renders, **Then** no cyber indicator is present.
2. **Given** the default status layout and cyber mode on, **When** the status
   line renders, **Then** the cyber indicator is present and distinguishable
   from the model and model-profile indicators.
3. **Given** the `claude3` composer footer and cyber mode on, **When** the
   footer renders, **Then** the cyber indicator is present with no operator
   configuration.
4. **Given** a custom status layout, **When** the operator adds the cyber
   segment to it, **Then** the layout renders the indicator.

---

### User Story 4 - Cyber mode state follows the session lifecycle (Priority: P2)

The cyber mode state is recorded on the session. The transition decides what the
next transcript carries.

- Resume keeps the recorded state, and a session switch keeps the state of the
  session being opened.
- `/clear` keeps the state, because the session continues.
- `/new` and `/delete` carry the active state onto the next transcript, so the
  next session continues in the same state. This matches how the active model
  profile is already carried onto a new transcript.
- `/session delete` produces no next transcript. It removes the session and
  returns to the session selector, so no session is active until the operator
  opens one, and that session follows its own record or the configured startup
  value.
- The configured startup value applies wherever there is no predecessor state:
  the first session of a process, and the session opened after a delete.
- A session that shares configuration state with another live session inherits
  that session's protection and cannot remove it. The reverse holds too: enabling
  protection in a nested session also protects the parent for as long as they
  share configuration.

**Why this priority**: An indicator that reads stale after a transition is worse
than no indicator, because the operator trusts it.

**Independent Test**: Switch cyber mode on, run `/new`, and confirm the next
session still reads on and still filters role chains. Then restart the tool with
cyber mode off in configuration and confirm the first session reads off.

**Acceptance Scenarios**:

1. **Given** a session saved with cyber mode on, **When** the operator resumes
   it, **Then** the indicator reads on and role chains stay filtered.
2. **Given** a session with cyber mode on, **When** the operator runs `/clear`,
   **Then** the indicator still reads on.
3. **Given** a session launched with cyber mode off in configuration where the
   operator then switched cyber mode on, **When** the operator runs `/new`,
   **Then** the next session reads on and role chains stay filtered.
4. **Given** a session with cyber mode on, **When** the operator runs `/delete`,
   **Then** the next session reads on.
5. **Given** a session with cyber mode on, **When** the operator runs
   `/session delete`, **Then** the session is removed, no session is active, and
   the next session the operator opens follows its own record or the configured
   startup value.
6. **Given** two sessions with different cyber mode states, **When** the
   operator switches between them, **Then** each session keeps its own state.
7. **Given** a session whose cyber model list no longer exists in configuration,
   **When** the operator resumes it, **Then** the state degrades to off with a
   warning instead of pinning an unknown list.

---

### Edge Cases

- The declared list holds entries that match no available model, or duplicates.
- The declared list holds models without working credentials.
- Every role in the session falls back to the primary cyber model at once.
- A role chain is already entirely cyber-capable, so filtering changes nothing.
- A role chain names another role alias rather than a concrete model.
- A role chain entry carries a thinking-level selector.
- The operator enables cyber mode, then runs `/new`, so the next session
  continues in cyber mode.
- The operator empties the declared list while cyber mode is on, then runs
  `/new`, so the next session inherits a state whose list no longer resolves.
- Cyber mode is on while a model profile is active, so both layers apply.
- The operator launches with a model flag that is not cyber-capable while cyber
  mode is on, so the session starts on the cyber-capable resolution instead.
- The model picker holds no cyber-capable model at all, so every pick is refused
  until the operator turns cyber mode off.
- Cyber mode is on while plan, goal, or vibe mode is active.
- Cyber mode is on while a session is forked or branched from an existing one.
- The operator toggles cyber mode while a turn is streaming, so the in-flight
  turn keeps the model it started on and the next model call uses the new one.
- A nested session enables cyber mode while its parent's state is off, so the
  parent's roles are filtered too while the parent's indicator stays hidden
  (FR-030). The parent is more protected than it reports.
- A nested session holds no recorded cyber state and its parent is protected, so
  the nested session inherits the protection and cannot clear it.
- Cyber mode starts on from configuration with no explicit model, so the first
  resolved model must already come from the allowlist.
- Cyber mode is on while a model profile is switched, so the role layer is
  replaced and the filter must still apply to every role the new profile names.
- The operator defines a custom role that the built-in role list does not name.
- The tool runs without an interactive terminal, so only the startup value applies.
- The declared list is emptied while cyber mode is on.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The operator MUST be able to declare an ordered list of
  cyber-capable model selectors in configuration, from any configuration scope.
- **FR-002**: The order of the declared list MUST be significant. The first
  entry is the primary cyber model.
- **FR-003**: Cyber mode MUST be off by default.
- **FR-004**: The operator MUST be able to set the startup cyber mode value in
  configuration, read from every configuration scope.
- **FR-005**: The operator MUST be able to switch cyber mode on and off at
  runtime through a slash command and a key binding, and the tool MUST confirm
  the resulting state.
- **FR-006**: While cyber mode is on, each role MUST resolve only among
  cyber-capable models. A chain that holds both kinds of model MUST keep its
  cyber-capable entries, in their configured relative order.
- **FR-007**: A role whose chain holds no cyber-capable model MUST resolve to
  the primary cyber model.
- **FR-008**: Enabling cyber mode MUST re-point the session's active model when
  that model is not cyber-capable. The re-point follows the active role's chain
  under FR-006, or the primary cyber model under FR-007. It MUST take effect for
  the next model call, because a streaming turn cannot change its model
  mid-flight.
- **FR-009**: While cyber mode is on, every operator model switch MUST be
  constrained, not only role resolution. The model picker and the model cycle
  keys MUST refuse a model that is not cyber-capable, and the refusal MUST name
  cyber mode as the reason. The launch path substitutes rather than refuses, per
  FR-010. Switching cyber mode off is the way to reach those models.
- **FR-010**: At launch, a named model that is not cyber-capable MUST NOT abort
  the launch. The session MUST start on the cyber-capable resolution for the
  active role instead. That substitution MUST be reported during startup, before
  the first turn, through the same pre-session warning channel the other launch
  warnings use. Resolution runs before any session exists, so it MUST return the
  substitution and the caller MUST emit it once the session exists.
- **FR-011**: Whenever cyber mode changes a role's selection, the tool MUST warn
  and MUST list every affected role together with the model that role landed on.
  A role that falls back to the primary cyber model under FR-007 MUST appear in
  that list.
- **FR-012**: The tool MUST report each affected role at least once, and MUST
  NOT repeat the same report for the same role and model within a session.
- **FR-013**: Every role-resolving surface MUST follow the filter, including
  background roles that run outside the interactive turn.
- **FR-014**: Cyber mode MUST cover operator-defined custom roles as well as
  built-in roles.
- **FR-015**: A role whose chain names another role MUST resolve the aliased
  chain before the filter applies.
- **FR-016**: Enabling cyber mode MUST be refused while no declared model
  resolves to an available model with working credentials. The tool MUST show
  the reason and leave cyber mode off.
- **FR-017**: Cyber mode MUST NOT change model selection when a role already
  resolves to a cyber-capable model.
- **FR-018**: With cyber mode off and no protection installed for the
  configuration state the session runs against, model selection MUST be unchanged
  from the current behavior. FR-030 names the one exception.
- **FR-019**: The status line MUST show a dedicated cyber indicator while cyber
  mode is on, and MUST hide it while cyber mode is off. The indicator reads
  `Cyber` with a crossed-swords mark, so it renders as `⚔️ Cyber` under the
  default symbol preset. The indicator reports the session's own state. Where
  another session sharing the configuration state has installed protection while
  this session's state is off, the indicator stays hidden, so the configuration
  is then more restrictive than the indicator shows.
- **FR-020**: The indicator MUST appear in the default status layout, MUST be
  selectable as a segment for a custom status layout, and MUST appear in the
  `claude3` composer footer without operator configuration.
- **FR-021**: The cyber mode state MUST be recorded on the session, so a resumed
  session reports the recorded state.
- **FR-022**: `/clear` MUST keep the cyber mode state, because the session
  continues.
- **FR-023**: `/new` and `/delete` MUST carry the active cyber mode state onto
  the next transcript, so the next session continues in that state. This follows
  how the active model profile is already carried onto a new transcript.
  `/session delete` creates no next transcript: it removes the session and
  returns to the session selector, whose next opened session follows its own
  record or the configured startup value.
- **FR-024**: A session transition MUST reinstate the incoming session's cyber
  state, so the outgoing session's state does not leak into the next session.
  This covers a resume, `/new`, `/delete`, a fork, and a switch to another
  session.
- **FR-025**: The configured startup value MUST apply wherever there is no
  predecessor state: the first session of a process, and the session opened after
  a `/session delete`.
- **FR-026**: A resumed or inherited on state MUST be re-validated against
  current configuration. When the declared cyber model list is empty, or no entry
  resolves to an available model, the state MUST degrade to off and MUST report a
  warning. The session record carries no list of its own, so this decision comes
  from current configuration alone.
- **FR-027**: Unusable configuration MUST be reported as a startup warning. This
  covers a list that is not a list of selectors, duplicate entries, and an entry
  that matches no available model.
- **FR-028**: Switching cyber mode off MUST restore role resolution to the
  configured values exactly.
- **FR-029**: Cyber protection belongs to the configuration state a session runs
  against, as the active model profile does. Sessions that share configuration
  state share one protection.
- **FR-030**: Adding protection applies to the shared configuration state, but
  removing it requires ownership. A session MUST NOT drop protection that another
  session installed, and MUST NOT drop config-driven protection it did not
  install. An explicit operator switch-off always clears, because that is the
  operator's stated intent. Implicit adoption, such as a session restoring a
  recorded off state, clears only protection that same session installed. A
  nested session or subagent therefore inherits its parent's protection and
  cannot remove it, while enabling protection in a nested session also protects
  the parent for as long as they share configuration.
- **FR-031**: Automatic recovery MUST obey the allowlist without failing the
  retry. The configured fallback chain, the usage-aware fallback, the Fireworks
  Fast degrade, and the restore of a fallback's primary are narrowed to the
  entries the allowlist covers, and the walk continues to the next covered entry.
  A candidate that reaches the model swap from any other path is refused, which
  leaves the session where it is, so no recovery path aborts on protection and
  none of them lands outside the list.

### Key Entities *(include if feature involves data)*

- **Cyber model list**: An ordered operator-declared set of model selectors that
  upstream providers will not block for security work. The first entry is the
  primary cyber model, used when a role chain survives filtering empty.
- **Cyber mode state**: The on or off condition of the protection for one
  session, together with the list it was resolved against. Recorded on the
  session so a resume can restore it, and installed on the shared configuration
  state while the session is active, per FR-029.
- **Role chain**: The ordered candidate models behind one role, as configured.
  The unit that cyber mode filters, and the unit whose order must survive.
- **Fallback report**: The list of roles whose selection cyber mode changed,
  with the model each role landed on. Shown when cyber mode is switched on, and
  whenever a role falls back to the primary cyber model later.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With cyber mode on, 100% of role resolutions select a model from
  the declared cyber-capable list. This covers the roles a session exercises and
  the roles it leaves idle.
- **SC-002**: A resumed session reports the recorded cyber mode state on the
  first render, with no operator action.
- **SC-003**: Every role whose selection cyber mode changed is named in a
  warning within the same interaction that caused the change.
- **SC-004**: Switching cyber mode on or off changes the rendered indicator
  within one render cycle, and the operator sees the confirmation in the same
  interaction.
- **SC-005**: A role chain that holds at least one cyber-capable model keeps its
  relative order. The first available cyber-capable entry is then chosen.
- **SC-006**: With cyber mode off, and with no session sharing that
  configuration state having installed protection, every role resolves exactly as
  it did before the feature existed, verified by comparing resolution results for
  the same configuration.
- **SC-007**: An unusable cyber model list is reported at startup in 100% of
  cases, and never switches cyber mode on silently.
- **SC-008**: After `/new` or `/delete`, the next session reports the inherited
  cyber mode state on its first render, with no operator action.
- **SC-009**: Switching cyber mode on while the active model is not
  cyber-capable moves the session to a cyber-capable model in the same
  interaction, so the next model call is protected.
- **SC-010**: While cyber mode is on, no operator path lands the session on a
  model outside the declared list. This covers the picker and the cycle keys,
  which refuse, and the launch path, which substitutes. Automatic recovery obeys
  the same list under FR-031: a recovery walk that finds no covered entry leaves
  the session on its current model instead of moving outside the list.

## Assumptions

- The list is declared under a new configuration key, proposed as `cyberModels`,
  read from the same layers as every other setting, so a repository can pin its
  own list in project configuration.
- The startup field is proposed as `cyberMode`, following the `modelProfile`
  field that names the bundle a new session starts on. The value is read from
  configuration. A launch flag is deliberately out of scope: the runtime switch
  and the startup value already cover the request, and a flag would add four CLI
  surfaces for a convenience the request did not name.
- Cyber mode is scoped to the configuration state a session runs against, not to
  a session instance in isolation. This mirrors the active model profile, which
  installs its role layer on that same shared state, and it is why the filter
  applies at one seam. The alternative, true per-session isolation, would require
  routing every role-resolution boundary through a session-owned lookup. That
  boundary list spans roughly twenty call sites across the package, including
  `main.ts`, `sdk.ts`, the commit, memories, mnemopi, and edit subsystems, the
  model hub and browser, and the session controllers. It is rejected as
  disproportionate. The consequences are stated as FR-029 and FR-030: protection
  is additive under sharing, and a session that did not install it cannot remove
  it.
- Filtering, not whole-chain replacement, is the reading applied. A chain that
  keeps any cyber-capable entry resolves through those entries in order. The
  primary cyber model applies only when nothing survives. This follows the
  request's "we still can specify multiple model in fallback order in the roles,
  but do the filtering" and the fallback warning it asks for.
- The warning surface reuses the notice mechanism that other session warnings
  use. Each affected role is named once per session for the same model.
- The runtime switch mirrors the model profile surface: a slash command plus a
  key binding, with the same session-scoped behavior. The model profile
  indicator supplies the precedent for the indicator's appearance, placement,
  and its status line segment.
- The filter covers every role, background roles included. This matches the
  runtime role layer that model profiles already install, which drives every
  role-resolving surface rather than a subset. It also keeps the promise of the
  feature: no role in the session reaches a blocked model.
- The new settings carry their default values in the agent configuration file,
  following the repository policy for operator-configurable settings.
- The default status layout gains the indicator, following how the model profile
  indicator ships in that layout.
- Recording on the session follows the existing session record that already
  carries the active model profile, because that record decides what a new
  transcript inherits. `/new` and the delete paths inherit the active state. A
  resumed session, a session switch, `/clear`, a fork, a move, and a handoff all
  keep the state. Only the first session of a process reads the configured
  startup value.
- `/drop` is a goal and todo subcommand in this product, not a session
  transition. The session transitions covered here are resume, session switch,
  `/clear`, `/new`, `/delete`, and `/session delete`.
- "Non-compliance model" means a model whose upstream provider refuses or blocks
  the request. The refusal is recognized today as a provider policy denial. This
  feature does not add runtime refusal detection. The operator declares the safe
  models in advance instead.
- Selection of a role is refused only when cyber mode is on. With cyber mode
  off, a non-cyber-capable model stays eligible.
- Enabling cyber mode is a fail-closed operation. An empty or unresolvable list
  refuses the switch instead of silently running an unprotected model.
- Duplicate entries in the declared list are tolerated and reported as a
  warning.
- Cyber mode narrows model selection only. It does not restrict the active tool
  set, so it composes with plan, goal, and vibe modes rather than excluding them.
- With no interactive terminal, only the startup value applies, and the state
  still records on the session.
- The feature does not change which models are available, authenticated, or
  enabled. It narrows the set that roles may select and the set the operator may
  switch to.
