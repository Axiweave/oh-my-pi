import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { getOAuthApiKey, getOAuthProvider } from "../registry/oauth";
import type { OAuthCredentials, OAuthProvider } from "../registry/oauth/types";
import type { Provider } from "../types";
import type { CredentialRankingContext, CredentialRankingStrategy, PlanGate, UsageReport } from "../usage";
import { resolveUsedFraction } from "../usage";
import type { RankingStrategyResolver } from "../usage/registry";
import { credentialPinHash, type SessionAffinity, type StrictAccount } from "./affinity";
import {
	AUTH_BLOCK_SCOPE,
	credentialBlockScopesForRequest,
	DEFAULT_BLOCK_MS,
	providerTypeKey,
	type CredentialBlocks,
} from "./blocks";
import { type AccountPolicies, capFor } from "./policy";
import { authCredentialEquals, type CredentialPool } from "./pool";
import {
	planPriority,
	type ApiKeySelection,
	type CredentialSelection,
	type OAuthCandidate,
	type OAuthSelection,
	type RankedApiKeyCandidate,
	type RankedOAuthCandidate,
	type UsageCandidate,
	type UsageRankedCandidate,
	type UsageRankingResult,
} from "./rank";
import { mergeRefreshedCredential, OAUTH_REFRESH_SKEW_MS, type OAuthRefresher } from "./refresh";
import { applySink, chargeKept, isRoutable, orderRankedCandidates, type WeightRound } from "./routing";
import { resolveCredentialIdentityKey } from "./sqlite-credential-store";
import type { AuthCredentialStore } from "./store";
import {
	type ApiKeyCredential,
	type AuthApiKeyOptions,
	type AuthCredential,
	type OAuthCredential,
	oauthAccountKey,
	type RoutingMode,
	type RoutingPreview,
	type StoredAuthCredential,
} from "./types";
import type { UsageService } from "./usage";
import {
	currentReserveLimits,
	isOverCaps,
	isUsageLimitReached,
	normalizeUsageFraction,
	remainingUsageFraction,
	scopedUsageLimits,
	usageReportMatchesCredential,
	usageResetAtMs,
	windowRequiredDrain,
} from "./usage-report";

/** Pace of an account whose weekly window is unknown: a full week of quota left. */
const UNKNOWN_PACE = 1 / 168;

/** Inputs every ranked candidate of one selection shares. */
type RankBasis = {
	provider: string;
	providerKey: string;
	mode: RoutingMode;
	/** Pool row ids by pool index, captured when the selection started. */
	credentialIds: readonly number[];
	strategy?: CredentialRankingStrategy;
	planGate?: PlanGate;
	defaultReservePct?: number;
	rankingContext: CredentialRankingContext;
	blockScope?: string;
	/** Scopes a block may live under for this request; reads honour all of them. */
	blockScopes?: readonly string[];
};

/** A ranking pass over `credentials` in `order`. */
type RankArgs<T extends AuthCredential> = RankBasis & {
	order: number[];
	credentials: CredentialSelection<T>[];
	options?: AuthApiKeyOptions;
};

/** Temporary block after a transient OAuth refresh failure. */
export const OAUTH_REFRESH_FAILURE_BACKOFF_MS = 5 * 60 * 1000;

/** A strict session's account was removed, for example after its sign-in failed (FR-013). */
function signedOutError(provider: string, sessionId: string, account: StrictAccount): Error {
	return new AIError.MissingApiKeyError(
		provider,
		`No API key for provider: ${provider} (session ${sessionId} stays on ${account.label} under \`stays: strict\`, and that account was signed out. Sign in to it again, start a new session, or pin an account to this session.)`,
	);
}

/** OAuth bearer and credential chosen for a request, with its durable row id when available. */
export type OAuthResolutionResult = { apiKey: string; credential: OAuthCredential; credentialId?: number };

/** Options for CredentialSelector.tryOAuth when evaluating one OAuth credential. */
export type TryOAuthOptions = {
	checkUsage: boolean;
	allowBlocked: boolean;
	prefetchedUsage?: UsageReport | null;
	usagePrechecked?: boolean;
	planGate?: PlanGate;
	enforcePlanRequirement?: boolean;
	strategy?: CredentialRankingStrategy;
	rankingContext?: CredentialRankingContext;
	blockScope?: string;
	blockScopes?: readonly string[];
	/** When false, a definitive failure of THIS credential returns undefined instead of falling back to the ranked/round-robin selector (target-only resolution). */
	allowFallback?: boolean;
	/** Receives a non-definitive refresh failure that left this credential unusable; the caller filters for retryable ones. */
	onTransientRefreshFailure?: (error: unknown) => void;
	/** False for a key check: the session pin is recorded as unserved, and the fallback `resolveOAuth` gets it too (see its `advance`). */
	advance?: boolean;
};

/** Services consulted by CredentialSelector for policy, usage, blocks, refresh, and session affinity. */
export interface CredentialSelectorDeps {
	store: AuthCredentialStore;
	pool: CredentialPool;
	policies: AccountPolicies;
	blocks: CredentialBlocks;
	affinity: SessionAffinity;
	usage: UsageService;
	refresher: OAuthRefresher;
	strategies: RankingStrategyResolver;
}

/** Picks which stored credential serves a request: ordering, usage ranking, OAuth refresh ladder. */
export class CredentialSelector {
	/** Tracks next credential index per provider:type key for round-robin distribution (non-session use). */
	#providerRoundRobinIndex: Map<string, number> = new Map();
	/** `weight` routing rounds per provider:type key. */
	#weightRounds: Map<string, WeightRound> = new Map();
	/** OAuth credential ids that already served their learn-once request, per provider. */
	#learnTried: Map<string, Set<number>> = new Map();
	/** Sunk credential ids per provider, in refusal order. */
	#sinkLists: Map<string, number[]> = new Map();
	#deps: CredentialSelectorDeps;

	constructor(deps: CredentialSelectorDeps) {
		this.#deps = deps;
	}

	/** Restart round-robin, weight, learn-once, and sink state after a provider's credential set changes. */
	resetRoundRobin(provider: string): void {
		for (const state of [this.#providerRoundRobinIndex, this.#weightRounds]) {
			for (const key of state.keys()) {
				if (key.startsWith(`${provider}:`)) state.delete(key);
			}
		}
		this.#learnTried.delete(provider);
		this.#sinkLists.delete(provider);
	}

	/** Sink `credentialId` behind every credential not refused since; no-op unless `sink` routing is on. */
	noteRateLimited(provider: string, credentialId: number): void {
		if (!this.#deps.policies.routingFor(provider).sink) return;
		const sunk = (this.#sinkLists.get(provider) ?? []).filter(id => id !== credentialId);
		this.#sinkLists.set(provider, [...sunk, credentialId]);
	}

	/** See {@link RoutingApi.strict}. */
	strict(provider: string, sessionId: string | undefined): boolean {
		return (
			this.#deps.policies.routingFor(provider).stays === "strict" &&
			this.#deps.affinity.get(provider, sessionId)?.explicit !== true
		);
	}

	/** Remember the account a strict session stays on; forget it once the session is not strict. */
	#holdStrict(
		provider: string,
		sessionId: string,
		credentialId: number | undefined,
		credential: OAuthCredential,
	): void {
		const affinity = this.#deps.affinity;
		const held = affinity.strictAccount(provider, sessionId);
		if (credentialId === undefined || !this.strict(provider, sessionId)) {
			if (held) affinity.holdStrict(provider, sessionId, undefined);
			return;
		}
		const identityKey = resolveCredentialIdentityKey(provider, credential) ?? undefined;
		const label = credential.email ?? oauthAccountKey(credential) ?? "its account";
		if (
			held?.credentialId === credentialId &&
			held.identityKey === identityKey &&
			held.label === label &&
			held.goneFrom === undefined
		) {
			return;
		}
		affinity.holdStrict(provider, sessionId, { credentialId, identityKey, label });
	}

	/**
	 * `strict`: pin a session whose pin was dropped back to its account. While that account is
	 * gone, throw, until it signs in again or the provider's credential ids change. A session
	 * that is no longer strict drops its account.
	 */
	#backToStrictAccount(
		provider: string,
		sessionId: string,
		credentials: readonly { credential: OAuthCredential; index: number }[],
		recordAffinity: boolean,
		advance: boolean,
	): void {
		const affinity = this.#deps.affinity;
		if (affinity.get(provider, sessionId)?.type === "oauth") return;
		const held = affinity.strictAccount(provider, sessionId);
		if (!held) return;
		if (!this.strict(provider, sessionId)) {
			affinity.holdStrict(provider, sessionId, undefined);
			return;
		}
		const entries = this.#deps.pool.entries(provider);
		const again = credentials.find(
			({ credential, index }) =>
				entries[index]?.id === held.credentialId ||
				(held.identityKey !== undefined &&
					resolveCredentialIdentityKey(provider, credential) === held.identityKey) ||
				(held.pinHash !== undefined && credentialPinHash(provider, credential) === held.pinHash),
		);
		if (again) {
			if (held.goneFrom !== undefined) affinity.holdStrict(provider, sessionId, { ...held, goneFrom: undefined });
			// A key check keeps the pin unserved, as its own pin would be.
			if (recordAffinity) affinity.record(provider, sessionId, "oauth", again.index, undefined, false, advance);
			return;
		}
		const ids = affinity.credentialIds(provider);
		if (held.goneFrom !== undefined && held.goneFrom !== ids) {
			affinity.holdStrict(provider, sessionId, undefined);
			return;
		}
		if (held.goneFrom === undefined) affinity.holdStrict(provider, sessionId, { ...held, goneFrom: ids });
		throw signedOutError(provider, sessionId, held);
	}

	/**
	 * Returns next index in round-robin sequence for load distribution.
	 * Increments stored counter and wraps at total.
	 */
	#getNextRoundRobinIndex(providerKey: string, total: number): number {
		if (total <= 1) return 0;
		const current = this.#providerRoundRobinIndex.get(providerKey) ?? -1;
		const next = (current + 1) % total;
		this.#providerRoundRobinIndex.set(providerKey, next);
		return next;
	}

	/**
	 * The strategy's plan gate for `context`. `order` moves on only after a failed plan check,
	 * so there an account whose plan is unknown counts as eligible.
	 */
	#planGate(
		provider: string,
		strategy: CredentialRankingStrategy | undefined,
		context: CredentialRankingContext,
	): PlanGate | undefined {
		const gate = strategy?.planGate?.(context);
		if (gate === undefined || this.#deps.policies.routingFor(provider).mode !== "order") return gate;
		return report => gate(report) !== false;
	}

	/**
	 * FNV-1a hash for deterministic session-to-credential mapping.
	 * Ensures the same session always starts with the same credential.
	 */
	#getHashedIndex(sessionId: string, total: number): number {
		if (total <= 1) return 0;
		return Bun.hash.xxHash32(sessionId) % total;
	}

	/**
	 * Returns credential indices in priority order for selection.
	 * With sessionId: starts from hashed index (consistent per session).
	 * Without sessionId: starts from round-robin index (load balancing).
	 * Order wraps around so all credentials are tried if earlier ones are blocked.
	 */
	#getCredentialOrder(providerKey: string, sessionId: string | undefined, total: number): number[] {
		if (total <= 1) return [0];
		const start = sessionId
			? this.#getHashedIndex(sessionId, total)
			: this.#getNextRoundRobinIndex(providerKey, total);
		const order: number[] = [];
		for (let i = 0; i < total; i++) {
			order.push((start + i) % total);
		}
		return order;
	}

	/**
	 * Selects a credential of the specified type for a provider.
	 * Returns both the credential and its index in the original array (for updates/removal).
	 * Uses deterministic hashing for session stickiness and skips blocked credentials when possible.
	 */
	selectByType<T extends AuthCredential["type"]>(
		provider: string,
		type: T,
		sessionId?: string,
		filter?: (credential: AuthCredential) => boolean,
	): { credential: Extract<AuthCredential, { type: T }>; index: number } | undefined {
		const credentials = this.#deps.pool
			.credentials(provider)
			.map((credential, index) => ({ credential, index }))
			.filter(
				(
					entry,
				): entry is {
					credential: Extract<AuthCredential, { type: T }>;
					index: number;
				} => {
					if (entry.credential.type !== type) return false;
					return filter?.(entry.credential) ?? true;
				},
			);

		if (credentials.length === 0) return undefined;
		if (credentials.length === 1) return credentials[0];

		const providerKey = providerTypeKey(provider, type);
		// Outside `smart` the cursor is the `rotate` turn, which a peek must not spend.
		const order =
			this.#deps.policies.routingFor(provider).mode === "smart"
				? this.#getCredentialOrder(providerKey, sessionId, credentials.length)
				: credentials.map((_credential, index) => index);
		const fallback = credentials[order[0]];

		for (const idx of order) {
			const candidate = credentials[idx];
			if (!this.#deps.blocks.isBlocked(provider, providerKey, candidate.index)) {
				return candidate;
			}
		}

		return fallback;
	}

	async #rankApiKeySelections(args: RankArgs<ApiKeyCredential>): Promise<RankedApiKeyCandidate[]> {
		const nowMs = Date.now();
		const ranked: RankedApiKeyCandidate[] = [];
		const usageTimeout = Math.max(5000, this.#deps.usage.requestTimeoutMs * 1.5);
		const usagePromise: Promise<Array<UsageRankingResult<ApiKeyCredential> | null>> = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#deps.blocks.blockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				if (blockedUntil !== undefined) {
					return { selection, usage: null, usageChecked: false, blockedUntil };
				}
				const usage = await this.#deps.usage.report(args.provider, selection.credential, {
					...args.options,
					timeoutMs: this.#deps.usage.requestTimeoutMs,
				});
				return {
					selection,
					usage,
					usageChecked: true,
					blockedUntil: undefined,
				};
			}),
		);
		const timeoutSignal = Promise.withResolvers<null>();
		const timer = setTimeout(() => timeoutSignal.resolve(null), usageTimeout);
		timer.unref?.();
		const usageResults = await Promise.race([usagePromise, timeoutSignal.promise]).then(result => {
			clearTimeout(timer);
			if (result) return result;
			return args.order.map(idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#deps.blocks.blockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				return { selection, usage: null, usageChecked: false, blockedUntil };
			});
		});

		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (result) ranked.push(this.#rankedCandidate(args, result, orderPos, nowMs));
		}
		return ranked;
	}

	/** `advance: false` (a key check, not a request) picks the same key but leaves rotate, weight, and sink state alone. */
	async selectApiKey(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		filter?: (credential: ApiKeyCredential) => boolean,
		advance = true,
	): Promise<ApiKeySelection | undefined> {
		const credentials = this.#deps.pool
			.credentials(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is ApiKeySelection => {
				if (entry.credential.type !== "api_key") return false;
				return filter?.(entry.credential) ?? true;
			});

		if (credentials.length === 0) return undefined;
		this.#deps.policies.validateUsageCapability(provider, this.#deps.usage.canFetchOAuthUsage(provider));
		if (credentials.length === 1) return credentials[0];

		const providerKey = providerTypeKey(provider, "api_key");
		const { mode } = this.#deps.policies.routingFor(provider);
		// Every mode but smart ranks the whole pool from sign-in order, with or without a usage strategy.
		const order =
			mode === "smart"
				? this.#getCredentialOrder(providerKey, sessionId, credentials.length)
				: credentials.map((_credential, index) => index);
		const fallback = credentials[order[0]];
		const strategy = this.#deps.strategies(provider);
		if (!strategy && mode === "smart") {
			// `sink` still moves refused keys behind the rest.
			const credentialIds = this.#deps.pool.entries(provider).map(entry => entry.id);
			const unblocked = order
				.map(idx => credentials[idx]!)
				.filter(candidate => !this.#deps.blocks.isBlocked(provider, providerKey, candidate.index))
				.map(selection => ({ selection, credentialId: credentialIds[selection.index] }));
			const sunk = this.#sunk(
				provider,
				unblocked.map(candidate => candidate.credentialId),
				!advance,
			);
			return applySink(unblocked, sunk)[0]?.selection ?? fallback;
		}

		const rankingContext: CredentialRankingContext = {
			modelId: options?.modelId,
		};
		const blockScope = strategy?.blockScope?.(rankingContext);
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const hasKeyPolicy = credentials.some(
			({ credential }) => this.#deps.policies.forCredential(provider, credential) !== undefined,
		);
		const ranked = await this.#rankApiKeySelections({
			providerKey,
			provider,
			mode,
			credentialIds: this.#deps.pool.entries(provider).map(entry => entry.id),
			order,
			credentials,
			options,
			strategy,
			defaultReservePct:
				hasKeyPolicy && (strategy !== undefined || this.#deps.usage.canFetchOAuthUsage(provider))
					? this.#deps.policies.defaultReservePct
					: undefined,
			rankingContext,
			blockScope,
			blockScopes,
		});
		// No await between ordering and the advance, so concurrent selections each get their own turn.
		const candidates = this.#orderRanked(provider, providerKey, ranked, false, !advance);
		// API keys carry no session pin, so `rotate` advances on every selection.
		if (advance && mode === "rotate") this.#getNextRoundRobinIndex(providerKey, credentials.length);
		return candidates[0]?.selection ?? fallback;
	}

	async #rankOAuthSelections(args: RankArgs<OAuthCredential>): Promise<RankedOAuthCandidate[]> {
		const nowMs = Date.now();
		const ranked: RankedOAuthCandidate[] = [];
		// Pre-fetch usage reports in parallel for non-blocked credentials.
		// Wrap with a timeout so slow/429'd fetches don't indefinitely block
		// credential selection — better to pick a credential without usage data
		// than to hang the agent waiting for rate-limited usage endpoints.
		const usageTimeout = Math.max(5000, this.#deps.usage.requestTimeoutMs * 1.5);
		const usagePromise = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				let blockedUntil = this.#deps.blocks.blockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				let usage: UsageReport | null = null;
				let usageChecked = false;
				if (
					blockedUntil !== undefined &&
					this.#deps.blocks.canHeal(
						args.provider,
						args.providerKey,
						selection.index,
						args.blockScopes ?? args.blockScope,
					)
				) {
					usage = await this.#deps.usage.report(args.provider, selection.credential, {
						...args.options,
						timeoutMs: this.#deps.usage.requestTimeoutMs,
					});
					usageChecked = true;
					blockedUntil = this.#deps.blocks.blockedUntil(
						args.provider,
						args.providerKey,
						selection.index,
						args.blockScopes ?? args.blockScope,
					);
				}
				if (blockedUntil !== undefined) return { selection, usage, usageChecked, blockedUntil };
				if (!usageChecked) {
					usage = await this.#deps.usage.report(args.provider, selection.credential, {
						...args.options,
						timeoutMs: this.#deps.usage.requestTimeoutMs,
					});
					usageChecked = true;
				}
				return {
					selection,
					usage,
					usageChecked,
					blockedUntil: undefined as number | undefined,
				};
			}),
		);
		const timeoutSignal = Promise.withResolvers<null>();
		// `Bun.sleep` keeps the event loop alive even after Promise.race resolves,
		// which leaks a 7.5–15s timer per credential-selection call. Use an unref'd
		// timer so the timeout doesn't pin the process and clear it on the happy
		// path so memory drops immediately.
		const timer = setTimeout(() => timeoutSignal.resolve(null), usageTimeout);
		timer.unref?.();
		const usageResults = await Promise.race([usagePromise, timeoutSignal.promise]).then(result => {
			clearTimeout(timer);
			return (
				result ??
				args.order.map(idx => {
					const selection = args.credentials[idx];
					return selection
						? {
								selection,
								usage: null,
								usageChecked: false,
								blockedUntil: undefined,
							}
						: null;
				})
			);
		});

		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (result) ranked.push(this.#rankedCandidate(args, result, orderPos, nowMs));
		}
		return ranked;
	}

	/** Ranking metrics for one fetched candidate. A reached usage limit blocks it, persisted unless `preview`. */
	#rankedCandidate<T extends AuthCredential>(
		basis: RankBasis,
		result: UsageRankingResult<T>,
		orderPos: number,
		nowMs: number,
		preview = false,
	): UsageRankedCandidate<T> {
		const { selection, usage, usageChecked } = result;
		const { provider, strategy, rankingContext } = basis;
		let { blockedUntil } = result;
		const scopedLimits = usage && strategy ? scopedUsageLimits(strategy, usage, rankingContext) : undefined;
		if (blockedUntil === undefined && scopedLimits && isUsageLimitReached(scopedLimits)) {
			const resetAtMs = usageResetAtMs(scopedLimits, nowMs);
			blockedUntil = resetAtMs ?? Date.now() + DEFAULT_BLOCK_MS;
			if (!preview) {
				this.#deps.blocks.mark(
					provider,
					basis.providerKey,
					selection.index,
					blockedUntil,
					basis.blockScope,
					resetAtMs !== undefined,
				);
			}
		}
		const windows = usage && strategy ? strategy.findWindowLimits(usage, rankingContext) : undefined;
		const primary = windows?.primary;
		const secondary = windows?.secondary;
		const limits = usage ? currentReserveLimits(strategy, usage, rankingContext, nowMs) : [];
		const usedFractions = limits
			.map(resolveUsedFraction)
			.filter((fraction): fraction is number => fraction !== undefined);
		const shareUsed = usedFractions.length === 0 ? undefined : Math.max(...usedFractions);
		const remainingFraction = shareUsed === undefined ? undefined : Math.max(0, 1 - shareUsed);
		const policy = this.#deps.policies.forCredential(provider, selection.credential);
		const cap = capFor(policy, basis.mode, basis.defaultReservePct);
		const secondaryRequiredDrain =
			strategy === undefined ? 0 : windowRequiredDrain(secondary, nowMs, strategy.windowDefaults.secondaryMs);
		return {
			selection,
			usage,
			usageChecked,
			credentialId: basis.credentialIds[selection.index],
			blocked: blockedUntil !== undefined,
			blockedUntil,
			inReserve: isOverCaps(limits, cap),
			reserveMeasured:
				remainingFraction !== undefined &&
				limits.some(limit => cap(limit.window?.id ?? limit.scope.windowId) !== undefined),
			accountPriority: policy?.priority === undefined || !Number.isFinite(policy.priority) ? 0 : policy.priority,
			allowanceSpent: remainingFraction === 0,
			usageMeasured:
				strategy === undefined ? remainingFraction !== undefined : primary !== undefined || secondary !== undefined,
			hasPriorityBoost:
				strategy?.hasPriorityBoost?.(primary, primary === undefined && secondary !== undefined, rankingContext) ??
				false,
			planPriority: planPriority(basis.planGate, usage),
			secondaryUsed: strategy ? normalizeUsageFraction(secondary) : 0,
			secondaryRequiredDrain,
			primaryUsed: strategy ? normalizeUsageFraction(primary) : 0,
			primaryRequiredDrain:
				strategy === undefined ? 0 : windowRequiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
			shareUsed: shareUsed ?? 0,
			pace: secondary === undefined ? UNKNOWN_PACE : secondaryRequiredDrain,
			orderPos,
		};
	}

	/** Learn once: OAuth credentials in `candidates` with no usage report that `usage`/`pace` has not served yet. */
	#learnable(provider: string, candidates: readonly UsageCandidate<AuthCredential>[]): Set<number> {
		const { mode } = this.#deps.policies.routingFor(provider);
		const learnable = new Set<number>();
		if ((mode !== "usage" && mode !== "pace") || !this.#deps.usage.canLearnFromHeaders(provider)) return learnable;
		const tried = this.#learnTried.get(provider);
		for (const { selection, usage, credentialId } of candidates) {
			// API keys never get a usage report, so learning one would only delay recent-token order.
			if (selection.credential.type !== "oauth" || usage !== null || credentialId === undefined) continue;
			if (!tried?.has(credentialId)) learnable.add(credentialId);
		}
		return learnable;
	}

	/** Learn once: the credential that served `resolved` has had its one learning request. */
	#noteServed(
		provider: string,
		candidates: readonly OAuthCandidate[],
		resolved: OAuthResolutionResult,
	): OAuthResolutionResult {
		const id = resolved.credentialId;
		const served = id === undefined ? undefined : candidates.find(candidate => candidate.credentialId === id);
		if (id !== undefined && served && this.#learnable(provider, [served]).has(id)) {
			const tried = this.#learnTried.get(provider);
			if (tried) tried.add(id);
			else this.#learnTried.set(provider, new Set([id]));
		}
		return resolved;
	}

	/**
	 * The `sink` list for `provider` (empty when sink is off). Once every routable credential
	 * (`routableIds`) is sunk, the list has no order left to give, so it is cleared.
	 */
	#sunk(provider: string, routableIds: readonly (number | undefined)[], preview: boolean): number[] {
		const sunk = (this.#deps.policies.routingFor(provider).sink && this.#sinkLists.get(provider)) || [];
		if (
			sunk.length === 0 ||
			routableIds.length === 0 ||
			routableIds.some(id => id === undefined || !sunk.includes(id))
		) {
			return sunk;
		}
		if (!preview) this.#sinkLists.delete(provider);
		return [];
	}

	/** Order `ranked` by `provider`'s routing mode. `preview` reads routing state without advancing it. */
	#orderRanked<C extends UsageRankedCandidate<AuthCredential>>(
		provider: string,
		providerKey: string,
		ranked: C[],
		planGated: boolean,
		preview = false,
	): C[] {
		const { mode } = this.#deps.policies.routingFor(provider);
		const learnable = this.#learnable(provider, ranked);
		const sunk = this.#sunk(
			provider,
			ranked.filter(candidate => isRoutable(candidate, planGated)).map(candidate => candidate.credentialId),
			preview,
		);
		const stored = this.#weightRounds.get(providerKey);
		const weightRound = stored && !preview ? stored : { cur: new Map(stored?.cur), total: stored?.total ?? 0 };
		// `last` names this ordering's pick only, so a kept pin never moves an older request's charge.
		weightRound.last = undefined;
		if (mode === "weight" && !preview) this.#weightRounds.set(providerKey, weightRound);
		const nowMs = Date.now();
		return orderRankedCandidates(mode, ranked, {
			planGated,
			rotateStart: ((this.#providerRoundRobinIndex.get(providerKey) ?? -1) + 1) % ranked.length,
			weightRound,
			weightOf: candidate =>
				this.#deps.policies.forCredential(provider, candidate.selection.credential)?.weight ?? 1,
			recentTokens: candidate =>
				candidate.credentialId === undefined
					? 0
					: this.#deps.usage.recentTokens(provider, candidate.credentialId, nowMs),
			learnable,
			sink: sunk,
		});
	}

	/** See {@link RoutingApi.preview}: ranks the OAuth pool (else the API keys) from `reports`. */
	preview(provider: string, reports: readonly UsageReport[]): RoutingPreview {
		const routing = this.#deps.policies.routingFor(provider);
		const pool = this.#deps.pool.credentials(provider).map((credential, index) => ({ credential, index }));
		const oauth = pool.filter(({ credential }) => credential.type === "oauth");
		const credentials = oauth.length > 0 ? oauth : pool.filter(({ credential }) => credential.type === "api_key");
		// One OAuth account beside API keys still serves first, so it is the next pick.
		if (pool.length < 2) return routing;
		const providerKey = providerTypeKey(provider, credentials[0]!.credential.type);
		const strategy = this.#deps.strategies(provider);
		const rankingContext: CredentialRankingContext = {};
		const blockScope = strategy?.blockScope?.(rankingContext);
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const hasPolicy = credentials.some(
			({ credential }) => this.#deps.policies.forCredential(provider, credential) !== undefined,
		);
		const basis: RankBasis = {
			provider,
			providerKey,
			mode: routing.mode,
			credentialIds: this.#deps.pool.entries(provider).map(entry => entry.id),
			strategy,
			planGate: this.#planGate(provider, strategy, rankingContext),
			defaultReservePct:
				hasPolicy && (strategy !== undefined || this.#deps.usage.canFetchOAuthUsage(provider))
					? this.#deps.policies.defaultReservePct
					: undefined,
			rankingContext,
			blockScope,
		};
		const nowMs = Date.now();
		const ranked = credentials.map((selection, orderPos) => {
			const { credential } = selection;
			// ponytail: API keys get no report here, so a key pool previews as unknown usage.
			const usage =
				credential.type === "oauth"
					? (reports.find(
							report => report.provider === provider && usageReportMatchesCredential(report, credential),
						) ?? null)
					: null;
			const blockedUntil = this.#deps.blocks.blockedUntil(provider, providerKey, selection.index, blockScopes);
			return this.#rankedCandidate(
				basis,
				{ selection, usage, usageChecked: usage !== null, blockedUntil },
				orderPos,
				nowMs,
				true,
			);
		});
		const next = this.#orderRanked(provider, providerKey, ranked, basis.planGate !== undefined, true)[0];
		// Without usage reports, `smart` picks by session hash or round robin, which a preview can't know.
		if (
			!next ||
			(routing.mode === "smart" && credentials.length > 1 && ranked.every(({ usage }) => usage === null))
		) {
			return routing;
		}
		const { credential } = next.selection;
		const label =
			credential.type === "oauth"
				? (credential.email ?? credential.accountId ?? credential.projectId ?? `cred ${next.credentialId}`)
				: `key …${credential.key.slice(-4)}`;
		const reason =
			credentials.length === 1
				? "only account"
				: {
						smart: "soonest reset",
						order: "first in order",
						rotate: "its turn",
						weight: "its share",
						usage: `least used: ${Math.round(next.shareUsed * 100)}%`,
						pace: `most to lose: ${(next.pace * 100).toFixed(1)}%/h`,
					}[routing.mode];
		return { ...routing, next: { label, reason } };
	}

	/**
	 * Resolves an OAuth credential, trying credentials in priority order.
	 *
	 * Resolution ladder — a request in hand always beats "no API key":
	 * 1. strict: unblocked credentials only, usage limits respected, plan
	 *    filter enforced (when any account is confirmed eligible);
	 * 2. plan-fitting last resort: same plan filter, but blocked/exhausted
	 *    accounts are allowed (an explicit session pin first, then blocked
	 *    candidates earliest-unblocking first) so the caller gets real
	 *    usage-limit semantics from the wire instead of a missing key;
	 * 3. unfiltered last resort: the plan filter matched nothing usable —
	 *    skip it and try every account once; the server is the final arbiter
	 *    of model access.
	 *
	 * Returns both the API key bytes for outbound requests AND the refreshed
	 * {@link OAuthCredential} so callers needing identity metadata (account id,
	 * project id, etc.) do not have to dereference the snapshot themselves.
	 *
	 * `advance: false` (a key check, not a request) picks the same account but leaves
	 * the rotate turn, weight round, sink list, and learn-once set alone. It records the
	 * session pin as unserved: the session's first request then counts as a new selection.
	 *
	 * Under `strict`, a session whose pin was dropped goes back to its account. While
	 * that account is gone, every request throws {@link AIError.MissingApiKeyError}, until
	 * the account signs in again or the provider's accounts change.
	 */
	async resolveOAuth(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
		advance = true,
	): Promise<OAuthResolutionResult | undefined> {
		await this.#deps.pool.adoptExternalChanges();
		const stored = this.#deps.pool
			.credentials(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is { credential: OAuthCredential; index: number } => entry.credential.type === "oauth");
		this.#deps.policies.validateFor(
			provider,
			stored.map(entry => entry.credential),
		);
		// A session restriction drops every other account before ranking, pins,
		// and the fallback passes below, so none of them can route back to it.
		const credentials = stored.filter(entry => this.#deps.affinity.allows(provider, sessionId, entry.credential));
		// Every OAuth row, so a restriction that leaves the account out is not read as a sign-out.
		if (sessionId) this.#backToStrictAccount(provider, sessionId, stored, options?.recordAffinity !== false, advance);

		if (credentials.length === 0) return undefined;
		// Ranking and preflight both await provider work; preserve the row each
		// selection started with even if a peer reorders the live pool.
		const credentialIds = this.#deps.pool.entries(provider).map(entry => entry.id);
		this.#deps.policies.validateUsageCapability(provider, this.#deps.usage.canFetchOAuthUsage(provider));

		const providerKey = providerTypeKey(provider, "oauth");
		const { mode, stays } = this.#deps.policies.routingFor(provider);
		// Every mode but smart ranks the whole pool on every request, from sign-in order.
		const rankAll = mode !== "smart" && credentials.length > 1;
		const order = rankAll
			? credentials.map((_credential, index) => index)
			: this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const strategy = this.#deps.strategies(provider);
		const rankingContext: CredentialRankingContext = {
			modelId: options?.modelId,
		};
		const blockScope = strategy?.blockScope?.(rankingContext);
		// Reads honour every scope that applies; the scalar above is for args that persist.
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const planGate = this.#planGate(provider, strategy, rankingContext);
		const hasPlanRequirement = planGate !== undefined;
		const accountIds = options?.accountIds?.length ? new Set(options.accountIds) : undefined;
		const enforceAccounts =
			accountIds !== undefined &&
			credentials.some(({ credential }) => {
				const accountKey = oauthAccountKey(credential);
				return accountKey !== undefined && accountIds.has(accountKey);
			});
		const hasAccountPolicy = credentials.some(
			({ credential }) => this.#deps.policies.forCredential(provider, credential) !== undefined,
		);
		const hasPriorityPolicy = credentials.some(
			({ credential }) => this.#deps.policies.forCredential(provider, credential)?.priority !== undefined,
		);
		const canFetchPolicyUsage = strategy !== undefined || this.#deps.usage.canFetchOAuthUsage(provider);
		const policyReserveEnabled = hasAccountPolicy && canFetchPolicyUsage;
		const checkUsage =
			(strategy !== undefined || policyReserveEnabled) && (credentials.length > 1 || hasPlanRequirement);
		const sessionCredential = this.#deps.affinity.get(provider, sessionId);
		const sessionPreferredIndex = sessionCredential?.type === "oauth" ? sessionCredential.index : undefined;
		const sessionPreferredCredential =
			sessionPreferredIndex !== undefined
				? credentials.find(entry => entry.index === sessionPreferredIndex)?.credential
				: undefined;
		const sessionPreferredCanRefreshOrUse =
			sessionPreferredCredential !== undefined &&
			(sessionPreferredCredential.refresh.trim().length > 0 ||
				Date.now() + OAUTH_REFRESH_SKEW_MS < sessionPreferredCredential.expires);
		// Skip ranking when the session already has a working preferred credential and its prompt
		// cache may still be warm. Providers without a verified idle boundary retain indefinite
		// stickiness rather than risk switching while their prompt cache remains warm. New sessions
		// (no preference), blocked pins, and sessions idle past the provider's sticky window still
		// rank. Legacy pins predating `lastUsedAtMs` count as warm until the next resolve rewrites the row.
		const sessionPreferredLastUsedAtMs =
			sessionCredential?.type === "oauth" ? sessionCredential.lastUsedAtMs : undefined;
		const sessionPreferredIsWarm =
			strategy?.stickyWarmMs === undefined ||
			sessionPreferredLastUsedAtMs === undefined ||
			Date.now() - sessionPreferredLastUsedAtMs < strategy.stickyWarmMs;
		const sessionPreferredIsAvailable =
			sessionPreferredIndex !== undefined &&
			sessionPreferredCanRefreshOrUse &&
			!this.#deps.blocks.isBlocked(provider, providerKey, sessionPreferredIndex, blockScopes);
		const sessionPinIsExplicit = sessionCredential?.type === "oauth" && sessionCredential.explicit === true;
		const sessionPinUnserved = sessionCredential?.unserved === true;
		const rankDespitePin =
			!sessionPreferredIsAvailable ||
			!sessionPreferredIsWarm ||
			hasPlanRequirement ||
			(policyReserveEnabled && !sessionPinIsExplicit);
		// A warm automatic pin whose allowance is spent keeps serving on paid overage
		// (Codex credits) and is never blocked, so check it and rank when spent: a
		// sibling with renewable allowance left must take over (#13889). tryOAuth
		// reads this same report for the pin, so it is handed on below.
		const sessionPreferredUsage =
			stays === "auto" &&
			!rankAll &&
			checkUsage &&
			!rankDespitePin &&
			!sessionPinIsExplicit &&
			sessionPreferredCredential
				? await this.#deps.usage.report(provider, sessionPreferredCredential, {
						...options,
						timeoutMs: this.#deps.usage.requestTimeoutMs,
					})
				: undefined;
		// Stays other than `auto` judge the pin on ranked usage, so they always rank.
		const shouldRank =
			rankAll ||
			(checkUsage &&
				(stays !== "auto" ||
					rankDespitePin ||
					(sessionPreferredUsage !== undefined &&
						remainingUsageFraction(strategy, sessionPreferredUsage, rankingContext, Date.now()) === 0)));
		// When ranking, seed the pinned credential first in the evaluation order so it wins genuine
		// ties (the ranked comparator falls back to `orderPos`) without overriding a strictly-better
		// sibling — this respects the residual value of a same-account shared static prefix that other
		// workspace traffic may have kept warm, while still rotating away from a clearly-worse account.
		const baseRankingOrder = credentials.map((_credential, index) => index);
		const policyOrder = hasPriorityPolicy
			? [...baseRankingOrder].sort((leftIndex, rightIndex) => {
					const leftPriority =
						this.#deps.policies.forCredential(provider, credentials[leftIndex]!.credential)?.priority ?? 0;
					const rightPriority =
						this.#deps.policies.forCredential(provider, credentials[rightIndex]!.credential)?.priority ?? 0;
					return rightPriority - leftPriority || leftIndex - rightIndex;
				})
			: order;
		let rankingOrder = shouldRank && (sessionId || rankAll) ? baseRankingOrder : policyOrder;
		const sessionPreferredRankingPos =
			shouldRank &&
			sessionId &&
			stays === "auto" &&
			!rankAll &&
			sessionPreferredIndex !== undefined &&
			!hasPlanRequirement
				? credentials.findIndex(entry => entry.index === sessionPreferredIndex)
				: -1;
		if (sessionPreferredRankingPos > 0) {
			rankingOrder = [
				sessionPreferredRankingPos,
				...baseRankingOrder.filter(index => index !== sessionPreferredRankingPos),
			];
		}
		const ranked = shouldRank
			? await this.#rankOAuthSelections({
					providerKey,
					provider,
					mode,
					credentialIds,
					planGate,
					order: rankingOrder,
					credentials,
					options,
					strategy,
					defaultReservePct: policyReserveEnabled ? this.#deps.policies.defaultReservePct : undefined,
					rankingContext,
					blockScope,
					blockScopes,
				})
			: undefined;
		// No await from ordering to the routing-state update below, so concurrent selections
		// (gateway, parallel subagents) never read the same `rotate` turn or `weight` round.
		const candidates: OAuthCandidate[] = ranked
			? this.#orderRanked(provider, providerKey, ranked, hasPlanRequirement, !advance)
			: applySink(
					policyOrder
						.map(idx => credentials[idx])
						.filter((selection): selection is { credential: OAuthCredential; index: number } =>
							Boolean(selection),
						)
						.map(selection => ({
							selection,
							credentialId: credentialIds[selection.index],
							...(selection.index === sessionPreferredIndex && sessionPreferredUsage !== undefined
								? { usage: sessionPreferredUsage, usageChecked: true }
								: { usage: null, usageChecked: false }),
						})),
					// `sink` applies here too; a warm `auto` pin is still moved to the front below.
					this.#sunk(
						provider,
						credentials
							.filter(({ index }) => !this.#deps.blocks.isBlocked(provider, providerKey, index, blockScopes))
							.map(({ index }) => credentialIds[index]),
						!advance,
					),
				);
		// Keep the candidate object: preflight may rebind its positional index
		// after a peer changes the credential pool.
		const explicitPin = sessionPinIsExplicit
			? candidates.find(candidate => candidate.selection.index === sessionPreferredIndex)
			: undefined;
		// `strict`: an automatic pin serves even while blocked, and a failed pin is not replaced.
		const strictPin =
			stays === "strict" && !sessionPinIsExplicit
				? candidates.find(candidate => candidate.selection.index === sessionPreferredIndex)
				: undefined;
		const preflightFailures = new Set<OAuthCandidate>();
		// The last retryable refresh error (network, timeout, 5xx) that removed a candidate.
		// When no candidate resolves, it is rethrown so callers retry instead of reporting
		// a missing key. Refresher outcomes after a dead grant (row disabled, CAS lost) are
		// classified auth failures and keep resolving to undefined.
		let transientRefreshFailure: unknown;
		const recordTransientRefreshFailure = (error: unknown): void => {
			if (AIError.retriable(AIError.classify(error))) transientRefreshFailure = error;
		};

		const sessionPreferredCandidate = candidates.findIndex(
			candidate =>
				!this.#deps.blocks.isBlocked(provider, providerKey, candidate.selection.index, blockScopes) &&
				candidate.selection.index === sessionPreferredIndex,
		);
		const preferredCandidate = sessionPreferredCandidate === -1 ? undefined : candidates[sessionPreferredCandidate];
		// A warm automatic pin normally wins. Two policies may evict it, each only
		// while a sibling is confirmed better: reserve (sibling measured outside
		// reserve) and spent allowance (unblocked sibling with allowance left).
		const automaticPinWouldBeEvicted = (excludePreflightFailures: boolean): boolean =>
			!sessionPinIsExplicit &&
			preferredCandidate !== undefined &&
			candidates.some(candidate => {
				if (candidate === preferredCandidate) return false;
				if (excludePreflightFailures && preflightFailures.has(candidate)) return false;
				if (
					preferredCandidate.inReserve === true &&
					candidate.reserveMeasured === true &&
					candidate.inReserve === false
				) {
					return true;
				}
				return (
					preferredCandidate.allowanceSpent === true &&
					candidate.usage !== null &&
					candidate.allowanceSpent === false &&
					!this.#deps.blocks.isBlocked(provider, providerKey, candidate.selection.index, blockScopes)
				);
			});
		// `stays`: whether an automatic pin keeps serving over the mode's pick.
		const keepAutomaticPin = (evicted: boolean): boolean => {
			if (preferredCandidate === undefined) return false;
			const usable =
				preferredCandidate.inReserve !== true &&
				preferredCandidate.allowanceSpent !== true &&
				planGate?.(preferredCandidate.usage) !== false;
			switch (stays) {
				case "auto":
					return sessionPreferredIsWarm && !evicted;
				case "session":
					return usable;
				case "turn":
					return options?.withinTurn === true && usable;
				case "strict":
					return true;
				case "off":
					return false;
			}
		};
		const pinEvictedBeforePreflight = automaticPinWouldBeEvicted(false);
		if (
			!hasPlanRequirement &&
			sessionPreferredCandidate > 0 &&
			(sessionPinIsExplicit || (stays === "auto" && !shouldRank) || keepAutomaticPin(pinEvictedBeforePreflight))
		) {
			const [preferred] = candidates.splice(sessionPreferredCandidate, 1);
			candidates.unshift(preferred);
		}
		// Enforce a tier only when at least one account is confirmed eligible. If
		// every report is unknown or ineligible, preserve trial/grandfathered access
		// by allowing the normal candidate fallback to attempt the request.
		const enforcePlanRequirement =
			hasPlanRequirement && candidates.some(candidate => planGate?.(candidate.usage) === true);
		const planKeepsPin = (pin: OAuthCandidate): boolean => {
			const planEligibility = planGate?.(pin.usage);
			return planEligibility === true || (!enforcePlanRequirement && planEligibility !== false);
		};
		// A kept pin does not count as the mode's pick: `rotate` keeps its turn and `weight`
		// charges the pin instead. A pin only key checks have used still takes its `rotate` turn.
		// The state follows this pre-preflight verdict; if preflight then drops the pick and a
		// sibling serves, nothing is re-charged (the dropped account loses that turn), so every
		// concurrent selection still sees one consistent round.
		const keptPin =
			strictPin ??
			(preferredCandidate !== undefined &&
			(sessionPinIsExplicit || keepAutomaticPin(pinEvictedBeforePreflight)) &&
			(candidates[0] === preferredCandidate || (hasPlanRequirement && planKeepsPin(preferredCandidate)))
				? preferredCandidate
				: undefined);
		if (advance && rankAll && mode === "rotate" && (keptPin === undefined || sessionPinUnserved)) {
			this.#getNextRoundRobinIndex(providerKey, credentials.length);
		}
		const weightRound = advance && rankAll && mode === "weight" ? this.#weightRounds.get(providerKey) : undefined;
		// Captured now: concurrent selections overwrite `last` while preflight awaits.
		const weightPick = weightRound?.last;
		if (weightRound && keptPin?.credentialId !== undefined) {
			chargeKept(weightRound, weightPick, keptPin.credentialId);
		}
		// Preflight dropped the sibling that evicted the pin, so the pin serves after all:
		// give back the `rotate` turn and move the `weight` pick's charge onto the pin.
		// A pin only key checks have used counts as a new pick, so its turn and charge stay.
		const restorePin = (pin: OAuthCandidate): void => {
			if (!advance || !rankAll || keptPin !== undefined || sessionPinUnserved) return;
			const turn = this.#providerRoundRobinIndex.get(providerKey);
			if (mode === "rotate" && turn !== undefined) {
				this.#providerRoundRobinIndex.set(providerKey, (turn - 1 + credentials.length) % credentials.length);
			}
			if (weightRound && pin.credentialId !== undefined) chargeKept(weightRound, weightPick, pin.credentialId);
		};
		// Step (b) of the auth-retry policy: when `forceRefresh` is set, re-mint
		// the session-preferred credential (or the first candidate when no
		// session preference exists yet) even if its cached token still looks
		// valid — a peer/broker may have rotated it out from under us.
		const forceRefreshIndex = options?.forceRefresh
			? (sessionPreferredIndex ?? candidates[0]?.selection.index)
			: undefined;
		// Candidate IDs were captured before ranking. Their synchronous rebinds
		// share one provider re-list; resyncs after refresh await re-read the store.
		let preflightRows: StoredAuthCredential[] | undefined;
		await Promise.all(
			// `strict` serves only its pin, so only the pin needs a fresh token.
			(strictPin ? [strictPin] : candidates).map(async candidate => {
				const force = forceRefreshIndex !== undefined && candidate.selection.index === forceRefreshIndex;
				const initialCredentialId = credentialIds[candidate.selection.index];
				if (initialCredentialId === undefined) {
					preflightFailures.add(candidate);
					return;
				}
				const beforeSync = candidate.selection.credential;
				preflightRows ??= this.#reloadProviderRows(provider);
				if (!this.#rebindOAuthSelection(preflightRows, candidate.selection, initialCredentialId)) {
					preflightFailures.add(candidate);
					return;
				}
				const syncedPeerCredential = !authCredentialEquals(beforeSync, candidate.selection.credential);
				const hasFreshAccess = Date.now() + OAUTH_REFRESH_SKEW_MS < candidate.selection.credential.expires;
				if ((!force || syncedPeerCredential) && hasFreshAccess) return;
				const latestCredential = this.#deps.pool.credentials(provider)[candidate.selection.index];
				if (
					!force &&
					latestCredential?.type === "oauth" &&
					Date.now() + OAUTH_REFRESH_SKEW_MS < latestCredential.expires
				) {
					candidate.selection.credential = latestCredential;
					return;
				}
				const credentialId = this.#deps.pool.entries(provider)[candidate.selection.index]?.id;
				try {
					// Hand the refresher a stale clone (expires:0) so its
					// not-yet-expired short-circuit doesn't suppress the forced
					// re-mint; an in-flight peer refresh is still awaited via the
					// per-credential single-flight.
					const refreshTarget = force
						? { ...candidate.selection.credential, expires: 0 }
						: candidate.selection.credential;
					const refreshedCredentials = await this.#deps.refresher.refresh(
						provider,
						refreshTarget,
						credentialId,
						options?.signal,
						force ? options?.refreshReason : undefined,
					);
					const beforeRefresh = candidate.selection.credential;
					const updated = mergeRefreshedCredential(beforeRefresh, refreshedCredentials);
					if (credentialId !== undefined && authCredentialEquals(beforeRefresh, updated)) {
						// The await may have allowed a peer to replace/remove this row or
						// compact its index. Rebind by id without writing the cached result.
						if (!this.#syncOAuthSelectionFromStore(provider, candidate.selection, credentialId)) {
							preflightFailures.add(candidate);
						}
						return;
					}
					candidate.selection.credential = updated;
					if (credentialId !== undefined) {
						const idx = this.#deps.pool.replaceById(provider, credentialId, updated);
						if (idx !== -1) candidate.selection.index = idx;
					} else {
						const rowId = this.#deps.pool.entries(provider)[candidate.selection.index]?.id;
						if (rowId !== undefined) this.#deps.pool.replaceById(provider, rowId, updated);
					}
				} catch (error) {
					// A failed preflight already exercised the provider refresh path.
					// Do not replay the same refresh token in the final candidate pass.
					const errorMsg = String(error);
					const isDefinitiveFailure = AIError.isDefinitiveOAuthFailure(errorMsg);
					logger.debug("OAuth preflight refresh failed", {
						provider,
						index: candidate.selection.index,
						error: errorMsg,
						isDefinitiveFailure,
					});
					if (isDefinitiveFailure) {
						// A dead grant discovered during preflight must be disabled here too —
						// the final candidate pass below skips every `preflightFailures` entry,
						// so if this branch only blocked the row (like the transient case), the
						// definitive failure would never reach `tryOAuth`'s own
						// disable logic and the row would be retried forever instead of torn down.
						const outcome = await this.#deps.refresher.disableDefinitiveFailure(
							provider,
							credentialId,
							candidate.selection.credential,
							candidate.selection.index,
							errorMsg,
						);
						if (
							outcome !== "disabled" &&
							credentialId !== undefined &&
							this.#syncOAuthSelectionFromStore(provider, candidate.selection, credentialId)
						) {
							// A peer rotated this row (or won the disable CAS) between our
							// snapshot and the refresh; the helper reloaded storage and the row
							// still exists, so it now holds a valid, freshly rotated credential.
							// Re-sync the candidate onto it and leave it eligible so the final
							// pass retries with the live token instead of stranding it (mirrors
							// tryOAuth's peer-rotated re-resolve). If the peer instead
							// deleted/disabled the row, the re-sync fails and we fall through to
							// preflightFailures — leaving a stale index could rebind the candidate
							// to a sibling account with the wrong prefetched usage/plan.
							return;
						}
					} else {
						recordTransientRefreshFailure(error);
						if (credentialId !== undefined) {
							const latestIndex = this.#deps.pool
								.entries(provider)
								.findIndex(entry => entry.id === credentialId);
							if (latestIndex !== -1) {
								this.#deps.blocks.mark(
									provider,
									providerKey,
									latestIndex,
									Date.now() + OAUTH_REFRESH_FAILURE_BACKOFF_MS,
									AUTH_BLOCK_SCOPE,
								);
							}
						}
					}
					preflightFailures.add(candidate);
				}
			}),
		);

		const pinEvictedAfterPreflight = automaticPinWouldBeEvicted(true);
		if (
			!hasPlanRequirement &&
			preferredCandidate !== undefined &&
			!preflightFailures.has(preferredCandidate) &&
			!sessionPinIsExplicit &&
			keepAutomaticPin(pinEvictedAfterPreflight)
		) {
			const preferredIndex = candidates.indexOf(preferredCandidate);
			if (preferredIndex > 0) {
				candidates.splice(preferredIndex, 1);
				candidates.unshift(preferredCandidate);
				restorePin(preferredCandidate);
			}
		}

		// Plan-gated models rank on every resolve to re-verify account tiers,
		// so the drain-urgency order can flip between two eligible accounts as their
		// usage headroom shifts. Promote the session-preferred credential back to the
		// front while it is unblocked and still plan-eligible (or the requirement is
		// unenforced and the pin is not known-ineligible) so an active session never
		// silently migrates accounts mid-conversation; blocked, exhausted, or
		// known-ineligible pins still fall through to the ranked sibling.
		if (
			hasPlanRequirement &&
			sessionPreferredCandidate > 0 &&
			(stays === "auto" || sessionPinIsExplicit
				? !pinEvictedAfterPreflight
				: keepAutomaticPin(pinEvictedAfterPreflight))
		) {
			const preferred = candidates[sessionPreferredCandidate]!;
			if (planKeepsPin(preferred)) {
				candidates.splice(sessionPreferredCandidate, 1);
				candidates.unshift(preferred);
				if (!preflightFailures.has(preferred)) restorePin(preferred);
			}
		}

		if (strictPin) {
			// No fallback: a dead grant is disabled without moving the session, and every
			// failure surfaces as this request's error.
			const resolved = preflightFailures.has(strictPin)
				? undefined
				: await this.tryOAuth(provider, strictPin.selection, providerKey, sessionId, options, {
						checkUsage: false,
						allowBlocked: true,
						prefetchedUsage: strictPin.usage,
						usagePrechecked: strictPin.usageChecked,
						planGate,
						enforcePlanRequirement: false,
						strategy,
						rankingContext,
						blockScope,
						blockScopes,
						allowFallback: false,
						onTransientRefreshFailure: recordTransientRefreshFailure,
						advance,
					});
			if (resolved) return advance ? this.#noteServed(provider, candidates, resolved) : resolved;
			if (transientRefreshFailure !== undefined) {
				throw new AIError.OAuthRefreshUnavailableError(provider, transientRefreshFailure);
			}
			// The pin's row is gone, so its sign-in failed for good: this request and the
			// session's later ones throw (no account can match a gone row).
			if (sessionId && !this.#deps.pool.entries(provider).some(entry => entry.id === strictPin.credentialId)) {
				this.#holdStrict(provider, sessionId, strictPin.credentialId, strictPin.selection.credential);
				this.#backToStrictAccount(provider, sessionId, [], false, advance);
			}
			return undefined;
		}

		const passes: Array<{
			allowBlocked: boolean;
			enforcePlanRequirement: boolean;
			enforceAccounts: boolean;
		}> = [
			{ allowBlocked: false, enforcePlanRequirement, enforceAccounts },
			{ allowBlocked: true, enforcePlanRequirement, enforceAccounts },
		];
		if (enforcePlanRequirement) passes.push({ allowBlocked: true, enforcePlanRequirement: false, enforceAccounts });
		if (enforceAccounts) passes.push({ allowBlocked: true, enforcePlanRequirement: false, enforceAccounts: false });
		// Blocked candidates rank earliest-unblock first, which would route a
		// blocked explicit pin to an equally blocked sibling. Once the strict
		// pass finds no unblocked account, the user's pin goes first.
		const lastResortCandidates = explicitPin
			? [explicitPin, ...candidates.filter(candidate => candidate !== explicitPin)]
			: candidates;

		for (const pass of passes) {
			for (const candidate of pass.allowBlocked ? lastResortCandidates : candidates) {
				if (preflightFailures.has(candidate)) continue;
				const candidateAccountKey = oauthAccountKey(candidate.selection.credential);
				if (pass.enforceAccounts && (candidateAccountKey === undefined || !accountIds?.has(candidateAccountKey)))
					continue;
				const resolved = await this.tryOAuth(provider, candidate.selection, providerKey, sessionId, options, {
					checkUsage,
					allowBlocked: pass.allowBlocked,
					prefetchedUsage: candidate.usage,
					usagePrechecked: candidate.usageChecked,
					planGate,
					enforcePlanRequirement: pass.enforcePlanRequirement,
					strategy,
					rankingContext,
					blockScope,
					blockScopes,
					onTransientRefreshFailure: recordTransientRefreshFailure,
					advance,
				});
				if (resolved) return advance ? this.#noteServed(provider, candidates, resolved) : resolved;
			}
		}

		if (transientRefreshFailure !== undefined) {
			throw new AIError.OAuthRefreshUnavailableError(provider, transientRefreshFailure);
		}
		return undefined;
	}

	#syncOAuthSelectionFromStore(
		provider: string,
		selection: { credential: OAuthCredential; index: number },
		credentialId: number,
	): boolean {
		return this.#rebindOAuthSelection(this.#reloadProviderRows(provider), selection, credentialId);
	}

	/** Re-list one provider's active rows and adopt them in the pool. */
	#reloadProviderRows(provider: string): StoredAuthCredential[] {
		const latestRows = this.#deps.store.listAuthCredentials(provider);
		this.#deps.pool.replace(
			provider,
			latestRows.map(row => ({ id: row.id, credential: row.credential })),
		);
		return latestRows;
	}

	/** Point `selection` at row `credentialId` in `latestRows`; false when it is gone or no longer OAuth. */
	#rebindOAuthSelection(
		latestRows: readonly StoredAuthCredential[],
		selection: { credential: OAuthCredential; index: number },
		credentialId: number,
	): boolean {
		const latestIndex = latestRows.findIndex(row => row.id === credentialId);
		if (latestIndex === -1) return false;
		const latest = latestRows[latestIndex];
		if (latest?.credential.type !== "oauth") return false;
		selection.index = latestIndex;
		selection.credential = latest.credential;
		return true;
	}

	async #prepareOAuthCredentialForRequest(
		provider: string,
		selection: { credential: OAuthCredential; index: number },
		options: AuthApiKeyOptions | undefined,
	): Promise<boolean> {
		const stored = this.#deps.pool.entries(provider);
		const selected = stored[selection.index];
		if (selected?.credential.type !== "oauth") return false;

		const prepare = this.#deps.store.prepareForRequest?.bind(this.#deps.store);
		if (prepare) {
			await prepare(selected.id, { signal: options?.signal });
		}
		return this.#syncOAuthSelectionFromStore(provider, selection, selected.id);
	}

	/** Attempts to use a single OAuth credential, checking usage and refreshing token. */
	async tryOAuth(
		provider: Provider,
		selection: OAuthSelection,
		providerKey: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		usageOptions: TryOAuthOptions,
	): Promise<OAuthResolutionResult | undefined> {
		const {
			checkUsage,
			allowBlocked,
			prefetchedUsage = null,
			usagePrechecked = false,
			planGate: providedPlanGate,
			enforcePlanRequirement,
			strategy,
			rankingContext,
			blockScope,
			blockScopes,
			allowFallback = true,
			advance = true,
		} = usageOptions;
		if (
			!allowBlocked &&
			this.#deps.blocks.isBlocked(provider, providerKey, selection.index, blockScopes ?? blockScope)
		) {
			return undefined;
		}

		if (!(await this.#prepareOAuthCredentialForRequest(provider, selection, options))) {
			return undefined;
		}
		// Capture the row id once, immediately after #prepareOAuthCredentialForRequest
		// resynced selection.index from the store. A concurrent disable during the
		// usage/refresh awaits below can shift positional indices, so every later
		// refresh / persist / CAS-disable addresses the row by this stable id.
		const credentialId = this.#deps.pool.entries(provider)[selection.index]?.id;

		const planGate =
			providedPlanGate ?? this.#planGate(provider, this.#deps.strategies(provider), { modelId: options?.modelId });
		const hasPlanRequirement = planGate !== undefined;
		const applyPlanFilter = enforcePlanRequirement ?? hasPlanRequirement;
		let usage: UsageReport | null = null;
		let usageChecked = false;

		if ((checkUsage && !allowBlocked) || hasPlanRequirement) {
			if (usagePrechecked) {
				usage = prefetchedUsage;
				usageChecked = true;
			} else {
				usage = await this.#deps.usage.report(provider, selection.credential, {
					...options,
					timeoutMs: this.#deps.usage.requestTimeoutMs,
				});
				usageChecked = true;
			}
			if (applyPlanFilter && planGate?.(usage) !== true) {
				return undefined;
			}
			if (checkUsage && !allowBlocked && usage && strategy && rankingContext) {
				const scopedLimits = scopedUsageLimits(strategy, usage, rankingContext);
				if (isUsageLimitReached(scopedLimits)) {
					const resetAtMs = usageResetAtMs(scopedLimits, Date.now());
					this.#deps.blocks.mark(
						provider,
						providerKey,
						selection.index,
						resetAtMs ?? Date.now() + DEFAULT_BLOCK_MS,
						blockScope,
						resetAtMs !== undefined,
					);
					return undefined;
				}
			}
		}

		try {
			let result: { newCredentials: OAuthCredentials; apiKey: string } | null;
			const customProvider = getOAuthProvider(provider);
			if (customProvider) {
				const refreshedCredentials = await this.#deps.refresher.refresh(
					provider,
					selection.credential,
					credentialId,
					options?.signal,
				);
				const apiKey = customProvider.getApiKey
					? customProvider.getApiKey(refreshedCredentials)
					: refreshedCredentials.access;
				result = { newCredentials: refreshedCredentials, apiKey };
			} else {
				// Refresh first through the broker-aware single-flighted machinery
				// so transient failures surface as network errors (5-min temp block)
				// instead of `getOAuthApiKey`'s "expired" precondition error, which
				// the definitive-failure regex below would otherwise classify as
				// auth failure and soft-disable a still-valid credential.
				const refreshedCredentials = await this.#deps.refresher.refresh(
					provider,
					selection.credential,
					credentialId,
					options?.signal,
				);
				const oauthCreds: Record<string, OAuthCredentials> = {
					[provider]: refreshedCredentials,
				};
				result = await getOAuthApiKey(provider as OAuthProvider, oauthCreds);
			}
			if (!result) return undefined;
			const updated = mergeRefreshedCredential(selection.credential, result.newCredentials);
			if (credentialId !== undefined) {
				const idx = this.#deps.pool.replaceById(provider, credentialId, updated);
				if (idx !== -1) selection.index = idx;
			} else {
				const rowId = this.#deps.pool.entries(provider)[selection.index]?.id;
				if (rowId !== undefined) this.#deps.pool.replaceById(provider, rowId, updated);
			}
			if ((checkUsage && !allowBlocked) || hasPlanRequirement) {
				const sameAccount = selection.credential.accountId === updated.accountId;
				if (!usageChecked || !sameAccount) {
					usage = await this.#deps.usage.report(provider, updated, {
						...options,
						timeoutMs: this.#deps.usage.requestTimeoutMs,
					});
					usageChecked = true;
				}
				if (applyPlanFilter && planGate?.(usage) !== true) {
					return undefined;
				}
				if (checkUsage && !allowBlocked && usage && strategy && rankingContext) {
					const scopedLimits = scopedUsageLimits(strategy, usage, rankingContext);
					if (isUsageLimitReached(scopedLimits)) {
						const resetAtMs = usageResetAtMs(scopedLimits, Date.now());
						this.#deps.blocks.mark(
							provider,
							providerKey,
							selection.index,
							resetAtMs ?? Date.now() + DEFAULT_BLOCK_MS,
							blockScope,
							resetAtMs !== undefined,
						);
						return undefined;
					}
				}
			}
			this.#deps.pool.noteBearer(provider, result.apiKey, credentialId);
			if (options?.recordAffinity !== false) {
				this.#deps.affinity.record(provider, sessionId, "oauth", selection.index, undefined, false, advance);
				if (sessionId) this.#holdStrict(provider, sessionId, credentialId, updated);
			}
			return { apiKey: result.apiKey, credential: updated, credentialId };
		} catch (error) {
			const errorMsg = String(error);
			// Only remove credentials for definitive auth failures
			// Keep credentials for transient errors (network, 5xx) and block temporarily
			const isDefinitiveFailure = AIError.isDefinitiveOAuthFailure(errorMsg);

			logger.warn("OAuth token refresh failed", {
				provider,
				index: selection.index,
				error: errorMsg,
				isDefinitiveFailure,
			});

			if (isDefinitiveFailure) {
				const outcome = await this.#deps.refresher.disableDefinitiveFailure(
					provider,
					credentialId,
					selection.credential,
					selection.index,
					errorMsg,
				);
				if (outcome === "peer-rotated") {
					if (allowFallback) return this.resolveOAuth(provider, sessionId, options, advance);
					return undefined;
				}
				if (outcome === "cas-lost") return undefined;
				if (this.#deps.pool.credentials(provider).some(credential => credential.type === "oauth")) {
					if (allowFallback) return this.resolveOAuth(provider, sessionId, options, advance);
				}
			} else {
				usageOptions.onTransientRefreshFailure?.(error);
				// Block temporarily for transient failures (5 minutes)
				this.#deps.blocks.mark(
					provider,
					providerKey,
					selection.index,
					Date.now() + OAUTH_REFRESH_FAILURE_BACKOFF_MS,
					AUTH_BLOCK_SCOPE,
				);
			}
		}

		return undefined;
	}
}
