# Research: Disable a Signed-In Account

All findings come from the current tree (after the `v18.10.4` merge). Line numbers are approximate.

## R1. Where the filter goes

- **Decision:** Drop a disabled credential from the selector's input lists, before ranking. The 4 list builders are:
  - `resolveOAuth` (`packages/ai/src/auth/select.ts:832`)
  - `selectApiKey` (`select.ts:407-410`)
  - `selectByType` (`select.ts:308-318`)
  - `preview` (`select.ts:716`)

  Sibling counts in `rotation.ts:191-199` and `rotation.ts:494-501`, the fallback health check in `health.ts:~218`, and `routing.weights` in `auth-storage.ts:154-163` skip disabled credentials too. One predicate, `AccountPolicies.isDisabled(provider, credential)`, sits next to `forCredential` (`policy.ts:294`).
- **Rationale:** Every mode, pin, sink, round robin, and last-resort pass reads these lists, so one filter in each list builder covers all 6 modes. `isRoutable` and `compareHard` in `routing.ts` only sort a candidate last. An over-cap account still serves as the last fallback (`select.ts:607`, `routing.ts:41`, `routing.ts:56-57`). This is the wrong behavior for FR-002.
- **Alternatives considered:**
  - A new hard flag in `routing.ts`: rejected. It would need a change in every mode and in the last-resort passes, and it gives the same result as the list filter.
  - A large `capPct` cap: rejected. An over-cap account is still a fallback.

## R2. Token refresh for a disabled account

- **Decision:** In `resolveOAuth`, start a refresh for each disabled OAuth credential whose token is near expiry. Use the existing `refresher.refresh` call with the row id, and do not wait for it. With a row id and a lease store, `refresh` takes the `refreshStored` path (`refresh.ts:489`), which saves the rotated token with a compare-and-set write and updates the pool (`refresh.ts:331-363`). `SqliteAuthCredentialStore` has all four lease methods. A broker client holds no refresh token, so the broker saves any rotation. The call therefore needs no second merge-and-save step. It does not rank the account, pin it, block it, or return its key. A transient failure goes to the debug log only. A definitive failure (for example, a revoked refresh token) follows the normal path in `refresh.ts:283-303`: the refresher disables the stored row and emits `credentials.onDisabled`, so the user sees the usual sign-in notice, the same as for an enabled account.
- **Rationale:** In local mode, OAuth refresh happens only during selection. The preflight step refreshes every candidate (`select.ts:1134`). Without this decision, a disabled account would lose its access token and keep only its refresh token. FR-003 requires that refresh continues. `refresher.refresh` already checks `OAUTH_REFRESH_SKEW_MS` and runs one refresh per credential at a time, so the added code is one loop. The broker refresher (`auth-broker/refresher.ts`) does not read policies, so broker mode needs no change.
- **Alternatives considered:**
  - Accept that the token goes stale: rejected, because it breaks FR-003.
  - A background timer: rejected. Local mode has no refresh timer, and the selection-time refresh covers the time when the user works.

## R3. Warning for an explicit choice

- **Decision:** Add a listener subscription, `authStorage.sessions.onAccountDisabled(listener)`, which returns an unsubscribe function. Its event is `{ provider, sessionId, label, nextLabel }`. `resolveOAuth` emits it when an explicit session pin points at a disabled credential and a sibling account serves the request. `sdk.ts` subscribes in the same way as for `credentials.onDisabled` (`sdk.ts:1796-1807`). It ignores events for other session ids, because subagents share one `AuthStorage`. For its own session, it calls `session.emitNotice("warning", text, "auth")`. The text formatter goes in `session/credential-disabled-notice.ts`, next to `formatCredentialDisabledNotice`.
- **Rationale:** The `ai` package has no event for an account change. The existing notice path with the `"auth"` source already reaches the interactive UI, print mode on stderr (`print-mode.ts:237-240`), and RPC (`NoticeEvent`). The move records a new pin that is not explicit (`select.ts:1570`), so the next request does not see an explicit disabled pin. The warning therefore shows once for each move, with no deduplication state.
- **Alternatives considered:**
  - A new event type on `AgentSession`: rejected, because `emitNotice` already covers every mode.
  - A deduplication set: not needed, because the pin change already gives "once".

## R4. Strict sessions

- **Decision:** Under `stays: strict` with an automatic pin, `resolveOAuth` checks the pinned credential before the filter. If the credential is disabled, it throws `MissingApiKeyError` with the disabled text (contract E2). `#backToStrictAccount` (`select.ts:203`) makes the same check on the account it finds again, and it does not record the pin. The hold stays unchanged, so the session uses the same account again after the mark is removed.
- **Rationale:** `strict` never moves (clarification Q2). An explicit pin under `strict` keeps the explicit rule (`select.ts:165`, docs: "An explicit session pin keeps its behavior"). For that case, R3 applies: the session moves and the user gets the warning.
- **Alternatives considered:** Reuse the signed-out error. Rejected, because the account is still signed in, and the text must tell the user how to fix it.

## R5. Error when nothing is usable

- **Decision:** `CredentialSelector` exposes `disabledLabels(provider, sessionId)`. It returns the labels of the disabled stored credentials that the session pool allows. `KeyCascade.#resolve` (`cascade.ts:517`) and the restricted-pool branch (`cascade.ts:411`) throw `MissingApiKeyError` with contract E3 when no source resolved and that list is not empty.
- **Rationale:** `#resolve` is the one place that decides "no key" after the runtime, config, OAuth, login, fallback, environment, and stored-key steps. `MissingApiKeyError` already goes through `getApiKey`, and `skipMissing` callers stay quiet. The gateway maps it to a bare 401 (`dispatch.ts:109-110`), so labels do not reach gateway clients.
- **Alternatives considered:** A reason field on `undefined` results. Rejected, because the callers already handle the error type.

## R6. Availability checks

- **Decision:** `selectByType` also skips disabled credentials. Then `keys.peek` and `hasAuth` see a provider with only disabled credentials as unauthenticated.
- **Rationale:** `peek` returns a real bearer (`cascade.ts:255-310`). If it skipped no credentials, a background caller could send a request with a disabled account, which breaks FR-002.
- **Trade-off:** The model picker hides a provider whose credentials are all disabled. A session that already uses such a model gets error E3 on its next request.

## R7. Validation, configuration, and reload

- **Decision:** Add `"disabled"` to the allowed field list in `parseAuthAccountPolicies` (`auth-broker/discover.ts:129`), and copy the field into its output (`discover.ts:~181`). `validateAccountPolicies` (`policy.ts:76`) rejects a value that is not boolean. The error is `auth.accountPolicies[<i>].disabled must be a boolean`.
- **Rationale:** `discover.ts` rebuilds each policy field by field, so a field that is not in that copy is lost without an error. `AccountPolicies.replace` already validates and swaps atomically on `/reload-config` and hot reload (`auth-broker-config.ts:184`). The gateway reads the same parser at start (`auth-gateway-cli.ts:275-293`).

## R8. `omp usage`

- **Decision:**
  - `preview` filters disabled credentials, so `next` never names one.
  - The routing line appears only when 2 or more credentials are enabled.
  - `formatPolicyLine` (`usage-cli.ts:680`) starts with `disabled` when the policy has the mark.
- **Rationale:** `getAccountPolicy` already returns the whole policy object, so no new connection is necessary. The existing red `✗ … disabled … (re-login to restore)` lines describe stored rows that a broker sign-out disabled. The new marker sits in the dim policy line, so the two states look different (spec Assumptions).

## R9. Scope of the API-key selector

- **Decision:** `keySuffix` matches stored API keys only. Runtime, config, fallback, and environment keys are outside routing, so a disable mark cannot target them.
- **Rationale:** `validateFor` checks selectors only against stored credentials. Edge case "Disabled OAuth accounts and an enabled API key" holds, because those sources come after OAuth in the cascade.
