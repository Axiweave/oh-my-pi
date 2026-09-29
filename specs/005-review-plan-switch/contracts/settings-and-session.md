# Contract: setting and session state

## Setting

```yaml
reviewUsesPlan: false   # default for new sessions. true: reviews use the active profile's plan model
```

- Registered next to `cyberMode` in `packages/coding-agent/src/config/model-settings.ts`.
- `Settings.setProjectReviewUsesPlan(enabled)` writes the project layer, a
  copy of `setProjectCyberMode`.
- Documented in `docs/settings.md`. The default is appended to
  `~/.omp/agent/config.yml`, per `.omp/AGENTS.md`.

`Settings` has no runtime switch state.

## Session API

| Member | Contract |
|---|---|
| `AgentSession.reviewPlan: boolean` | This session's flag. |
| `AgentSession.reviewPlanActive: boolean` | Flag and a resolvable `plan` role. |
| `AgentSession.setReviewPlan(enabled: boolean): void` | Sets the flag and records it on a `model_change`. Changes no other session. |
| `CreateAgentSessionOptions.reviewPlan?: boolean` | The inherited value for a subagent session. |

## Session record

```ts
interface ModelChangeEntry {
	// …existing fields
	/** Review plan switch state. Undefined: not recorded by this entry. */
	reviewPlan?: boolean;
}
```

- `SessionManager.appendModelChange(model, role?, fallback?, profile?, cyber?, reviewPlan?)`.
- `SessionManager.getLastReviewPlan(): boolean | undefined` returns the last
  defined value on the branch.
- A transcript from before this feature records nothing. Restore uses the
  inherited value, then `cfgReviewUsesPlan`.
