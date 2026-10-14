# Contract: `auth.accountPolicies[].disabled`

## Configuration

```yaml
auth:
  accountPolicies:
    - provider: anthropic
      account: { email: second@example.com }
      disabled: true
    - provider: openai
      account: { keySuffix: "9f2c" }
      disabled: true
```

- `disabled` is optional. Its default is `false`.
- `disabled` can be used together with `priority`, `weight`, `capPct`, and `windowCapPct`. Those fields have no effect while `disabled` is `true`.
- The field applies after `/reload-config`, or at once with `config.hotReload: true`. `omp auth-gateway serve` reads it when it starts.

## Messages

| Id | When | Text |
|---|---|---|
| V1 | `disabled` is not a boolean | `auth.accountPolicies[<i>].disabled must be a boolean` |
| W1 | An explicit session pin is disabled, and a sibling served the request. The message shows once for each move. It is a notice with level `warning` and source `auth`. | `<provider> account <label> is disabled by auth.accountPolicies. This session now uses <new label>.` |
| E2 | A `stays: strict` session with an automatic pin, and the pinned account is disabled. The message repeats on every request. | `No API key for provider: <provider> (session <sessionId> stays on <label> under \`stays: strict\`, and auth.accountPolicies disables that account. Remove its disabled mark, change \`stays\`, or pin another account to this session.)` |
| E3 | No source resolved a key, and at least one stored credential that the session may use is disabled | `No API key for provider: <provider> (auth.accountPolicies disables <labels>, and no other account or key can serve. Remove a disabled mark to use this provider.)` |

E2 and E3 are `MissingApiKeyError`. The auth gateway still answers them with a bare 401.

## `omp usage`

- **Policy line:** for a disabled account, the line starts with `disabled`. For example: `policy: disabled · priority 5 · cap 80%`. The account's usage windows are still shown.
- **Routing line:** it appears only when 2 or more of the provider's credentials are enabled. `next:` never names a disabled credential.
- **Weights line:** it lists only enabled API keys.
