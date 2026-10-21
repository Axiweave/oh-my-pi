import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type {
	AuthAccountPolicies,
	AuthAccountPolicy,
	AuthAccountSelector,
	AuthCredential,
	OAuthAccountIdentity,
	ProviderRouting,
	RoutingMode,
	StaysMode,
} from "./types";
import { DEFAULT_USAGE_RESERVE_PCT } from "./types";

const ROUTING_MODES: readonly RoutingMode[] = ["smart", "order", "rotate", "weight", "usage", "pace"];
const STAYS_MODES: readonly StaysMode[] = ["auto", "session", "turn", "off", "strict"];
const ROUTING_FIELDS: readonly string[] = ["mode", "stays", "sink"];
const MIN_KEY_SUFFIX_LENGTH = 4;

/** Whether every identity field set on `selector` matches `identity`; `keySuffix` selectors never match OAuth. */
export function matchesAuthAccountSelector(selector: AuthAccountSelector, identity: OAuthAccountIdentity): boolean {
	return (
		selector.keySuffix === undefined &&
		(selector.email === undefined || selector.email === identity.email) &&
		(selector.accountId === undefined || selector.accountId === identity.accountId) &&
		(selector.projectId === undefined || selector.projectId === identity.projectId) &&
		(selector.orgId === undefined || selector.orgId === identity.orgId)
	);
}

/** Whether `selector` names `credential`: OAuth by identity, API keys by `keySuffix`. */
function matchesCredential(selector: AuthAccountSelector, credential: AuthCredential): boolean {
	if (credential.type === "api_key") {
		return selector.keySuffix !== undefined && credential.key.endsWith(selector.keySuffix);
	}
	return matchesAuthAccountSelector(selector, credential);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Strictly validate `auth.routing` (provider → `{ mode, stays, sink }`).
 *
 * @throws ConfigurationError naming the `auth.routing.<provider>` path on unknown fields or values.
 */
export function parseAuthRouting(value: unknown): Readonly<Record<string, ProviderRouting>> {
	if (value === undefined) return {};
	if (!isPlainObject(value)) throw new AIError.ConfigurationError("auth.routing must be an object");
	for (const [provider, entry] of Object.entries(value)) {
		const path = `auth.routing.${provider}`;
		if (!isPlainObject(entry)) throw new AIError.ConfigurationError(`${path} must be an object`);
		const unknownFields = Object.keys(entry).filter(key => !ROUTING_FIELDS.includes(key));
		if (unknownFields.length > 0) {
			throw new AIError.ConfigurationError(`${path} has unknown fields: ${unknownFields.join(", ")}`);
		}
		if (entry.mode !== undefined && !ROUTING_MODES.includes(entry.mode as RoutingMode)) {
			throw new AIError.ConfigurationError(`${path}.mode must be one of ${ROUTING_MODES.join(", ")}`);
		}
		if (entry.stays !== undefined && !STAYS_MODES.includes(entry.stays as StaysMode)) {
			throw new AIError.ConfigurationError(`${path}.stays must be one of ${STAYS_MODES.join(", ")}`);
		}
		if (entry.sink !== undefined && typeof entry.sink !== "boolean") {
			throw new AIError.ConfigurationError(`${path}.sink must be a boolean`);
		}
	}
	return value as Readonly<Record<string, ProviderRouting>>;
}

/**
 * Validate account-policy values (identity selectors, priority, weight, caps, reclaim line).
 * `reclaimAbovePct` must sit above the account's reserve: 100 − its smallest cap, where an
 * account without `capPct` falls back to `defaultReservePct` when given.
 *
 * @throws ConfigurationError naming the `auth.accountPolicies[i]` path of the first bad value.
 */
export function validateAccountPolicies(accountPolicies: AuthAccountPolicies, defaultReservePct?: number): void {
	for (let index = 0; index < accountPolicies.length; index += 1) {
		const policy = accountPolicies[index]!;
		const path = `auth.accountPolicies[${index}]`;
		if (
			typeof policy.provider !== "string" ||
			policy.provider.length === 0 ||
			policy.provider.trim() !== policy.provider
		) {
			throw new AIError.ConfigurationError(
				`${path}.provider must be a non-empty string without surrounding whitespace`,
			);
		}
		if (!policy.account || typeof policy.account !== "object") {
			throw new AIError.ConfigurationError(`${path}.account must be an object`);
		}
		const { keySuffix } = policy.account;
		if (keySuffix !== undefined) {
			if (typeof keySuffix !== "string" || keySuffix.length < MIN_KEY_SUFFIX_LENGTH) {
				throw new AIError.ConfigurationError(
					`${path}.account.keySuffix must have at least ${MIN_KEY_SUFFIX_LENGTH} characters`,
				);
			}
			const { email, accountId, projectId, orgId } = policy.account;
			if (email !== undefined || accountId !== undefined || projectId !== undefined || orgId !== undefined) {
				throw new AIError.ConfigurationError(
					`${path}.account.keySuffix cannot be combined with email, accountId, projectId, or orgId`,
				);
			}
		} else {
			const baseIdentities = [policy.account.email, policy.account.accountId, policy.account.projectId];
			if (!baseIdentities.some(value => typeof value === "string" && value.length > 0)) {
				throw new AIError.ConfigurationError(
					`${path}.account must include at least one of email, accountId, or projectId`,
				);
			}
			for (const field of ["email", "accountId", "projectId", "orgId"] as const) {
				const value = policy.account[field];
				if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
					throw new AIError.ConfigurationError(`${path}.account.${field} must be a non-empty string`);
				}
			}
		}
		if (policy.priority !== undefined && !Number.isFinite(policy.priority)) {
			throw new AIError.ConfigurationError(`${path}.priority must be a finite number`);
		}
		if (
			policy.weight !== undefined &&
			!(Number.isInteger(policy.weight) && policy.weight >= 1 && policy.weight <= 1000)
		) {
			throw new AIError.ConfigurationError(`${path}.weight must be an integer between 1 and 1000`);
		}
		if (
			policy.capPct !== undefined &&
			(typeof policy.capPct !== "number" || !(policy.capPct >= 1 && policy.capPct <= 100))
		) {
			throw new AIError.ConfigurationError(`${path}.capPct must be a number between 1 and 100`);
		}
		if (policy.windowCapPct !== undefined) {
			if (!isPlainObject(policy.windowCapPct)) {
				throw new AIError.ConfigurationError(`${path}.windowCapPct must be an object`);
			}
			for (const [windowId, cap] of Object.entries(policy.windowCapPct)) {
				if (typeof cap !== "number" || !(cap >= 1 && cap <= 100)) {
					throw new AIError.ConfigurationError(
						`${path}.windowCapPct.${windowId} must be a number between 1 and 100`,
					);
				}
			}
		}
		if (policy.reclaimAbovePct !== undefined) {
			const fallbackCap = policy.capPct ?? (defaultReservePct === undefined ? undefined : 100 - defaultReservePct);
			const caps = Object.values(policy.windowCapPct ?? {});
			if (fallbackCap !== undefined) caps.push(fallbackCap);
			const reservePct = caps.length === 0 ? 0 : 100 - Math.min(...caps);
			if (
				typeof policy.reclaimAbovePct !== "number" ||
				!Number.isFinite(policy.reclaimAbovePct) ||
				policy.reclaimAbovePct <= reservePct ||
				policy.reclaimAbovePct > 100
			) {
				throw new AIError.ConfigurationError(
					`${path}.reclaimAbovePct must be a finite number above the account's reserve (${reservePct}%) and at most 100`,
				);
			}
		}
		if (policy.disabled !== undefined && typeof policy.disabled !== "boolean") {
			throw new AIError.ConfigurationError(`${path}.disabled must be a boolean`);
		}
	}
}

/**
 * Cap (percent used) for each usage window of `policy`'s account, or `undefined` when none applies:
 * the window's `windowCapPct`, else `capPct`, else 100 − the global reserve (never in `order` mode).
 */
export function capFor(
	policy: AuthAccountPolicy | undefined,
	mode: RoutingMode,
	defaultReservePct: number | undefined,
): (windowId: string | undefined) => number | undefined {
	const fallback =
		policy?.capPct ??
		(mode === "order" || defaultReservePct === undefined || !Number.isFinite(defaultReservePct)
			? undefined
			: 100 - Math.max(0, Math.min(100, defaultReservePct)));
	return windowId => (windowId === undefined ? undefined : policy?.windowCapPct?.[windowId]) ?? fallback;
}

/** Validated per-account routing policies (priority/weight/caps), per-provider routing, and the global reserve fallback. */
export class AccountPolicies {
	#accountPolicies: AuthAccountPolicies;
	#defaultReservePct: number;
	#routing: Readonly<Record<string, ProviderRouting>>;
	/** Indexes of policies already warned as unmatched; validation runs on every selection. */
	#warnedUnmatched = new Set<number>();

	constructor(
		policies: AuthAccountPolicies,
		defaultReservePct: number | undefined,
		routing: Readonly<Record<string, ProviderRouting>> | undefined,
	) {
		const effectiveDefaultReservePct =
			typeof defaultReservePct === "number" && Number.isFinite(defaultReservePct)
				? Math.max(0, Math.min(100, defaultReservePct))
				: DEFAULT_USAGE_RESERVE_PCT;
		validateAccountPolicies(policies, effectiveDefaultReservePct);
		this.#routing = parseAuthRouting(routing);
		this.#accountPolicies = policies;
		this.#defaultReservePct = effectiveDefaultReservePct;
	}

	/** Global usage reserve (0–100) for accounts without a per-account `capPct`. */
	get defaultReservePct(): number {
		return this.#defaultReservePct;
	}

	/** Routing settings for `provider`, defaults (`smart`, `auto`, no sink) filled in. */
	routingFor(provider: string): Required<ProviderRouting> {
		const routing = this.#routing[provider];
		return { mode: routing?.mode ?? "smart", stays: routing?.stays ?? "auto", sink: routing?.sink ?? false };
	}

	/** Providers with an `auth.routing` entry. */
	routedProviders(): string[] {
		return Object.keys(this.#routing);
	}

	/**
	 * Replace the policy set, global reserve, and routing table in place (live settings change).
	 * Validates the configuration, every provider in `storedCredentials`, and every cap against
	 * `canFetchUsage` before committing; on error the previous settings stay active.
	 */
	replace(
		policies: AuthAccountPolicies,
		defaultReservePct: number | undefined,
		routing: Readonly<Record<string, ProviderRouting>> | undefined,
		storedCredentials: ReadonlyMap<string, readonly AuthCredential[]>,
		canFetchUsage: (provider: string) => boolean,
	): void {
		const next = new AccountPolicies(policies, defaultReservePct, routing);
		for (const [provider, credentials] of storedCredentials) next.validateFor(provider, credentials);
		for (const { provider } of next.#accountPolicies) next.validateUsageCapability(provider, canFetchUsage(provider));
		this.#accountPolicies = next.#accountPolicies;
		this.#defaultReservePct = next.#defaultReservePct;
		this.#routing = next.#routing;
		this.#warnedUnmatched = next.#warnedUnmatched;
	}

	/**
	 * Throw the contract error when `provider` has a cap but no usage reports. Live replaces check
	 * this up front; construction cannot, since a runtime usage provider may register after it,
	 * so selection checks it too.
	 */
	validateUsageCapability(provider: string, canFetchUsage: boolean): void {
		if (canFetchUsage) return;
		const policyIndex = this.#accountPolicies.findIndex(
			policy => policy.provider === provider && (policy.capPct !== undefined || policy.windowCapPct !== undefined),
		);
		if (policyIndex !== -1) {
			const field = this.#accountPolicies[policyIndex]!.capPct !== undefined ? "capPct" : "windowCapPct";
			throw new AIError.ConfigurationError(
				`auth.accountPolicies[${policyIndex}].${field} requires a usage provider for ${provider}`,
			);
		}
		const reclaimIndex = this.#accountPolicies.findIndex(
			policy => policy.provider === provider && policy.reclaimAbovePct !== undefined,
		);
		if (reclaimIndex !== -1) {
			throw new AIError.ConfigurationError(
				`auth.accountPolicies[${reclaimIndex}].reclaimAbovePct requires a usage provider for ${provider}`,
			);
		}
	}

	/** Throw on ambiguous selectors for `provider`; a selector whose account is absent is inert and warns once. */
	validateFor(provider: string, credentials: readonly AuthCredential[]): void {
		const claimedCredentials = new Map<number, number>();
		for (let index = 0; index < this.#accountPolicies.length; index += 1) {
			const policy = this.#accountPolicies[index]!;
			if (policy.provider !== provider) continue;
			const kind = policy.account.keySuffix === undefined ? "oauth" : "api_key";
			const noun = kind === "oauth" ? "OAuth account" : "API key";
			if (!credentials.some(credential => credential.type === kind)) continue;
			const matches: number[] = [];
			for (let credentialIndex = 0; credentialIndex < credentials.length; credentialIndex += 1) {
				if (matchesCredential(policy.account, credentials[credentialIndex]!)) matches.push(credentialIndex);
			}
			const path = `auth.accountPolicies[${index}].account`;
			if (matches.length === 0) {
				if (!this.#warnedUnmatched.has(index)) {
					this.#warnedUnmatched.add(index);
					logger.warn(`Account policy matches no stored ${noun}; ignoring it`, { provider, path });
				}
				continue;
			}
			if (matches.length > 1) {
				throw new AIError.ConfigurationError(
					kind === "oauth"
						? `${path} matches ${matches.length} stored OAuth accounts for ${provider}; add another identity field`
						: `${path} matches ${matches.length} stored API keys for ${provider}; use a longer keySuffix`,
				);
			}
			const credentialIndex = matches[0]!;
			const previousPolicyIndex = claimedCredentials.get(credentialIndex);
			if (previousPolicyIndex !== undefined) {
				throw new AIError.ConfigurationError(
					`auth.accountPolicies[${previousPolicyIndex}] and auth.accountPolicies[${index}] match the same stored ${noun} for ${provider}`,
				);
			}
			claimedCredentials.set(credentialIndex, index);
		}
	}

	/**
	 * Return the configured account policy matching an OAuth identity.
	 *
	 * This is a read-only diagnostics surface: it performs the same conjunctive
	 * selector match as routing and never refreshes, ranks, or mutates credentials.
	 */
	find(provider: string, identity: OAuthAccountIdentity): AuthAccountPolicy | undefined {
		return this.#accountPolicies.find(
			policy => policy.provider === provider && matchesAuthAccountSelector(policy.account, identity),
		);
	}

	/** Return the configured policy for a stored credential (OAuth by identity, API key by `keySuffix`). */
	forCredential(provider: string, credential: AuthCredential): AuthAccountPolicy | undefined {
		return this.#accountPolicies.find(
			policy => policy.provider === provider && matchesCredential(policy.account, credential),
		);
	}

	/** Whether a policy disables `credential`: routing then never selects it, not even as a last fallback. */
	isDisabled(provider: string, credential: AuthCredential): boolean {
		return this.forCredential(provider, credential)?.disabled === true;
	}
}
