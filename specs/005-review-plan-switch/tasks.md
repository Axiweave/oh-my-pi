---

description: "Task list for the review plan-model switch"
---

# Tasks: Review Plan-Model Switch

**Input**: Design documents from `/specs/005-review-plan-switch/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included. The repository rules (`~/.omp/agent/AGENTS.md` → Tests)
require property tests for non-trivial logic. Research D9 lists the
properties. Write each test before its implementation task and see it fail.

**Organization**: Tasks are grouped by user story. `src/` means
`packages/coding-agent/src/`. `test/` means `packages/coding-agent/test/`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no open dependency)
- **[Story]**: The user story the task belongs to (US1, US2, US3)

## Phase 1: Setup

**Purpose**: The saved default that every story reads.

- [X] T001 Register `cfgReviewUsesPlan` (`id: "reviewUsesPlan"`, `type: "boolean"`, `default: false`) next to `cfgCyberMode`, with a doc comment that says it is the startup value for new sessions, in src/config/model-settings.ts

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: The per-session flag. `Settings` gets no runtime state (research D1).

- [X] T002 Add `#reviewPlan: boolean` to `ModelControls`, set in the constructor to `inherited ?? cfgReviewUsesPlan.get(settings)` for now, with a `reviewPlan` getter and a `setReviewPlan(enabled)` method that changes only this instance, in src/session/model-controls.ts
- [X] T003 Add `AgentSession.reviewPlan`, `AgentSession.reviewPlanActive` (`reviewPlan && settings.getModelRole("plan") !== undefined`), and `AgentSession.setReviewPlan(enabled)` that forwards to `ModelControls`, in src/session/agent-session.ts
- [X] T004 Add `reviewPlan?: boolean` to `CreateAgentSessionOptions` and pass it to `ModelControls` as the inherited value, in src/sdk.ts

**Checkpoint**: A session has its own flag. Nothing reads it yet.

---

## Phase 3: User Story 1 — Send reviews to the plan model on demand (Priority: P1) 🎯 MVP

**Goal**: While the switch is active, every `@reviewer` reference and every review agent resolves to the active profile's plan model and plan retry chain.

**Independent Test**: A profile has a cross-provider reviewer. Run `/review-plan on`, then `/review`. The reviewer task runs on the plan model. Quickstart scenarios 2–5 and 10.

### Tests for User Story 1

- [X] T005 [P] [US1] Property tests for `reviewPlanRole` and `reviewPlanLookup` over generated role maps: with `active` true, every role except `reviewer` returns the input lookup's value, and `reviewer` returns the `plan` value. With `active` false, all roles match the input. Print the fixed seed. In test/review-plan-switch.test.ts
- [X] T006 [P] [US1] Precedence and chain tests for `resolveAgentModelSelection`. With the switch active: (a) `requestModel` wins; (b) agents `reviewer` (frontmatter `@slow`), `plan-reviewer`, `impl-reviewer`, and a custom agent with `@reviewer` resolve to the `@plan` patterns with role `plan`; (c) a fixed-model `task.agentModelOverrides.reviewer` loses to the switch; (d) a non-review agent keeps its override; (e) with no `plan` role, results equal the switch-off results. In test/review-plan-switch.test.ts
- [X] T007 [P] [US1] Session test: two sessions on one `Settings.isolated(...)`. Turn the switch on in one session only. That session's reviewer spawn resolves to plan. The other session resolves to the configured reviewer and reports `reviewPlanActive === false`. Repeat with the roles of the two sessions reversed. Base the setup on test/cyber-mode-shared-settings.test.ts:139. In test/review-plan-switch-session.test.ts

### Implementation for User Story 1

- [X] T008 [US1] Add `export function reviewPlanRole(role: string, active: boolean): string` and `export function reviewPlanLookup(settings: ModelRoleLookup, active: boolean): ModelRoleLookup`, in src/config/model-resolver.ts
- [X] T009 [US1] Add `agentName?: string` and `reviewPlanActive?: boolean` to `AgentModelPatternResolutionOptions`. In `resolveEffectiveAgentModelSelection`, after the `requestModel` branch, return the `@reviewer` source for review agents while `reviewPlanActive` is true (contracts/model-resolution.md). Expand patterns through `reviewPlanLookup`. In `resolveAgentModelSelection`, map the role with `reviewPlanRole`. In src/config/model-resolver.ts
- [X] T010 [P] [US1] Pass `agentName` and `reviewPlanActive: request.session.reviewPlanActive` to `resolveAgentModelSelection` in src/task/structured-subagent.ts
- [X] T011 [P] [US1] Pass `agentName` and `reviewPlanActive: session.reviewPlanActive` to `resolveAgentModelSelection` in src/vibe/runtime.ts
- [X] T012 [P] [US1] Pass the parent session's `reviewPlan` as `reviewPlan` into the child `createAgentSession` options, in src/task/executor.ts
- [X] T013 [US1] Add `reviewPlanActive(): boolean` to the turn-recovery host interface. Make the retry context's `getModelRole` use `reviewPlanRole(role, this.#host.reviewPlanActive())`, in src/session/turn-recovery.ts
- [X] T014 [US1] Provide `reviewPlanActive: () => this.reviewPlanActive` in the turn-recovery host object, beside `cyberModeEnabled` (line 1885), in src/session/agent-session.ts
- [X] T015 [P] [US1] Make the retry context's `getModelRole` use `reviewPlanRole(role, session.reviewPlanActive)` in src/eval/completion-bridge.ts
- [X] T016 [US1] Add the `/review-plan [on|off|status]` command (session scope only in this phase), a copy of `/cyber`. Output follows contracts/slash-command.md, including the FR-011 notice when no plan resolves. In src/slash-commands/builtin-modes.ts
- [X] T017 [P] [US1] Command tests: `on`, `off`, `status`, the toggle without arguments, bad input gives the usage line, and the no-plan notice, in test/slash-commands/review-plan.test.ts

**Checkpoint**: US1 works in one session. Save scopes, recording, and the indicator come later.

---

## Phase 4: User Story 2 — Turn the switch off to restore diversity (Priority: P2)

**Goal**: Turning off returns reviews to the configured reviewer. A running review keeps its model.

**Independent Test**: Quickstart scenario 11.

### Tests for User Story 2

- [X] T018 [P] [US2] Tests for on → off in one session: the next reviewer spawn resolves to the configured reviewer with role `reviewer` and chain `retry.fallbackChains.reviewer`. For generated inputs with the switch off, `resolveAgentModelSelection` returns the same value with and without the new options (SC-004). In test/review-plan-switch.test.ts
- [X] T019 [P] [US2] Test that a subagent that has already started keeps its resolved model after the parent turns the switch off (FR-007), in test/review-plan-switch-session.test.ts (Holds by construction: resolution runs once per spawn and the child keeps its own session state. No separate test.)

### Implementation for User Story 2

- [X] T020 [US2] Make T018 and T019 pass. Fix only the code from T008–T016. Expect little or no change, because the switch is read once at each spawn. Files: src/config/model-resolver.ts, src/session/model-controls.ts

**Checkpoint**: US1 and US2 pass together.

---

## Phase 5: User Story 3 — See the switch in the bottom bar and keep its state (Priority: P3)

**Goal**: A bottom-bar indicator while active. Session-only state survives `/new`, `/clear`, resume, and branch moves. The `global` and `project` scopes save the default.

**Independent Test**: Quickstart scenarios 1, 2, 6–9, and the `claude3` check.

### Tests for User Story 3

- [X] T021 [P] [US3] Segment tests: hidden while `reviewPlan` is falsy. Visible with `icon.reviewPlan` and `Review:Plan` while true, for the unicode, nerd, and ascii presets. Present in the default preset and in the `claude3` footer. Base them on test/status-line-cyber.test.ts. In test/status-line-review-plan.test.ts
- [X] T022 [P] [US3] Lifecycle tests: session-only "on" survives `/new`, `/clear`, resume, and a session switch back. A fresh session reads `reviewUsesPlan`. A transcript from before this feature restores the inherited value, then the config value. A subagent session inherits the parent's value. Base them on test/cyber-mode-session.test.ts. In test/review-plan-switch-session.test.ts
- [X] T023 [P] [US3] Command save-scope tests: `on global` writes `reviewUsesPlan: true` to the global layer, and `off project` writes `false` to the project layer. Without a scope, no file changes. In test/slash-commands/review-plan.test.ts

### Implementation for User Story 3

- [X] T024 [P] [US3] Add `reviewPlan?: boolean` to `ModelChangeEntry`, with a doc comment that `undefined` means "not recorded", in src/session/session-entries.ts
- [X] T025 [US3] Add the sixth optional parameter `reviewPlan` to `appendModelChange`, and add `getLastReviewPlan()`, a copy of `getLastCyberMode`, in src/session/session-manager.ts
- [X] T026 [US3] Use the restore order `recorded ?? inherited ?? cfgReviewUsesPlan` in the constructor and in a new `restoreReviewPlan(recorded)`. Call `restoreReviewPlan` from `restoreCyberBranch`. Make `setReviewPlan` record the state with `appendModelChange(..., reviewPlan)`, the same way `#recordCyberState` does. In src/session/model-controls.ts
- [X] T027 [US3] Pass `this.reviewPlan` on the `/new` carry-over `appendModelChange` (line 9501). Call `restoreReviewPlan(this.sessionManager.getLastReviewPlan())` beside the resume restore (line 11151). Restore the previous value on the switch rollback (line 11284). In src/session/agent-session.ts
- [X] T028 [US3] Pass the starting `reviewPlan` on the initial `model_change` (line 4414) in src/sdk.ts
- [X] T029 [P] [US3] Add `Settings.setProjectReviewUsesPlan(enabled)`, a `#modifiedProjectReviewUsesPlan` flag, and its save and flush handling, as copies of the `setProjectCyberMode` code (lines 631, 1254–1258, 1764, 3930), in src/config/settings.ts
- [X] T030 [US3] Add the `[global|project]` save scope to `/review-plan`, a copy of `persistCyberMode`, in src/slash-commands/builtin-modes.ts
- [X] T031 [P] [US3] Add `REVIEW_PLAN_SCOPES` completion after `on` or `off`, a copy of `CYBER_SCOPES`, in src/slash-commands/builtin-completions.ts
- [X] T032 [P] [US3] Add the `icon.reviewPlan` symbol key with glyphs unicode `⇄`, nerd `⇄`, and ascii `[RP]`, in packages/tui/src/theme/symbols.ts
- [X] T033 [P] [US3] Expose `reviewPlan` on the icon accessor next to `cyber` (lines 623 and 712), in packages/tui/src/theme/theme-class.ts
- [X] T034 [P] [US3] Add `reviewPlan?: boolean` to the status-line host session next to `cyberMode`, in packages/tui/src/status-line/host.ts
- [X] T035 [US3] Add `reviewPlanSegment` (id `review_plan`, `warning` color, hidden when off) and register it in `SEGMENTS`, in packages/tui/src/status-line/segments.ts
- [X] T036 [P] [US3] Add `review_plan` to the segment schema in packages/tui/src/status-line/schema.ts
- [X] T037 [P] [US3] Add `review_plan` after `cyber` in the default preset in packages/tui/src/status-line/presets.ts
- [X] T038 [US3] Render `review_plan` next to `cyber` in the `claude3` footer in packages/tui/src/status-line/component.ts
- [X] T039 [US3] Fill `reviewPlan: session.reviewPlanActive` where `cyberMode` is filled (line 3145), and request a status-line render after `/review-plan` changes the state, in src/modes/interactive-mode.ts (Not needed: the status line reads `reviewPlanActive` from the session object directly. Checked in the TUI.)

**Checkpoint**: All three stories pass on their own and together.

---

## Phase 6: Polish and cross-cutting concerns

- [X] T040 [P] Add a `reviewUsesPlan` entry next to `cyberMode` in docs/settings.md
- [X] T041 [P] Write docs/review-plan.md: the `/review-plan` command, save scopes, which agents follow the switch, the precedence rules, the lifecycle, and the `review_plan` segment
- [X] T042 [P] Add a `/review-plan` entry to the Unreleased section of packages/coding-agent/CHANGELOG.md
- [X] T043 [P] Add a "Review plan switch" decision block, with key paths and test files, in UPSTREAM_DIVERGENCES.md
- [X] T044 [P] Append `reviewUsesPlan: false` to ~/.omp/agent/config.yml (the rule in `.omp/AGENTS.md`), and add `review_plan` to `statusLine.leftSegments` there, after `model_profile`
- [X] T045 Run `PATH="$HOME/.cargo/bin:$PATH" bun run setup && bun check` from the repository root. Then run the four new test files and test/cyber-mode-shared-settings.test.ts
- [X] T046 Run the manual scenarios in specs/005-review-plan-switch/quickstart.md in a real `omp` TUI, and record the results (Done. TUI: scenarios 1–12 and both footer layouts pass. Reviewer models for 3, 4, 5, 10, 11 come from the subagent transcripts, see T053.)

---

## Dependencies and execution order

### Phase dependencies

- Setup (T001) → Foundational (T002–T004) → US1 → US2 → US3 → Polish.
- US2 checks US1 behavior, so it needs US1.
- The recording and indicator parts of US3 need only Foundational. The command-scope task (T030) needs T016.

### Within each story

- Tests first. They must fail before the implementation.
- In US1: T008 → T009 → T010 and T011. T013 → T014. T016 needs T003.
- In US3: T024 → T025 → T026 → T027 and T028. T032 → T033 → T035. T034 → T035 → T038 → T039.

### Parallel opportunities

- US1 tests: T005, T006, T007.
- US1 callers after T009: T010, T011, T012, T015.
- US3 tests: T021, T022, T023.
- US3 files: T024, T029, T031, T032, T034, T036, T037.
- Polish docs: T040–T044.

## Parallel example: User Story 3

```text
Task: "T021 Segment tests in test/status-line-review-plan.test.ts"
Task: "T022 Lifecycle tests in test/review-plan-switch-session.test.ts"
Task: "T023 Command save-scope tests in test/slash-commands/review-plan.test.ts"
Task: "T032 icon.reviewPlan in packages/tui/src/theme/symbols.ts"
Task: "T034 reviewPlan field in packages/tui/src/status-line/host.ts"
```

## Implementation strategy

### MVP (US1 only)

1. Do Phase 1 and Phase 2.
2. Do Phase 3.
3. Stop and check quickstart scenarios 2–5 and 10. With the session-only toggle, reviews move to the plan model today.

### Incremental delivery

1. MVP → US2 (off path and the SC-004 identity check).
2. → US3 (indicator, recording, save scopes).
3. → Polish (docs, config default, full check, manual run).

## Phase 7: Convergence

- [X] T047 Emit a warning notice when the review plan switch is on but no plan model resolves at session start, on restore (resume, `/new`, branch moves, inherited value), and after a profile change, in src/session/model-controls.ts and src/session/agent-session.ts per FR-011 (partial) (Done in model-controls.ts: warns once per inactive stretch; startup goes to configWarnings. TUI: warning at startup with no plan role, and on a change to a profile without plan.)
- [X] T048 Test the retry chain of a remapped reviewer: with the switch on, the subagent inherited chain (`resolveSubagentInheritedRetryFallbackChain`), the turn-recovery retry context, and the eval completion chain read `plan`; with the switch off, they read `retry.fallbackChains.reviewer`, in test/review-plan-switch.test.ts per FR-003 / D9.2 / T018 (partial) (Done. The test found that the remap let a `reviewer` chain key take over a plan-model session by YAML order. `reviewPlanRetryContext` keeps the reviewer→plan read and sets the `reviewer` key aside, see research D2 correction. Tests cover the subagent chain `runSubprocess` installs, the main-session chain key, and eval completion fallback, for both key orders. The eval tests in test/eval/completion-bridge.test.ts check the model that `completeSimple` gets after the primary fails: a plan-model completion falls back through `plan` for both orders, with the switch on and off. A reviewer-model completion uses the `reviewer` chain only while the switch is off. Mutation checks: when the bridge ignores the switch, or the helper keeps the `reviewer` key, a test fails.)
- [X] T049 Add a seeded property test over generated role maps: `reviewPlanLookup(s, true)` equals `s` for every role except `reviewer`, which reads `plan`, and `reviewPlanLookup(s, false)` equals `s` for every role, in test/review-plan-switch.test.ts per FR-012 / D9.1 / T005 (partial) (Done, seed 516581.)
- [X] T050 Extend the shared-settings test so each session's reviewer spawn resolves through its own tool session (`getReviewPlan`): plan for the session with the switch on, reviewer for the other, both ways round, in test/review-plan-switch-session.test.ts per FR-009 / D9.5 / T007 (partial) (Done: resolution through each session's own `reviewPlan`. The sdk getter is a one-line forward, so no wiring test.)
- [X] T051 Add lifecycle tests: a session switch away and back restores the recorded state; the task executor passes the parent's `reviewPlan` into the child session; a transcript with no record uses the inherited value before `reviewUsesPlan`, in test/review-plan-switch-session.test.ts per FR-009a / T022 (partial) (Done. The executor inheritance is checked in test/review-plan-switch.test.ts with the chain test.)
- [X] T052 Add a test that a subagent already running keeps its resolved model and retry chain after the parent turns the switch off, in test/review-plan-switch-session.test.ts per FR-007 / US2/AC2 / T019 (partial)
- [X] T053 Run quickstart scenarios 3, 4, 5, 10, 11 with a real reviewer spawn, scenario 7 (resume), and scenario 12 (no plan model) in a real `omp` TUI, and record the results under T046 per T046 / quickstart (partial) (Done, in a scratch repo with a one-line diff. Models are from each subagent transcript. 3: opus profile, switch on, `/review` → `anthropic/claude-opus-5-5`. 5: `/model-profile astra`, `/review` → `openai-codex/gpt-6-astra:max`. 10: project `task.agentModelOverrides.reviewer: openai-codex/gpt-6-sol`, switch on → `anthropic/claude-opus-5-5:xhigh`. 11: same override, switch off → `openai-codex/gpt-6-sol:high`. 4: `/debate` could not reach its reviewer, because `xd://propose` fails at HEAD ("Plan proposal lifecycle context is unavailable.", `internal-urls/xd-protocol.ts` passes no context). This bug is not part of this feature. A direct `plan-reviewer` task, which uses the same `runSubprocess` resolution, ran on `anthropic/claude-opus-5-5:xhigh`. 7: resume restores on over a saved off. 12: startup warning, no indicator.)
- [X] T054 Assert that `review_plan` is in the default preset and renders in the `claude3` footer, in test/status-line-review-plan.test.ts per FR-010a / T021 (partial) (Done in test/modes/components/status-line/component.test.ts beside the cyber layout tests.)
- [X] T055 Assert that `/review-plan on global` writes the global layer and `/review-plan off project` writes the project layer, in test/slash-commands/review-plan.test.ts per FR-009 / T023 (partial)
- [X] T056 Review the shared `buildVerbScopeCompletions` refactor and the `buildCyberInlineHint` → `buildVerbScopeInlineHint` rename in src/slash-commands/builtin-completions.ts, then keep them with a note or revert to a plain copy per plan D6 (unrequested) (Kept: the shared helper is shorter than a copy, and test/slash-commands/cyber.test.ts passes unchanged.)

## Phase 8: Convergence

- [X] T057 Pass the `write` call's abort signal and tool call ID as the `PlanProposalContext` from `internal-urls/xd-protocol.ts` to `dispatchResolutionDevice`, so `xd://propose` reaches the debate `plan-reviewer`. Then run quickstart scenario 4 through `/debate` with the switch on, and record the `PlanReviewer` transcript model under T053 per US1/AC3 / FR-003 (partial) (Done. `xd-protocol.ts` now passes `{ signal, toolCallId }` when the write call has both. test/write-xdev-dispatch.test.ts writes `xd://propose` through `WriteTool` and checks the handler gets the title, the signal and the call ID. The test failed before the fix with the same error as the TUI. TUI: `/review-plan on`, then `/debate` in a scratch repo, reached plan approval. The `PlanReviewer` transcript shows `anthropic/claude-opus-5-5` at `xhigh` with `reviewPlan: true`.)
- [X] T058 Add the `reviewer` chain-key rule from `reviewPlanRetryContext` to contracts/model-resolution.md "Session retry contexts" and to the data-model.md role table: while the switch is active, the key is set aside, and a session on the real reviewer model keeps only its selector-keyed chain, per plan: D2 correction (partial) (Done. contracts/model-resolution.md "Session retry contexts" and the data-model.md role lookup section now state the key rule and the reviewer-model effect.)
