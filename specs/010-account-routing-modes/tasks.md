---

description: "Task list for Account Routing Modes Ported from Magpie"
---

# Tasks: Account Routing Modes Ported from Magpie

**Input**: Design documents from `specs/010-account-routing-modes/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/routing-config.md, quickstart.md

**Tests**: Included. The plan (R11) and the quickstart name the test files. Tests check properties (block ratios, invariants, agreement with a slow reference sort) on generated inputs with a fixed, printed seed. They must not copy the implementation, and they must not only check that one function forwards to another.

**Organization**: Tasks are grouped by user story. Line numbers come from research.md. Read the code again before you edit, because the line numbers can move.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: The user story of the task (US1–US6)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Shared test fixtures for all routing tests

- [X] T001 Create `packages/ai/test/helpers/routing-fixtures.ts`. Move `createCredential`, `createCodexUsageReport`, and `countApiKeySelections` there from `packages/ai/test/auth-storage-codex-selection.test.ts`, without changing them. Add `createRoutingStorage({ credentials, usageByAccount, accountPolicies, routing, defaultReservePct })`, which builds an in-memory `SqliteAuthCredentialStore` + `AuthStorage` the same way as that test file. Then import the helpers in `auth-storage-codex-selection.test.ts`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Types, config, validation, live apply, and the cut from `reservePct` to `capPct`. Every story needs these.

**⚠️ CRITICAL**: No user story work can start until this phase is complete.

- [X] T002 In `packages/ai/src/auth/types.ts`:
  - Add `RoutingMode` (`"smart" | "order" | "rotate" | "weight" | "usage" | "pace"`), `StaysMode` (`"auto" | "session" | "turn" | "off" | "strict"`), and `ProviderRouting { mode?; stays?; sink? }`.
  - Add `keySuffix?` to `AuthAccountSelector`.
  - In `AuthAccountPolicy`, remove `reservePct` and add `weight?`, `capPct?`, and `windowCapPct?: Readonly<Record<string, number>>`.
  - Add `routing?: Readonly<Record<string, ProviderRouting>>` to `AuthStorageOptions`.
  - Add `withinTurn?: boolean` to `AuthApiKeyOptions`.
  - Add `credentialId?: number` to `ObservedUsageInput`.
  - Add `RoutingApi { config(provider): Required<ProviderRouting> }`. US6 adds `preview` to it.
- [X] T003 In `packages/ai/src/auth/policy.ts`:
  - Store the routing table in `AccountPolicies`. Add `routingFor(provider): Required<ProviderRouting>`, which fills the defaults `smart`, `auto`, `false`.
  - Extend `replace(...)` to take `routing` and swap it atomically together with the policies.
  - In `#validateAccountPolicyConfiguration`, validate:
    - `weight`: integer 1–1000
    - `capPct` and each `windowCapPct` value: 1–100
    - `keySuffix`: at least 4 characters, and not mixed with the OAuth identity fields
    - routing values: from the enums above
    Use the exact error texts in `contracts/routing-config.md`.
  - Make `forCredential` match `api_key` credentials by `keySuffix`.
  - Make `validateFor` reject a `keySuffix` that is ambiguous, or that two policies claim.
  - Extend `validateUsageCapability` to cover `capPct` and `windowCapPct`.
- [X] T004 [P] In `packages/ai/src/auth-broker/discover.ts`:
  - Add `parseAuthRouting(value)`. It is strict, rejects unknown fields, and its error paths start with `auth.routing.<provider>`.
  - Change the `parseAuthAccountPolicies` allow-list (top level `provider|account|priority|weight|capPct|windowCapPct`, account level plus `keySuffix`) and the object that it returns.
  - Add `routing` to `ConfigSnapshot`, `readConfigYaml`, `LoadAuthAccountPolicyConfigOptions`, the `needsMainConfigFallback` condition, `AuthAccountPolicyConfig`, and `loadAuthAccountPolicyConfig`.
  - Pass `routing` through `discoverAuthStorage` into `new AuthStorage`.
- [X] T005 In `packages/ai/src/auth-storage.ts`:
  - Pass `options.routing` into `new AccountPolicies(...)`.
  - Widen `setAccountPolicies(config)` to `{ accountPolicies, defaultReservePct, routing }` and forward it to `replace`.
  - Expose `routing: RoutingApi` with `config(provider)` delegating to `AccountPolicies.routingFor`.
- [X] T006 In `packages/ai/src/auth/select.ts` (around 467-468 and 652) and `packages/ai/src/auth/health.ts` (`resolveReserveFraction`), replace `policy?.reservePct ?? default` with one shared helper, `capReserveFraction(policy, mode, defaultReservePct)`, in `packages/ai/src/auth/policy.ts`:
  - It returns `1 − capPct/100` when the policy sets `capPct`.
  - Otherwise it returns the global reserve, but not when `mode === "order"`.
  - Otherwise it returns `undefined`.
  Keep the condition at select.ts:652 (the global reserve applies only when the provider has a policy). `smart` results must stay the same as today.
- [X] T007 [P] In `packages/coding-agent/src/config/model-settings.ts`, register `cfgAuthRouting` (`id: "auth.routing"`, `type: "record"`, default empty) next to `cfgAuthAccountPolicies`. Give it `validate` and `normalize` in the style of `providers.maxInFlightRequests` (`packages/coding-agent/src/session/settings.ts:148-163`), with the same error texts as `parseAuthRouting`.
- [X] T008 In `packages/coding-agent/src/session/auth-broker-config.ts`:
  - Add `routing: cfgAuthRouting.get(settings)` to `loadEffectiveAuthAccountPolicyConfig`.
  - Add `routing` to `cfgAuthStorageSettings` (`combine`).
  - Add `!Bun.deepEquals(next.routing, previous.routing)` to the `policiesChanged` diff in `createAuthStorageSettingsSync`. Make sure that this branch calls `setAccountPolicies` only and does not resolve the broker again.
- [X] T009 Pass `routing` from `loadEffectiveAuthAccountPolicyConfig` (T008) into the `AuthStorage` options in these places:
  - `packages/coding-agent/src/sdk.ts` (around 1030-1045). The explicit option wins. Also update the doc comment near line 1023.
  - Both `new AuthStorage` sites in `packages/coding-agent/src/cli/auth-gateway-cli.ts` (around 276-292 and 743-755). The gateway reads it once at start (FR-019). Do not add a live sync there.
- [X] T010 [P] In `packages/coding-agent/src/cli/usage-cli.ts` `formatPolicyLine` (around 666-695), change the reserve label to a cap label:
  - `cap X% (override)` for an account `capPct`
  - `cap X% (global)` for 100 − the global reserve
  - `cap none (order)` in `order` mode
  - `inside cap` instead of `inside reserve`
  Read the mode through `authStorage.routing.config(provider)`.
- [X] T011 Rename `reservePct` to `capPct` (value `100 − old`) in the existing tests: `packages/ai/test/auth-storage-codex-selection.test.ts`, `packages/ai/test/auth-broker-config-discovery.test.ts`, `packages/coding-agent/test/usage-cli.test.ts`, `packages/coding-agent/test/auth-gateway-account-pool.test.ts`, and any other file that `grep reservePct packages/*/test` finds. Two old values have no `capPct` equivalent. For `reservePct: 0`, remove the policy field, because no cap means no own reserve. For `reservePct: 100`, remove that account from the test pool. Change only the expected strings that come from T010.
- [X] T012 After T011, in `packages/ai/test/auth-broker-config-discovery.test.ts`, add one case for each row of the error table in `contracts/routing-config.md`. Write each row to `config.yml` in a temp agent directory, then assert the error substring.
- [X] T013 After T008, in `packages/coding-agent/test/auth-broker-live-settings.test.ts`:
  - Add a case where `auth.routing` changes, and assert that the next selection uses the new mode after `sync.settled()`.
  - Add a case where `mode: fastest` is set, and assert that the previous routing stays active (FR-019, FR-020).

**Checkpoint**: The config loads and validates. `smart` + `auto` select exactly as before. All existing tests pass.

---

## Phase 3: User Story 1 - Use accounts in a fixed order (Priority: P1) 🎯 MVP

**Goal**: `mode: order` uses account 1 until it is blocked, refused, at 100% of a window, or past its own cap. Then it uses account 2. New sessions go back to account 1 when it recovers.

**Independent Test**: Two accounts with `order`. Account 1 at 95% weekly and 90% 5-hour use is still selected. When account 1 is blocked, account 2 is selected. When account 1 is unblocked, a new session selects account 1.

- [X] T014 [US1] Create `packages/ai/src/auth/routing.ts` with the dispatcher `orderRankedCandidates(mode, candidates, ctx)`. For `smart`, it calls the existing `orderUsageRankedCandidates` (`packages/ai/src/auth/rank.ts`). Add the pure `order` comparator:
  1. blocked last (earliest `blockedUntil` first)
  2. plan gate
  3. `inReserve` (here only an own cap) or `allowanceSpent` last
  4. `accountPriority` descending
  5. `orderPos` ascending
  There is no hot guard, no measured-first rule, no boost, and no drain.
- [X] T015 [US1] In `packages/ai/src/auth/select.ts` `resolveOAuth`:
  - In `order` mode only, make the base order priority-descending, then sign-in index, for every session. Do not use the session hash or the round-robin.
  - In every mode except `smart`, rank whenever the pool has 2 or more accounts, even when the provider has no usage strategy (for example `openrouter`). Unknown usage counts as not capped. `smart` keeps today's condition (`strategy || policyReserveEnabled`), so it does not change.
  - Call `orderRankedCandidates` in `#rankOAuthSelections` and in `#rankApiKeySelections`.
  - In `selectApiKey`, route key pools of 2 or more through the mode order before today's `!strategy` early return, for every mode except `smart`. In `order`, keys go by policy priority through `keySuffix`, then index.
- [X] T016 [US1] In `packages/ai/test/auth-storage-routing-modes.test.ts`, add `order` property tests. Use generated usage vectors (fixed seed, 200 cases, seed printed on failure).
  - The selected account is always the highest-priority account that is not blocked, not past its own cap, and below 100%.
  - The global reserve never changes the result.
  - SC-001: a 50-request run stays on account 1 until it is blocked.
  - SC-002: a new session after unblock selects account 1.

**Checkpoint**: US1 works for new sessions. Running sessions follow `stays: auto` until US2 is done.

---

## Phase 4: User Story 2 - Control how long a conversation stays on one account (Priority: P1)

**Goal**: The `stays` modes `auto`, `session`, `turn`, `off`, and `strict`. `withinTurn` is true only when the last message is a tool result. `strict` shows a usage-limit error at once.

**Independent Test**: `order` + `stays: off`, and a session that failed over to account 2. When account 1 is unblocked, the next request selects account 1. With `turn`, tool-result requests keep the account of the turn, and a steering message selects again.

- [X] T017 [US2] In `packages/agent/src/types.ts` (259), `packages/agent/src/agent.ts` (182, 517), and `packages/agent/src/agent-loop.ts` (2023):
  - Change the `getApiKey` signature to `(model, context?: { withinTurn: boolean })`.
  - In the agent loop, set `withinTurn` to `context.messages.at(-1)?.role === "toolResult"` (the role in `packages/ai/src/types.ts:1334`). A user message, a steering or follow-up message (agent-loop.ts:1317-1324), an error retry, and a re-sample (1708-1712) all give `false` (FR-012).
- [X] T018 [US2] Forward `withinTurn` through these files:
  - `packages/coding-agent/src/sdk.ts` (2236: `effectiveGetApiKey`)
  - `packages/coding-agent/src/config/model-registry.ts` (`resolver(...)` options, and `getApiKeyWithCredentialForProvider` around 3323-3343)
  - `packages/coding-agent/src/config/api-key-resolver.ts` (resolve options around 62-70)
  - `packages/ai/src/auth/cascade.ts` (`#resolve`, into `resolveOAuth` and `selectApiKey`)
- [X] T019 [US2] In `packages/ai/src/auth/select.ts` `resolveOAuth` (pin logic around 597-601 and 689-717), apply the stays table from `data-model.md`:
  - `auto`: today's rule.
  - `session`: keep the pin while it is usable, and ignore warmth.
  - `turn`: keep the pin only when `withinTurn` is true and the pin is usable.
  - `off`: never promote the pin.
  - `strict`: always return the pin, even when it is blocked.
  Explicit user pins keep today's behavior. Do not add a pin to `selectApiKey`. API keys keep today's session-hash start in `smart` and follow the mode order in the other modes (research R4, "API keys").
- [X] T020 [US2] For `strict` account rotation:
  - In `packages/ai/src/auth/rotation.ts` `rotate`, return a result with no switch for a provider whose stays is `strict`. Still record the block.
  - In `packages/coding-agent/src/config/api-key-resolver.ts`, skip step (c) (rotate, around 75-95) for `strict`, so that the error reaches the user.
- [X] T021 [US2] In `packages/coding-agent/src/session/turn-recovery.ts`, in the usage-limit retry path (around 2600-2940), close the retry saga at once with the error when `authStorage.routing.config(provider).stays === "strict"` and the error is a usage limit. Run this check before the retry model fallback (`#tryRetryModelFallback`, around 2837). Do not wait for the reset, even when `retry.waitForUsageReset` is set. Do not try a sibling account, and do not switch the model (FR-013).
- [X] T022 [P] [US2] In the auth gateway, edit `packages/ai/src/auth-gateway/server.ts` and `packages/ai/src/auth-gateway/dispatch.ts`:
  - Add an exported pure function `isWithinTurn(messages)` in server.ts. It is true when the last item is an OpenAI Chat `role: "tool"` message, an OpenAI Responses `function_call_output` item, or an Anthropic `user` message whose content has only `tool_result` blocks. Call it next to the session id derivation (around 354 and 553), and pass the result to `resolveGatewayApiKey` (dispatch.ts:92).
  - Add a `credentialId` parameter to `recordGatewayUsage` and pass it to `usage.observe`. Pass `message.credentialId` at the call sites in server.ts (407, 463, 624, 676). US3 uses it for recent tokens.
  - In a new file `packages/ai/test/auth-gateway-within-turn.test.ts`, add a table test for `isWithinTurn`: Anthropic `tool_result`, Anthropic `tool_result` plus text (false, because the user added a message), OpenAI Chat `tool`, Responses `function_call_output`, a user text message, an assistant message, and an empty list (FR-012).
- [X] T023 [US2] In `packages/ai/test/auth-storage-routing-modes.test.ts`, add a stays truth-table test. For each stays mode × (warm/cold pin) × (`withinTurn` true/false) × (pin usable/blocked), assert whether the pinned account is selected. Also assert:
  - An explicit pin behaves the same in all modes (FR-014).
  - `strict` + blocked returns the pin.
  - With `order` + `turn`, a session on account 2, and account 1 usable again, a request with `withinTurn: false` (a steering message after a tool batch) selects account 1.
- [X] T024 [US2] In `packages/coding-agent/test/agent-session-retry-cap.test.ts`, add one case in the pattern of "waits past retry.maxDelayMs for a usage-limit reset when retry.waitForUsageReset is set" (line 199): with `auth.routing.<provider>.stays: strict`, `retry.waitForUsageReset: true`, and `retry.modelFallback: true`, a usage-limit error ends the turn at once. Assert no wait, no second request, and no model switch.

**Checkpoint**: US1 + US2 give the requested "drain account 1, then account 2, then back to account 1" with `stays: turn` or `off`. This is the MVP.

---

## Phase 5: User Story 3 - Spread requests by turn, weight, least use, or pace (Priority: P2)

**Goal**: The `rotate`, `weight`, `usage`, and `pace` modes, with the recent-token tally and the learn-once rule.

**Independent Test**: For each mode, three accounts or keys with known usage and `stays: off`. The sequence of selections matches the rule of the mode.

- [X] T025 [US3] In `packages/ai/src/auth/usage.ts` `UsageService`:
  - In `observe`, when `credentialId` is set, add `input + output` tokens to a decayed in-memory tally keyed by provider and credential id: `tokens × 0.5^(Δt / 1h)`.
  - Add `recentTokens(provider, credentialId, nowMs)`.
  - Add `canLearnFromHeaders(provider)`, true when the provider's usage provider has `parseRateLimitHeaders`.
  - Add a clear method for each provider. Call it from the pool `onReset` in `packages/ai/src/auth-storage.ts` (186-189).
- [X] T026 [P] [US3] In `packages/coding-agent/src/session/agent-session.ts` (around 4475), pass `credentialId: assistantMsg.credentialId` to `authStorage.usage.observe`.
- [X] T027 [US3] In `packages/ai/src/auth/routing.ts`, add pure ordering for `rotate`, `weight`, `usage`, and `pace`. In all four modes, put these last, in this order: blocked, plan-ineligible, then `inReserve` or `allowanceSpent` (FR-009, FR-017).
  - `rotate`: rotate the list to start at the given index.
  - `weight`: smooth weighted round robin over a `WeightRound` state object passed in, and a `chargeKept(round, credentialId)` function for a kept pin.
  - `usage`: a learn-once candidate first (see below). Then order by `max(primaryUsed, secondaryUsed)` ascending, then recent tokens ascending. Unknown usage counts as 0.
  - `pace`: tiers 0 (below 0.90), 1 (0.90 to below 0.98), and 2 (0.98 or more). Tier 0 puts a learn-once candidate first. Then it orders by `secondaryRequiredDrain` descending in 10% bands (as in research R2), then by recent tokens. Unknown usage counts as 0% used with a pace of `100 / 168` per hour. Tiers 1 and 2 are ordered by share used.
  - Learn once: `ctx.learnable` is a set of credential ids that have no usage report, are not yet tried, and are on a provider where `canLearnFromHeaders` is true. The first usable learnable candidate goes first.
- [X] T028 [US3] In `packages/ai/src/auth/select.ts`:
  - Add the per-provider weight-round map and the per-provider learn-once tried set next to `#providerRoundRobinIndex`. Clear both in `resetRoundRobin`.
  - In `rotate`, take the start index from `#getNextRoundRobinIndex` (ignore the session hash). Advance the index only when the selection ranks a new pick. A request that keeps its pin does not advance it (SC-004).
  - In `weight`, call `chargeKept` when the pin rule keeps a pin.
  - In `usage` and `pace`, build `ctx.learnable` from the tried set and `canLearnFromHeaders`. When the picked candidate is learnable, add its id to the tried set.
  - Give the selector a `recentTokens` dependency (from `UsageService`) and pass it to the orderings.
  - Use the account policy weight, matched by `forCredential` (OAuth or `keySuffix`), with a default of 1.
- [X] T029 [US3] In `packages/ai/test/auth-storage-routing-modes.test.ts`, add property tests with a fixed seed:
  - `rotate` with `stays: off`: each of N accounts serves exactly one selection in each block of N. With `stays: turn` and one request per turn, the same holds per turn (SC-004).
  - `weight` with `stays: off`: for random weights 1–10, each block of `sum(weights)` has exact counts, and no account exceeds its share by more than 1 at any prefix. With `stays: turn`, use one request per turn, because FR-006 counts requests, not turns (SC-003).
  - `usage` and `pace`: the result equals a slow reference sort written from spec FR-007 and FR-008, over generated usage vectors that include unknown usage.
  - In every mode, no account over a cap or with spent allowance is selected while a usable account exists.
  - Learn once: on `openai-codex`, an account with no usage report is first exactly once, and after that it sorts as an account at 0% used. On a provider without header parsing, it is never put first by the learn rule.

**Checkpoint**: All six modes select correctly. `smart` is covered by the existing selection tests, which stay unchanged (SC-005, T046).

---

## Phase 6: User Story 4 - Cap each account and each usage window (Priority: P2)

**Goal**: `windowCapPct` caps each window apart. The selection, the health check, and `omp usage` all follow it.

**Independent Test**: `windowCapPct: { 7d: 40 }` on account 1 at 41% weekly use. A new session selects account 2, and `omp usage` shows account 1 as `inside cap`.

- [X] T030 [US4] In `packages/ai/src/auth/usage-report.ts`, add `isOverCaps(limits, capFor: (windowId) => number | undefined)`. It returns true when any reserve-scoped limit has used fraction ≥ cap/100. Extend `capReserveFraction` in `packages/ai/src/auth/policy.ts` to `capFor(policy, mode, defaultReservePct)`, which applies `windowCapPct[w] ?? capPct ?? global (not in order)`. Use it for `inReserve` and `reserveMeasured` in `packages/ai/src/auth/select.ts` `#rankOAuthSelections` and in `packages/ai/src/auth/health.ts`.
- [X] T031 [US4] In `packages/coding-agent/src/cli/usage-cli.ts` `formatPolicyLine`, list the window caps (`cap 90% (5h 50%, 7d 40%)`) and use `isOverCaps` for `inside cap`. Print the window id of each usage row in `formatUsageBreakdown`, so that users can copy it into `windowCapPct`.
- [X] T032 [US4] Add tests:
  - In `packages/ai/test/auth-storage-routing-modes.test.ts`: a generated cap/usage matrix where the selection never returns an account over a window cap while an account under its caps exists. A window cap overrides `capPct`. Every account over its cap behaves the same as "every account in reserve" today.
  - In `packages/coding-agent/test/usage-cli.test.ts`: the cap label lines from the contract.

**Checkpoint**: Caps work for each window in selection, fallback health, and output.

---

## Phase 7: User Story 5 - Move rate-limited accounts to the back ("sink") (Priority: P3)

**Goal**: With `sink: true`, an account that is rate limited while it has quota goes behind all accounts that have not been rate limited since.

**Independent Test**: `order` + `sink: true`. Account 1 gets one 429 with quota left. After its backoff, account 2 is still selected first.

- [X] T033 [US5] In `packages/ai/src/auth/routing.ts`, add the pure function `applySink(ordered, sinkList)`. It moves listed credentials behind the others in list order. It is a no-op for `rotate` and `weight`.
- [X] T034 [US5] In `packages/ai/src/auth/select.ts`:
  - Keep a per-provider sink list (credential ids in refusal order) and clear it in `resetRoundRobin`.
  - Add `noteRateLimited(provider, credentialId)`, which appends the id (moving it to the end if it is already on the list). It does nothing when sink is off.
  - Call `applySink` after the mode ordering.
  - Clear the list when every usable credential is on it.
- [X] T035 [US5] Expose `noteRateLimited` on `LimitsApi` in `packages/ai/src/auth/types.ts`, and implement it in `packages/ai/src/auth/rotation.ts` by delegating to the selector. In `markReached`, call it when the usage report shows that quota is left (around 271-272).
- [X] T036 [US5] In `packages/coding-agent/src/session/turn-recovery.ts`, for a 429 that is not a usage limit (the `calculateRateLimitBackoffMs` retry path), call `authStorage.limits.noteRateLimited(provider, message.credentialId)` when `credentialId` is set.
- [X] T037 [US5] In `packages/ai/test/auth-storage-routing-modes.test.ts`, add sink tests:
  - After `noteRateLimited` and the end of the backoff, the order puts the account last.
  - `rotate` and `weight` ignore sink.
  - When all credentials are sunk, the list clears.
  - `resetRoundRobin` (a credential change) clears it.

**Checkpoint**: Sink works and resets correctly.

---

## Phase 8: User Story 6 - See the routing in effect (Priority: P3)

**Goal**: `omp usage` prints `routing: <mode> · stays <stays> · sink <on|off> · next: <label> (<reason>)` for each provider with 2 or more credentials.

**Independent Test**: `mode: usage` with two accounts. `omp usage` names the least-used account as next.

- [X] T038 [US6] In `packages/ai/src/auth/select.ts`, add `preview(provider, reports)`. It builds the ranked candidates from the given reports without network calls. It uses `orderRankedCandidates` and `applySink` with the rotate, weight, and learn-once state read-only (copy it, do not advance it). It returns `RoutingPreview` (`data-model.md`) with the reasons listed there. Add `preview` to `RoutingApi` in `packages/ai/src/auth/types.ts` and to `AuthStorage.routing` in `packages/ai/src/auth-storage.ts`.
- [X] T039 [US6] In `packages/coding-agent/src/cli/usage-cli.ts`:
  - Add `getRoutingPreview?: (provider, reports) => RoutingPreview | undefined` to `UsagePolicyDiagnosticsOptions` (86-91), and connect it near 1586-1589 to `authStorage.routing.preview` with the reports already fetched (1591-1594).
  - In `formatUsageBreakdown` (around 808), print the routing line after the provider notes when the account count is 2 or more.
- [X] T040 [US6] In `packages/coding-agent/test/usage-cli.test.ts`, add tests:
  - The routing line for `order` and `usage` pools, with the expected `next` and reason.
  - No line for a single-account provider.
  - Calling preview twice does not change the next real selection (no state advance).

**Checkpoint**: Users can see and check the routing in effect.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T041 [P] In `docs/settings.md`:
  - Add rows for `auth.routing.<provider>.mode`, `.stays`, and `.sink`, and for the `auth.accountPolicies` fields `weight`, `capPct`, `windowCapPct`, and `account.keySuffix`.
  - Change the `retry.usageReservePct` row (around 610) to say that it is the global cap fallback and that `order` ignores it.
  - Add `auth.routing` to the live-apply sentence (around 110), and say that the auth gateway reads it only at start.
  - Say that `stays: strict` ignores `retry.waitForUsageReset`.
- [X] T042 [P] In `docs/auth-broker-gateway.md`:
  - Update the config keys table (305-306) for the new fields and `auth.routing`.
  - Rewrite "How sessions choose and keep an account" (310-320) to describe the six modes, the five stays modes (with the tool-result turn rule), learn once, sink, caps, and that `order` skips the global reserve and the 85% guard.
  - Say that API keys have no pin and act as `stays: off` outside `smart`.
  - Say that the gateway reads `auth.routing` at start, and that a restart applies a change.
- [X] T043 [P] In `packages/ai/CHANGELOG.md` `[Unreleased]`:
  - Under `### Breaking Changes`: `reservePct` is replaced by `capPct`/`windowCapPct`.
  - Under `### Added`: routing modes, stays modes, learn once, sink, weight, keySuffix, `withinTurn`, `credentialId` on observed usage, and `routing.config`/`routing.preview`.
- [X] T044 [P] In `packages/coding-agent/CHANGELOG.md` `[Unreleased]`:
  - Under `### Breaking Changes`: the cap rename.
  - Under `### Added`: the `auth.routing` setting, `strict` ending a usage-limit turn at once, and the `omp usage` routing line.
- [X] T045 [P] Append `auth.routing: {}` (under the existing `auth:` key if one exists) to `~/.omp/agent/config.yml`. Do not change other keys.
- [X] T046 Run `PATH="$HOME/.cargo/bin:$PATH" bun check` and the test commands in `specs/010-account-routing-modes/quickstart.md` sections 1–3. The existing selection tests must pass with no edits other than the T011 rename (SC-005). Fix failures.
- [X] T047 Run the live smoke steps in `specs/010-account-routing-modes/quickstart.md` sections 4–5 with a scratch config directory, and report the observed output.

---

## Dependencies & Execution Order

### Phase Dependencies

```mermaid
flowchart LR
    S[Phase 1 Setup] --> F[Phase 2 Foundational]
    F --> US1[US1 order]
    US1 --> US2[US2 stays]
    F --> US3[US3 other modes]
    US1 -. routing.ts dispatcher .-> US3
    F --> US4[US4 window caps]
    US1 -. routing.ts .-> US5[US5 sink]
    US3 --> US6[US6 omp usage]
    US5 --> US6
    US2 --> P[Polish]
    US4 --> P
    US6 --> P
```

- **Foundational**: T002 → T003 → T005 → T006 run in order. T008 → T009 and T008 → T013 are true dependencies. T011 → T012 edit the same file.
- **US1** needs the foundational phase. It creates `routing.ts`.
- **US2** needs US1, because its independent test uses `order`. Its plumbing tasks (T017, T018, T022) can start right after the foundational phase. T021 needs `routing.config` from T005.
- **US3** needs the `routing.ts` dispatcher from T014. T026 needs only T002.
- **US4** needs only the foundational phase.
- **US5** needs the `routing.ts` dispatcher from T014.
- **US6** needs US3 and US5, because the preview shows every mode, learn once, and the sink.

### Within Each Story

The pure ordering in `routing.ts` comes before the `select.ts` wiring, and the wiring comes before the tests. Tasks that edit `select.ts` (T006, T015, T019, T028, T030, T034, T038) run one at a time, in task order. Tasks that edit `turn-recovery.ts` (T021, T036) also run in order.

### Parallel Opportunities

- Foundational: T004, T007, and T010 edit different files. They can run in parallel after T002, T003, and T005.
- US2: T017, T018, and T022 (agent, coding-agent, and gateway plumbing) can run in parallel with US1 T014 and T015.
- US3: T025, T026, and T027 can run in parallel.
- US4 (T030–T032) can run in parallel with US3, but T030 and T028 both edit `select.ts`, so merge them in order.
- Polish: T041–T045 can run in parallel.

## Parallel Example: User Story 3

```text
Task: "T025 recent-token tally and canLearnFromHeaders in packages/ai/src/auth/usage.ts"
Task: "T026 pass credentialId in packages/coding-agent/src/session/agent-session.ts"
Task: "T027 rotate/weight/usage/pace ordering in packages/ai/src/auth/routing.ts"
Then: "T028 wire into packages/ai/src/auth/select.ts" → "T029 property tests"
```

## Implementation Strategy

### MVP (US1 + US2)

1. Do Phase 1 and Phase 2. Make sure `smart` is unchanged (existing tests pass).
2. Do US1. Then `order` works for new sessions.
3. Do US2. Then `order` + `stays: turn` or `off` gives the requested "drain account 1, then account 2, then back".
4. Stop and run quickstart section 4.

### Incremental Delivery

After the MVP, add US3, then US4, then US5, then US6. Run the story's tests and `bun check` after each story. Do the polish phase last, but write the CHANGELOG entries in the same commit as their story.

---

## Phase 10: Convergence

- [X] T048 Make the rotate advance and the weight pick/kept-pin charge happen synchronously with the ordering in `packages/ai/src/auth/select.ts` (no `await` between reading `rotateStart`/`round.last` and advancing them), so concurrent selections from the gateway or parallel subagents each see advanced state per FR-005, FR-006, SC-003, SC-004 (partial)
- [X] T049 Make the auth gateway honor `stays: strict` in `packages/ai/src/auth-gateway/dispatch.ts` (auth-error and usage-limit retry return no other account for a strict non-explicit session) and skip `affinity.clear` for strict sessions in `packages/ai/src/auth/rotation.ts` `invalidateMatching` per FR-013, FR-021 (contradicts)
- [X] T050 Skip the strict early exits in `packages/coding-agent/src/config/api-key-resolver.ts` (step c) and `packages/coding-agent/src/session/turn-recovery.ts` (usage-limit saga close) when the session pin is explicit, exposing the explicit-pin state from `AuthStorage`, per FR-014 (contradicts)
- [X] T051 Show the routing line in `omp usage` for every provider with 2 or more credentials, including providers without a usage provider (for example an `openrouter` key pool), by not dropping them in `packages/coding-agent/src/cli/usage-cli.ts` / `packages/coding-agent/src/slash-commands/helpers/usage-accounts.ts` per FR-022, US6 (partial)
- [X] T052 Mark an account as tried for learn once only after the selection resolves to it (after the stays pin decision and `tryOAuth`) in `packages/ai/src/auth/select.ts` per FR-007, FR-008 (partial)
- [X] T053 Restrict the learn-once set to OAuth credentials in `packages/ai/src/auth/select.ts`, so API keys go straight to recent-token ordering per spec Assumptions (API keys) (contradicts)
- [X] T054 Return the strict pin's refresh or preflight error instead of falling through to other candidates in `packages/ai/src/auth/select.ts` `resolveOAuth` per FR-013 (contradicts)
- [X] T055 Call `validateUsageCapability` for API-key pools in `packages/ai/src/auth/select.ts` `selectApiKey` (or at policy load) so `capPct`/`windowCapPct` on a usage-less provider raises the contract error per FR-016, FR-020, contracts/routing-config.md (missing)
- [X] T056 Call `limits.noteRateLimited(provider, credentialId)` on a non-usage 429 refusal in `packages/ai/src/auth-gateway/dispatch.ts` so sink works in the gateway per FR-018, FR-021 (missing)
- [X] T057 Add property tests to `packages/ai/test/auth-storage-routing-modes.test.ts`: `weight` with one account blocked or over cap leaves the round and the others keep their ratio, a mixed OAuth + API-key pool keeps OAuth-first precedence in every mode, an all-blocked pool picks the earliest unblock in every mode, and `rotate`/`order` on an API-key pool without a usage strategy, per FR-006, FR-009, spec Edge Cases (missing)
- [X] T058 Review the forced `withinTurn: true` on auth retries in `packages/coding-agent/src/config/api-key-resolver.ts` (steps b, c) and `packages/ai/src/auth-gateway/dispatch.ts` `modelKeyOptions`: keep it and add a one-line reason comment at each site, or remove it, per FR-012 (unrequested)
- [X] T059 Add an `[Unreleased]` entry for the `getApiKey(model, { withinTurn })` context to `packages/agent/CHANGELOG.md`, add the gateway turn rule, `limits.noteRateLimited`, and strict turn recovery to `packages/ai/CHANGELOG.md`, and note the removed `eligible` word on the `omp usage` policy line in `packages/coding-agent/CHANGELOG.md` per plan: changelog gate (missing)

---

## Phase 11: Convergence

- [X] T060 Make the strict short-circuit in `packages/ai/src/auth/cascade.ts` not depend on reading `affinity` after `resolveOAuth` (decide it before the call, or have `resolveOAuth` report that a strict pin was tried), so a strict pin disabled during this request (dead grant removed by `disableDefinitiveFailure`) returns the error instead of falling back to login, env, or stored API keys per FR-013, T054 (contradicts)
- [X] T061 Fix weight/rotate state edge cases in `packages/ai/src/auth/select.ts` and `packages/ai/src/auth/routing.ts`: reset `round.last` at the start of each ordering so `chargeKept` never moves a stale charge, charge a kept pin that is outside the leading hard group, and keep rotate/weight state consistent when preflight restores a pin, per FR-005, FR-006, SC-003 (partial)
- [X] T062 Make the `packages/ai/CHANGELOG.md` gateway sink text match the gate in `packages/ai/src/auth-gateway/dispatch.ts` `recordGatewayMessage` (only `CONCURRENT_LIMIT` / `RATE_LIMIT_EXCEEDED` rate-limit refusals feed `sink`, not every non-usage 429) per FR-018, T059 (contradicts)
- [X] T063 Add the strict exception to the stale comments in `packages/ai/src/auth/types.ts` (~1382-1383), `packages/ai/src/auth/rotation.ts` (~405-406), and `packages/ai/src/auth-gateway/dispatch.ts` (~133-134): under `stays: strict` a hard 401 keeps the session pin and the row is not replaced by a sibling, per FR-013 (partial)
- [X] T064 Update the `strict` text in `docs/settings.md` (~1054) and `docs/auth-broker-gateway.md` (~359): no sibling, env-key, or API-key fallback; a failed pin refresh is the request's error; an explicit pin keeps the earlier behavior; in the gateway an auth or usage-limit error returns the upstream error without switching accounts, per FR-013, FR-014, FR-021 (partial)
- [X] T065 Show the routing line for usage-less pools in `packages/coding-agent/src/cli/usage-cli.ts` without adding their credentials to `omp usage --json` `accountsWithoutUsage` or to "no usage data" rows (or document that change in `packages/coding-agent/CHANGELOG.md`), and fix the stale `selectReportableAccounts` comment in `packages/coding-agent/src/slash-commands/helpers/usage-accounts.ts` (~48-58), per FR-022 (unrequested)
- [X] T066 Replace the single-fixture T051 test in `packages/coding-agent/test/usage-cli.test.ts` with a seeded property test over pool sizes 0, 1, 2, and many, with and without a usage provider, asserting the routing line appears if and only if the provider has 2 or more credentials, per FR-022, SC-006, AGENTS.md test rules (partial)
- [X] T067 Gate the usage-aware preflight pin release in `packages/coding-agent/src/session/turn-recovery.ts` (`#maybeApplyUsageAwareFallback`, ~1956-1958 and ~2021-2024 `sessions.release`) on `routing.strict(provider, sessionId)`, so a strict session never moves accounts before a request (model fallback may still apply), and add a test, per FR-013, US2/AC4, spec Edge Case strict + usage-aware fallback (contradicts, HIGH)
- [X] T068 Make a turn-recovery retry after an error count as a new turn: the retry strips the failed assistant message (`turn-recovery.ts` ~3085), so a request after tool results has a toolResult tail and `withinTurn` stays true; make the retry request select again under `stays: turn` (auth-retry steps that force `withinTurn: true` stay as they are), and add a test, per FR-012, spec Clarifications (retry selects again) (contradicts)
- [X] T069 Reject `capPct`/`windowCapPct` on a provider without usage reports when the policy is loaded or applied live (keep the previous policies), instead of committing it and throwing on every selection, without breaking a usage provider that registers later (`packages/ai/src/auth/policy.ts` `validateUsageCapability`, `AccountPolicies.replace`, `packages/coding-agent/src/session/auth-broker-config.ts`), per FR-020, SC-007, contracts/routing-config.md row 9 (partial)
- [X] T070 Apply `sink` in `smart` mode on providers without a usage strategy (the `selectApiKey` smart early return in `packages/ai/src/auth/select.ts` ~325-334 and the OAuth `shouldRank=false` path ~785 skip `#orderRanked`), and add a test with an API-key pool, per FR-018, US5/AC1 (partial)
- [X] T071 State in `docs/settings.md` (stays row) and `docs/auth-broker-gateway.md` (`strict` bullet) that a dead sign-in removes the account, so that request fails and the next request selects again, per FR-013 (partial)
- [X] T072 Show each account's or key's `weight` in the `omp usage` policy line when the provider has a weight policy or uses `weight` mode (`packages/coding-agent/src/cli/usage-cli.ts` `formatPolicyLine`), per SC-006 (partial)
- [X] T073 Add a test that a bad live `auth.accountPolicies` value (for example `weight: 0`) keeps the previous policies and reports an error that names the setting (`packages/coding-agent/src/session/auth-broker-config.ts` ~168-171), per FR-020, SC-007 (missing)
- [X] T074 Add the missing tests: agent turn recovery feeds `sink` on `CONCURRENT_LIMIT`/`RATE_LIMIT_EXCEEDED` (`turn-recovery.ts` ~2628), a 5-hour cap stops applying after the window resets (US4/AC2, fake time), and the agent loop sets `withinTurn` only when the last message is a tool result (`packages/agent/src/agent-loop.ts` ~2023), per FR-018, US4/AC2, FR-012 (missing)
- [X] T075 Advance `rotate`/`weight` routing state only for a selection that sends a request (`keys.getWithCredential`), not for key checks through `keys.get` (for example the prompt-time key check at `agent-session.ts` ~8313, memory startup at `memories/index.ts` ~391, and the judge key at `judgment/index.ts` ~349). Live smoke showed 2 checks before each first request, so `rotate` and `weight` skip turns in a real session. Add a test that `get` calls between requests do not change the request sequence, per FR-005, FR-006, SC-003, SC-004 (contradicts)

## Phase 12: Convergence

- [X] T076 Keep a strict session on its account after a definitive sign-in failure (`invalid_grant`): the account's later requests fail with the sign-in error and no request selects a sibling, env key, or API key (`packages/ai/src/auth/cascade.ts` ~387-427, `select.ts` strict pin). Correct `docs/settings.md:1054`, `docs/auth-broker-gateway.md:359` and T071's text in the CHANGELOG to match. Test two requests in a row after the failure: both fail and neither returns another credential, per FR-013, US2/AC4 (contradicts)
- [X] T077 Stop key checks (`advance=false` through `keys.get`/`getApiKey`) from recording the session pin, so the first real request of a session under `stays: auto`/`session`/`strict` still moves `rotate` and charges `weight` (`select.ts` ~992-994 keep-pin path, `affinity.record` via `tryOAuth` ~1449). Extend the T075 property test to `stays: auto` and `session` with a `keys.get` before each session's first request, per FR-005, FR-006, SC-003, SC-004 (partial)
- [X] T078 Make availability checks through `getApiKeyForProvider` read-only for routing state (`model-registry.ts` ~2149 and ~2272 discovery, `selector-controller.ts` ~331 and ~2351, `model-controls.ts` ~891, `mnemopi/backend.ts` ~527), and send the Perplexity API-key search request through the request path (`web/search/providers/perplexity-auth.ts` ~51), per T075, FR-005 (partial)
- [X] T079 Call `Agent.startNewTurn()` before every retry that drops a failed assistant message in `packages/coding-agent/src/session/session-maintenance.ts` (context rollover ~1887, context promotion ~2981, ~3117, ~3168, incomplete retry ~3238, compaction retry ~5535, shake retry ~5677), so a retry after an error selects again under `stays: turn`, per FR-012, Clarifications (turn) (partial)
- [X] T080 Show a bad live `auth.accountPolicies` value as a configuration error that names the setting, the same way a bad `auth.routing` value shows (settings-level validate in `packages/coding-agent/src/config/model-settings.ts` ~72-78), and keep the previous policies. Keep the usage-capability check in `AccountPolicies.replace` and send its error through the same path, per FR-020, SC-007, Edge Cases (partial)
- [X] T081 Count every stored credential of a provider (OAuth accounts and API keys) when `omp usage` decides to show the routing line, also when the provider has usage reports (`packages/coding-agent/src/cli/usage-cli.ts` ~842-852). Add a case with an OAuth report plus API keys to the T066 property test, per FR-022, T051 (partial)
- [X] T082 Show `weight N` for every account of a provider in `weight` mode in `omp usage`, also for an account without a policy (`usage-cli.ts` `formatPolicyLine`), per T072, SC-006 (partial)
- [X] T083 State in `docs/settings.md` (~110) and the coding-agent CHANGELOG routing line that a hand-edited `config.yml` applies live only with `config.hotReload: true` or after `/reload-config`. Add "requires a provider with usage reports" to the `capPct` row (`docs/settings.md` ~1059), per FR-019, FR-023 (partial)
- [X] T084 Replace the single fixture in the T061(c) test (`packages/ai/test/auth-storage-routing-modes.test.ts` ~507) with a seeded `forAll` case over sibling count (0, 1, 2+), which account fails preflight, and whether the pin is cold. Keep the current fixture as one explicit case, per T061, plan: test strategy (partial)
- [X] T085 Convert the single-scenario tests to seeded properties that print the seed, with empty, single, boundary, and over-limit inputs (pattern: `packages/agent/test/agent.test.ts` ~1806): `agent-session-retry-cap.test.ts` ~511 (sink) and ~555 (retry selects again), `auth-broker-live-settings.test.ts` ~205 (bad live policy), `agent.test.ts` ~1839 (`startNewTurn`), per AGENTS.md test rules, T073, T074 (partial)

## Phase 13: Convergence

- [X] T086 Restore the session-pin write, `forget`, and the last-used refresh on key checks (`keys.get`, `ModelRegistry.getApiKey`) in every mode, as before this feature (`packages/ai/src/auth/select.ts` ~1489, `cascade.ts` ~432/446/461). Keep T077's result another way: on the request path, a pin that no request has served yet counts as a new selection, so `rotate` moves and `weight` charges it. Keep the T075/T077 property test green for every stays mode. Fix the stale comments and docs (`model-registry.ts` `getApiKey` doc, `title-generator.ts` ~327, `speech-enhancer.ts` ~99, `judgment/index.ts` ~357, `auto-repair.ts` ~354, `session-advisors.ts` ~2556) and the ai CHANGELOG key-check line, per FR-002, SC-005, FR-005, FR-006 (contradicts)
- [X] T087 Keep a strict session failing on every removal path of its account, not only `invalid_grant` in `rotate`: `rotation.ts` `invalidateMatching` (~337-383) and the generic-401 `markCredentialSuspect` path, and `affinity.ts` `#lookup` (~218-226), which now drops a pin whose row is gone so a sibling can be pinned. Add these sources to the T076 property test, per FR-013, US2/AC4 (partial)
- [X] T088 Store only the account key, credential id, and label in the strict signed-out marker (`select.ts` `#signedOut` ~141), never the OAuth tokens. Bound it like the affinity map, and clear it when the account signs in again or the provider's credential set changes, also when `oauthAccountKey` is undefined. Gate the re-login pin write (~758) like other pin writes, per FR-013, T076 (partial)
- [X] T089 Remove the account email and session id from the signed-out error that the auth gateway returns to clients (`dispatch.ts` ~107-112, `select.ts` `signedOutError` ~86-93). Keep the account name in the agent's own error, per FR-013, plan: gateway (partial)
- [X] T090 Keep a refused live policy change in `authSettingsApplied` until a later apply succeeds, so a second `/reload-config` of the same bad file reports the error again (`packages/coding-agent/src/session/auth-broker-config.ts` ~227-228). Update `auth-broker-live-settings.test.ts` ~299-300 to expect the same rejection on the second wait, per FR-020, SC-007 (partial)
- [X] T091 Send requests that take their key from a key check API through the request path: `ModelRegistry.getApiKeyAndHeaders` (~3281) and its scoped copy in `account-pools.ts` ~141, and `stencil/credential.ts` ~21. Keep the Codex prewarm (`sdk.ts` ~5226), the blob-broker credential (`sdk.ts` ~4234), and `omp token` as checks, per FR-005, FR-006, T075 (partial)
- [X] T092 Set `newTurn` on the TTSR interrupt re-sample that discards the reply (`ttsr-coordinator.ts` ~722). Extend the T079 seeded test to all retry and re-sample sources, including manual retry and the 6 untested maintenance sources, per FR-012, Clarifications (turn), T085 (partial)
- [X] T093 Make the `omp usage` routing preview match the real pick for `smart` on a pool without usage reports (session hash or round robin), or show no `next` there (`select.ts` `preview` ~588-690), per FR-022, US6/AC1 (partial)
- [X] T094 Fix the existing tests that build a sticky pin with `keys.get`, so they test what they claim after T086: `auth-storage-email-dedupe.test.ts` ~904-948 and `auth-storage-force-refresh-rotate.test.ts` ~517-577, per T077 (partial)

## Phase 14: Convergence

- [X] T095 Keep key checks safe for a strict session whose account is gone: callers that read `undefined` as "skip" must not crash on the `MissingApiKeyError` from `keys.get` (`turn-recovery.ts` ~2313/2426/2498, `session-maintenance.ts` ~3438/3529/5108, `model-controls.ts` ~891/957, `session-handoff.ts` ~123, `agent-session.ts` ~12972). The prompt-time check must still show the error that names the account. Add a test for the prompt error and one skip caller, per FR-013 (partial)
- [X] T096 Make a subagent of a strict session follow the strict rule when the parent's account is gone: copy the strict hold with the pin in `sessions.inherit`, or fail the child the same way, so the child never selects a sibling (`select.ts` strict hold, `affinity.ts` `inherit`, `sdk.ts` ~1903). Add a subagent test, per FR-013, Edge Cases (subagents) (partial)
- [X] T097 Pass `served = advance` in the re-pin in `#backToStrictAccount` (`select.ts` ~228), so a key check does not mark a never-served pin as served. Add tests for the strict-hold LRU bound and an account with no `oauthAccountKey`, per T086, T088 (partial)
- [X] T098 Drop a session's strict hold when the provider's stays mode is no longer `strict` (`select.ts` `#backToStrictAccount` ~217), so a later switch back to `strict` does not throw for an old account. Add a strict → auto → strict test with the account removed in between, per FR-010, FR-013 (partial)
- [X] T099 Stop the advisor from retrying a strict session after `markReached` (`session-advisors.ts` ~2168-2182): check `routing.strict(provider, providerSessionId)` like turn recovery does, per FR-013 (partial)
- [X] T100 Keep an account with unknown plan eligibility at its place in `order` mode when a plan gate is active (`rank.ts` ~76-79, `routing.ts` `compareHard`), so `order` moves on only after a failed plan check, per FR-003 (partial)
- [X] T101 Add the missing seeded cases: an unserved pin (made by `keys.get`) that fails preflight and is put back (`auth-storage-routing-modes.test.ts` ~581), a pin that stays unserved while other sessions send requests (~736), and an explicit pin under `strict` through `rotate`, `invalidateMatching`, `api-key-resolver`, and the gateway, per T086, FR-014 (partial)
- [X] T102 Align the text with the code: add `routing.strict`, `routing.weights`, `Agent.startNewTurn`, and `newTurn` to `contracts/routing-config.md`. Add the `only account` preview case to `data-model.md`, and say there that the usage-aware health check always applies `retry.usageReservePct` (also in `docs/auth-broker-gateway.md` ~307/349). Add the `markReached` quota-left feeder to the ai CHANGELOG sink line. Say "OAuth accounts" for learn-once (ai CHANGELOG, `auth-broker-gateway.md` ~347). Replace "/settings" in the coding-agent routing line with `config.yml` or `omp config set`. Add the `config.hotReload` or `/reload-config` condition at `docs/settings.md` ~110 and `auth-broker-gateway.md` ~309, per FR-017, FR-019, FR-022, SC-006 (partial)
- [X] T103 Keep the strict signed-out state across a restart: store it with the persisted session pin (no tokens), so a restored strict session whose account is gone keeps failing instead of selecting again. Its lifetime equals the session pin's lifetime (the same per-provider cap). Add a restart test, and update the "a restart forgets" text in `docs/auth-broker-gateway.md` ~359 and the ai CHANGELOG, per FR-013 (partial)

## Phase 15: Convergence

- [X] T104 Restore the HEAD contract of `ModelRegistry.getApiKey` and `getApiKeyForProvider`: they throw `MissingApiKeyError` by default, as before T095. Only the callers that read `undefined` as "skip" opt in to `undefined` (`turn-recovery.ts` ~2313/2426/2498, `session-maintenance.ts` ~3438/3529/5108, `model-controls.ts` ~891, and the other true skip sites). Then the throw sites (`agent-session.ts` ~12972, `turn-recovery.ts` ~2150, `session-handoff.ts` ~123, `model-controls.ts` ~957, `completion-bridge.ts` ~371, `skill-descriptions.ts` ~58, `judgment/index.ts` ~349, `image-gen.ts` ~279/297, `selector-controller.ts` ~2351) and the auth fallback (`sdk.ts` ~3111, `model-resolver.ts` ~1923) keep the error that names the account or the restricted pool. Update the coding-agent CHANGELOG line, per FR-013 (contradicts)
- [X] T105 Keep the strict signed-out state across a restart in broker mode: `RemoteAuthCredentialStore` keeps cache rows in memory only, so carry the hold in the session-file pin record that a resumed session restores (`credential-pin.ts`), or scope the "survives a restart" text in `docs/auth-broker-gateway.md` ~359 and the ai CHANGELOG to the local store. Add a resume test, per FR-013, T103 (partial)
- [X] T106 Drop strict holds for every configured provider whose stays is not `strict`, also when the provider has no accounts left (`auth-storage.ts` ~166-188 uses `pool.providers()`, which omits it) and at construction. Add a seeded test: remove the account, switch stays, send no request, switch back, per T098 (partial)
- [X] T107 Give the strict hold the same expiry as its pin: `holdStrict` and the `goneFrom` writes use the pin's `expiresAtSec`, and `record` updates a hold that is not in the in-memory cache (`affinity.ts` ~183/260/272, `select.ts` ~224-237/1559). Add a seeded test with an old `restoredAtMs` and a fake clock, per T103 (partial)
- [X] T108 Do not fail a restricted subagent for a strict hold on an account outside its pool: drop the hold in `#backToStrictAccount` (or in `restrict()`) when the held account is not allowed (`sdk.ts` ~1904-1917 restricts after `inherit`). Add a seeded test that inherits first and restricts after, per FR-013, T096 (partial)
- [X] T109 Use one `order` plan-gate helper in `resolveOAuth`, the `tryOAuth` fallback (`select.ts` ~1451, used by an explicit `oauth.access`), and `preview` (~721), so an account with an unknown plan is served the same way on every path. Add a seeded check that other modes still put unknown plans last, per FR-003, T100 (partial)
- [X] T110 Make the text match the decided behavior: in `spec.md`, name the usage-aware health check as the exception in FR-017 (it always applies `retry.usageReservePct`, as before this feature), and add "except under `stays: strict`" to the removed-account edge case (~157), per FR-017, FR-013 (contradicts)
- [X] T111 Turn the fixed-example tests into seeded properties: the strict-hold memory bound over 1, 255, 256, 257 and 300 sessions (`auth-storage-routing-modes.test.ts` ~628), the gateway explicit-pin case over mode and failure kind (`auth-gateway-account-routing.test.ts` ~71-110), and the advisor strict case with a real strict pin and no mocks of `routing.strict` or `markReached` (`advisor-toggle.test.ts` ~1113), per T085, T099, T101 (partial)

## Phase 16: Convergence

- [X] T112 Keep the strict signed-out state across a restart in broker mode too: when `seedCredentialPins` (`credential-pin.ts` ~86) finds that the session-file pin hash matches no current account (or the provider has no accounts left) and the provider's stays is `strict`, install a strict hold with no account identity (no raw email or id, only the current credential ids as `goneFrom` and a generic label), unless the store already holds one for the session. It ends, as the local hold does, when the provider's set of accounts changes or the stays mode is no longer `strict`. Add a seeded resume test over a remote-like store (cache in memory, new `AuthStorage` per run), and restore the unscoped restart text in `docs/auth-broker-gateway.md` ~359 and the ai CHANGELOG, per FR-013, T105 (partial)

## Phase 17: Convergence

- [X] T113 Align the design text with the persisted strict hold: `data-model.md` (~44, ~62) and `plan.md` (~25, ~51) still say all new state is in memory. State that the strict hold is an in-memory cache in front of persisted `session:strict:` rows, that it lives as long as its session pin, and that a broker client restores it from the session-file pin hash (`sessions.holdGone`), per FR-013, plan: storage decision (contradicts)
- [X] T114 Skip `holdGone` when the store hides accounts from this client (a broker `accountPool`, `remote-store.ts` ~359/1001), because the pin hash cannot tell a hidden account from a gone one. Treat it like a session pool (T108), and add a seeded `credential-pin.test.ts` case with an account pool, per FR-013, T108, T112 (partial)
- [X] T115 Drop persisted strict holds of a provider that is no longer strict also when its `auth.routing` entry was deleted before a restart (`auth-storage.ts` ~103 passes only `routedProviders()`). Add a seeded case: strict, remove the routing entry, restart, remove the account, set strict again, and the idle session selects without an error, per T098, T106 (partial)
- [X] T116 Complete `contracts/routing-config.md`: add `AuthStorage.routing.config(provider)`, `AuthStorage.sessions.holdGone(provider, sessionId, lastUsedAtMs)`, and the `{ skipMissing }` option of `ModelRegistry.getApiKey`/`getApiKeyForProvider` to the API list, and add a `weight N` policy sample, a `weights:` line, and the removed `eligible` word to the `omp usage` section, per FR-022, SC-006 (partial)
- [X] T117 Add a Breaking line to the ai CHANGELOG: custom `SessionsApi` implementations must implement `holdGone(provider, sessionId, lastUsedAtMs)` (`types.ts` ~1215), as the 18.9.0 entry did for `permits`, per T112 (partial)
- [X] T118 Let a broker-restored strict hold go back to the same account: store the session-file pin hash on the `holdGone` hold (`pinHash`, already persisted, no raw identity), move `credentialPinHash` from `credential-pin.ts` ~44 into `packages/ai`, and match `again` in `#backToStrictAccount` (`select.ts` ~219-223) on it too. Extend the seeded resume test to assert which account serves after the account signs in again, per FR-013, T112 (partial)
- [X] T119 Give FR-013 (`spec.md` ~181) the same exception that the removed-account edge case (~157) states, so the two texts agree: after its account is removed, a strict session fails until that account signs in again (it goes back to it) or the provider's set of accounts changes (it selects again), per FR-013, T110 (contradicts)

## Phase 18: Convergence

- [X] T120 Stop the startup sweep from deleting strict holds when the caller gave no routing settings: `AuthStorage`'s constructor (`auth-storage.ts` ~103-106) runs `dropStrictExcept` with an empty keep-list when `options.routing` is undefined, so `omp` login (`auth-broker-cli.ts` ~226), `images-cli.ts` ~238, and other no-routing constructions on the agent DB erase every `session:strict:` row. Run the sweep only when the caller passes `routing` (the settings-backed paths), check that those paths always pass it, and add a seeded test: a no-routing construction over a saved strict hold leaves it intact, per FR-013, T103, T115 (contradicts)
- [X] T121 Fail closed for a broker client with an account pool: remove the `hidesOAuthAccounts` skip in `holdGone` (`affinity.ts` ~255), and remove the then unused `hidesOAuthAccounts` from `CredentialRowStore` (`store.ts` ~38) and `remote-store.ts` ~346. A client cannot tell a hidden account from a removed one, and FR-013 has no pool exit. Keep the `isRestricted` skip. Change the `account-pool` case in `credential-pin.test.ts` to expect `held`, and remove the "does not restore" sentences from the ai CHANGELOG and `docs/auth-broker-gateway.md` ~359, per FR-013 (contradicts)

## Phase 19: Convergence

- [X] T122 Make the strict-hold text match the code: (a) the ai CHANGELOG strict line says a restricted subagent keeps the hold unless its pool lacks the account, but `restrict()` (`affinity.ts` ~107-110) drops every restored broker hold, because it has no `identityKey`; say so there and in `docs/auth-broker-gateway.md` ~359. (b) Add to `docs/auth-broker-gateway.md` ~359 that a broker client with an account pool cannot tell a hidden account from a removed one, so its strict session fails until the pool shows the account again or the provider's accounts change. (c) List `identityKey` and `pinHash` among the hold fields in `data-model.md` ~44, and say that a restored hold goes back to its account by the pin hash, per FR-013, T113, T118, T121 (partial)

## Phase 20: Convergence

- [X] T123 Add the seeded case `pool-without-it-then-removed` to the resume test in `packages/coding-agent/test/credential-pin.test.ts`: the session resumes while the pinned account is gone, that account signs in again under a new row, `restrict` sets a pool without it, the new row is removed with no request in between, and the request must match the restricted control (picks within the pool, no signed-out error); confirm it fails when the `allows()` filter is removed from the pin-hash check in `restrict()` (`affinity.ts` ~143-151), per FR-013, T122 (partial)
- [X] T124 Qualify the subagent sentence in `docs/auth-broker-gateway.md` ~359 ("A subagent started from such a session gets the same state and fails the same way") so it matches the code and the ai CHANGELOG strict line: the subagent keeps the state unless `sessions.restrict` limits it to a pool without that account, per FR-013, T122 (partial)

## Phase 21: Convergence

- [X] T125 Make `inherit()` in `packages/ai/src/auth/affinity.ts` (~565-569) decide whether a strict hold may go to a restricted target with the same in-pool test as `restrict()` (~137-153: the hold's `identityKey` is in the pool, or an allowed OAuth row has its `pinHash`), through one shared helper, instead of `permits(target, held.credentialId)`, which is false for a removed account or a restored hold (id -1); add a seeded test where a parent's strict account is removed (local hold and restored hold) and the parent's state goes to a child that is already restricted to a pool with and without that account, and expect the same outcome as inherit-then-restrict, per FR-013 (partial)
- [X] T126 Make the strict-hold text match the code: (a) in `packages/ai/CHANGELOG.md` ~13, `docs/auth-broker-gateway.md` ~359, and the `SessionsApi.restrict` doc in `packages/ai/src/auth/types.ts` (~1244-1247), say that a hold restored from a session file stays under a pool only while an allowed account has its pin hash, and that a session that is already restricted gets no restored hold; (b) in the `holdGone` doc (~1217-1220), say "session restriction" for the skipped case and "broker client account pool" for the held case; (c) in `docs/settings.md` ~1054, say that after a restart the strict error names "the account this session used"; (d) in `data-model.md` ~44, say a restored hold has credential id -1; (e) in the `inherit` doc (~1223-1230), say that a strict hold goes to the target only when the target's pool contains that account, per FR-013, T122 (partial)
