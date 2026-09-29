# Feature Specification: Review Plan-Model Switch

**Feature Branch**: `main` (feature directory: `005-review-plan-switch`)

**Created**: 2026-09-29

**Status**: Draft

**Input**: User description: "we default to use model from other provider to have some diversity in review; but sometimes; other provider just run out of usage; so I want to have a swtich to just plan model (which is generally smarter) to do review; propose a design"

## Clarifications

### Session 2026-09-29

- Q: When the switch is on and a saved per-agent model override names a fixed reviewer model, should the switch win over that override? → A: The switch wins. Only an explicit model on a single review request wins over the switch.
- Q: When the switch is on, should it redirect only the built-in review agents, or every place that names the reviewer role? → A: Every place that names the reviewer role, including custom agents and fallback chains.
- Q (user direction): Where must the switch state show? → A: In the bottom status bar as a dedicated indicator, the same way the cyber mode indicator shows.
- Q: If the user turns the switch on for the current session only, should resume, `/new`, or `/clear` keep it on? → A: Yes, the same as cyber mode. The session records the switch state. Only a restart without save resets it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Send Reviews to the Plan Model on Demand (Priority: P1)

A user works in a profile whose reviewer comes from a different provider. That provider has no usage left. The user turns on one switch. After that, every review in the session uses the plan model of the active profile. The user does not edit any profile.

**Why this priority**: This is the requested capability. Without it, the user must edit the reviewer entry in each profile, or reviews fail until the other provider resets.

**Independent Test**: Configure a profile with a reviewer from provider B and a plan model from provider A. Turn on the switch. Start a review. Confirm that the review runs on the plan model of the active profile.

**Acceptance Scenarios**:

1. **Given** the switch is off and the profile names a cross-provider reviewer, **When** the user starts a review, **Then** the review uses the configured reviewer.
2. **Given** the switch is on, **When** the user starts a review, **Then** the review uses the plan model of the active profile, with its configured thinking level.
3. **Given** the switch is on, **When** a debate-plan workflow, an implementation review, a custom agent, or a fallback chain names the reviewer role, **Then** it gets the plan model.
4. **Given** the switch is on, **When** the user changes to another profile, **Then** reviews use the plan model of the new profile.

---

### User Story 2 - Turn the Switch Off to Restore Diversity (Priority: P2)

After the other provider resets, the user turns off the switch. Reviews go back to the cross-provider reviewer of the active profile.

**Why this priority**: Cross-provider review is the preferred default. The switch is a temporary measure, so returning to the default must be one action.

**Independent Test**: Turn on the switch, start a review, turn off the switch, start a second review. Confirm that the second review uses the configured reviewer.

**Acceptance Scenarios**:

1. **Given** the switch is on, **When** the user turns it off, **Then** the next review uses the configured reviewer of the active profile.
2. **Given** a review is in progress, **When** the user changes the switch, **Then** the running review keeps its model and only later reviews use the new setting.

---

### User Story 3 - See the Switch in the Bottom Bar and Keep Its State (Priority: P3)

The bottom status bar shows a dedicated indicator while the switch is on, the same way it shows cyber mode. The indicator is not visible while the switch is off. The user can choose to keep the setting for future sessions or only for the current session.

**Why this priority**: A silent override can hide the loss of review diversity. Persistence helps when the other provider stays exhausted for days.

**Independent Test**: Turn on the switch and confirm the indicator appears in the default status layout and in the `claude3` composer footer. Turn it off and confirm the indicator disappears. Turn it on for the session only and restart. Confirm that it is off. Turn it on with save and restart. Confirm that it is on and the indicator shows.

**Acceptance Scenarios**:

1. **Given** the switch is off, **When** the status bar renders, **Then** no review-switch indicator is present.
2. **Given** the switch is on, **When** the status bar renders in the default layout or in the `claude3` composer footer, **Then** the indicator is present and distinguishable from the model, model-profile, and cyber indicators.
3. **Given** a custom status layout, **When** the user adds the review-switch segment to it, **Then** the layout renders the indicator.
4. **Given** the user turns on the switch for the session only, **When** the user runs `/new`, runs `/clear`, or resumes that session, **Then** the switch stays on and the indicator is visible.
5. **Given** the user turns on the switch for the session only, **When** the user restarts the tool with a fresh session, **Then** the switch is off and the indicator is not visible.
6. **Given** the user saves the switch as on, **When** a fresh session starts, **Then** the switch is on and the indicator is visible.

### Edge Cases

- If the profile has no plan model, the system uses the global plan model. If no plan model exists, the system keeps the configured reviewer and tells the user.
- If the plan model and the configured reviewer are the same, the switch has no visible effect and the system shows no error.
- If a caller names an explicit model for one review, that explicit model wins over the switch.
- If the plan model also has no usage left, the existing retry and fallback behavior applies. The switch does not add a new fallback path.
- The switch changes only the reviewer role. The advisor, the default model, and other roles keep their configured models.
- A custom agent or fallback chain that names the reviewer role gets the plan model while the switch is on, even if the user does not think of it as a review.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide one switch that selects the review model source: the configured reviewer or the plan model.
- **FR-002**: The default value MUST be the configured reviewer, so current behavior does not change.
- **FR-003**: When the switch selects the plan model, every reference to the reviewer role MUST resolve to the plan model of the active profile. This includes the review command, reviewer subagents, debate-plan reviewers, custom agents, and fallback chains that name the reviewer role.
- **FR-004**: The plan model MUST keep its configured thinking level when it runs a review.
- **FR-005**: The switch MUST apply to all profiles. The user MUST NOT need to edit any profile to use it.
- **FR-006**: A profile change MUST make later reviews use the plan model of the new profile while the switch is on.
- **FR-007**: A change to the switch MUST apply to reviews that start after the change and MUST NOT change reviews in progress.
- **FR-008**: An explicit model on a single review request MUST take precedence over the switch. The switch MUST take precedence over saved per-agent model overrides for review agents, including overrides that name a fixed model.
- **FR-009**: The user MUST be able to set the switch for the current session only or save it for future sessions.
- **FR-009a**: The session MUST record the switch state, the same way it records cyber mode. A resumed session, `/new`, and `/clear` MUST keep the recorded state and the indicator MUST match it.
- **FR-010**: The bottom status bar MUST show a dedicated review-switch indicator while the switch is on and MUST hide it while the switch is off, the same way it shows cyber mode.
- **FR-010a**: The indicator MUST appear in the default status layout and in the `claude3` composer footer without user configuration. It MUST also be a selectable segment for a custom status layout.
- **FR-011**: If no plan model resolves, the system MUST keep the configured reviewer and tell the user.
- **FR-012**: The switch MUST NOT change any role other than the reviewer.

### Key Entities *(include if feature involves data)*

- **Reviewer model**: The model that the active profile names for review. It usually comes from a different provider than the main models.
- **Plan model**: The model that the active profile names for planning. It is usually the strongest model in the profile.
- **Review model source**: A user preference with two values: configured reviewer (default) or plan model. It has a session value and an optional saved value.
- **Model profile**: A named set of model roles. The switch reads the plan model and the reviewer model from the active profile.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With one action in under 10 seconds and zero profile edits, a user can make every later review use the plan model of the active profile. The review leaves an exhausted provider only when that plan model uses a different provider that still has usage.
- **SC-002**: In acceptance checks, 100% of references to the reviewer role resolve to the plan model while the switch is on, across every configured profile.
- **SC-003**: In acceptance checks, 100% of reviews use the configured reviewer after the user turns the switch off.
- **SC-004**: With the switch at its default value, review model selection is identical to the behavior before this feature in 100% of checks.
- **SC-005**: A change to the switch changes the bottom-bar indicator within one render cycle. A user can tell whether reviews use the plan model without opening any settings.

## Assumptions

- The user asks for a manual switch. Automatic change on usage exhaustion is out of scope. The existing retry fallback chains already cover the automatic case.
- The switch covers the reviewer role only. The advisor also comes from another provider, but the user did not ask to change it.
- The switch follows the save choices that model profiles already use: session only or saved.
- The switch remaps the reviewer role itself, so every reference to that role follows it. Review agents can also get a fixed model from a saved per-agent override. The switch also applies at the point where a review agent gets its model, so it covers that source.
- The cyber mode indicator is the precedent for the look, placement, and segment behavior of the review-switch indicator. The user's own layout lists segments by hand, so the user must add the new segment to that list.
- The global plan model is the fallback when a profile does not name a plan model, which matches how profiles already inherit roles.
