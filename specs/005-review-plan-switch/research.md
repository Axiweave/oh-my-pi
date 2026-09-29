# Research: Review Plan-Model Switch

All paths are relative to the repository root. Line numbers are from the
checkout on 2026-09-29.

## D1 — Where the switch state lives

**Decision**: The live state is per session. `ModelControls` owns
`#reviewPlan: boolean` (`packages/coding-agent/src/session/model-controls.ts`),
beside `#cyberMode` (line 95). `AgentSession` exposes two members:
- `reviewPlan`: the session's own flag.
- `reviewPlanActive`: `reviewPlan && settings.getModelRole("plan") !== undefined`.

`Settings` holds only the saved default `reviewUsesPlan`. Nothing writes the
live state into the merged settings view.

**Rationale**:
- FR-009 needs a session-only choice. Two sessions can share one `Settings`
  instance. `test/cyber-mode-shared-settings.test.ts:139` builds a parent and a
  sibling on one instance. A flag in the merged view would move both sessions.
- Cyber mode shares its state on purpose, because it is a protection
  (`settings.ts:1965-1972`). That reason does not apply to a preference.

**Alternatives considered**:
- Overlay `modelRoles.reviewer` in `Settings.#rebuildMerged()`, as cyber mode
  does. Rejected: the overlay is visible to every session on the instance,
  which breaks FR-009.
- A cyber-style owner set. Rejected: "on wins" moves a session whose own state
  is off.

## D2 — Where `@reviewer` resolves to the plan model

Every `@reviewer` expansion calls `getModelRole` on a `ModelRoleLookup`
(`config/model-resolver.ts:1062`, `:1213`). The switch changes the lookup the
session gives, not `Settings`.

**Decision**: Add two helpers to `config/model-resolver.ts`:

```ts
/** `plan` when the switch is active and `role` is `reviewer`, else `role`. */
export function reviewPlanRole(role: string, active: boolean): string;
/** Wrap a lookup so `reviewer` reads `plan` while `active` is true. */
export function reviewPlanLookup(settings: ModelRoleLookup, active: boolean): ModelRoleLookup;
```

Apply them at the three places where a session resolves roles:

1. **Subagent spawns.** `resolveAgentModelSelection`
   (`model-resolver.ts:1331`) gets a new option `reviewPlanActive?: boolean`.
   While it is true:
   - Pattern expansion uses `reviewPlanLookup(settings, true)`.
   - The returned role identity is `reviewPlanRole(role, true)`.
   Callers pass `request.session.reviewPlanActive` from
   `task/structured-subagent.ts:351` and `vibe/runtime.ts:363`.
2. **Main-session retry fallback.** `turn-recovery.ts:1643` builds
   `getModelRole: role => this.#host.settings.getModelRole(role)`. Change it to
   `reviewPlanRole(role, this.#host.reviewPlanActive())`. Add
   `reviewPlanActive()` to the host interface, beside `cyberModeEnabled`
   (`agent-session.ts:1885`).
3. **Eval completion fallback.** `eval/completion-bridge.ts:263` gets the same
   change, with `session.reviewPlanActive`.

**Rationale**: These are the places that expand `@reviewer` for a known
session. The other role readers (`sdk.ts:2842` launch, `tiny/online-candidates.ts`,
compaction, and advisors) resolve their own roles and never name `reviewer`.

**Correction (T048)**: Retry chains read a role only to find the primary model
of a chain key. With items 2 and 3 alone, the `reviewer` key's primary became
the plan model. A plan-model session could then retry through the `reviewer`
chain when that key came first in YAML, and that chain points at the exhausted
provider. Both retry contexts now go through `reviewPlanRetryContext`
(`session/retry-fallback-chains.ts`). While the switch is active, it reads
`reviewer` as `plan` and sets aside the `reviewer` chain key.

## D3 — Which retry chain a reviewer uses

`resolveExplicitModelRole` (`model-resolver.ts:1087`) takes the alias before
expansion. So `@reviewer` gives the role identity `reviewer`, and the subagent
looks up `retry.fallbackChains.reviewer` (`task/executor.ts:267`). That chain
usually points at the exhausted provider.

**Decision**: While the switch is active, the role identity is remapped to
`plan` (D2, item 1). The subagent therefore uses the `plan` chain, or the
`default` chain when plan has none. This is the same chain that the plan model
uses anywhere else.

**Alternatives considered**: Keep the identity `reviewer`, and overlay the
chain value. Rejected: the overlay needs the merged settings view, which D1
rules out.

## D4 — Saved per-agent overrides and the `reviewer` agent (FR-008)

**Decision**: `resolveEffectiveAgentModelSelection` (`model-resolver.ts:1283`)
gets an optional `agentName`. After the `requestModel` check: when
`reviewPlanActive` is true and the agent is a review agent, the source is
`@reviewer`. It skips `settingsOverride` and `agentModel`. D2 then maps that
source to the plan model and the `plan` identity.

A review agent is one of these:
- `agentName` is `reviewer`, `plan-reviewer`, or `impl-reviewer`.
- The saved override or the frontmatter model names the reviewer role.

**Rationale**:
- The built-in `reviewer` agent declares `model: "@slow"`
  (`src/prompts/agents/reviewer.md:6`). It reaches the reviewer role only
  through a saved override, such as the user's `reviewer: "@reviewer"`.
- An override with a fixed model skips role expansion. Clarification Q1 says
  the switch wins over it.
- `reviewPlanActive` is false when no plan resolves. Then normal precedence
  applies (FR-011).

## D5 — Recording and restore

**Decision**:
- Setting `reviewUsesPlan: boolean`, default `false`, next to `cfgCyberMode`
  (`config/model-settings.ts:145`).
- `ModelChangeEntry.reviewPlan?: boolean` (`session/session-entries.ts:124`).
- `SessionManager.getLastReviewPlan()`, a copy of `getLastCyberMode`
  (`session/session-manager.ts:3179`).
- `appendModelChange` (`session-manager.ts:2945`) gets a sixth optional
  parameter, `reviewPlan`. Readers take the last defined value, so the writers
  that omit it do not change the state. These writers pass it:
  - the toggle,
  - the `/new` carry-over (`agent-session.ts:9501`),
  - the SDK initial entry (`sdk.ts:4414`).

**Restore order**: `recorded ?? inherited ?? cfgReviewUsesPlan`.
- The `ModelControls` constructor (`model-controls.ts:142`) uses it.
- Resume and session switch (`agent-session.ts:11151`, `:11284`) use it.
- `/fork`, branch selection, and tree navigation use it, through
  `ModelControls.restoreCyberBranch` (`model-controls.ts:709`).
- `/clear` changes nothing (the same as cyber mode, `docs/cyber-mode.md:89`).

**Inherited value**: `CreateAgentSessionOptions` gets `reviewPlan?: boolean`.
The task executor passes the parent's `reviewPlan` into a subagent session. A
subagent that spawns its own reviewer then follows the parent's session-only
choice. A top-level session gets no inherited value.

## D6 — Command and save scope

**Decision**: `/review-plan [on|off|status] [global|project]`, a copy of
`/cyber` (`slash-commands/builtin-modes.ts:680-753`).
- Without a scope, the command changes only this session.
- `global` also saves `reviewUsesPlan` through `settings.set`.
- `project` also saves it through a new `Settings.setProjectReviewUsesPlan`, a
  copy of `setProjectCyberMode` (`settings.ts:1764`).

Completion copies `CYBER_SCOPES` (`slash-commands/builtin-completions.ts:453`).

**Not added**: a keybinding. The spec does not ask for one.

## D7 — Bottom-bar indicator

**Decision**: A `review_plan` status-line segment, a copy of `cyberSegment`
(`packages/tui/src/status-line/segments.ts:335`).
- It is hidden while `ctx.session.reviewPlan` is falsy. Interactive mode fills
  that field from `session.reviewPlanActive`, where it fills `cyberMode`
  (`modes/interactive-mode.ts:3145`).
- When visible, it renders `withIcon(theme.icon.reviewPlan, "Review:Plan")` in
  the `warning` color.
- Register it in `SEGMENTS` (`segments.ts:971`), `status-line/schema.ts`, and
  the default preset after `cyber` (`status-line/presets.ts:10`).
- Render it beside `cyber` in the `claude3` footer (`status-line/component.ts:3228`).
- Add `reviewPlan?: boolean` to the host session (`status-line/host.ts:47`).
- Add the symbol `icon.reviewPlan` (`packages/tui/src/theme/symbols.ts`):
  unicode `⇄`, nerd `⇄`, ascii `[RP]`. Expose it in `theme/theme-class.ts:623`.

## D8 — Notices

When the user turns the switch on and no plan model resolves, `/review-plan`
reports that reviews keep the configured reviewer. The switch stays on. A
later profile with a plan model makes it active (FR-011).

## D9 — What the tests must prove

1. **Role isolation**: for generated role maps, `reviewPlanLookup(s, true)`
   returns the same value as `s` for every role except `reviewer` (FR-012).
2. **Agreement**: with the switch active, a review agent resolves to the same
   patterns as `@plan`, with role identity `plan`. Its retry chain equals the
   `plan` chain, or the `default` chain when plan has no chain.
3. **Identity when off**: with the switch off, `resolveAgentModelSelection`
   returns the same result as without the option (SC-004).
4. **Precedence**: `requestModel` beats the switch. The switch beats a
   fixed-model saved override for review agents. Non-review agents keep their
   override.
5. **Two sessions, one `Settings`**: start a parent and a sibling on shared
   settings. Turn the switch on in one session only. The other session stays
   off, its indicator stays hidden, and its review agents keep the configured
   reviewer. Repeat with the other session as the one that toggles. Model the
   setup on `test/cyber-mode-shared-settings.test.ts:139`.
6. **Lifecycle**: a session-only "on" survives `/new`, `/clear`, and resume.
   A fresh session reads the saved value. A subagent session inherits the
   parent's value.
7. **Indicator**: visible only while `reviewPlanActive` is true, in the default
   preset and in the `claude3` footer.

Templates: `test/cyber-mode-session.test.ts`, `test/status-line-cyber.test.ts`,
`test/slash-commands/cyber.test.ts`.
