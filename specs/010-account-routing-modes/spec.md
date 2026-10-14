# Feature Specification: Account Routing Modes Ported from Magpie

**Feature Branch**: `010-account-routing-modes`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "try porting them as much as possible" — port the account-routing policies of the magpie gateway (`/Users/fuyu0425/agents/magpie`) into the OMP account pool. The user's first goal: "use account 1 until it is used up, then account 2".

## Clarifications

### Session 2026-10-13

- Q: Should this feature also port magpie model groups (manual pick, weighted models, time/folder rules) and traffic limits, or only the account-pool policies? → A: Only the account-pool policies. Model groups and traffic limits are out of scope.
- Q: In `order` mode, should account 1 be used until it reaches 100%, or should it stop at the global reserve (`retry.usageReservePct`)? → A: `order` ignores the global reserve. An account stops only at 100%, at a refusal, or at a cap set on that account.
- Q: Should `omp auth-gateway serve` pick up changes to routing settings while it runs, or only when it restarts? → A: Only at start, as today for `auth.accountPolicies`. A gateway restart applies a change.
- Q: In `strict` mode, when the conversation's account hits a usage limit, should OMP show the error at once, or wait for that same account to reset and then retry? → A: Show the error at once. Turn recovery does not wait or retry for a strict session.
- Q: When `stays` is `turn`, which requests count as part of the current turn and keep the turn's account? → A: Only a request whose last message is a tool result. Every other request starts a new turn: a new user message, a retry after an error, a steering or follow-up message, or a re-sample.
- Q: In `usage` and `pace` modes, how should OMP rank an account whose usage it does not know? → A: Try it first, once, so that OMP learns its usage (as magpie does). After that one request, an account whose usage is still unknown counts as unused.

## Background

Today OMP selects one account from a provider's pool of signed-in accounts and API keys as follows:

- With usage reports, OMP ranks accounts. The first account is the one whose quota is lost soonest at its reset ("drain urgency"). This is the same idea as magpie's default `smart` routing.
- `auth.accountPolicies` gives an OAuth account a `priority` and a `reservePct`. Priority comes after the safety checks (blocked, plan, spent allowance, reserve, the 85% short-window guard, and measured usage). Thus OMP cannot give a strict "account 1, then account 2" order.
- A running session keeps its account while the account is warm. It moves only when the account enters its reserve or spends its allowance. It does not go back to a recovered higher-priority account.
- Without usage reports, OMP uses a hashed start index for each session, or round-robin.

Magpie has six routing modes for the accounts and keys of one provider (`smart`, `order`, `rotate`, `usage`, `pace`, `weight`). It has five stays modes (`auto`, `session`, `turn`, `off`, `strict`), a "sink" for accounts that hit a rate limit while they have quota, and usage caps for each account and each window. This feature brings these policies to the OMP account pool.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Use accounts in a fixed order (Priority: P1)

A user has two or more accounts for one provider. The user wants OMP to use account 1 until it is used up, then account 2, and so on. When account 1 has quota again, new requests go back to account 1.

The user sets the provider's routing mode to `order`. The order is the account priority (highest first), then the sign-in order. In this mode, an account is "used up" only when a usage window is at 100%, or when the provider refuses or blocks the account. The short-window guard and the drain-urgency ranking do not apply.

**Why this priority**: This is the behavior the user asked for first. No current setting gives it.

**Independent Test**: Sign in two accounts for one provider. Set `order`. Send requests until account 1 is refused for usage. Make sure every request before the refusal used account 1, and every later request used account 2. Make account 1 usable again. Make sure the next new session uses account 1.

**Acceptance Scenarios**:

1. **Given** mode `order` and two usable accounts, **When** a new session sends a request, **Then** OMP uses the first account in the order.
2. **Given** mode `order`, the default 10% global reserve, and the first account at 95% of its weekly window, **When** a request starts, **Then** OMP still uses the first account.
3. **Given** mode `order` and the first account refused for usage, **When** the next request starts, **Then** OMP uses the second account without a user action.
4. **Given** mode `order`, the first account usable again, and a new session, **When** the session sends a request, **Then** OMP uses the first account.
5. **Given** mode `order` and a policy with a higher priority on the second account, **When** a new session sends a request, **Then** OMP uses the second account first.
6. **Given** mode `order` and a 60% cap set on the first account, **When** the first account reaches 61% of a window, **Then** OMP uses the second account.
7. **Given** mode `order` and the first account at 90% of its 5-hour window, **When** a request starts, **Then** OMP still uses the first account.

---

### User Story 2 - Control how long a conversation stays on one account (Priority: P1)

The user sets a stays mode for each provider. Staying on one account keeps the provider's prompt cache useful, but it can keep a conversation on a worse account. The modes are:

- `auto` (default): today's behavior. A conversation stays on its account while the account is warm. It moves only when the account is blocked, enters its reserve, or spends its allowance.
- `session`: the conversation stays on its account for the whole session, while the account is usable.
- `turn`: the conversation stays on its account while the agent sends tool results back. Every other request (a new user message, a retry after an error, a steering or follow-up message, or a re-sample) starts a new turn and selects again by the routing mode.
- `off`: each request selects again by the routing mode.
- `strict`: the conversation never moves. When its account is blocked or used up, the error goes to the user at once. OMP does not wait for a reset and does not go to another account.

**Why this priority**: Without `turn` or `off`, a running session that moved to account 2 does not go back to account 1. User Story 1 then works only for new sessions.

**Independent Test**: Use mode `order` with stays `off`. Make account 1 refuse one request, so that the session moves to account 2. Make account 1 usable again. Make sure the next request in the same session uses account 1. Repeat with `auto`, and make sure the session stays on account 2 while it is warm.

**Acceptance Scenarios**:

1. **Given** stays `turn` and a session on account 2 after a failover, **When** the user sends a new message and account 1 is first by the routing mode, **Then** the new turn uses account 1.
2. **Given** stays `turn`, **When** the agent sends tool results inside one turn, **Then** each of these requests uses the account of that turn.
3. **Given** stays `turn`, mode `order`, a session on account 2, and account 1 usable again, **When** a steering message follows a tool batch, **Then** that request selects again and uses account 1.
4. **Given** stays `strict` and the session account is blocked, **When** a request starts, **Then** OMP shows the block error and does not try another account.
5. **Given** stays `strict` and the session account hits a usage limit during a turn, **When** the refusal arrives, **Then** OMP shows the error at once and does not wait for a reset or retry.
6. **Given** an account that the user pinned for the session, **When** any stays mode is set, **Then** the pin keeps its current behavior.

---

### User Story 3 - Spread requests by turn, weight, least use, or pace (Priority: P2)

The user selects one of the other magpie modes for a provider:

- `smart` (default): today's drain-urgency ranking, with all of today's safety checks.
- `rotate`: each new selection starts one account further along the order.
- `weight`: each account has a weight (1 to 1000, default 1). Accounts get requests in the ratio of their weights, and the order mixes them smoothly. For example, weights 3 and 1 give a, a, b, a, a, a, b, a.
- `usage`: the account with the lowest share of its allowance used goes first. When shares are equal, or when no usage is known, the account that served the fewest tokens recently goes first. Recent tokens lose half their weight each hour. An account with unknown usage goes first once, so that OMP learns its usage.
- `pace`: the account with the most weekly quota left per hour until its weekly reset goes first. Accounts at 90% or more of a window go after the others. Accounts at 98% or more go last.

**Why this priority**: These modes help users with team seats or several API keys. They are not needed for the first goal.

**Independent Test**: For each mode, sign in three accounts or keys with known usage. Send a fixed number of new-session requests. Compare the account sequence with the rule of the mode.

**Acceptance Scenarios**:

1. **Given** mode `rotate` with three accounts and stays `off`, **When** six requests start, **Then** the accounts are used in the sequence 1, 2, 3, 1, 2, 3.
2. **Given** mode `weight` with weights 3 and 1, **When** eight requests start with stays `off`, **Then** the first account serves six requests and the second account serves two, and the second account never serves two requests in a row.
3. **Given** mode `usage`, account A at 20% used, and account B at 60% used, **When** a new session starts, **Then** OMP uses account A.
4. **Given** mode `pace`, account A with 50% of its week left and 10 hours to its reset, and account B with 90% left and 100 hours to its reset, **When** a new session starts, **Then** OMP uses account A.
5. **Given** any mode, **When** an account is blocked or fails a plan check for the model, **Then** OMP skips that account in the same way as today.

---

### User Story 4 - Cap each account and each usage window (Priority: P2)

The user sets a usage cap for one account, or for one usage window of one account. Example: "use at most 50% of the 5-hour window and 40% of the week on my work account". Past its cap, routing treats the account as used up for that window until the window resets.

**Why this priority**: Users share seats or keep part of a personal plan for other tools. Today the reserve has one value for each account, and that value applies to all windows.

**Independent Test**: Set a 40% weekly cap on account 1. Make account 1 report 41% weekly use. Make sure that a new session uses account 2. Make sure that `omp usage` shows account 1 as capped.

**Acceptance Scenarios**:

1. **Given** a weekly cap of 40% on account 1 and its weekly use at 41%, **When** a new session starts, **Then** OMP selects another usable account.
2. **Given** a 5-hour cap of 50% and no weekly cap, **When** the 5-hour window resets, **Then** account 1 is usable again.
3. **Given** caps on every account and every account past its cap, **When** a request starts, **Then** OMP behaves the same as today when every account is inside its reserve.

---

### User Story 5 - Move rate-limited accounts to the back ("sink") (Priority: P3)

The user turns on sink for a provider. When an account gets a rate-limit refusal while it still has quota, it goes behind every account that has had no rate limit since. It stays there until OMP restarts or until every other account has also had a rate limit.

**Why this priority**: This helps with providers whose concurrency limits trip often. Most users do not need it.

**Independent Test**: Turn on sink with mode `order`. Make account 1 return one rate-limit refusal while its usage is low. Make sure that later requests start with account 2 after the account 1 backoff ends.

**Acceptance Scenarios**:

1. **Given** sink on and account 1 rate limited with quota left, **When** its backoff ends, **Then** account 2 stays before account 1.
2. **Given** sink on with mode `rotate` or `weight`, **When** an account is rate limited, **Then** sink has no effect. Those modes keep their own sequence.
3. **Given** sink on, **When** OMP restarts, **Then** the sink order is cleared.

---

### User Story 6 - See the routing in effect (Priority: P3)

The user runs `omp usage`. For each provider with two or more accounts or keys, the output shows the routing mode, the stays mode, sink, the caps for each account, and the account that the next new session would use, with a short reason. Examples: "first in order", "its turn", "least used: 20%".

**Why this priority**: Without this output, users cannot check that a mode does what they expect.

**Independent Test**: Set mode `usage` on a provider with two accounts. Run `omp usage`. Make sure the output names the mode and the least-used account as the next account.

**Acceptance Scenarios**:

1. **Given** a provider with two accounts in mode `order`, **When** the user runs `omp usage`, **Then** the output shows `order` and names the first usable account as next.
2. **Given** a provider with one account, **When** the user runs `omp usage`, **Then** the output shows no routing line for it.

---

### Edge Cases

- The provider gives no usage reports: `order`, `rotate`, and `weight` work as written. `usage` and `pace` order by recent tokens only. `smart` keeps the account order.
- Account usage is unknown for one account: `usage` and `pace` put it first for one request so that OMP learns its usage. After that request, if its usage is still unknown, it counts as unused (0% used, a full week left). It does not go first again until OMP restarts or the provider's accounts change.
- An account is removed or signed out while it is the session account: the session selects again by the routing mode. Exception: under `stays: strict`, every later request of the session fails with an error that names the account, until that account signs in again or the provider's set of accounts changes. An explicit pin keeps its own behavior.
- The routing mode changes while sessions run: the next selection uses the new mode. Current conversations stay on their account as the stays mode says.
- The pool mixes OAuth accounts and API keys: today's precedence between OAuth accounts and API keys stays. The routing mode orders accounts inside each kind.
- A weight is outside 1–1000, a cap is outside 1–100, or the routing or stays value is unknown: OMP shows a configuration error that names the setting. The previous settings stay active.
- Every account is blocked: OMP behaves as today (wait for the earliest reset, or fail, as the retry settings say).
- Subagents start with the pins of their parent session, as today. They then follow the stays mode of the provider.
- `strict` and the usage-aware model fallback (`retry.usageAwareFallback`, checked before a request) are both on: `strict` wins for the account. The usage-aware fallback can still pick another model before the request. After a usage-limit refusal, turn recovery does not switch the account or the model.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Users MUST be able to set a routing mode for each provider. The modes are `smart`, `order`, `rotate`, `weight`, `usage`, and `pace`. The default is `smart`.
- **FR-002**: `smart` MUST give the same selection as today for every input.
- **FR-003**: `order` MUST use the accounts in priority order (highest first), then in sign-in order. It MUST move to the next account only when the current account is blocked, refused for usage, failed for auth, failed a plan check, at 100% of a usage window, or past a cap set on that account. `order` MUST NOT apply the global reserve (`retry.usageReservePct`).
- **FR-004**: `order` MUST NOT apply the short-window guard or drain-urgency ranking.
- **FR-005**: `rotate` MUST start each new selection one account further along the order, and it MUST skip unusable accounts.
- **FR-006**: `weight` MUST give requests to usable accounts in the ratio of their weights, with a smooth weighted round robin. An account that is unusable MUST leave the round until it is usable again. A request that the stays mode keeps on an account MUST count against that account.
- **FR-007**: `usage` MUST order accounts by the share of allowance used (lowest first), then by recent tokens served (lowest first). Recent tokens MUST lose half their weight each hour. An account with unknown usage MUST go first for one request (learn once). After that, it MUST count as 0% used while its usage stays unknown.
- **FR-008**: `pace` MUST order accounts in three tiers: below 90% used, 90% to below 98%, and 98% or more. Inside the first tier, an account with unknown usage MUST go first for one request (learn once). The other accounts in the first tier MUST be ordered by weekly quota left per hour until the weekly reset (highest first). Paces within 10% of each other count as equal, and then recent tokens decide. Inside the other tiers, it MUST order by share used (lowest first). After its one learning request, an account with unknown usage MUST count as 0% used with a full week left.
- **FR-009**: Every mode MUST skip accounts that are blocked, disabled, past a cap, or ineligible for the model plan, the same as `smart` does today.
- **FR-010**: Users MUST be able to set a stays mode for each provider: `auto`, `session`, `turn`, `off`, or `strict`. The default is `auto`.
- **FR-011**: `auto` MUST keep today's rule for keeping a conversation on its account.
- **FR-012**: `turn` MUST keep the account for a request whose last message is a tool result. Every other request MUST select again by the routing mode. This rule MUST be the same in the agent and in the auth gateway.
- **FR-013**: `strict` MUST NOT move a conversation to another account. It MUST show the account error to the user at once. Exception: after its account is removed, the session fails until that account signs in again (the session goes back to it) or the provider's set of accounts changes (the session selects again). Turn recovery MUST NOT wait for a reset, retry, or switch the model after a usage-limit refusal for a strict session.
- **FR-014**: An explicit session pin by the user MUST keep its current behavior in every stays mode.
- **FR-015**: Users MUST be able to set a weight (1–1000) for each account or API key.
- **FR-016**: Users MUST be able to set a usage cap for each account, either for all windows or for one named window. A cap for one window MUST override the cap for all windows on that window.
- **FR-017**: The cap and the existing reserve MUST be one concept. A cap of X% MUST be the same as a reserve of (100 − X)%. Users MUST NOT have two settings for the same limit. The global reserve MUST apply to accounts without their own cap in every mode except `order`, when the provider has at least one account policy (today's rule). Exception: the health check of the usage-aware fallback always applies the global reserve, except in `order`, as it did before this feature.
- **FR-018**: Users MUST be able to turn sink on for each provider. With sink on, an account that gets a rate-limit refusal while it has quota MUST go behind every account without a rate limit since then. This MUST apply to all modes except `rotate` and `weight`. OMP MUST clear the sink order on restart.
- **FR-019**: In the interactive agent, subagents, and the SDK, the routing, stays, sink, weight, and cap settings MUST take effect for the next selection without a restart. The auth gateway MUST read them at start, as it does today for `auth.accountPolicies`. A gateway restart applies a change.
- **FR-020**: OMP MUST reject invalid values with an error that names the setting, and it MUST keep the previous settings active.
- **FR-021**: The same selection rules MUST apply in the interactive agent, in subagents, in the SDK, and in the auth gateway.
- **FR-022**: `omp usage` MUST show the routing mode, stays mode, sink state, and caps for each provider with two or more accounts or keys. It MUST name the account that the next new session would use, with a short reason.
- **FR-023**: Each new setting MUST have its default value in the user's main config file, and the settings reference MUST document it.
- **FR-024**: Magpie features outside the account pool of one provider are out of scope: model groups (manual pick, weight across models, rules by hour, day, agent, or folder), traffic limits (concurrency, requests per minute, queues), and agent sign-in moves ("keep login").

### Key Entities

- **Provider routing policy**: one for each provider. It has a routing mode, a stays mode, and a sink switch.
- **Account policy**: one for each account or API key. It has a priority, a weight, and caps (one for all windows, or one for each named window). It extends today's account policy.
- **Usage window**: one quota period of an account, for example the 5-hour or weekly window. It has a share used and a reset time.
- **Session affinity**: the account that a conversation uses now, when it was last used, and whether the user pinned it.
- **Recent-use record**: the tokens that each account served recently, with a one-hour half-life. It lives only in memory.
- **Sink order**: the accounts that had a rate limit while they had quota, in the order of their refusals. It lives only in memory.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In `order` mode with two accounts, 100% of requests use account 1 until account 1 is refused or reaches 100% of a window, in a test of 50 requests.
- **SC-002**: In `order` mode with stays `off` or `turn`, the first request or turn after account 1 recovers uses account 1 in 100% of test runs.
- **SC-003**: In `weight` mode with weights 3 and 1 and stays `off`, every block of 8 requests has a 6:2 split. With stays `turn` and one request per turn, the same split holds for every block of 8 new user turns. The round counts requests, so turns with more tool calls weigh more.
- **SC-004**: In `rotate` mode with N usable accounts and stays `off`, every account serves exactly one request in each block of N requests. With stays `turn`, requests inside one turn stay on one account, and each account serves exactly one turn in each block of N new turns.
- **SC-005**: With the default settings, OMP selects the same account as today for the same accounts, usage, and session state, in 100% of compared cases.
- **SC-006**: A user can set the mode, stays, sink, weight, and caps for a provider and see them in `omp usage` in under 2 minutes, without a restart.
- **SC-007**: Every invalid setting gives an error that names the setting, and the previous routing stays active, in 100% of test cases.

## Assumptions

- The settings live in the OMP config next to `auth.accountPolicies`, in the same layers (global and project). Example names: a provider routing table under `auth` with `routing`, `stays`, and `sink`. `weight` and `caps` go in each account policy entry.
- Today's `reservePct` becomes the "all windows" cap. Per-window caps extend it. No compatibility path for an old shape is needed (the repository allows breaking config changes).
- The window names are the ones that each provider's usage report gives (for example `5h` and `7d`). The plan phase fixes the exact names.
- API keys follow the same routing modes. A key without a usage report has no allowance. `usage` uses recent tokens for it, and `pace` counts it as 0% used with a full week left. API keys have no session pin today, so the stays mode applies to OAuth accounts only. Outside `smart`, the routing mode decides each API-key request, as with stays `off`. `strict` still stops rotation to another key.
- `turn` decides from the last message of the request only, as magpie does. It needs no saved state. A steering message after a tool batch can therefore move the conversation to another account. The cost is a lost prompt cache.
- In `order` mode, today's 85% short-window guard is off. In `pace` mode, the 90% tier covers the same need.
- Explicit session pins, plan checks, auth retry, and the usage-aware model fallback keep their current behavior.
- The "learn once" rule applies only to providers that report usage in response headers (for example Anthropic and Codex). For other providers, an account with unknown usage counts as unused at once.
