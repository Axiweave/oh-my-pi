# Quickstart: Validate the Disable Mark

## Automated checks

Run each file in its own process from the repo root:

```sh
(cd packages/ai && bun test test/auth-storage-routing-modes.test.ts)
(cd packages/ai && bun test test/auth-broker-config-discovery.test.ts)
(cd packages/ai && bun test test/auth-storage-session-restriction.test.ts)
(cd packages/coding-agent && bun test test/usage-cli.test.ts)
(cd packages/coding-agent && bun test test/auth-broker-live-settings.test.ts)
(cd packages/coding-agent && bun test test/sdk-credential-disabled-bridge.test.ts)
```

Expected: all of them pass. The routing-modes file holds the new property checks:

- In all 6 modes, with generated pools and a fixed seed, no selection returns a disabled credential.
- The result is the same when every other credential is blocked or past its cap.
- Clearing the mark makes the credential selectable again with no new sign-in.

## Manual smoke check

1. Sign in two accounts for one provider. Run `omp usage accounts` to get their emails.
2. Add this to `~/.omp/agent/config.yml`:
   ```yaml
   auth:
     accountPolicies:
       - provider: anthropic
         account: { email: <second email> }
         disabled: true
   ```
3. Run `omp usage`. Expected: the second account's policy line starts with `disabled`, and no `routing:` line appears, because only 1 credential is enabled.
4. Run `omp -p "say hi"` several times. Expected: every request uses the first account.
5. Pin the second account in a session with `/session pin`, and then send a prompt. Expected: one warning (contract W1), and the reply comes from the first account.
6. Set `auth.routing.anthropic.stays: strict`, start a new session on the first account, and then disable the first account. Expected: each prompt fails with error E2. Remove the mark, and the next prompt works on the same account.
7. Disable both accounts and send a prompt. Expected: error E3 names both accounts.
8. Remove the marks. Expected: both accounts serve again with no new sign-in.
