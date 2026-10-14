# Contract: Routing Settings and `omp usage` Output

## config.yml

```yaml
auth:
  routing:
    anthropic:
      mode: order        # smart | order | rotate | weight | usage | pace
      stays: turn        # auto | session | turn | off | strict
      sink: false
  accountPolicies:
    - provider: anthropic
      account: { email: first@example.com }
      priority: 100
    - provider: anthropic
      account: { email: second@example.com }
      priority: 50
      capPct: 90
      windowCapPct: { 5h: 50, 7d: 40 }
    - provider: openrouter
      account: { keySuffix: "x9Kq" }
      weight: 3
retry:
  usageReservePct: 10    # global reserve; `order` ignores it
```

Defaults that are appended to `~/.omp/agent/config.yml`:

```yaml
auth:
  routing: {}
```

The agent, subagents, and the SDK apply a change to `auth.routing` or `auth.accountPolicies` on the next selection. `omp auth-gateway serve` reads both at start. Restart the gateway to apply a change (FR-019).

## Errors

Every error names the setting path. When the settings reload live, the previous settings stay active after an error.

| Input | Error text contains |
|---|---|
| `auth.routing.anthropic.mode: fastest` | `auth.routing.anthropic.mode must be one of smart, order, rotate, weight, usage, pace` |
| `auth.routing.anthropic.stays: forever` | `auth.routing.anthropic.stays must be one of auto, session, turn, off, strict` |
| `auth.routing.anthropic.speed: 1` | `auth.routing.anthropic has unknown fields: speed` |
| `weight: 0` | `auth.accountPolicies[i].weight must be an integer between 1 and 1000` |
| `capPct: 0` | `auth.accountPolicies[i].capPct must be a number between 1 and 100` |
| `windowCapPct: { 5h: 120 }` | `auth.accountPolicies[i].windowCapPct.5h must be a number between 1 and 100` |
| `reservePct: 10` | `auth.accountPolicies[i] has unknown fields: reservePct` |
| `account: { keySuffix: "ab" }` | `auth.accountPolicies[i].account.keySuffix must have at least 4 characters` |
| `capPct` on a provider without usage reports | `auth.accountPolicies[i].capPct requires a usage provider for <provider>` |

## `omp usage`

For each provider with 2 or more accounts or keys, one line follows the provider notes:

```
routing: order · stays turn · sink off · next: first@example.com (first in order)
```

For each account, the policy line shows caps instead of the reserve:

```
policy: priority 50 · cap 90% (5h 50%, 7d 40%) · inside cap · 58.0% left
policy: priority 100 · cap none (order) · 12.0% left
policy: priority 0 · cap 90% (global) · 40.0% left
policy: priority 0 · weight 3 · cap none · 70.0% left
```

The weight shows in `weight` mode or when a policy sets one. The policy line no longer prints `eligible`. API-key weights show on one line under the routing line:

```
weights: key …a1b2 3 · key …c3d4 1
```

A provider with one credential shows no routing line.

## Programmatic API (`@oh-my-pi/pi-ai`)

- `AuthStorageOptions.routing?: Readonly<Record<string, ProviderRouting>>`
- `AuthStorage.setAccountPolicies({ accountPolicies, defaultReservePct, routing })`
- `AuthApiKeyOptions.withinTurn?: boolean`
- `ObservedUsageInput.credentialId?: number`
- `AuthStorage.limits.noteRateLimited(provider, credentialId): void`
- `AuthStorage.routing.config(provider)`: the effective `{ mode, stays, sink }` of a provider
- `AuthStorage.routing.preview(provider, reports): RoutingPreview`
- `AuthStorage.routing.strict(provider, sessionId): boolean`
- `AuthStorage.routing.weights(provider)`: the weight of each API key in `weight` mode or when a key policy sets one
- `AuthStorage.sessions.holdGone(provider, sessionId, pin: { hash, lastUsedAt })`: restores a strict hold on resume when the session-file pin names no current account
- `credentialPinHash(provider, identity)`: the session-file pin hash, also used to match a restored hold
- `AgentLoopConfig.getApiKey(model, context?: { withinTurn: boolean })`
- `Agent.startNewTurn()`: the next request gets `withinTurn: false` (`@oh-my-pi/pi-agent`)
- `ModelRegistry.getApiKey(model, sessionId?, { skipMissing })` and `getApiKeyForProvider(provider, sessionId?, { skipMissing })`: return `undefined` instead of throwing `MissingApiKeyError` (`@oh-my-pi/pi-coding-agent`)
- `ScheduledAgentContinueOptions.newTurn?: boolean`: a retry or re-sample continue starts a new turn (`@oh-my-pi/pi-coding-agent`)
