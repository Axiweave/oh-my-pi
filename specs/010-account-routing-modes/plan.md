# Implementation Plan: Account Routing Modes Ported from Magpie

**Branch**: `010-account-routing-modes` | **Date**: 2026-10-13 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/010-account-routing-modes/spec.md`

## Summary

This feature ports magpie's routing policies for the account pool of one provider into OMP credential selection:

- six routing modes (`smart`, `order`, `rotate`, `weight`, `usage`, `pace`)
- five stays modes (`auto`, `session`, `turn`, `off`, `strict`)
- sink
- weight for each account or API key
- caps for each account and each window

All routing modes plug into one pure ordering step in the existing `CredentialSelector` pipeline. `smart` keeps today's comparator. Blocked, plan-ineligible, over-cap, and spent accounts go last in every other mode. `usage` and `pace` try an account with unknown usage first, once, on providers that report usage in response headers. Stays modes change only the pin-promotion rule. A new request option, `withinTurn`, gives the pin rule the turn boundary: it is true only when the last message is a tool result. `strict` also stops turn recovery from waiting or retrying a usage-limit refusal. Caps replace `reservePct` and use the existing reserve code, and `order` does not apply the global reserve. A new record setting, `auth.routing`, uses the existing atomic live-apply path. The auth gateway reads it at start (FR-019). `omp usage` shows the routing in effect through a side-effect-free preview of the same ordering step. See [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript on Bun (repository toolchain)

**Primary Dependencies**: existing packages only: `@oh-my-pi/pi-ai` (auth, usage, auth gateway), `@oh-my-pi/pi-agent` (agent loop), and `@oh-my-pi/pi-coding-agent` (settings, session, CLI). No new dependency.

**Storage**: config.yml settings (existing layers). Session pins use the existing credential-store cache. The new runtime state lives only in memory, except the strict hold, which uses persisted `session:strict:` cache rows with the pin's expiry, fronted by an in-memory cache.

**Testing**: `bun test` with in-memory SQLite credential stores, the existing selection-test pattern, and property tests with fixed seeds.

**Target Platform**: the OMP CLI and SDK on macOS, Linux, and Windows, and the `omp auth-gateway` server.

**Project Type**: monorepo (library + CLI)

**Performance Goals**: no new network calls during selection. The ordering step is O(n log n) for n credentials, and n is small (at most tens).

**Constraints**: with default settings, the selection must be the same as today (SC-005). Invalid settings must not replace the active settings (FR-020).

**Scale/Scope**: about 20 source files in 3 packages, 1 new test file, and changes to 5 existing test files and 2 docs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template, so it defines no gates. The plan uses the repository rules in AGENTS.md as gates:

| Gate | Status |
|---|---|
| No backward compatibility until required | Pass. `reservePct` is replaced by `capPct` and `windowCapPct` with no alias (R6). |
| Remove means remove | Pass. The old reserve-only label in `omp usage` is replaced, not kept as an option. |
| Tests prove a property, not a copy of the body | Pass. Mode tests check block ratios, invariants, and agreement with a slow reference sort, using generated inputs with a fixed seed (R11). |
| Reuse existing patterns | Pass. The design reuses the ranking pipeline, the reserve machinery, `#providerRoundRobinIndex`, `SessionAffinity`, `createAuthStorageSettingsSync`, and the `providers.maxInFlightRequests` record pattern. |
| No over-defensive code or ceremony | Pass. The routing state is plain in-memory maps. The strict hold is the only new persisted state: one cache row per held session, with no tokens. A broker client restores it from the existing session-file pin hash, so no new hashing is added. |
| Changelog and docs updated | Pass. `packages/ai/CHANGELOG.md`, `packages/coding-agent/CHANGELOG.md`, `docs/settings.md`, and `docs/auth-broker-gateway.md` are in scope. |
| New config default appended to `~/.omp/agent/config.yml` | Pass. `auth.routing: {}` is appended. |

**Post-design re-check**: Pass. The design adds one module for the mode ordering functions, and it adds no new abstraction layer. The gateway keeps start-time settings, as FR-019 states (R10). SC-005 relies on the existing selection tests that stay unchanged, not on a new forwarding test (R11).

## Project Structure

### Documentation (this feature)

```text
specs/010-account-routing-modes/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── routing-config.md
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit.tasks output
```

### Source Code (repository root)

```text
packages/ai/src/
├── auth/
│   ├── routing.ts           # NEW: per-mode ordering, smooth WRR, pace bands, sink order (pure)
│   ├── rank.ts              # smart comparator unchanged; export metrics for routing.ts
│   ├── select.ts            # base order per mode, stays pin rule, order skips global reserve, sink/WRR state, preview
│   ├── policy.ts            # routing table, weight, capPct/windowCapPct, keySuffix match, validation
│   ├── health.ts            # same cap rule as select (order: no global reserve)
│   ├── rotation.ts          # strict: no switch; sink on quota-left refusal; noteRateLimited
│   ├── usage.ts             # recent-token tally (1h half-life) from observe(credentialId)
│   ├── cascade.ts           # pass withinTurn to OAuth and API-key selection
│   └── types.ts             # ProviderRouting, AuthAccountPolicy fields, withinTurn, ObservedUsageInput.credentialId
├── auth/usage-report.ts     # per-window cap check
├── auth-broker/discover.ts  # parseAuthRouting, allow-list for new policy fields, config snapshot
├── auth-storage.ts          # routing option, setAccountPolicies(routing), routing.config, routing.preview
└── auth-gateway/
    ├── server.ts            # withinTurn from last message role; credentialId to usage
    └── dispatch.ts          # recordGatewayUsage(credentialId)

packages/agent/src/
├── types.ts, agent.ts       # getApiKey(model, { withinTurn })
└── agent-loop.ts            # compute withinTurn from the last context message

packages/coding-agent/src/
├── config/model-settings.ts         # register auth.routing
├── config/model-registry.ts         # forward withinTurn
├── config/api-key-resolver.ts       # forward withinTurn; no rotate for strict
├── session/auth-broker-config.ts    # load + live-diff auth.routing
├── session/agent-session.ts         # observe(credentialId)
├── session/turn-recovery.ts         # noteRateLimited on non-usage 429; strict: no usage-limit wait/retry
├── sdk.ts                           # thread routing + withinTurn
├── cli/auth-gateway-cli.ts          # pass routing to AuthStorage (2 sites)
└── cli/usage-cli.ts                 # routing line, cap labels

packages/ai/test/auth-storage-routing-modes.test.ts   # NEW
packages/ai/test/auth-storage-codex-selection.test.ts # reservePct → capPct
packages/ai/test/auth-broker-config-discovery.test.ts
packages/coding-agent/test/auth-broker-live-settings.test.ts
packages/coding-agent/test/usage-cli.test.ts
docs/settings.md, docs/auth-broker-gateway.md
packages/ai/CHANGELOG.md, packages/coding-agent/CHANGELOG.md
~/.omp/agent/config.yml                              # append auth.routing: {}
```

**Structure Decision**: The work stays in the existing monorepo packages. The only new source module is `packages/ai/src/auth/routing.ts`. It holds the pure mode-ordering functions, so that `select.ts` (selection) and `routing.preview` (`omp usage`) share one implementation.

## Delivery Order

1. Types, config parsing, and validation (R6, R7, R10). These block everything else.
2. The `order` mode with caps and without the global reserve, plus the stays pin rule and `withinTurn` plumbing (US1, US2: P1).
3. `rotate`, `weight`, `usage`, `pace`, and recent tokens (US3).
4. Per-window caps in health and `omp usage` (US4).
5. Sink (US5).
6. The `omp usage` routing line and preview (US6). Then docs, changelogs, and the config default.

## Complexity Tracking

No gate violations.
