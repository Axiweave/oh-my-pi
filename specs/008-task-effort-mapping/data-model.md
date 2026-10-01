# Data Model: Task Effort Matches Auto Mode Levels

## TaskEffort (requested effort)

- **Values**: `low`, `medium`, `high`, `xhigh`, `max`. These are the `Effort` enum values in this order (`TASK_EFFORTS`).
- **Position**: i/5, where i is the 1-based index in `TASK_EFFORTS`.
- **Validation**: The wire schema accepts only these five strings. `validateEffort` rejects any other value that reaches the executor through an internal or stale call. The error lists the five values.

## Supported levels

- **Source**: `getSupportedEfforts(model)`, or `THINKING_EFFORTS` (`minimal..max`) when no model resolves.
- **Order**: canonical `THINKING_EFFORTS` order, ascending.
- **Size**: 0 to 6. Size 0 means no controllable effort. The mapping then returns `undefined`.

## Eligible levels

- **Rule**: supported levels at or above `low`. If none qualifies, all supported levels.
- **Size**: 1 to 5 when supported is non-empty.
- **Position**: k/n for the k-th (1-based) of n eligible levels.
- **Shared with**: `clampAutoThinkingEffort`, through one helper.

## Mapped level

- **Rule**: the first eligible level with `k * 5 >= i * n`.
- **Then**: the `task.maxEffort` ceiling applies over the supported levels (no change). If no supported level is at or below the ceiling, the spawn fails with `RangeError`.

## Level criteria

- **Shape**: `Record<"low" | "medium" | "high" | "xhigh", string>` plus the `max` criterion.
- **Consumers**: the auto classifier questions and the task tool description.
- **Location**: `packages/coding-agent/src/auto-thinking/criteria.ts`.
