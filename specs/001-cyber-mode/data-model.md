# Phase 1 Data Model: Cyber Mode

Four entities. Three are runtime concepts, one is the operator's configuration.
None introduces a new persistence format: the state reuses the session's existing
`model_change` record.

## 1. Cyber model list (the allowlist)

The operator's declaration of models that upstream providers will not block for
security work.

| Field | Type | Rules |
|---|---|---|
| entries | ordered list of model selectors | Required for cyber mode to be usable. Order is significant. May hold aliases, globs, and thinking suffixes, because each entry is resolved the same way a role value is. |
| primary | the first entry that resolves to an available model | Derived, never configured separately. Used when a role chain survives filtering empty (FR-007). |

**Identity and uniqueness**: identity is the resolved concrete model, not the
spelling. `anthropic/claude-sonnet-5` and an alias resolving to it are the same
allowlist member. Duplicate spellings are tolerated and reported (FR-027).

**Validation rules** (FR-027): a value that is not a list of selector strings is
reported and ignored; duplicate entries are reported; an entry that matches no
available model is reported. All three surface as startup warnings through the
existing `configWarnings` path.

**Relationship**: the allowlist resolves against the same available-model set the
model picker uses, so the two can never disagree about whether a model exists.

## 2. Cyber mode state

The protection's condition for one session.

| Field | Type | Rules |
|---|---|---|
| enabled | boolean | Off by default (FR-003). Set from configuration for the first session of a process (FR-025), toggled at runtime (FR-005), or inherited from a session record (FR-023). |
| allowlist | the resolved cyber model list | Held in memory only, and it is the value the overlay stores. The filter is derived from this allowlist on every merge, so a role layer replaced later, by a model profile switch or a config edit, is filtered against the same allowlist rather than against a stale map (FR-006, FR-013). The session record does not carry it (FR-026). |
| owner | the session id that installed the protection, or the configuration for a config-driven install | Set on install. An implicit clear is a no-op for any other owner, so a session sharing configuration state cannot remove protection it did not install. An explicit operator switch-off clears regardless, because that is the operator's stated intent (FR-030). |

**Refusal rule** (FR-016): enabling is refused while no allowlist entry resolves
to an available model with working credentials. The tool reports the reason and
the state stays off. Cyber mode is fail-closed.

**Degradation rule** (FR-026): the recorded state is a boolean and carries no
list of its own. On read, an on state is re-validated against current
configuration. An empty list, or one where no entry resolves to an available
model, degrades the state to off and reports a warning, rather than pinning a
list the configuration no longer supports.

**Sharing rule** (FR-029, FR-030): the protection is installed on the
configuration state a session runs against, which is the same state the model
profile's runtime role layer occupies. Sessions that share that state share one
protection. Installing is always allowed, so a caller that turns protection on
protects every session sharing its configuration.

Two clearing rules, because the two cases differ in intent:

- An explicit operator switch-off always clears. That is the operator's stated
  intent, and it is the only way to reach a model outside the list (FR-009).
- Implicit adoption clears only what the same session installed. A session
  restoring a recorded off state, or a nested session whose own record is off,
  therefore cannot remove protection installed by another session or by
  configuration.

**Accepted consequence: over-restriction.** When a nested session installs
protection while its parent's own state is off, the parent also runs filtered.
FR-018 and SC-006 do not apply in that state, because protection is installed for
the shared configuration. The parent's indicator stays hidden, because it reports
its own state (FR-019). The operator is therefore more protected than the
indicator shows. This is the safe direction of the two, and it is the same
relationship the model profile already has, where the profile indicator is
per-session while the role layer it installs is shared.

**Recorded form**: one optional boolean on the session's `model_change` entry,
read back by the same rule the model profile uses. Every model change carries the
state in effect, so the most recent entry always names the truth and the state
can never disagree with the model it was recorded beside. A session transition
reinstates the incoming session's recorded state (FR-024), which is what keeps an
outgoing session's state from leaking forward.

## 3. Role chain

The unit cyber mode filters.

| Field | Type | Rules |
|---|---|---|
| role | string | A built-in role or an operator-defined custom role (FR-014). |
| entries | ordered selector list | The role's configured value, split on commas, order preserved. |
| survivors | ordered subset of entries | Entries whose resolved model is allowlisted. Relative order preserved (FR-006). |
| landed | one model | The first survivor, or the primary allowlist entry when there are no survivors (FR-007). |

**Rules**:
- A chain naming another role resolves that alias first, then filters (FR-015).
- A chain already entirely allowlisted is unchanged (FR-017), so cyber mode is
  invisible to an operator whose configuration already complies.
- Roles the operator never configured stay unconfigured. Cyber mode narrows
  existing selections, and never invents a role assignment.

## 4. Fallback report

The operator-facing record of what cyber mode changed.

| Field | Type | Rules |
|---|---|---|
| changes | list of `{ role, landed, reason }` | One entry per role whose selection changed (FR-011). |
| reason | `filtered` or `substituted` | `filtered`: survivors existed, and the landed model differs from the one the unfiltered chain would have chosen. `substituted`: no survivor, so the primary allowlist entry applies. |
| dedup key | `{ role, landed }` | Each pair is reported at most once per session (FR-012). |

**Reported versus not reported.** A role is reported when cyber mode changed the
model it lands on. A role whose first chain entry is already allowlisted is
`unchanged` and is not reported, because nothing about its selection moved. The
distinction is the landed model, not whether a chain held a non-allowlisted
entry: an earlier non-allowlisted entry that the filter dropped is exactly a
changed selection and is reported.

**Delivery**: a warning notice through the session's existing notice path, shown
when cyber mode is switched on and whenever a role substitutes later.

## State transition matrix

The transition decides what the session enforces next. This table is the contract
that FR-021 through FR-026 encode.

| Transition | Resulting state | Rule |
|---|---|---|
| Process start, first session | The configured startup value | FR-025 |
| Resume a session | The state recorded on that session's branch | FR-021 |
| Switch to another session | That session's own recorded state | FR-024 |
| `/clear` | Unchanged, because the session continues | FR-022 |
| `/new` | Inherited and revalidated before the next transcript records it | FR-023, FR-026 |
| `/delete` | Inherited and revalidated. The delete command removes the old transcript | FR-023, FR-026 |
| `/session delete` | Nothing is carried, because no session remains. The transcript is removed and the session selector is shown. The next session the operator opens follows its own record, or the configured startup value when it has none | FR-023, FR-025 |
| Fork, branch, or tree navigation | Inherited from the destination entry and revalidated. Degradation records an off state | FR-021, FR-026 |
| Move, worktree, or handoff | Unchanged, because the session is the same session | FR-021 |
| Toggle while a turn streams | Recorded immediately. The in-flight turn keeps its model. The next model call uses the new state | FR-008 |

## Invariants

1. While cyber mode is on, the active model is always an allowlist member. The
   enable path re-points it (FR-008), the guard refuses every other path
   (FR-009), and the restore path re-points it (research D7).
2. While cyber mode is on, no role resolves outside the allowlist (FR-006,
   FR-007).
3. Cyber mode off means byte-identical selection behavior to before the feature
   (FR-018), while no protection is installed for the shared configuration state.
   When another session sharing that state has installed protection, the shared
   view stays filtered and FR-030 governs instead.
4. The allowlist in configuration is never mutated by enabling, disabling, or
   resolving (FR-028). Filtering happens in the merged view only.
5. The recorded state and the active model agree on every session entry, because
   they are written in the same operation.
