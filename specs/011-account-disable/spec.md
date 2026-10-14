# Feature Specification: Disable a Signed-In Account

**Feature Branch**: `011-account-disable`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Can we log in but disable one account? Add `disabled: true` to `accountPolicies`. Routing skips that account in every mode, and the account stays signed in."

## Clarifications

### Session 2026-10-13

- Q: If you chose a specific account for a session yourself, and that account is then disabled in the config, what should the session do? → A: The disable mark wins. The session moves to another account, as for a blocked account, and the user sees a warning.
- Q: Your current config has `stays: strict` for a provider. If the account that a session holds is disabled, should the session fail or move to another account? → A: The session fails. Each request returns an error that says the account is disabled. The session works again when the user enables the account.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Stop using one account without signing out (Priority: P1)

A user has two or more accounts for one provider. The user wants OMP to stop using one of them for a while, for example to save its quota for other work. The user marks that account as disabled in its account rule. OMP then never sends a request with that account, and the account stays signed in. When the user removes the mark, OMP can use the account again, and the user does not sign in again.

**Why this priority**: This is the full request. Today the only way to stop using an account is to sign out, and then the user must sign in again later.

**Independent Test**: Sign in two accounts for one provider. Mark one as disabled. Send requests in each routing mode and check that every request uses the other account. Remove the mark, reload the settings, and check that the first account serves requests again without a new sign-in.

**Acceptance Scenarios**:

1. **Given** two signed-in accounts and one marked disabled, **When** the user sends requests in any routing mode, **Then** every request uses the account that is not disabled.
2. **Given** a disabled account, **When** the user removes the mark and reloads the settings, **Then** the account can serve the next selection with no new sign-in.
3. **Given** a disabled account, **When** its sign-in token gets old, **Then** OMP still keeps the sign-in valid, so the account works at once after the user enables it again.
4. **Given** a disabled API key (matched by the end of the key), **When** the provider has other keys or accounts, **Then** no request uses that key.

---

### User Story 2 - Running sessions follow the change (Priority: P2)

A user disables an account while sessions use it. The sessions move to another account at their next account selection. They do not continue on the disabled account.

**Why this priority**: A disable that only affects new sessions does not save the account's quota.

**Independent Test**: Start a session that holds account A. Mark A as disabled and reload the settings. Send the next request and check that it uses another account.

**Acceptance Scenarios**:

1. **Given** a session that holds account A under any non-strict stays value, **When** the user disables A and reloads the settings, **Then** the next account selection of the session uses another account.
2. **Given** a session in which the user chose account A explicitly, **When** A becomes disabled, **Then** the session moves to another account, as it does when A is blocked, and the user sees a warning that names A and says it is disabled.
3. **Given** a session under `strict` stays whose account A came from automatic selection, **When** A becomes disabled, **Then** every later request of the session fails with an error that says A is disabled. The session does not move to another account. It works again when the user enables A.
4. **Given** a session under `strict` stays in which the user chose account A explicitly, **When** A becomes disabled, **Then** the session moves to another account and shows the FR-006 warning.
5. **Given** a resumed session or a subagent that would start on account A, **When** A is disabled, **Then** it does not use A.

---

### User Story 3 - See which accounts are disabled (Priority: P3)

A user checks the account list and sees which accounts are disabled, so the user knows why an account gets no traffic.

**Why this priority**: The behavior works without this, but a silent skip is hard to explain.

**Independent Test**: Disable one account and open the usage report. Check that the account shows as disabled and that the report never names it as the next account.

**Acceptance Scenarios**:

1. **Given** a disabled account, **When** the user opens the usage report, **Then** the account's line says it is disabled, and its usage is still shown.
2. **Given** a disabled account, **When** the report names the next account for the provider, **Then** it never names the disabled account.

---

### Edge Cases

- **All accounts disabled:** when every account and key of a provider is disabled, a request fails with an error that says the provider's accounts are disabled. It does not say that no key exists.
- **Disabled is not "used last":** an account past its cap still serves as a last fallback when no other account can serve. A disabled account never does. With every other account blocked or past its cap, a request fails before it uses a disabled account.
- **Disabled OAuth accounts and an enabled API key:** OMP uses the API key, as it does when all OAuth accounts are blocked.
- **Account pools:** a subagent pool or broker pool that lists a disabled account does not make it usable. The disable wins.
- **Mark with other fields:** a rule can have the disable mark together with `priority`, `weight`, or caps. Those fields have no effect while the account is disabled, and they apply again after the user enables it.
- **Invalid value:** a value that is not true or false is a configuration error. The error names the field, and the old settings stay active.
- **Unmatched selector:** a disabled rule that matches no credential has no effect, as for other rules.
- **Gateway:** the auth gateway skips disabled accounts. It reads the change when it starts, as for other account rules.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: An account rule MUST accept an optional disable mark that is true or false. False is the default.
- **FR-002**: Account selection MUST remove a disabled account or API key from the candidates in every routing mode: `smart`, `order`, `rotate`, `weight`, `usage`, and `pace`. A disabled credential MUST NOT serve as a fallback when every other credential is blocked or past its cap.
- **FR-003**: The disable mark MUST NOT sign out, delete, or change the stored credential. Token refresh MUST continue for a disabled account.
- **FR-004**: A change to the mark MUST apply at the next account selection, after a settings reload or at once with hot reload.
- **FR-005**: A session that holds a disabled account MUST select another account at its next account selection under `auto`, `session`, `turn`, and `off` stays values.
- **FR-006**: An explicit account choice for a session MUST move to another account while the chosen account is disabled. The user MUST see a warning that names the account and says it is disabled. The warning MUST appear once each time the session moves for this reason, not on each request.
- **FR-007**: A `strict` session whose account came from automatic selection (not an explicit choice) MUST NOT move when that account is disabled. Each of its requests MUST fail with an error that names the account, says it is disabled, and says that the user can enable it again or change the stays value. The session MUST work again on the same account after the user enables it. An explicit choice under `strict` follows FR-006.
- **FR-008**: Resumed sessions, subagents, and account pools MUST NOT use a disabled account.
- **FR-009**: When no usable credential remains because of disable marks, the error MUST say that the accounts are disabled.
- **FR-010**: The usage report MUST mark each disabled account and MUST NOT name a disabled account as the next account.
- **FR-011**: The settings reference MUST describe the disable mark and its effect on stays values and explicit choices.

### Key Entities

- **Account rule**: A per-account setting entry for one provider. It has a selector that matches one credential and optional routing values. This feature adds the disable mark.
- **Disabled account**: A signed-in account or stored API key that a rule marks as disabled. It stays stored and refreshed, but routing never selects it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With one of two accounts disabled, 100% of requests in each of the 6 routing modes use the enabled account.
- **SC-002**: After the user removes the mark, the account serves the next selection with 0 new sign-ins.
- **SC-003**: After a reload, a running non-strict session stops using a disabled account within 1 account selection.
- **SC-004**: The user can see which accounts are disabled from 1 command, the usage report.

## Assumptions

- The mark is a field in the existing account rule list. It is not a separate list.
- The word "disabled" in this feature means "disabled by an account rule". A broker sign-out also disables a stored row. That is a different state, and the usage report must keep the two separate.
- The disable mark overrides an explicit choice and every account pool. A `strict` session on an automatically selected account does not move. It fails instead (FR-007). An explicit choice keeps its existing rule under every stays value, so it moves (FR-006).
- A provider whose credentials are all disabled looks signed out to the model picker, because availability checks return real keys. A session that already uses a model of that provider gets the FR-009 error on its next request.
- The account stays visible to commands that list or check accounts, so the user can check it while it is disabled.
- No command to toggle the mark is in scope. The user edits the settings file.
