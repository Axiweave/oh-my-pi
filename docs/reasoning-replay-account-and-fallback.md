# Reasoning and compaction replay across account changes and model fallback

This document describes how omp sends stored reasoning blocks and compaction blocks again after two events:

1. The session changes to a different account of the same provider.
2. Retry recovery falls back to a different model or provider.

"Replay" means that omp sends earlier assistant turns again as input. The stored session never changes. Only the request body changes.

## 1. What changes the account

The routing mode selects the account for a new conversation. A running session keeps a pin on the account it used last. `auth.routing.<provider>.stays` controls when the pin wins: `auto`, `session`, `turn`, `off`, or `strict`. See [auth-broker-gateway.md](./auth-broker-gateway.md) ("stays mode") for the full rules.

The account can change at these points:

| Trigger                                                                                                 | Where                                                                                                                          | Notes                                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| A new selection under the stays mode (cold pin, `turn`, `off`, reserve or spent allowance under `auto`) | `packages/ai/src/auth/affinity.ts`, `auth/select.ts`                                                                           | Starts before a request. An explicit user pin never moves because of routing. |
| Auth retry inside one request: force-refresh the same account, then rotate to a sibling                 | `packages/ai/src/stream.ts:1312-1364` (`resolveNextAuthRetryKey`), `packages/ai/src/auth-retry.ts:371-488` (`withOAuthAccess`) | A 401 rotates after one refresh. A usage limit rotates directly.              |
| Usage-limit recovery between attempts of a turn                                                         | `packages/coding-agent/src/session/turn-recovery.ts:2714-2753`, `:2831-2836` (`limits.rotate`)                                 | Sets `switchedCredential` and retries at once.                                |
| Account-policy denial                                                                                   | `turn-recovery.ts:2824`, `session-advisors.ts:2137`                                                                            | Rotates to a sibling account.                                                 |

`stays: strict` stops all of these moves. The session stays on its account. If that account is gone or disabled, requests fail. `sessions.restrict` limits a session to an account pool.

### How omp records the account on a turn

`stream.ts:1249-1252` and `:1282` write the `credentialId` of the stored account on every assistant event and on the final message (`AssistantMessage.credentialId`, `packages/ai/src/types.ts:1287`). This includes the account that an auth retry selected. omp writes no account on user messages. This includes the compaction summary message.

## 2. Account change, same model

### Anthropic thinking and `redacted_thinking`

`packages/ai/src/providers/transform-messages.ts:952-958`, `:1023`:

- The target must be a signing Anthropic endpoint (`compat.signingEndpoint`).
- If the turn has a `credentialId`, the request has a `credentialId`, and the two are different, omp drops all `thinking` and `redactedThinking` blocks of that turn. Text and tool calls stay.
- This rule has no exemption for the latest assistant turn.
- If either ID is unknown (imported or older sessions), omp sends the blocks unchanged.
- Test: `packages/ai/test/anthropic-prefill.test.ts:124`.

The latest assistant turn is a known risk. Anthropic requires the latest assistant run to be byte-for-byte unchanged (`transform-messages.ts:988-989`, `:1042-1044`). The run includes all assistant messages after the last real user message, for example a tool loop. If the account changes in the middle of a tool loop, omp sends that run without its thinking.

- If Anthropic accepts the run without thinking, the request succeeds.
- If Anthropic rejects it with `latest assistant message cannot be modified`, the retry at `anthropic.ts:3661-3704` does not help. That retry reads thinking keys from the request body that omp already stripped (`latestAssistantTurnThinkingKeys`, `anthropic.ts:2045`). It finds no keys, so it skips.
- If Anthropic rejects it because a tool-use continuation with thinking enabled must start with a `thinking` or `redacted_thinking` block, the request fails. No code in `packages/ai` or `packages/coding-agent` matches this error, so no retry runs. This outcome comes from the Anthropic API contract as recalled. It was not observed here.
- The signature retries (`anthropic.ts:3705-3779`) do not help in either rejection case, because the run has no signatures left.

This document does not verify which of the three Anthropic responses happens. One possible fix: exempt the latest surviving assistant run at `transform-messages.ts:1023`. This fix helps only with the `cannot be modified` rejection: the immutable-thinking retry can then find the keys and drop exactly those blocks. It does not help with the "must start with a thinking block" rejection. The unsigned-demotion rung converts only unsigned thinking, and the drop rungs remove thinking, which causes that same rejection.

### Anthropic compaction blocks

`packages/ai/src/providers/anthropic.ts:1728-1755`:

- omp sends a stored summary as a native `compaction` block only if both checks pass:
   - Payload check (`anthropic.ts:1732`): `payload.provider === model.provider`, and the block has a `signature` or legacy `encrypted_content`. This check uses the provider only. It does not check which model or account produced the block.
   - Target check (`anthropic.ts:5580-5582`, `:5614`, used at `:6053-6056` and `:6160-6164`): the target must support server compaction (`supportsAnthropicCompaction`, `anthropic-compaction.ts:7-8`, `:36-37`). This needs `compat.supportsServerCompaction` on the target model and a supported deployment. The catalog sets the flag for first-party Opus and Sonnet 4.6+, Haiku 5.5, and Fable and Mythos 5+ (`packages/catalog/src/rules/classes/anthropic.kdl:168-194`). Bedrock has a narrower list (`rules/providers/amazon-bedrock.kdl:70-93`). Haiku 3.5 does not have the flag.
- If the target check fails, omp sends the summary as text.
- The payload is on the harness's user-role summary message (`anthropic.ts:6055-6056`). That message has no `credentialId` (see section 1). An account check therefore needs a stored account first. The fix must copy the `credentialId` of the producing turn onto the compaction payload when omp stores the summary.
- The signature retries skip compaction errors: `isInvalidThinkingSignatureError` returns false for messages that contain `compaction_*` (`anthropic.ts:1991`).

### OpenAI reasoning items (`encrypted_content`)

- omp stores a Responses reasoning item as JSON in `thinkingSignature`. `include: ["reasoning.encrypted_content"]` is always set for Codex (`openai-codex/request-transformer.ts:548`).
- Codex sends native history items only if the API, provider, and model id are the same (`openai-codex-responses.ts:5032-5035`). The provider check is in `utils.ts:668-678`.
- OpenAI Responses and Azure use `buildResponsesInput` (`openai-shared.ts:2110`). Native assistant items need the same API, provider, and model id (`:2235-2242`). They also need `nativeHistory.replay`, or a cold-replayable turn (`:2267-2271`). Azure always sets `replay: true` (`azure-openai-responses.ts:379`). OpenAI Responses sets it from `nativeHistoryReplayWarmed` (`openai-responses.ts:1611`). That flag is per provider session: it becomes true after a successful request (`:1310`) and false when the session closes (`:477`). It does not depend on the model or the account. On a cold session, omp also leaves out the signatures of the reasoning blocks (`includeThinkingSignatures`, `:1626`).
- No check uses `credentialId` or `accountId`. After an account change, omp sends the encrypted reasoning from the old account unchanged.
- The Codex WebSocket session key includes the account: `account:${accountId}:…` (`openai-codex-responses.ts:3460-3474`). A new account therefore opens a new socket and does not reuse the incremental append state of the old account. The request still carries the full history, with the old encrypted reasoning.
- Recovery: `StaleResponsesItem` (`error/flags.ts:297-298`, `:701-702`) matches `Item with id … not found` and stale `previous_response` errors. A match resets the Responses provider session (`turn-recovery.ts:2707-2709`). No pattern matches a rejection of `encrypted_content`.

### OpenAI compaction items (`compaction`, `compaction_summary`)

Both converters read these items from the user-role summary message, and both check the provider only:

- Codex: `openai-codex-responses.ts:4990-5017`. No other condition.
- OpenAI Responses and Azure: `openai-shared.ts:2183-2205`. The items are read only when `options.nativeHistory` is set, but both callers always set it (`openai-responses.ts:1622`, `azure-openai-responses.ts:379`). Compaction items replay even on a cold session (`:2186-2193`).

No check uses the model or the account.

### Summary: account change

| Block                                      | Account check                                                                  | After an account change                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Anthropic `thinking` / `redacted_thinking` | Yes (`credentialId`)                                                           | Dropped, also from the latest run. Anthropic acceptance of a stripped latest run is not verified. |
| Anthropic `compaction`                     | No (provider, and target support)                                              | Sent unchanged if the target supports server compaction. No retry for signature errors.           |
| OpenAI reasoning `encrypted_content`       | No (API, provider, model; OpenAI Responses also needs a warm provider session) | Sent unchanged. The Codex WebSocket session changes with the account.                             |
| OpenAI `compaction` items                  | No (provider only)                                                             | Sent unchanged.                                                                                   |

## 3. Model fallback

### Candidate selection

`packages/coding-agent/src/session/turn-recovery.ts:2255-2383` (`#tryRetryModelFallback`) skips a candidate in these cases:

- The latest assistant turn is Anthropic, the candidate is on the same Anthropic provider, the model is different, and the turn has signed `thinking` or `redacted_thinking` (`:2312-2325`). Anthropic signatures are bound to the model, and the latest turn must stay byte-identical. A same-provider switch cannot meet both rules. A candidate on a different provider is allowed, because the message transform can convert the foreign thinking.
   - Exception: Anthropic fallback-credit redemption after a refusal (`:2306-2311`). The server checks the thinking across the boundary itself.
- The context window of the candidate cannot hold the conversation (`contextFitsModel`). omp skips the candidate. It does not compact first.
- The candidate is blocked by cyber mode, has no API key, is outside the account pool, or is above the effort ceiling.

omp does not fall back at all if the failed turn already streamed output that is not safe to replay (`#hasReplayUnsafeOutput`).

### Reasoning blocks after the switch

`transform-messages.ts:894-1161`. "Same model" means the same provider, API, and model id (`isSameModelTurn`, `:522-527`).

| Source turn → target                                                                                      | What omp sends                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same model (for example, after omp restores the primary)                                                  | Native, with the signature. The Anthropic account check from section 2 still applies.                                                                 |
| Anthropic → Anthropic, same deployment, different model                                                   | Signature kept. Anthropic does its own model-compatibility check.                                                                                     |
| Anthropic signed → a different provider or deployment                                                     | Signature removed. The thinking goes to the unsigned-thinking rule of the target, or becomes demoted text. `redacted_thinking` is dropped.            |
| A different provider → Anthropic, latest turn                                                             | The foreign signature is removed, so the session does not get stuck on `400 Invalid signature`.                                                       |
| Any → OpenAI Responses/Codex, different model                                                             | omp cannot send the encrypted reasoning. The thinking becomes text through `renderDemotedThinking(...)`, in the thinking dialect of the target model. |
| Same weights on a different host (`carriesReasoning`)                                                     | Plain reasoning in a native slot, without the item id or signature.                                                                                   |
| A target that reads foreign thinking (Z.AI format, or Anthropic-compatible with `replayUnsignedThinking`) | Native unsigned thinking (`targetReadsForeignThinking`, `:535-544`).                                                                                  |
| Empty thinking with only a signature (for example, an OpenAI encrypted blob)                              | Dropped.                                                                                                                                              |

Other blocks:

- omp removes `thoughtSignature` from tool calls when the model is different.
- Anthropic server-tool blocks go only to the same provider.
- `fallback` boundary markers (Anthropic server-side fallback) go only to Anthropic targets.

Codex native history items go only to the same API, provider, and model id. For any other target, omp builds the request again from the content blocks.

### Compaction blocks after the switch

| Compaction                                       | Native replay condition                                                          | Otherwise                |
| ------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------ |
| Anthropic `compaction`                           | The same provider, and the target model and deployment support server compaction | The summary goes as text |
| OpenAI `compaction` / `compaction_summary` items | The same provider                                                                | The summary goes as text |

The compaction entry always stores the summary text. A change of provider loses only the native form, not the information.

### After the fallback

- The turns of the fallback model are foreign to the primary. If omp restores the primary (`maybeRestoreRetryFallbackPrimary`, policy `cooldown-expiry`), those turns follow the table above. The older turns of the primary go back to native replay.
- If Anthropic still rejects a signature, the retries in `anthropic.ts:3661-3779` run once each, before the first token:
   1. `latest assistant message cannot be modified`: omp drops the thinking of the latest run and stores the block keys in `prefixDroppedThinkingBlocks`, so later requests send the same prefix.
   2. `Invalid signature`: omp converts unsigned thinking to text and retries.
   3. The same error again: omp drops all replayed thinking (`thinkingReplayDisabled`) and retries.

## 4. Known gaps

1. **Anthropic latest run after an account change.** `transform-messages.ts:1023` strips the latest run, and no retry can restore it (section 2). Recovery depends on Anthropic accepting the stripped run. This is not verified. A rejection that requires a leading thinking block has no retry at all.
2. **Anthropic compaction has no account check.** The summary message stores no `credentialId`. A fix must first copy the account of the producing turn onto the payload.
3. **Compaction across models of the same provider.** The payload checks use the provider only. They do not check which model produced the block.
   - OpenAI: a fallback from `openai-codex/gpt-A` to `openai-codex/gpt-B` sends the native compaction items.
   - Anthropic: a fallback sends the native block only if the target model has `supportsServerCompaction`. Opus 4.6+ to Sonnet 4.6+ sends it, because both have the flag. A fallback to Haiku 3.5 sends text.
   - If the provider binds the block to the model that produced it, the request fails, and no retry covers it.
4. **OpenAI has no account check.** After an account change on the same OpenAI model, omp sends the encrypted reasoning and compaction items from the old account. No error pattern catches an `encrypted_content` rejection.
