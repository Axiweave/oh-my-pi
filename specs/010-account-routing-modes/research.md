# Research: Account Routing Modes Ported from Magpie

All file references are relative to the repository root. Magpie references are relative to `/Users/fuyu0425/agents/magpie`.

## R1. Where the routing mode plugs in

- **Decision**: Add a per-mode ordering step to `CredentialSelector` (`packages/ai/src/auth/select.ts`). Put the mode comparators in `packages/ai/src/auth/rank.ts`, next to today's comparator. `smart` keeps `compareUsageRankedCandidatePriority` unchanged. Each other mode gets its own pure ordering function over `UsageRankedCandidate[]`. `#rankOAuthSelections` (select.ts:344) and `#rankApiKeySelections` (select.ts:187) call it. `resolveOAuth` (select.ts:519) picks the base order per mode before the rank.
- **Rationale**: One pipeline already fills every metric the modes need: `blocked`, `planPriority`, `inReserve`, `allowanceSpent`, `primaryUsed`, `secondaryUsed`, `secondaryRequiredDrain`, `accountPriority`, and `orderPos` (rank.ts:40-55). Magpie also orders by mode in one switch (`internal/gateway/routing.go:934-1132`). A pure function also gives `omp usage` its "next account" without side effects (R9).
- **Alternatives considered**: A strategy class for each mode was rejected because there is one caller and no state per class. Branches inside the existing comparator were rejected because they would make `smart` harder to keep byte-for-byte equal (SC-005).

## R2. Mode semantics mapped onto OMP metrics

| Mode | Order (after hard checks in every mode: blocked last, then plan gate, then over a cap or allowance spent last) |
|---|---|
| `smart` | Today's comparator. No change. |
| `order` | Over cap or allowance spent last. Then `accountPriority` descending, then sign-in index. There is no hot-window guard, no measured-first rule, no boost, and no drain. |
| `rotate` | Start at `#getNextRoundRobinIndex` (select.ts:110). The session hash does not apply. Unusable accounts are skipped by the existing pass. The index advances only when the selection ranks a new pick. A request that keeps its pin (stays) does not advance it, so `stays: turn` moves once per turn (SC-004). |
| `weight` | Smooth weighted round robin (NGINX). The pick goes first, and the others follow in sign-in order. A pin that stickiness keeps is charged to the pinned account (magpie `weightedKept`, `internal/gateway/weighted.go`). |
| `usage` | Learn-once account first (see below). Then share used ascending (`max(primaryUsed, secondaryUsed)`, the fullest window). Ties go to recent tokens ascending (R5). |
| `pace` | Tiers: below 90% used, 90% to below 98%, and 98% or more. Tier 0 puts a learn-once account first. Then it orders by `secondaryRequiredDrain` descending in 10% bands, then by recent tokens. Tiers 1 and 2 are ordered by share used. |

- **Rationale**: `secondaryRequiredDrain` is "weekly remaining per hour until reset", which is magpie's `Allowance.Pace` (`internal/provider/routing.go:355-430`). The band rule copies magpie `routing.go:1072-1096`, so that the sort stays consistent.
- **Hard checks in every mode** (FR-009, FR-017): the over-cap and allowance-spent checks run before the mode order in `rotate`, `weight`, `usage`, and `pace` too. Only `smart` keeps its own place for them inside today's comparator. Every mode except `smart` ranks whenever the pool has 2 or more accounts or keys, even when the provider has no usage strategy (spec edge case: `rotate` and `weight` work without reports). `selectApiKey` routes key pools through the mode order before its `!strategy` early return. `smart` keeps today's condition for ranking, so it does not change (FR-002).
- **Learn once** (spec clarification, FR-007, FR-008): an account is "unknown" when it has no usage report. It goes first once only when the provider's usage provider has `parseRateLimitHeaders` (today `anthropic` and `openai-codex`, `packages/ai/src/usage/claude.ts:808`, `usage/openai-codex.ts:510`). The selector keeps an in-memory set of tried credential ids per provider, next to the rotate index. It adds the id when the learn rule puts the account first. `resetRoundRobin` clears the set. After the try, an unknown account counts as unused: share used 0, and pace equal to a full week (`100 / 168` percent per hour), as with magpie `FreshPace`. For providers without header parsing, the unknown account counts as unused at once.
- **Alternatives considered for learn once**: Treat unknown as unused from the start. The user rejected this in the clarify session.
- **Note**: OMP `smart` is closer to magpie `pace` than to magpie `smart`, because it already sorts by required drain. The spec keeps today's `smart` (FR-002), so OMP `smart` is not changed to match magpie `smart`.

## R3. `order` mode and the global reserve

- **Decision**: In `order` mode, the reserve fraction for an account comes only from its own caps (R6). `retry.usageReservePct` is not used. The change goes in two places: select.ts:467-468 (`policy?.reservePct ?? args.defaultReservePct`) and select.ts:652 (`policyReserveEnabled ? defaultReservePct : undefined`). The same rule applies in `CredentialHealth.model` (`packages/ai/src/auth/health.ts`, `resolveReserveFraction`).
- **Rationale**: This is the clarification answer (FR-003, FR-017). Health must follow the same rule. If it does not, the usage-aware model fallback (`retry.usageAwareFallback`) can move the session to another model when account 1 is at 95%, and `order` then fails.
- **Alternatives considered**: Keep health on the global reserve. This was rejected because of the fallback problem above.

## R4. Stays modes and the turn boundary

- **Decision**: Add `withinTurn?: boolean` to `AuthApiKeyOptions` (`packages/ai/src/auth/types.ts:478`). `withinTurn` is true when the last message in the request context is a tool result. The caller computes it:
  - In the agent loop: `config.getApiKey(model, { withinTurn })` (`packages/agent/src/agent-loop.ts:2023`, signature in `packages/agent/src/types.ts:259` and `agent.ts:182,517`). `sdk.ts:2236` forwards it to `modelRegistry.resolver(...)`, which forwards it to `keys.getWithCredential`.
  - In the gateway: `auth-gateway/server.ts` derives it from the role of the last message, next to the session id derivation (server.ts:354, 553).

  The pin rule in `resolveOAuth` (select.ts:597-601 and 710-717) becomes:

  | stays | Keep a warm automatic pin first when |
  |---|---|
  | `auto` | Today's rule (warm and not evicted). |
  | `session` | The pin is usable (not blocked, not past a cap, plan eligible). The warm window is not checked. |
  | `turn` | `withinTurn` is true and the pin is usable. |
  | `off` | Never. |
  | `strict` | Always, even when blocked. The selector returns the pin, the request fails, and the error goes to the user. `RateLimits.rotate` (`packages/ai/src/auth/rotation.ts`) returns "no switch" for a strict session. Turn recovery does not wait, retry, or switch the model after a usage-limit refusal (FR-013): in `turn-recovery.ts`, the usage-limit path (2600-2940) closes the retry saga at once, before `#tryRetryModelFallback`, when the provider's stays mode is `strict`. It reads the mode through `AuthStorage.routing.config(provider)`. The usage-aware fallback before the request is not changed. |

- **Rationale**: Magpie uses the same signal ("the agent sending tool results back: mid-turn", `internal/gateway/affinity.go:57`). The spec clarification fixes the rule: only a request whose last message has role `toolResult` is inside the turn. A steering message, a follow-up, an error retry, or a re-sample (agent-loop.ts:1317-1324, 1708-1712) starts a new turn. The last message role needs no new state, and it works the same in the gateway. `agent-session.ts` `#turnIndex` runs only with an extension runner, so it cannot be the signal.
- **Alternatives considered**: A "this run already made a request" flag in the agent loop. It keeps the pin across steering messages, but the gateway cannot see a run, so the two surfaces would differ. The user chose the last-message rule. A turn id in the session file was rejected because it needs persistence and a migration. Separate pin records for each turn were rejected because they duplicate `SessionAffinity`.
- **Explicit user pins**: No change (FR-014). They keep `explicit: true` behavior in every stays mode.
- **API keys**: `selectApiKey` reads no session pin today. It starts from a per-session hash (`#getCredentialOrder`, select.ts:174). cascade.ts records an API-key affinity (cascade.ts:417, 445), but `selectApiKey` does not read it. No pin is added. In `smart` the hash keeps today's behavior. In the other modes the mode order decides each request, so API keys act as `stays: off`. `strict` still blocks key rotation through the `rotate` rule above.

## R5. Recent tokens for `usage` and `pace`

- **Decision**: Add optional `credentialId` to `ObservedUsageInput` (types.ts:717). `UsageService.observe` (`packages/ai/src/auth/usage.ts:457`) adds the request tokens to an in-memory decayed tally, keyed by provider and credential id, with a one-hour half-life. Callers pass `assistantMsg.credentialId`:
  - `packages/coding-agent/src/session/agent-session.ts:4475`
  - `packages/ai/src/auth-gateway/dispatch.ts` `recordGatewayUsage` (callers at `server.ts:407,463,624,676`)

  The selector reads the tally through a new `usage.recentTokens(provider, credentialId)` accessor.
- **Rationale**: `AssistantMessage.credentialId` is already stamped by `stream.ts` `runAttempt` (stream.ts:1310-1343). This needs only one new optional field and one map. Magpie keeps its tally in memory too (`routed.used`, `usageHalfLife = time.Hour`).
- **Alternatives considered**: Persist the tally in the credential store. This was rejected because magpie does not persist it and the spec calls it memory-only.

## R6. Caps and the reserve as one concept

- **Decision**: Replace the per-account `reservePct` with `capPct` (all windows) and `windowCapPct` (map from usage window id to percent), with no alias. The selector converts a cap to the reserve fraction `1 − cap/100`, so the existing reserve code applies. An account is "in reserve" when any reserve-scoped window `w` has `used_w ≥ cap_w`. `cap_w` is the first defined value of `windowCapPct[w]`, `capPct`, and `100 − retry.usageReservePct` (the last one is skipped in `order`). This needs a new per-window check in `packages/ai/src/auth/usage-report.ts`, next to `remainingUsageFraction`.
- **Rationale**: FR-017 requires one concept. AGENTS.md allows breaking config changes without compatibility. Users think in caps ("use at most 40% of the week"), as in magpie (`AccountCaps`, `AccountWindowCaps`). `retry.usageReservePct` remains the global value because the usage-aware fallback also reads it.
- **Window ids**: Use the `UsageWindow.id` that each usage provider reports. Claude reports `5h` and `7d` (limits `anthropic:5h`, `anthropic:7d`, `packages/ai/src/usage/claude.ts`). Codex reports labels from `buildWindowLabel` (`packages/ai/src/usage/openai-codex.ts:293`). `omp usage` prints the window ids, so users can copy them.
- **Validation**: `capPct` and each `windowCapPct` value must be 1–100. `validateUsageCapability` (`policy.ts:101`) extends to caps: setting a cap for a provider without usage reports is an error.
- **Alternatives considered**: Keep `reservePct` and add `windowReservePct`. This was rejected because the spec and magpie use caps, and two names for one limit break FR-017.

## R7. Weight and caps for API keys

- **Decision**: Add `keySuffix` to the account selector (`AuthAccountSelector`, types.ts). It matches an API-key credential whose key ends with this suffix (minimum 4 characters). `AccountPolicies.forCredential` (`policy.ts:168`) returns policies for API keys through this match. Ambiguous matches are an error, as with OAuth (`validateFor`, `policy.ts:113`).
- **Rationale**: `ApiKeyCredential` has only `key` and `source` (types.ts:28-32), so it has no identity. A suffix lets the user name a key without putting the secret in the config. Magpie keys use a fingerprint (`KeyID`).
- **Alternatives considered**: The stored row id was rejected because users cannot see it and it changes on re-login. The array index was rejected because it breaks when keys are reordered.

## R8. Sink

- **Decision**: Keep a per-provider in-memory sink list in `CredentialSelector`, next to `#providerRoundRobinIndex` (select.ts:89). `resetRoundRobin` clears it. An account goes on the list when it gets a rate-limit refusal while it has quota:
  1. `RateLimits.markReached` (`rotation.ts:232-310`) finds that the usage report is not exhausted (the branch at rotation.ts:271-272).
  2. The turn-recovery retry for a 429 that is not a usage limit (`packages/coding-agent/src/session/turn-recovery.ts`, the `calculateRateLimitBackoffMs` path) calls a new `limits.noteRateLimited(provider, credentialId)` with `message.credentialId`.

  The ordering step moves listed accounts behind all unlisted ones, in list order. When every usable account is listed, the list is cleared. Sink has no effect in `rotate` and `weight` (magpie `sinks()`, `internal/gateway/sink.go:59`).
- **Rationale**: Today a 429 that is not a usage limit never reaches AuthStorage (see `isRetryableUpstreamError`, stream.ts:1139-1164). The turn-recovery path is the one place that sees it together with `credentialId`.
- **Alternatives considered**: A persisted sink was rejected because the spec says it clears on restart.

## R9. `omp usage` output

- **Decision**: Add `AuthStorage.routing.preview(provider)`. It calls the R1 pure ordering function with the usage reports that the CLI already fetched and with the rotate and weight state read-only. It returns `{ mode, stays, sink, next: { label, reason } }`. `formatUsageBreakdown` (`packages/coding-agent/src/cli/usage-cli.ts:~808`) prints one routing line after the provider notes when the provider has 2 or more accounts or keys. `formatPolicyLine` (usage-cli.ts:666-695) prints `cap X%` (with per-window caps) instead of `reserve X%`.
- **Rationale**: `CredentialHealth.model` does not advance state, but it needs a model id and returns no next account. A preview over the same pure function cannot drift from the real selection.

## R10. Settings and live reload

- **Decision**: Add one record setting, `auth.routing`, keyed by provider, with the value `{ mode?, stays?, sink? }` (defaults `smart`, `auto`, `false`). Register it in `packages/coding-agent/src/config/model-settings.ts` next to `cfgAuthAccountPolicies`, with `validate` and `normalize` in the style of `providers.maxInFlightRequests` (`session/settings.ts:148-163`). Parse it in pi-ai `parseAuthRouting` (`packages/ai/src/auth-broker/discover.ts`, next to `parseAuthAccountPolicies` at 112-182). Thread it through:
  - `ConfigSnapshot` and `readConfigYaml` (discover.ts:84-88 and 197-227)
  - `AuthAccountPolicyConfig` and `loadAuthAccountPolicyConfig` (discover.ts:230-256)
  - `AuthStorageOptions` (types.ts:331-345)
  - `AccountPolicies` (holds the table and swaps it atomically in `replace`)
  - `loadEffectiveAuthAccountPolicyConfig` and `cfgAuthStorageSettings` with its change diff (`session/auth-broker-config.ts:79-87, 128-133, 195-197`)
  - The construction sites: `sdk.ts:1030-1045`, `discover.ts:471-489`, and `auth-gateway-cli.ts:276-292, 743-755`

  The per-account keys `weight`, `capPct`, `windowCapPct`, and `account.keySuffix` go into the `parseAuthAccountPolicies` allow-list (discover.ts:124) and into `#validateAccountPolicyConfiguration` (`policy.ts:61-99`).
- **Rationale**: Records merge per key across settings layers (`settings.ts` `#deepMerge`), so a project can override one provider. `createAuthStorageSettingsSync` already gives an atomic live apply that keeps the old settings when the new ones fail (FR-019, FR-020).
- **Gateway**: The gateway reads the settings once at start, as it does today for `auth.accountPolicies`. FR-019 states this exception (spec clarification). FR-021 (same selection rules) holds.
- **In-memory state** (rotate index, weight round, sink list, recent tokens) lives in `CredentialSelector` and `UsageService`, not in `AccountPolicies`. A settings swap does not reset it. A credential-set change resets it through `pool.reset` → `resetRoundRobin` (`auth-storage.ts:186-189`).

## R11. Tests

- **Decision**: Add `packages/ai/test/auth-storage-routing-modes.test.ts`, in the same pattern as `auth-storage-codex-selection.test.ts`: in-memory SQLite store, `createCredential`, `createCodexUsageReport`, and `keys.get` with a distinct session id for each sample.
- **Properties under test** (with fixed seeds and generated usage vectors):
  - `order` always returns the highest-priority usable account, and it is never one that is blocked or over its cap.
  - `rotate` gives each of N accounts exactly one selection in each block of N.
  - `weight` gives exact ratios in each block of `sum(weights)`, and no account exceeds its share by more than 1 at any prefix.
  - `usage` and `pace` agree with a slow reference sort written from the spec text.
  - `smart` (SC-005): the existing selection test files (`auth-storage-codex-selection.test.ts` and the other `auth-storage-*` selection tests) pass with no edits. A new test that calls the dispatcher and `orderUsageRankedCandidates` and compares them only proves forwarding, so it is not written (AGENTS.md test rule).
  - Learn once: an unknown account on a header-reporting provider is first exactly once. After that, it sorts as an account at 0% used.
  - The stays truth table from R4, including: a steering message after a tool batch selects again under `turn`.
  - `strict`: a usage-limit refusal ends the turn with the error and no retry wait (`packages/coding-agent/test` turn-recovery test, same pattern as the existing usage-limit retry tests).
  - SC-003 with `stays: turn` uses one request per turn. FR-006 counts requests, not turns, so a turn with more tool calls weighs more. The per-turn split in SC-003 holds only when turns have equal request counts.
- Config errors go in `packages/ai/test/auth-broker-config-discovery.test.ts`, live apply in `packages/coding-agent/test/auth-broker-live-settings.test.ts`, and the routing line in `packages/coding-agent/test/usage-cli.test.ts`.
