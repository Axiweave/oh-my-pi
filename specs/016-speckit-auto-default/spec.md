# Feature Specification: Speckit-Auto Startup Default

**Feature Branch**: `main`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "add it; should support project local override like model profile !" (Context: add a config setting that turns speckit-auto mode on by default, with a value of off, full, or stop after tasks. The setting must work in the global config, and a project config must override it, the same way the startup model profile works.)

## Clarifications

### Session 2026-10-21

- Q: When you resume an older session that never used speckit-auto mode, should the startup default turn the mode on in that session? → A: No. The default applies only to brand-new sessions (startup with no transcript, `/new`, `/delete`). A resumed session keeps its own state, and a session with no record stays off.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - New sessions start with speckit-auto mode on (Priority: P1)

An operator who uses speckit for most work does not want to toggle speckit-auto mode in every new session. The operator sets a startup default in the global config. Each new interactive session then starts with speckit-auto mode already on, at the scope the setting names.

**Why this priority**: This is the core ask. Without it, the operator must toggle the mode by hand at the start of every session.

**Independent Test**: Set the global default to "full". Start a new interactive session in a project that has the speckit commands. The status line shows speckit-auto mode on, and `/speckit.specify <feature>` starts a full run without a toggle.

**Acceptance Scenarios**:

1. **Given** the global default is "full", **When** the operator starts a new interactive session in a speckit project, **Then** speckit-auto mode is on and runs go through every phase.
2. **Given** the global default is "tasks", **When** the operator starts a new interactive session in a speckit project, **Then** speckit-auto mode is on and runs stop after the tasks phase.
3. **Given** the default is "off" or not set, **When** the operator starts a new interactive session, **Then** speckit-auto mode is off, which is the current behavior.
4. **Given** the default is "full" and the mode is on, **When** the operator toggles the mode, **Then** the toggle cycles from the current state as it does today, and the setting does not change.

---

### User Story 2 - A project config overrides the global default (Priority: P1)

An operator works in several projects. Only some projects use speckit. The operator sets a value in a project config, and that value wins over the global value for sessions in that project. This matches how the startup model profile works.

**Why this priority**: The user asked for this explicitly. A global-only setting is wrong for projects that do not use speckit, or that want a different scope.

**Independent Test**: Set the global default to "off" and the project default to "tasks". Start a session in that project: the mode is on, stopping after tasks. Start a session in another project: the mode is off.

**Acceptance Scenarios**:

1. **Given** the global default is "off" and the project default is "full", **When** the operator starts a new session in that project, **Then** speckit-auto mode is on with the full scope.
2. **Given** the global default is "full" and the project default is "off", **When** the operator starts a new session in that project, **Then** speckit-auto mode is off.
3. **Given** the global default is "full" and the project sets no value, **When** the operator starts a new session in that project, **Then** the global value applies.

---

### User Story 3 - Save the default from the command, at a chosen scope (Priority: P2)

The operator wants to save the startup default without a manual config edit. The speckit-auto mode command takes an optional scope word, "global" or "project", the same way the model profile command does. The command sets the mode in the current session and saves that value as the startup default in the named config.

**Why this priority**: This follows the model profile pattern that the user named. It is a convenience. The config field alone covers the core need.

**Independent Test**: Run the command with a value and the "project" scope. Open the project config and see the saved value. Start a new session and see the mode on at that scope.

**Acceptance Scenarios**:

1. **Given** speckit-auto mode is off, **When** the operator runs the mode command with "full" and "project", **Then** the mode turns on with the full scope, and the project config stores "full" as the startup default.
2. **Given** any state, **When** the operator runs the mode command with "off" and "global", **Then** the mode turns off, and the global config stores "off".
3. **Given** any state, **When** the operator runs the mode command with no arguments, **Then** the command cycles the mode as it does today, and no config changes.
4. **Given** any state, **When** the operator gives an unknown value or scope word, **Then** the command shows the usage text and changes nothing.

---

### Edge Cases

- A resumed session never gets the startup default. If it has saved speckit-auto state, that state comes back as it does today. If it has no record, for example an old session from before the mode existed, the mode stays off.
- `/new` (and `/delete`) while the mode is on carries the mode into the new session, as it does today. If the mode is off at that time, the new session is brand-new, so the startup default applies.
- The project does not have the speckit phase commands. The mode stays off, and no warning shows. A global default must not make noise in projects that do not use speckit.
- An explicit startup mode that blocks speckit-auto mode is active, for example plan mode or a goal from the command line. The explicit mode wins. Speckit-auto mode stays off, and one notice tells the operator why.
- The config value is not one of the known values. The mode stays off, and the debug log gets a warning that names the bad value. All enum settings handle bad values this way.
- Non-interactive runs, such as print mode, RPC, and ACP, ignore the setting. Speckit-auto mode exists only in the interactive session.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide one config setting for the speckit-auto startup default, with the values "off", "full", and "tasks". The default value is "off".
- **FR-002**: The system MUST read the setting from the global config and from the project config. The project value MUST override the global value when both exist.
- **FR-003**: When a brand-new interactive session starts, the system MUST turn speckit-auto mode on at the scope the setting names. A brand-new session is one that starts with no transcript: a fresh startup, `/new`, or `/delete`. The value "off" leaves the mode off.
- **FR-004**: The system MUST NOT apply the startup default to a resumed session, with or without saved speckit-auto state. A resumed session keeps its saved state, or stays off when it has none.
- **FR-005**: The system MUST apply the startup default only when the project has the speckit phase commands. If they are missing, the mode MUST stay off with no warning.
- **FR-006**: The system MUST apply the startup default only when no other blocking mode is active at startup. If a blocking mode is active, the mode MUST stay off and the system MUST show one notice that names the blocking mode.
- **FR-007**: The system MUST treat an unknown value of the setting as "off", and MUST log a warning that names it, the same way every other enum setting does.
- **FR-008**: The speckit-auto mode command MUST accept an optional value ("off", "full", or "tasks") and an optional scope word ("global" or "project"). With a scope word, the command MUST set the mode in the current session and save the value as the startup default in the named config.
- **FR-009**: The speckit-auto mode command with no arguments MUST keep its current cycle behavior and MUST NOT change any config.
- **FR-010**: The system MUST show the new setting in the settings panel with the three values.
- **FR-011**: The operator's global config file (`~/.omp/agent/config.yml`) MUST list the new setting with its default value, per the repository's local rule for configurable features.

### Key Entities

- **Speckit-auto startup default**: One config value, "off", "full", or "tasks". It can exist in the global layer and in the project layer. The project layer wins.
- **Saved speckit-auto session state**: The existing per-session record of whether the mode is on, its scope, and the run. Only a resume reads it. The startup default never applies on resume.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With a default set, an operator starts speckit work in a new session with zero toggle actions. Today this takes one or more toggle actions.
- **SC-002**: In 100% of test cases where the global and project values differ, a new session in that project uses the project value.
- **SC-003**: In a project without the speckit commands, a global default of "full" shows zero warnings at startup.
- **SC-004**: For every startup default value, a resumed session shows the same mode and scope as before it closed in 100% of test cases. A resumed session with no record shows the mode off.
- **SC-005**: An operator can save the startup default to either config scope with one command.

## Assumptions

- "Like model profile" means the same layer rules (the project config overrides the global config) and the same command pattern (an optional "global" or "project" scope word that saves the value). It does not include a new command-line flag. Add a flag later if a need appears.
- The scope values match the existing toggle states: "full" runs every phase, and "tasks" stops after the tasks phase.
- A startup default turns the mode on but does not start a run. The operator still starts a run with `/speckit.specify`, as with a manual toggle.
- Silence in projects without the speckit commands is correct, because a global default targets speckit projects only.
- Existing settings infrastructure already merges the project config over the global config for ordinary settings. The feature reuses it.
- The toggle keybinding `app.speckitAuto.toggle` has no default key. The operator must bind it in the keybindings config, or use `/speckit-auto-mode`. This feature does not add a default key.
