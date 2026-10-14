# Quickstart: Validate Account Routing Modes

## Prerequisites

- Install the repository dependencies (`bun install`).
- Set `PATH="$HOME/.cargo/bin:$PATH"` before you run `bun check`.
- For the live smoke steps, you need two signed-in accounts for one provider that reports usage (Anthropic or Codex). Use a scratch config directory so that your real config does not change.

## 1. Type check

```sh
PATH="$HOME/.cargo/bin:$PATH" bun check
```

Expected: exit code 0.

## 2. Selection properties

```sh
bun test packages/ai/test/auth-storage-routing-modes.test.ts
bun test packages/ai/test/auth-storage-codex-selection.test.ts
bun test packages/ai/test/auth-storage-session-restriction.test.ts
```

Expected: all tests pass. The first file covers every mode and the stays table in [data-model.md](data-model.md). The other two files must still pass unchanged, except for the rename from `reservePct` to `capPct`. This shows that `smart` and `auto` keep today's behavior (SC-005).

## 3. Config errors and live apply

```sh
bun test packages/ai/test/auth-broker-config-discovery.test.ts
bun test packages/coding-agent/test/auth-broker-live-settings.test.ts
bun test packages/coding-agent/test/usage-cli.test.ts
```

Expected: all tests pass. Each row of the error table in [contracts/routing-config.md](contracts/routing-config.md) has one case.

## 4. Smoke: `order` on a real pool

1. Add to the scratch `config.yml`:
   ```yaml
   auth:
     routing:
       anthropic: { mode: order, stays: turn }
   ```
2. Run `omp usage`.
   Expected: the Anthropic section shows `routing: order · stays turn · sink off · next: <first account> (first in order)`.
3. Start `omp` and send two prompts.
   Expected: the session status shows the first account for both prompts.
4. Change `mode` to `rotate` while `omp` runs, then send two more prompts.
   Expected: the account changes between the prompts, but not inside one prompt's tool calls. You do not restart `omp`.
5. Set `mode: fastest` while `omp` runs.
   Expected: a log line says that the account policy change was not applied, and the routing stays `rotate`.
6. Set `stays: strict` and use the first account until it hits a usage limit.
   Expected: the turn ends with the usage-limit error at once. No "retrying in …" countdown shows, and the next prompt still uses the first account.

## 5. Smoke: caps in `omp usage`

1. Add `windowCapPct: { 5h: 1 }` to the policy of the first account.
2. Run `omp usage`.
   Expected: the first account's policy line shows `cap … (5h 1%)` and `inside cap`, and `next` names the second account.
