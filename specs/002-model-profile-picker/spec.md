# Feature Specification: Model Profile Picker

**Feature Branch**: `main` (feature directory: `002-model-profile-picker`)

**Created**: 2026-09-22

**Status**: Draft

**Input**: User description: "check current model profile ui to switching them; I want have alternatie way to like model pricker for model profiles; keep both of them; add a config field for style; and default to model picker style for model profile"

## Clarifications

### Session 2026-09-22

- Q: Which action should open the new profile picker? → A: Profile keys open the picker by default. The existing style keeps key-based cycling.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Choose a Profile from a Picker (Priority: P1)

A user presses a profile-switch key and sees the configured profiles in a searchable picker similar to the model picker. The current profile is clear. The user selects a profile and the session applies its role bundle.

**Why this priority**: This is the requested default way to choose a profile without memorizing names or cycling through all profiles.

**Independent Test**: Configure several profiles, press either profile-switch key without a style setting, filter by name, and select another profile. Confirm that its role bundle becomes active.

**Acceptance Scenarios**:

1. **Given** two or more configured profiles and no style preference, **When** the user presses either profile-switch key, **Then** a picker lists those profiles and marks the active profile.
2. **Given** an open picker, **When** the user types part of a profile name and selects a match, **Then** the session activates that profile and closes the picker.
3. **Given** an open picker, **When** the user cancels, **Then** the active profile remains unchanged.

---

### User Story 2 - Retain Key-Based Cycling (Priority: P2)

A user who prefers profile cycling selects the existing style and uses the profile keys to cycle forward or backward.

**Why this priority**: Existing users must be able to keep their current key-based workflow.

**Independent Test**: Select the existing style, press the forward and backward profile keys, and confirm that each cycles in the corresponding direction.

**Acceptance Scenarios**:

1. **Given** the existing style, **When** the user presses the forward profile key, **Then** the next configured profile becomes active and the cycle track shows the selection.
2. **Given** the existing style, **When** the user presses the backward profile key, **Then** the previous configured profile becomes active and the cycle track shows the selection.

---

### User Story 3 - Use Direct Profile Commands (Priority: P3)

A user can still name a profile directly, request profile status, and choose whether to save it as the startup profile. The style preference changes only the profile keys.

**Why this priority**: The new interface must not remove direct commands or persistence choices.

**Independent Test**: Select each style and use a named profile command with and without a save scope. Confirm that each command keeps its existing result.

**Acceptance Scenarios**:

1. **Given** either style, **When** the user names a configured profile directly, **Then** the session activates that profile without requiring picker input.
2. **Given** either style, **When** the user saves a named profile as the startup profile, **Then** the chosen scope retains it for future sessions.
3. **Given** either style, **When** the user invokes `/model-profile` without a name, **Then** the command reports the active and available profiles instead of opening a picker.

### Edge Cases

- When no profiles exist, opening the switcher explains that the user must configure profiles and does not show an empty picker.
- When the filter finds no profile, the picker shows a no-match state and does not switch the session.
- When only one profile exists, the picker still shows it and allows the user to cancel or select it.
- If a selected profile has no available model for the active role, the system keeps the existing notice that the profile was installed but no model resolved.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST offer a profile picker that lists the configured model profiles and identifies the active profile.
- **FR-002**: The picker MUST let users filter profiles by name, select a bundle, or cancel without changing the active profile.
- **FR-003**: The system MUST retain forward and backward key-based profile cycling as a selectable style.
- **FR-004**: The system MUST expose a configuration preference for the profile-key style with exactly two supported choices: picker and cycling.
- **FR-005**: The system MUST open the picker when either profile-switch key is pressed and the style preference is absent or set to picker.
- **FR-006**: The style preference MUST change the profile keys, not the selected profile or its configured roles.
- **FR-007**: Both styles MUST apply the chosen profile bundle, resolve the active role, update session state, and report when no model resolves.
- **FR-008**: Direct `/model-profile` selection, status display, and startup-profile save choices MUST remain unchanged in either style.
- **FR-009**: The system MUST explain when no profiles are configured instead of presenting an unusable switcher.

### Key Entities *(include if feature involves data)*

- **Model profile**: A named set of configured model roles. One profile can be active in a session.
- **Profile-key style**: A user preference that selects the picker or key-based cycling. Its default is picker.
- **Startup profile**: An optional saved profile name for future sessions. It is separate from the switcher style.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a configuration with 20 profiles, a user can find and activate a named profile through the default switcher in under 15 seconds.
- **SC-002**: In acceptance checks, 100% of canceled picker sessions leave the active profile unchanged.
- **SC-003**: In acceptance checks, both style choices permit successful profile selection, and 100% of direct commands retain their prior outcomes.
- **SC-004**: At least 9 of 10 users in a task trial can identify the active profile and choose another on their first attempt without instructions.

## Assumptions

- The existing interface is key-based forward and backward profile cycling. The picker replaces the keys' cycling action by default, not the `/model-profile` command.
- The style preference changes the profile keys only. It does not change which profile starts a session.
- The picker uses the existing model picker's familiar search, selection, and cancellation behavior where these actions apply to profiles.
- Existing profile definitions and save scopes remain unchanged.
