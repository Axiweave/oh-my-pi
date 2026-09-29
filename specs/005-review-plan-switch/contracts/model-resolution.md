# Contract: reviewer model resolution

## Helpers (`packages/coding-agent/src/config/model-resolver.ts`)

```ts
export function reviewPlanRole(role: string, active: boolean): string;
export function reviewPlanLookup(settings: ModelRoleLookup, active: boolean): ModelRoleLookup;
```

- `reviewPlanRole("reviewer", true) === "plan"`. Every other input returns `role`.
- `reviewPlanLookup(s, true).getModelRole("reviewer")` equals `s.getModelRole("plan")`.
- `reviewPlanLookup(s, false)` behaves the same as `s`.

## Agent model selection (`resolveAgentModelSelection`)

New optional inputs: `agentName?: string` and `reviewPlanActive?: boolean`.

Precedence, highest first:

1. `requestModel`, a model given on one request.
2. **New:** if `reviewPlanActive` is true and the agent is a review agent, then `@reviewer`.
3. `settingsOverride` (`task.agentModelOverrides[agentName]`).
4. `agentModel` (frontmatter).
5. The active or default model.

While `reviewPlanActive` is true:
- Expansion uses `reviewPlanLookup(settings, true)`.
- The returned `role` is `reviewPlanRole(role, true)`. A `@reviewer` source
  therefore returns `role: "plan"`, and the subagent uses the `plan` retry
  chain (`task/executor.ts:267`).

A review agent is one of these:
- `agentName` ∈ {`reviewer`, `plan-reviewer`, `impl-reviewer`}.
- `settingsOverride` or `agentModel` names the reviewer role.

Callers MUST pass both inputs from the spawning session:
- `packages/coding-agent/src/task/structured-subagent.ts`
- `packages/coding-agent/src/vibe/runtime.ts`

## Session retry contexts

- `session/turn-recovery.ts` `#retryFallbackContext`: `getModelRole` uses
  `reviewPlanRole(role, host.reviewPlanActive())`.
- `eval/completion-bridge.ts`: `getModelRole` uses
  `reviewPlanRole(role, session.reviewPlanActive)`.

`Settings` and the merged settings view do not change.
