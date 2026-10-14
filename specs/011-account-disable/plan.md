# Implementation Plan: Disable a Signed-In Account

**Branch**: `011-account-disable` | **Date**: 2026-10-13 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/011-account-disable/spec.md`

## Summary

An entry in `auth.accountPolicies` gets an optional `disabled: true`. The credential selector drops a disabled credential from its input lists before ranking. Because of this, no mode, pin, sink, round robin, or last-resort pass can select it. Each selection still refreshes a disabled OAuth account's token, but the selector never returns that account. When an explicit session pin is disabled, the session moves to another account and emits one `auth` warning notice. A `strict` session whose account came from automatic selection fails with a specific `MissingApiKeyError`. An explicit choice under `strict` moves and warns, as in FR-006. When only disable marks leave a provider without a key, the cascade throws an error that names the disabled accounts. `omp usage` marks disabled accounts and never shows one as `next`.

## Technical Context

**Language/Version**: TypeScript on Bun (repository toolchain)

**Primary Dependencies**: existing packages only: `@oh-my-pi/pi-ai` (auth selection, cascade, config parsing) and `@oh-my-pi/pi-coding-agent` (SDK notice bridge, `omp usage`). No new dependency.

**Storage**: none new. The mark lives in config.yml. Pins and strict holds use the existing state unchanged.

**Testing**: `bun test` with the existing in-memory pool fixtures, and property checks with a fixed seed in `auth-storage-routing-modes.test.ts`.

**Target Platform**: the OMP CLI and SDK, and `omp auth-gateway serve`.

**Project Type**: monorepo (library + CLI)

**Performance Goals**: no new network calls on the request path. The refresh of disabled accounts runs in the background and only when a token is near expiry.

**Constraints**: without the mark, selection is the same as today. An invalid value does not replace the active policies.

**Scale/Scope**: about 10 source files in 2 packages, additions to 6 existing test files, 2 docs, and 2 changelogs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template, so it defines no gates. The plan uses the repository rules in AGENTS.md as gates:

| Gate | Status |
|---|---|
| No backward compatibility until required | Pass. A new optional field. No alias and no migration. |
| Remove means remove | Pass. Nothing is made optional in place of a removal. |
| Tests prove a property | Pass. The checks assert "never selected" across all modes with generated pools and a fixed seed, including the case where every other credential is blocked or past its cap. |
| Reuse existing patterns | Pass. Reused parts: `forCredential` matching, the `discover.ts` field allow-list, `AccountPolicies.replace`, `MissingApiKeyError`, the `credentials.onDisabled` → `emitNotice` bridge, and the `refresher.refresh` single-flight refresh. |
| No over-defensive code or ceremony | Pass. No new persisted state and no deduplication set. The pin change makes the warning show once (R3). |
| Changelog and docs updated | Pass. `packages/ai/CHANGELOG.md`, `packages/coding-agent/CHANGELOG.md`, `docs/settings.md`, `docs/auth-broker-gateway.md`, and the "Per-provider account routing" entry in `UPSTREAM_DIVERGENCES.md`. |
| New config default appended to `~/.omp/agent/config.yml` | N/A. `disabled` is a field inside list entries. It is not a top-level setting, and `auth.accountPolicies` already has its default. |

**Post-design re-check**: Pass. The design adds one predicate (`isDisabled`), one selector query (`disabledLabels`), one listener subscription (`sessions.onAccountDisabled`), one shared label helper, and one error builder. It adds no module.

## Project Structure

### Documentation (this feature)

```text
specs/011-account-disable/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── disable-config.md
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit.tasks output
```

### Source Code (repository root)

```text
packages/ai/src/
├── auth/
│   ├── types.ts          # AuthAccountPolicy.disabled; SessionsApi.onAccountDisabled + event type
│   ├── policy.ts         # boolean validation (V1); isDisabled()
│   ├── select.ts         # filter in resolveOAuth/selectApiKey/selectByType/preview; refresh disabled tokens;
│   │                     # strict E2 (resolveOAuth + #backToStrictAccount); explicit-pin W1 callback; disabledLabels()
│   ├── cascade.ts        # E3 at the end of #resolve and in the restricted-pool branch
│   ├── rotation.ts       # disabled credentials are not siblings
│   └── health.ts         # fallback health check skips disabled siblings
├── auth-broker/discover.ts  # allow-list + copy `disabled`
└── auth-storage.ts       # pass the callback; routing.weights skips disabled keys

packages/coding-agent/src/
├── sdk.ts                # sessions.onAccountDisabled → own session only → session.emitNotice("warning", W1, "auth")
├── session/credential-disabled-notice.ts  # W1 formatter
└── cli/usage-cli.ts      # `disabled` policy marker; routing line counts enabled credentials

packages/ai/test/auth-storage-routing-modes.test.ts
packages/ai/test/auth-broker-config-discovery.test.ts
packages/ai/test/auth-storage-session-restriction.test.ts
packages/coding-agent/test/usage-cli.test.ts
packages/coding-agent/test/auth-broker-live-settings.test.ts
packages/coding-agent/test/sdk-credential-disabled-bridge.test.ts
docs/settings.md, docs/auth-broker-gateway.md
packages/ai/CHANGELOG.md, packages/coding-agent/CHANGELOG.md, UPSTREAM_DIVERGENCES.md
```

**Structure Decision**: The work stays in the existing `ai` and `coding-agent` packages, with no new source module. The filter sits in the 4 list builders in `select.ts` (R1), and not in `routing.ts`. The `routing.ts` checks only sort a candidate last, and an over-cap account is still a fallback.

## Delivery Order

1. Type, parsing, validation, and `isDisabled` (R7). These block everything else.
2. The filter in the 4 list builders, plus the sibling and health checks (US1, P1). Then the refresh of disabled tokens (R2).
3. Strict E2, the explicit-pin warning W1 with its SDK bridge, and E3 in the cascade (US2).
4. `omp usage` marker and routing gate (US3).
5. Docs, changelogs, and the divergence entry.

## Complexity Tracking

No gate violations.
