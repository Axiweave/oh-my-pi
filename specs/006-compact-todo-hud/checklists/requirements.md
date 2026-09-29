# Specification Quality Checklist: Compact Todo HUD

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-29
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Iteration 1 claimed all-pass but missed two contradictions:
  - The short-terminal edge case said Compact shows "whatever layout the user selected", which conflicted with FR-010. Fixed: FR-010 and the edge case now define a temporary override that keeps the selected layout and restores it at 18+ rows. Story 1 scenario 6 tests this.
  - SC-005 claimed no change without config, but the short-terminal fallback gets the blocked count, the new shortening order, and the blocked-task fallback (FR-004). Fixed: SC-005 and Assumptions now name these three changes.
- Iteration 2: all items pass. FR-004, FR-009, FR-010, the edge cases, Story 2 scenario 2, and SC-005 agree.
- The spec names `/todo` commands, the status row, and the 18-row threshold. These are user-visible behavior of a terminal tool, not implementation details.
- Default layout (`preview`, opt-in) is an assumption, not a clarification marker. Change FR-008 if the user wants `compact` as the default.
- Planning notes: the HUD state today is a boolean (`todoExpanded`). The plan must replace it with an explicit three-value layout. Both usage tables need `compact`: `modes/controllers/todo-command-controller.ts` and `slash-commands/helpers/todo.ts`.
