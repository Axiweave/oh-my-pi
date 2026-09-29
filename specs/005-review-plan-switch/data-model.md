# Data Model: Review Plan-Model Switch

## Entities

### Review plan switch (per session)

| Field | Type | Owner | Notes |
|---|---|---|---|
| `reviewPlan` | boolean | `ModelControls.#reviewPlan` | This session's flag. Other sessions on the same `Settings` do not see it. |
| `reviewPlanActive` | boolean (derived) | `AgentSession` | `reviewPlan && settings.getModelRole("plan") !== undefined`. Role resolution and the indicator read this value. |

### Saved preference

| Key | Type | Default | Layers |
|---|---|---|---|
| `reviewUsesPlan` | boolean | `false` | global `~/.omp/agent/config.yml`, project `.omp/config.yml` |

### Session record

`ModelChangeEntry.reviewPlan?: boolean`. `undefined` means the entry does not
record it. `SessionManager.getLastReviewPlan()` returns the last defined value
on the current branch.

### Session role lookup (derived, never stored)

While `reviewPlanActive` is true, the session resolves roles through
`reviewPlanLookup`:

| Input role | Lookup result | Role identity for retry chains |
|---|---|---|
| `reviewer` | `settings.getModelRole("plan")` | `plan` |
| any other role | unchanged | unchanged |

## Validation rules

- `reviewUsesPlan` must be a boolean. The schema handles bad values.
- When `reviewPlan` is true and no plan resolves, `reviewPlanActive` is false.
  Reviews keep the configured reviewer (FR-011).

## State transitions

Restore order: `recorded ?? inherited ?? cfgReviewUsesPlan`.

| Event | New `reviewPlan` value | Recorded? |
|---|---|---|
| Top-level session start | restore order (no inherited value) | Yes, on the SDK initial `model_change` |
| Subagent session start | restore order (inherited = parent's value) | Yes, on the SDK initial `model_change` |
| `/review-plan on\|off` | the argument | Yes |
| `/review-plan on\|off global\|project` | the argument, also saved to that layer | Yes |
| `/new`, `/delete` | unchanged | Yes, on the carry-over `model_change` |
| `/clear` | unchanged | No |
| Resume, session switch | restore order | No |
| `/fork`, branch selection, tree navigation | restore order | No |
| Profile switch | unchanged. `reviewPlanActive` is derived again. | No |
| Another session on the same `Settings` toggles | unchanged | No |

A review that is already running keeps its model. Each spawn resolves its
model once (FR-007).
