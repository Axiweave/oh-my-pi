# Feature Specification: Task Effort Matches Auto Mode Levels

**Feature Branch**: `008-task-effort-mapping`

**Created**: 2026-10-01

**Status**: Draft

**Input**: User description: "change task efforts to match auto mode; based on the current task role model supporting effort we do the mapping; so low/medium/high/xhigh/max you can think it split like 1/5, 2/5 ~ 1/5 and if our current model only support 3 low/medium/high => 1/3, 2/3, 1 so if model return medium => 2/5 => choose 1/3 because 1/3 is next upper close to 1/3"

## Clarifications

### Session 2026-10-01

- Q: When the subagent's model also supports `minimal`, should the mapping ignore `minimal`, the same way auto mode does? → A: Yes. Ignore levels below `low` before the mapping. If the model has no level at or above `low`, use all its levels.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Delegating agent requests a level on the auto-mode ladder (Priority: P1)

A delegating agent spawns a subagent and sets the per-spawn effort. Today it can only pick `lo`, `med`, or `hi`. After this change it picks from the same five levels that auto mode uses: `low`, `medium`, `high`, `xhigh`, `max`. The delegating agent also sees the same level descriptions that the auto classifier uses, so one level name means the same thing in both places.

**Why this priority**: The five-level vocabulary is the base for the proportional mapping. Without it, no other story has an input.

**Independent Test**: Enable per-task effort. Spawn a subagent with each of the five levels. Make sure the call accepts each one. Make sure the call rejects `lo`, `med`, and `hi` with a message that lists the five valid levels.

**Acceptance Scenarios**:

1. **Given** per-task effort is enabled, **When** the delegating agent reads the task tool description, **Then** the effort field lists `low`, `medium`, `high`, `xhigh`, `max` with the same criteria the auto classifier uses for each level.
2. **Given** per-task effort is enabled, **When** a spawn sets `effort` to `xhigh`, **Then** the spawn starts and the subagent runs at the level that User Story 2 gives for `xhigh`.
3. **Given** per-task effort is enabled, **When** a spawn sets `effort` to `med`, **Then** the spawn fails before start with an error that names the five valid levels.

---

### User Story 2 - Requested level maps proportionally onto the subagent model's supported range (Priority: P1)

The requested level has a fixed position on the five-level ladder: `low` = 1/5, `medium` = 2/5, `high` = 3/5, `xhigh` = 4/5, `max` = 5/5. The subagent's resolved model supports its own ordered list of levels. The system removes levels below `low` (as auto mode does), and the rest are the eligible levels. Each eligible level has a position: the k-th of n levels is at k/n. The system selects the lowest eligible level whose position is at or above the requested position ("next upper"). For a model that supports `low`, `medium`, `high` (positions 1/3, 2/3, 1), a request for `medium` (2/5) selects `medium` (2/3).

**Why this priority**: This is the core behavior the user asked for. It replaces the current rule (first, middle, or last supported level).

**Independent Test**: For a set of model ranges (eligible sizes 1 to 5, with and without `minimal`), resolve each of the five requested levels. Compare the results with the mapping table below.

**Acceptance Scenarios**:

1. **Given** a subagent model that supports exactly `low`, `medium`, `high`, `xhigh`, `max`, **When** a spawn requests any of these levels, **Then** the subagent runs at that same level.
2. **Given** a subagent model that supports `low`, `medium`, `high`, **When** a spawn requests `medium`, **Then** the subagent runs at `medium`.
3. **Given** a subagent model that supports one level only, **When** a spawn requests any level, **Then** the subagent runs at that one level.
4. **Given** the spawn has no resolved model, **When** a spawn requests a level, **Then** the subagent runs at that same level (the full canonical list has eligible levels `low..max`).

**Reference mapping** (rule: next upper position over eligible levels, see FR-003 and FR-004):

| Requested (position) | 2 levels `high,xhigh` | 3 levels `low,medium,high` | 4 levels `low..xhigh` | 5 levels `low..max` | `minimal..xhigh` (eligible `low..xhigh`) |
|---|---|---|---|---|---|
| `low` (1/5) | `high` | `low` | `low` | `low` | `low` |
| `medium` (2/5) | `high` | `medium` | `medium` | `medium` | `medium` |
| `high` (3/5) | `xhigh` | `medium` | `high` | `high` | `high` |
| `xhigh` (4/5) | `xhigh` | `high` | `xhigh` | `xhigh` | `xhigh` |
| `max` (5/5) | `xhigh` | `high` | `xhigh` | `max` | `xhigh` |

---

### User Story 3 - Operator ceiling still limits the mapped level (Priority: P2)

An operator sets the maximum per-spawn effort. The system first maps the request onto the model's range, then applies the ceiling, as it does today.

**Why this priority**: The ceiling is an existing safety limit on cost. The new mapping must not bypass it.

**Independent Test**: Set the ceiling to `medium`. Spawn with `max` on a five-level model. Make sure the subagent runs at `medium`.

**Acceptance Scenarios**:

1. **Given** the ceiling is `medium` and the model supports `low..max`, **When** a spawn requests `max`, **Then** the subagent runs at `medium`.
2. **Given** the ceiling is below the model's lowest supported level, **When** a spawn requests any level, **Then** the spawn fails with the existing ceiling error.

---

### Edge Cases

- The model has no controllable effort: the system ignores the requested level and the subagent uses its normal level selection, as today.
- The model supports `minimal`: the system removes `minimal` before the mapping, the same as auto mode. A `minimal..xhigh` model maps as `low..xhigh` (see the table).
- The model supports only `minimal`: no level is at or above `low`, so every request selects `minimal`.
- A supported position equals the requested position: "at or above" includes equal, so the system selects that level. Positions compare exactly, with no rounding error.
- `max` (5/5) always selects the model's highest eligible level, because the last position is always 1.
- A retry with a fallback model: the ceiling from the spawn stays in force, as today.
- The requested level is outside the five valid values (for example from an old transcript): the spawn fails with a clear error. The system does not translate `lo`, `med`, or `hi`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The per-spawn effort field MUST accept exactly `low`, `medium`, `high`, `xhigh`, `max`, and MUST reject every other value, including `lo`, `med`, `hi`.
- **FR-002**: The task tool description MUST describe each of the five levels with the same criteria that the auto thinking classifier uses for that level.
- **FR-003**: The system MUST give the requested level the position i/5, where i is its 1-based index in `low, medium, high, xhigh, max`. The eligible levels are the model's supported levels at or above `low`. If no supported level is at or above `low`, all supported levels are eligible. The system MUST give the k-th of n eligible levels the position k/n.
- **FR-004**: The system MUST select the lowest eligible level whose position is at or above the requested position. The system MUST NOT select an eligible level below the requested position.
- **FR-005**: The system MUST apply the operator ceiling after the mapping, with the same result and error behavior as today.
- **FR-006**: When the model has no controllable effort, the system MUST leave the subagent's normal level selection in place.
- **FR-007**: When no model resolves, the system MUST use the full canonical level list as the supported levels.
- **FR-008**: The mapped level MUST keep its current precedence: it wins over an explicit model level suffix, the agent default, and the pattern level.
- **FR-009**: The subagent progress display MUST show the mapped level, as it does today.

### Key Entities

- **Requested effort**: One of five ordered levels on the auto-mode ladder. Each has a fixed position from 1/5 to 5/5.
- **Supported levels**: The ordered list of thinking levels that the subagent's resolved model accepts. Size 1 to 6.
- **Eligible levels**: The supported levels at or above `low`, or all supported levels when none is at or above `low`. Size 1 to 5. Each has a position k/n.
- **Effort ceiling**: The operator maximum for per-spawn effort. It limits the mapped level.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every eligible list of size 1 to 5 and every requested level, the resolved level equals the level the FR-004 rule gives (all 25 combinations of request and size, checked against a slow reference calculation).
- **SC-002**: For a model that supports exactly the five auto-mode levels, 5 of 5 requested levels resolve to themselves.
- **SC-003**: For a requested level `max`, the resolved level is always the model's highest eligible level (before the ceiling). For `low`, it is always the lowest eligible level.
- **SC-004**: 100% of spawns that use `lo`, `med`, or `hi` fail before the subagent starts, with an error that names the valid levels.

## Assumptions

- "Match auto mode" means the same five level names and the same level criteria as the auto thinking classifier. It does not change how auto mode itself clamps its result to a model.
- The "current task role model" is the model that the subagent resolves to at spawn, after model fallback. The mapping uses that model's supported levels.
- No backward compatibility: old `lo`/`med`/`hi` values are not translated.
- The existing setting that enables per-task effort stays, with its current default (off).
- The `solutionSpace` field and the child's auto classifier do not change.
