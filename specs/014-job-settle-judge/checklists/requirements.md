# Specification Quality Checklist: Judge Whether a Turn Needs the User While Background Jobs Run

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-18
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

- Resolved 2026-10-18: speckit-auto reuses the "waits for the user" answer of its existing judge and makes no second call (FR-011a, US3 amends 009 US1-8 and the background-job edge case). The no-input example "Next action: when the first E6 Runs finish …" is in FR-001a, US2 scenario 2, and SC-002. The approval example "reply with approval of the two sha256 values" is in FR-001a, US1 scenario 4, and SC-001.
- FR-009 and FR-010 name the `judge` model role and the `agent_end` event. These are user-visible contracts for configuration and extensions, not internal design.
- Items marked incomplete require spec updates before `/speckit.clarify` or `/speckit.plan`
