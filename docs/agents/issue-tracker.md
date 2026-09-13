# Issue tracker: Spec Kit

Spec Kit is the local source of truth for specifications and implementation tasks.
This convention overrides skill defaults that use `.sdd/` or separate issue files.

## Paths

- Feature directory: `specs/<NNN-feature-name>/`.
- Specification: `spec.md` within the feature directory.
- Implementation plan: `plan.md` within the feature directory.
- Implementation tasks: `tasks.md` within the feature directory.
- Spec Kit configuration, scripts, and templates: `.specify/`.

MUST preserve an explicitly supplied `SPECIFY_FEATURE_DIRECTORY`.
For the current feature, use `.specify/scripts/bash/check-prerequisites.sh --paths-only --json`.
If no feature exists, use `/speckit.specify` to create it.

## Tracker operations

- Publish a specification: create or update the feature's `spec.md`.
- Publish implementation tickets: create or update the feature's `tasks.md`.
- Fetch a ticket: read the referenced feature's `tasks.md` and locate its task ID.
- Plan implementation: use `/speckit.plan`, then `/speckit.tasks`.
- Implement tasks: use `/speckit.implement`.

MUST preserve Spec Kit task IDs, checkboxes, phase structure, and dependency information.
MUST preserve existing task details and completion state when updating tasks.
NEVER create `.sdd/` or a duplicate per-ticket issue directory.

## Triage and discussion

Use `docs/agents/triage-labels.md` for role names.
Record feature triage as `Status: <role>` near the top of `spec.md`.
For task-specific triage, add an indented `Status: <role>` below the task.
Task checkboxes record completion, not triage status.

Append feature discussion under `## Comments` in `spec.md`.
Append task discussion below the corresponding task.

## Wayfinding

When `/wayfinder` needs a map, use `map.md` within the feature directory.
Record child tickets as identified tasks in `tasks.md`, not separate issue files.
Add ticket details below each task:

- `Type:` records research, prototype, grilling, or task.
- `Blocked by:` lists prerequisite task IDs.
- `Claimed by:` identifies the worker before work starts.
- `Answer:` records the result.

An eligible task is unchecked, unclaimed, and has all prerequisites complete.
Select the first eligible task in task-list order.
On resolution, record the answer and mark the task complete.
Append the decision summary and task reference to the map.

## External trackers

GitHub issues and pull requests are external references, not the default tracker.
Publishing locally MUST NOT create GitHub issues, comments, labels, or pull requests.
For requested GitHub operations, follow the approval rules in `AGENTS.md`.
MUST name the repository explicitly: `Axiweave/oh-my-pi` is the fork, while `can1357/oh-my-pi` is upstream.
