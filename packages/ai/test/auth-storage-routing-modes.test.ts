import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import {
	type AuthAccountPolicy,
	type AuthApiKeyOptions,
	AuthStorage,
	DEFAULT_USAGE_RESERVE_PCT,
	type ProviderRouting,
	resolveCredentialIdentityKey,
	type RoutingMode,
	type SessionAccountDisabledEvent,
	SqliteAuthCredentialStore,
	type StaysMode,
} from "@oh-my-pi/pi-ai/auth-storage";
import { credentialPinHash } from "@oh-my-pi/pi-ai/auth/affinity";
import { OAUTH_REFRESH_SKEW_MS } from "@oh-my-pi/pi-ai/auth/refresh";
import { getEnvApiKeyName } from "@oh-my-pi/pi-ai/env-api-key";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import {
	createCodexUsageReport,
	createCredential,
	createRoutingStorage,
	forAll,
	type Gen,
	HOUR_MS,
	MODES,
	WEEK_MS,
} from "./helpers/routing-fixtures";

const PROVIDER = "openai-codex";
const CASES = 200;
const STAYS: readonly StaysMode[] = ["auto", "session", "turn", "off", "strict"];

type Usage = { primary: number; secondary: number; secondaryResetMs: number };
type Account = {
	/** Undefined: the provider returns no report for this account. */
	usage?: Usage;
	/** Weekly allowance spent but not blocked (paid overage keeps serving). */
	spent?: boolean;
	priority?: number;
	capPct?: number;
	windowCapPct?: Record<string, number>;
	weight?: number;
	/** Token already expired, so a request refreshes it first (preflight). */
	stale?: boolean;
	/** `auth.accountPolicies` disables this account. */
	disabled?: boolean;
};

const accountId = (index: number) => `acct-${index}`;
const emailOf = (index: number) => `user${index}@example.test`;
const share = (account: Account) => (account.usage ? Math.max(account.usage.primary, account.usage.secondary) : 0);
const isBlocked = (account: Account) =>
	account.usage !== undefined && !account.spent && Math.max(account.usage.primary, account.usage.secondary) >= 1;
const hasPolicy = (account: Account) =>
	account.priority !== undefined ||
	account.capPct !== undefined ||
	account.windowCapPct !== undefined ||
	account.weight !== undefined;

/** The `auth.accountPolicies` entries `accounts` describe, matched by email. */
function policiesFor(accounts: readonly Account[]): AuthAccountPolicy[] {
	return accounts.flatMap((account, index): AuthAccountPolicy[] =>
		hasPolicy(account) || account.disabled
			? [
					{
						provider: PROVIDER,
						account: { email: emailOf(index) },
						...(account.priority === undefined ? {} : { priority: account.priority }),
						...(account.capPct === undefined ? {} : { capPct: account.capPct }),
						...(account.windowCapPct === undefined ? {} : { windowCapPct: account.windowCapPct }),
						...(account.weight === undefined ? {} : { weight: account.weight }),
						...(account.disabled ? { disabled: true } : {}),
					},
				]
			: [],
	);
}

function reportFor(index: number, usage: Usage, spent: boolean | undefined): UsageReport {
	const report = createCodexUsageReport({
		accountId: accountId(index),
		primary: { usedFraction: usage.primary, resetInMs: HOUR_MS / 2 },
		secondary: { usedFraction: usage.secondary, resetInMs: usage.secondaryResetMs },
	});
	if (spent) report.limits[1]!.status = "ok";
	return report;
}

function randomUsage(g: Gen, exhausted: boolean): Usage {
	const used = () => (exhausted && g.chance(0.1) ? 1 : g.int(0, 99) / 100);
	return { primary: used(), secondary: used(), secondaryResetMs: g.int(1, 168) * HOUR_MS };
}

type Pool = {
	authStorage: AuthStorage;
	store: SqliteAuthCredentialStore;
	ids: number[];
	reports: UsageReport[];
	/** Index of the account the next request gets, or -1 when none. */
	select(sessionId?: string, options?: AuthApiKeyOptions): Promise<number>;
};

async function withPool<T>(
	accounts: readonly Account[],
	options: {
		routing?: ProviderRouting;
		defaultReservePct?: number;
		headerLearning?: boolean;
		stickyWarmMs?: number;
	},
	run: (pool: Pool) => Promise<T>,
): Promise<T> {
	const reports = accounts.flatMap((account, index) =>
		account.usage ? [reportFor(index, account.usage, account.spent)] : [],
	);
	const accountPolicies = policiesFor(accounts);
	const { authStorage, store } = await createRoutingStorage({
		credentials: accounts.map((account, index) => ({
			...createCredential(accountId(index), emailOf(index)),
			...(account.stale ? { expires: Date.now() - 1 } : {}),
		})),
		usageByAccount: new Map(reports.map(report => [report.metadata!.accountId as string, report])),
		accountPolicies,
		routing: options.routing ? { [PROVIDER]: options.routing } : undefined,
		defaultReservePct: options.defaultReservePct,
		headerLearning: options.headerLearning,
		stickyWarmMs: options.stickyWarmMs,
	});
	try {
		return await run({
			authStorage,
			store,
			ids: authStorage.credentials.list(PROVIDER).map(row => row.id),
			reports,
			async select(sessionId, selectOptions) {
				// The request path: only it spends rotate turns and weight shares.
				const resolved = await authStorage.keys
					.getWithCredential(PROVIDER, sessionId, selectOptions)
					.catch((error: unknown) => {
						if (error instanceof AIError.OAuthRefreshUnavailableError) return undefined;
						throw error;
					});
				return resolved === undefined ? -1 : Number(resolved.apiKey.slice("api-acct-".length));
			},
		});
	} finally {
		vi.restoreAllMocks();
		store.close();
	}
}

/** Over a cap per FR-016/FR-017: window cap, else account cap, else the global reserve (not in `order`). */
function isOverCap(account: Account, mode: RoutingMode, reservePct: number, poolHasPolicy: boolean): boolean {
	if (!account.usage) return false;
	const fallback = account.capPct ?? (mode === "order" || !poolHasPolicy ? undefined : 100 - reservePct);
	const windows: Array<[string, number]> = [
		["1h", account.usage.primary],
		["7d", account.usage.secondary],
	];
	return windows.some(([windowId, used]) => {
		const cap = account.windowCapPct?.[windowId] ?? fallback;
		return cap !== undefined && used >= cap / 100 - 1e-9;
	});
}

const keyOf = (index: number) => `sk-or-test-k${index}zz`;
const keySuffixOf = (index: number) => `k${index}zz`;

/** `openrouter` key pool: no usage provider, no ranking strategy. `select` returns the serving key's index, or -1. */
async function withKeyPool<T>(
	count: number,
	options: { routing: ProviderRouting; accountPolicies?: AuthAccountPolicy[] },
	run: (select: (sessionId?: string) => Promise<number>, authStorage: AuthStorage) => Promise<T>,
): Promise<T> {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const authStorage = new AuthStorage(store, {
		usageProviderResolver: () => undefined,
		accountPolicies: options.accountPolicies,
		routing: { openrouter: options.routing },
	});
	try {
		await authStorage.credentials.set(
			"openrouter",
			Array.from({ length: count }, (_key, index) => ({
				type: "api_key" as const,
				key: keyOf(index),
				source: "login" as const,
			})),
		);
		return await run(async sessionId => {
			const resolved = await authStorage.keys.getWithCredential("openrouter", sessionId);
			return resolved === undefined ? -1 : Number(resolved.apiKey.slice("sk-or-test-k".length, -2));
		}, authStorage);
	} finally {
		store.close();
	}
}

/** Run with the provider's env key set; a request it serves reads as account 98 (`api-acct-98`). */
async function withEnvKey(run: () => Promise<void>): Promise<void> {
	const envName = getEnvApiKeyName(PROVIDER)!;
	const envBefore = Bun.env[envName];
	Bun.env[envName] = "api-acct-98";
	try {
		await run();
	} finally {
		if (envBefore === undefined) delete Bun.env[envName];
		else Bun.env[envName] = envBefore;
	}
}

/** Run with the providers' env keys unset, so only stored credentials can serve. */
async function withoutEnvKeys(providers: readonly string[], run: () => Promise<void>): Promise<void> {
	const names = providers.flatMap(provider => getEnvApiKeyName(provider) ?? []);
	const before = names.map(name => Bun.env[name]);
	for (const name of names) delete Bun.env[name];
	try {
		await run();
	} finally {
		for (const [index, name] of names.entries()) {
			if (before[index] !== undefined) Bun.env[name] = before[index];
		}
	}
}

afterEach(() => {
	setSystemTime();
	vi.restoreAllMocks();
});

describe("order mode", () => {
	it("picks the highest-priority usable account, and the global reserve never changes the pick", async () => {
		await forAll(CASES, async g => {
			const accounts: Account[] = Array.from({ length: g.int(2, 4) }, () => ({
				usage: randomUsage(g, true),
				...(g.chance(0.6) ? { priority: g.int(0, 3) } : {}),
				...(g.chance(0.4) ? { capPct: g.int(30, 99) } : {}),
			}));
			const expected = accounts
				.map((_account, index) => index)
				.filter(index => !isBlocked(accounts[index]!) && !isOverCap(accounts[index]!, "order", 0, true))
				.sort(
					(left, right) => (accounts[right]!.priority ?? 0) - (accounts[left]!.priority ?? 0) || left - right,
				)[0];
			const picks: number[] = [];
			for (const defaultReservePct of [0, g.int(1, 60)]) {
				picks.push(
					await withPool(accounts, { routing: { mode: "order" }, defaultReservePct }, pool => pool.select()),
				);
			}
			expect(picks[1]).toBe(picks[0]!);
			if (expected !== undefined) expect(picks[0]).toBe(expected);
		});
	});

	it("keeps 50 requests on account 1 until it is blocked, then returns to it once usable (SC-001, SC-002)", async () => {
		const start = Date.now();
		setSystemTime(start);
		const accounts: Account[] = [
			{ usage: { primary: 0.9, secondary: 0.95, secondaryResetMs: 72 * HOUR_MS } },
			{ usage: { primary: 0.1, secondary: 0.1, secondaryResetMs: 72 * HOUR_MS }, priority: 0 },
		];
		for (const stays of ["off", "auto"] as const) {
			await withPool(accounts, { routing: { mode: "order", stays }, defaultReservePct: 10 }, async pool => {
				for (let request = 0; request < 50; request += 1) expect(await pool.select(`s-${request}`)).toBe(0);
				await pool.authStorage.limits.markReached(PROVIDER, undefined, {
					credentialId: pool.ids[0],
					retryAfterMs: HOUR_MS,
				});
				expect(await pool.select("moved")).toBe(1);
				setSystemTime(start + 2 * HOUR_MS);
				expect(await pool.select("fresh")).toBe(0);
				expect(await pool.select("moved")).toBe(stays === "off" ? 0 : 1);
				setSystemTime(start);
			});
		}
	});

	it("with a plan gate, `order` keeps an account whose plan is unknown at its place on every path, and the other modes put unknown plans after eligible ones (FR-003)", async () => {
		const plans = ["pro", "free", undefined] as const;
		// Eligible, then unknown (a report without a plan type), then failed.
		const rank = (plan: (typeof plans)[number]) => (plan === "pro" ? 0 : plan === undefined ? 1 : 2);
		await forAll(CASES, async g => {
			const mode = g.pick(MODES);
			const accounts: Account[] = Array.from({ length: g.int(2, 4) }, () => ({
				usage: { primary: g.int(0, 50) / 100, secondary: g.int(0, 50) / 100, secondaryResetMs: 72 * HOUR_MS },
				priority: g.int(0, 2),
			}));
			const plan = accounts.map(() => g.pick(plans));
			const accessed = g.int(0, accounts.length - 1);
			// Spark needs a Pro plan.
			const options = { modelId: "gpt-5.3-codex-spark" };
			const { pick, access } = await withPool(accounts, { routing: { mode } }, async pool => {
				for (const [index, report] of pool.reports.entries()) report.metadata!.planType = plan[index];
				const pick = await pool.select("s", options);
				const access = await pool.authStorage.oauth.accessById(PROVIDER, pool.ids[accessed]!, options);
				return { pick, access: access?.ok === true };
			});
			if (mode === "order") {
				const byOrder = accounts
					.map((_account, index) => index)
					.sort((left, right) => accounts[right]!.priority! - accounts[left]!.priority! || left - right);
				expect({ plan, pick }).toEqual({ plan, pick: byOrder.find(index => plan[index] !== "free") ?? byOrder[0] });
			} else {
				expect({ mode, plan, rank: rank(plan[pick]) }).toEqual({ mode, plan, rank: Math.min(...plan.map(rank)) });
			}
			// An explicit `oauth.access` of one account follows the same plan check.
			const servable = mode === "order" ? plan[accessed] !== "free" : plan[accessed] === "pro";
			expect({ mode, plan: plan[accessed], access }).toEqual({ mode, plan: plan[accessed], access: servable });
		});
	});
});

describe("stays modes", () => {
	const twoAccounts: Account[] = [
		{ usage: { primary: 0.1, secondary: 0.1, secondaryResetMs: 72 * HOUR_MS } },
		{ usage: { primary: 0.1, secondary: 0.1, secondaryResetMs: 72 * HOUR_MS } },
	];

	it("keeps an automatic pin exactly per the stays truth table", async () => {
		for (const stays of STAYS) {
			for (const warm of [true, false]) {
				for (const blocked of [false, true]) {
					for (const withinTurn of [false, true]) {
						const kept = await withPool(
							twoAccounts,
							{ routing: { mode: "order", stays }, stickyWarmMs: HOUR_MS },
							async pool => {
								expect(
									pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[1]!, {
										restoredAtMs: Date.now() - (warm ? 0 : 2 * HOUR_MS),
									}),
								).toBe(true);
								if (blocked) {
									await pool.authStorage.limits.markReached(PROVIDER, undefined, {
										credentialId: pool.ids[1],
										retryAfterMs: HOUR_MS,
									});
								}
								return (await pool.select("s", { withinTurn })) === 1;
							},
						);
						const expected = {
							auto: warm && !blocked,
							session: !blocked,
							turn: withinTurn && !blocked,
							off: false,
							strict: true,
						}[stays];
						expect({ stays, warm, blocked, withinTurn, kept }).toEqual({
							stays,
							warm,
							blocked,
							withinTurn,
							kept: expected,
						});
					}
				}
			}
		}
	});

	it("leaves an explicit pin as it is in every stays mode", async () => {
		for (const blocked of [false, true]) {
			const picks: number[] = [];
			for (const stays of STAYS) {
				picks.push(
					await withPool(twoAccounts, { routing: { mode: "order", stays } }, async pool => {
						expect(pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[1]!)).toBe(true);
						if (blocked) {
							await pool.authStorage.limits.markReached(PROVIDER, undefined, {
								credentialId: pool.ids[1],
								retryAfterMs: HOUR_MS,
							});
						}
						return pool.select("s", { withinTurn: false });
					}),
				);
			}
			expect(picks).toEqual(STAYS.map(() => (blocked ? 0 : 1)));
		}
	});

	it("turn: a session on account 2 goes back to account 1 on its next turn once account 1 is usable", async () => {
		const start = Date.now();
		setSystemTime(start);
		await withPool(twoAccounts, { routing: { mode: "order", stays: "turn" } }, async pool => {
			await pool.authStorage.limits.markReached(PROVIDER, undefined, {
				credentialId: pool.ids[0],
				retryAfterMs: HOUR_MS,
			});
			expect(await pool.select("s", { withinTurn: false })).toBe(1);
			setSystemTime(start + 2 * HOUR_MS);
			expect(await pool.select("s", { withinTurn: true })).toBe(1);
			expect(await pool.select("s", { withinTurn: false })).toBe(0);
		});
	});

	it("strict: a pin that fails to mint surfaces its error, and neither a sibling nor an API key serves the session", async () => {
		await forAll(CASES, async g => {
			const mode = g.pick(MODES);
			const accounts: Account[] = Array.from({ length: g.int(2, 4) }, () => ({
				usage: { primary: g.int(0, 50) / 100, secondary: g.int(0, 50) / 100, secondaryResetMs: 72 * HOUR_MS },
			}));
			const pinned = g.int(0, accounts.length - 1);
			for (const explicit of [false, true]) {
				await withPool(accounts, { routing: { mode, stays: "strict" } }, async pool => {
					// Keys resolve as `api-acct-<n>`, so this login key reads as account 99.
					await pool.authStorage.credentials.upsert(PROVIDER, {
						type: "api_key",
						key: "api-acct-99",
						source: "login",
					});
					let failing = true;
					vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
						const credential = credentials[PROVIDER] as OAuthCredentials;
						if (failing && credential.accountId === accountId(pinned))
							throw new Error("fetch failed: ECONNRESET");
						return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
					});
					expect(
						pool.authStorage.sessions.pin(
							PROVIDER,
							"s",
							pool.ids[pinned]!,
							explicit ? undefined : { restoredAtMs: Date.now() },
						),
					).toBe(true);
					if (explicit) {
						// FR-014: an explicit pin keeps today's fallback to an OAuth sibling.
						const pick = await pool.select("s");
						const moved = pick !== pinned && pick >= 0 && pick < accounts.length;
						expect({ mode, explicit, moved }).toEqual({ mode, explicit, moved: true });
						return;
					}
					const error = await pool.authStorage.keys.getWithCredential(PROVIDER, "s").catch((err: unknown) => err);
					expect(error).toBeInstanceOf(AIError.OAuthRefreshUnavailableError);
					expect({ mode, next: await pool.select("s") }).toEqual({ mode, next: -1 });
					failing = false;
					expect({ mode, recovered: await pool.select("s") }).toEqual({ mode, recovered: pinned });
				});
			}
		});
	});

	it("strict: once the pin's account is removed, every request of that session fails with no other credential until the account signs in again or the accounts change", async () => {
		await withEnvKey(async () => {
			await forAll(CASES, async g => {
				const mode = g.pick(MODES);
				// How the account goes: its grant dies on refresh (`invalid_grant`), upstream reports the
				// token invalidated, a suspect check removes it (after a matching-key invalidation or a
				// generic 401), or it is removed.
				const source = g.pick(["refresh", "upstream", "invalidate", "suspect", "removed"] as const);
				const accounts: Account[] = Array.from({ length: g.int(2, 4) }, () => ({
					usage: { primary: g.int(0, 50) / 100, secondary: g.int(0, 50) / 100, secondaryResetMs: 72 * HOUR_MS },
				}));
				const pinned = g.int(0, accounts.length - 1);
				await withPool(accounts, { routing: { mode, stays: "strict" } }, async pool => {
					// Keys resolve as `api-acct-<n>`: the login key reads as 99, the env key as 98.
					await pool.authStorage.credentials.upsert(PROVIDER, {
						type: "api_key",
						key: "api-acct-99",
						source: "login",
					});
					let dead = source === "refresh";
					vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
						const credential = credentials[PROVIDER] as OAuthCredentials;
						if (dead && credential.accountId === accountId(pinned)) {
							throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
						}
						return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
					});
					expect(
						pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[pinned]!, { restoredAtMs: Date.now() }),
					).toBe(true);
					if (source !== "refresh") expect(await pool.select("s")).toBe(pinned);
					if (source === "upstream") {
						await pool.authStorage.limits.rotate(PROVIDER, "s", {
							error: new Error("401 invalidated oauth token"),
							credentialId: pool.ids[pinned],
						});
					}
					if (source === "invalidate" || source === "suspect") {
						// A broker's suspect check finds the grant dead and removes the row.
						Object.assign(pool.store, {
							markCredentialSuspect: async (id: number) => {
								await pool.store.deleteAuthCredential(id, "grant dead");
							},
						});
					}
					if (source === "invalidate") {
						await pool.authStorage.limits.invalidateMatching(PROVIDER, `access-${accountId(pinned)}`, {
							sessionId: "s",
						});
					}
					if (source === "suspect") {
						await pool.authStorage.limits.rotate(PROVIDER, "s", {
							error: new Error("401 Unauthorized"),
							credentialId: pool.ids[pinned],
						});
					}
					if (source === "removed") await pool.authStorage.credentials.removeById(PROVIDER, pool.ids[pinned]!);
					const request = () =>
						pool.authStorage.keys.getWithCredential(PROVIDER, "s").then(
							resolved => resolved?.apiKey,
							(error: unknown) => error,
						);
					const failures = [await request(), await request()].map(
						result => result instanceof AIError.MissingApiKeyError && result.message.includes(emailOf(pinned)),
					);
					expect({ mode, source, failures }).toEqual({ mode, source, failures: [true, true] });
					const fresh = await pool.select("fresh");
					expect({ mode, source, sibling: fresh !== pinned && fresh >= 0 && fresh < accounts.length }).toEqual({
						mode,
						source,
						sibling: true,
					});
					dead = false;
					if (g.chance(0.5)) {
						await pool.authStorage.credentials.upsert(PROVIDER, {
							type: "oauth",
							...createCredential(accountId(pinned), emailOf(pinned)),
						});
						expect({ mode, source, back: await pool.select("s") }).toEqual({ mode, source, back: pinned });
					} else {
						// Another account signs in: the accounts changed, so the session selects again.
						await pool.authStorage.credentials.upsert(PROVIDER, {
							type: "oauth",
							...createCredential(accountId(9), emailOf(9)),
						});
						const next = await pool.select("s");
						expect({ mode, source, oauth: next !== pinned && next >= 0 && next <= 9 }).toEqual({
							mode,
							source,
							oauth: true,
						});
					}
				});
			});
		});
	});

	it("strict: a subagent of a session whose account is gone fails the same way, whether it inherits before or after the removal", async () => {
		await withEnvKey(async () => {
			await forAll(CASES, async g => {
				const mode = g.pick(MODES);
				// With one account, the env key would serve a child that does not stay on the parent's account.
				const accounts: Account[] = Array.from({ length: g.int(1, 4) }, () => ({
					usage: { primary: g.int(0, 50) / 100, secondary: g.int(0, 50) / 100, secondaryResetMs: 72 * HOUR_MS },
				}));
				const pinned = g.int(0, accounts.length - 1);
				const inheritFirst = g.chance(0.5);
				await withPool(accounts, { routing: { mode, stays: "strict" } }, async pool => {
					const { credentials, keys, sessions } = pool.authStorage;
					expect(sessions.pin(PROVIDER, "parent", pool.ids[pinned]!, { restoredAtMs: Date.now() })).toBe(true);
					expect(await pool.select("parent")).toBe(pinned);
					if (inheritFirst) sessions.inherit("parent", "child");
					await credentials.removeById(PROVIDER, pool.ids[pinned]!);
					if (!inheritFirst) sessions.inherit("parent", "child");
					const failures: boolean[] = [];
					for (const sessionId of ["child", "child", "parent"]) {
						const result = await keys.getWithCredential(PROVIDER, sessionId).then(
							resolved => resolved?.apiKey,
							(error: unknown) => error,
						);
						failures.push(
							result instanceof AIError.MissingApiKeyError && result.message.includes(emailOf(pinned)),
						);
					}
					expect({ mode, inheritFirst, failures }).toEqual({ mode, inheritFirst, failures: [true, true, true] });
				});
			});
		});
	});

	it("strict: a subagent restricted to a pool without its parent's account never fails for that account, whether it inherits before or after it gets its pool", async () => {
		const identityKeyOf = (index: number) =>
			resolveCredentialIdentityKey(PROVIDER, {
				type: "oauth",
				...createCredential(accountId(index), emailOf(index)),
			})!;
		await forAll(CASES, async g => {
			const mode = g.pick(MODES);
			const accounts: Account[] = Array.from({ length: g.int(2, 4) }, () => ({
				usage: { primary: g.int(0, 50) / 100, secondary: g.int(0, 50) / 100, secondaryResetMs: 72 * HOUR_MS },
			}));
			const pinned = g.int(0, accounts.length - 1);
			// The child's pool: at least one other account, with or without the parent's.
			const others = accounts.map((_account, index) => index).filter(index => index !== pinned);
			const allowed = others.filter(() => g.chance(0.5));
			if (allowed.length === 0) allowed.push(g.pick(others));
			const inPool = g.chance(0.5);
			if (inPool) allowed.push(pinned);
			// The parent holds its account from this process (local), or from its session file after a
			// restart that found the account gone (restored: it knows the account only by pin hash).
			const hold = g.pick(["local", "restored"] as const);
			// Local: the parent's account is removed before the subagent starts, after, or not at all.
			// Restored: it is gone, and may sign in again before the subagent starts.
			const removal = g.pick(
				hold === "local" ? (["before", "after", "none"] as const) : (["gone", "signs in again"] as const),
			);
			const order = g.pick(["inherit, then restrict", "restrict, then inherit"] as const);
			const outcome = await withPool(accounts, { routing: { mode, stays: "strict" } }, async pool => {
				const { credentials, keys, sessions } = pool.authStorage;
				const parentAccount = { type: "oauth" as const, ...createCredential(accountId(pinned), emailOf(pinned)) };
				if (hold === "local") {
					expect(sessions.pin(PROVIDER, "parent", pool.ids[pinned]!, { restoredAtMs: Date.now() })).toBe(true);
					expect(await pool.select("parent")).toBe(pinned);
					if (removal === "before") await credentials.removeById(PROVIDER, pool.ids[pinned]!);
				} else {
					await credentials.removeById(PROVIDER, pool.ids[pinned]!);
					sessions.holdGone(PROVIDER, "parent", {
						hash: credentialPinHash(PROVIDER, parentAccount)!,
						lastUsedAt: Date.now(),
					});
					if (removal === "signs in again") await credentials.upsert(PROVIDER, parentAccount);
				}
				// A subagent starts: it inherits the parent's accounts and gets its pool, in either order.
				const restrict = () => sessions.restrict(PROVIDER, "child", allowed.map(identityKeyOf));
				if (order === "restrict, then inherit") restrict();
				sessions.inherit("parent", "child");
				if (order === "inherit, then restrict") restrict();
				if (removal === "after") await credentials.removeById(PROVIDER, pool.ids[pinned]!);
				const result = await keys.getWithCredential(PROVIDER, "child").then(
					resolved => resolved?.apiKey,
					(error: unknown) => error,
				);
				if (
					result instanceof AIError.MissingApiKeyError &&
					(result.message.includes(emailOf(pinned)) || result.message.includes("the account this session used"))
				) {
					return "signed out";
				}
				const served = typeof result === "string" ? Number(result.slice("api-acct-".length)) : -1;
				if (served === pinned) return "parent's account";
				return allowed.includes(served) ? "its pool" : String(result);
			});
			// A restored hold whose account is gone cannot show it is in the pool, so it drops.
			const expected = !inPool
				? "its pool"
				: removal === "none" || removal === "signs in again"
					? "parent's account"
					: removal === "gone"
						? "its pool"
						: "signed out";
			expect({ mode, inPool, hold, removal, order, outcome }).toEqual({
				mode,
				inPool,
				hold,
				removal,
				order,
				outcome: expected,
			});
		});
	});

	it("strict: after a restart, a session whose account is gone still fails until the accounts change", async () => {
		await withEnvKey(async () => {
			await forAll(CASES, async g => {
				const mode = g.pick(MODES);
				const accounts: Account[] = Array.from({ length: g.int(2, 4) }, () => ({
					usage: { primary: g.int(0, 50) / 100, secondary: g.int(0, 50) / 100, secondaryResetMs: 72 * HOUR_MS },
				}));
				const pinned = g.int(0, accounts.length - 1);
				// The restart comes before or after the session first finds its account gone.
				const failedBefore = g.chance(0.5);
				await withPool(accounts, { routing: { mode, stays: "strict" } }, async pool => {
					expect(
						pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[pinned]!, { restoredAtMs: Date.now() }),
					).toBe(true);
					expect(await pool.select("s")).toBe(pinned);
					await pool.authStorage.credentials.removeById(PROVIDER, pool.ids[pinned]!);
					if (failedBefore) await expect(pool.select("s")).rejects.toBeInstanceOf(AIError.MissingApiKeyError);
					// A new process on the same store.
					const restarted = new AuthStorage(pool.store, {
						usageProviderResolver: () => undefined,
						routing: { [PROVIDER]: { mode, stays: "strict" } },
					});
					await restarted.credentials.reload();
					const request = (sessionId: string) =>
						restarted.keys.getWithCredential(PROVIDER, sessionId).then(
							resolved => resolved?.apiKey,
							(error: unknown) => error,
						);
					const signedOut = (result: unknown) =>
						result instanceof AIError.MissingApiKeyError && result.message.includes(emailOf(pinned));
					const failures = [signedOut(await request("s")), signedOut(await request("s"))];
					const fresh = await request("fresh");
					const sibling = accounts.some(
						(_account, index) => index !== pinned && fresh === `api-${accountId(index)}`,
					);
					expect({ mode, failedBefore, failures, sibling }).toEqual({
						mode,
						failedBefore,
						failures: [true, true],
						sibling: true,
					});
					// Another account signs in: the accounts changed, so the session selects again.
					await restarted.credentials.upsert(PROVIDER, {
						type: "oauth",
						...createCredential(accountId(9), emailOf(9)),
					});
					const next = await request("s");
					expect({ mode, failedBefore, next: typeof next }).toEqual({ mode, failedBefore, next: "string" });
				});
			});
		});
	});

	it("strict: with 1, 255, 256, 257 or 300 sessions (256 are kept in memory), a session whose account is gone fails and the others keep their accounts", async () => {
		for (const count of [1, 255, 256, 257, 300]) {
			await forAll(3, async g => {
				const mode = g.pick(MODES);
				const accounts: Account[] = Array.from({ length: g.int(2, 3) }, () => ({
					usage: { primary: g.int(0, 50) / 100, secondary: g.int(0, 50) / 100, secondaryResetMs: 72 * HOUR_MS },
				}));
				const removed = g.int(0, accounts.length - 1);
				const sessions = Array.from({ length: count }, (_session, index) => ({
					id: `s-${index}`,
					account: g.int(0, accounts.length - 1),
				}));
				// Oldest first reaches the sessions evicted from memory first.
				const later = g.chance(0.5) ? sessions : sessions.toReversed();
				await withPool(accounts, { routing: { mode, stays: "strict" } }, async pool => {
					const { credentials, sessions: affinity } = pool.authStorage;
					for (const session of sessions) {
						const pinOptions = { restoredAtMs: Date.now() };
						expect(affinity.pin(PROVIDER, session.id, pool.ids[session.account]!, pinOptions)).toBe(true);
						expect(await pool.select(session.id)).toBe(session.account);
					}
					await credentials.removeById(PROVIDER, pool.ids[removed]!);
					const wrong: string[] = [];
					for (const session of later) {
						const result = await pool.select(session.id).catch((error: unknown) => error);
						const actual = result instanceof AIError.MissingApiKeyError ? "signed out" : result;
						if (actual !== (session.account === removed ? "signed out" : session.account)) {
							wrong.push(`${session.id} on ${session.account}: ${String(actual)}`);
						}
					}
					expect({ count, mode, wrong }).toEqual({ count, mode, wrong: [] });
				});
			});
		}
	});

	it("strict: an account with no account id or email is matched by its row only, never by a sibling without one", async () => {
		await forAll(CASES, async g => {
			const mode = g.pick(MODES);
			const count = g.int(2, 4);
			const pinned = g.int(0, count - 1);
			const { authStorage, store } = await createRoutingStorage({
				credentials: Array.from({ length: count }, (_credential, index) => ({
					access: `token-${index}`,
					refresh: `refresh-${index}`,
					expires: Date.now() + WEEK_MS,
				})),
				usageByAccount: new Map(),
				routing: { [PROVIDER]: { mode, stays: "strict" } },
			});
			try {
				vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
					const credential = credentials[PROVIDER] as OAuthCredentials;
					return { apiKey: credential.access, newCredentials: credential };
				});
				const ids = authStorage.credentials.list(PROVIDER).map(row => row.id);
				const request = () =>
					authStorage.keys.getWithCredential(PROVIDER, "s").then(
						resolved => resolved?.apiKey,
						(error: unknown) => error,
					);
				expect(authStorage.sessions.pin(PROVIDER, "s", ids[pinned]!, { restoredAtMs: Date.now() })).toBe(true);
				expect(await request()).toBe(`token-${pinned}`);
				await authStorage.credentials.removeById(PROVIDER, ids[pinned]!);
				const result = await request();
				expect({ mode, signedOut: result instanceof AIError.MissingApiKeyError }).toEqual({
					mode,
					signedOut: true,
				});
			} finally {
				vi.restoreAllMocks();
				store.close();
			}
		});
	});

	it("strict: a session lets go of its account once stays is no longer strict, so going back to strict after that account is removed does not fail it", async () => {
		await withEnvKey(async () => {
			await forAll(CASES, async g => {
				const mode = g.pick(MODES);
				const other = g.pick(STAYS.filter(stays => stays !== "strict"));
				// The other stays mode is set, or the provider's routing entry is deleted (stays `auto`).
				// It comes live or with a restart, before or after the removal, with or without a request under it.
				const deleted = g.chance(0.5);
				const restart = g.chance(0.5);
				const removedFirst = g.chance(0.5);
				const requests = g.chance(0.5);
				// Another provider may stay strict meanwhile.
				const bystander: Record<string, ProviderRouting> = g.chance(0.5) ? { anthropic: { stays: "strict" } } : {};
				const routingWith = (stays: StaysMode | undefined): Record<string, ProviderRouting> =>
					stays ? { ...bystander, [PROVIDER]: { mode, stays } } : bystander;
				// With one account the provider has none left after the removal; the env key serves the session.
				const accounts: Account[] = Array.from({ length: g.int(1, 3) }, () => ({
					usage: { primary: g.int(0, 50) / 100, secondary: g.int(0, 50) / 100, secondaryResetMs: 72 * HOUR_MS },
				}));
				const pinned = g.int(0, accounts.length - 1);
				await withPool(accounts, { routing: { mode, stays: "strict" } }, async pool => {
					expect(
						pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[pinned]!, { restoredAtMs: Date.now() }),
					).toBe(true);
					expect(await pool.select("s")).toBe(pinned);
					let storage = pool.authStorage;
					const routeWith = (stays: StaysMode | undefined) =>
						storage.setAccountPolicies({
							accountPolicies: [],
							defaultReservePct: 0,
							routing: routingWith(stays),
						});
					const remove = () => storage.credentials.removeById(PROVIDER, pool.ids[pinned]!);
					if (removedFirst) await remove();
					if (restart) {
						storage = new AuthStorage(pool.store, {
							usageProviderResolver: () => undefined,
							routing: routingWith(deleted ? undefined : other),
						});
						await storage.credentials.reload();
					} else {
						routeWith(deleted ? undefined : other);
					}
					if (!removedFirst) await remove();
					const request = () =>
						storage.keys.getWithCredential(PROVIDER, "s").then(
							resolved => resolved?.apiKey,
							(error: unknown) => error,
						);
					const sibling = (result: unknown) => typeof result === "string" && result !== `api-${accountId(pinned)}`;
					const under = !requests || sibling(await request());
					routeWith("strict");
					const back = sibling(await request());
					expect({ mode, other, deleted, restart, removedFirst, requests, under, back }).toEqual({
						mode,
						other,
						deleted,
						restart,
						removedFirst,
						requests,
						under: true,
						back: true,
					});
				});
			});
		});
	});

	it("strict: storage opened without routing settings (login, images) keeps strict sessions' accounts; one opened with settings, even `{}`, drops those of providers not strict there", async () => {
		await withEnvKey(async () => {
			await forAll(CASES, async g => {
				const mode = g.pick(MODES);
				const other = g.pick(STAYS.filter(stays => stays !== "strict"));
				const settings = g.pick(["none", "empty", "other provider strict", "not strict", "strict"] as const);
				const routings: Record<typeof settings, Record<string, ProviderRouting> | undefined> = {
					none: undefined,
					empty: {},
					"other provider strict": { anthropic: { stays: "strict" as const } },
					"not strict": { [PROVIDER]: { mode, stays: other } },
					strict: { [PROVIDER]: { mode, stays: "strict" as const } },
				};
				const routing = routings[settings];
				const removedFirst = g.chance(0.5);
				// With one account the provider has none left after the removal; the env key serves the session.
				const accounts: Account[] = Array.from({ length: g.int(1, 3) }, () => ({
					usage: { primary: g.int(0, 50) / 100, secondary: g.int(0, 50) / 100, secondaryResetMs: 72 * HOUR_MS },
				}));
				const pinned = g.int(0, accounts.length - 1);
				const outcome = await withPool(accounts, { routing: { mode, stays: "strict" } }, async pool => {
					expect(
						pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[pinned]!, { restoredAtMs: Date.now() }),
					).toBe(true);
					expect(await pool.select("s")).toBe(pinned);
					const remove = (storage: AuthStorage) => storage.credentials.removeById(PROVIDER, pool.ids[pinned]!);
					if (removedFirst) await remove(pool.authStorage);
					// Another process opens the same database, with or without routing settings.
					const opened = new AuthStorage(pool.store, {
						usageProviderResolver: () => undefined,
						...(routing && { routing }),
					});
					await opened.credentials.reload();
					// The session resumes under `strict`.
					const resumed = new AuthStorage(pool.store, {
						usageProviderResolver: () => undefined,
						routing: { [PROVIDER]: { mode, stays: "strict" } },
					});
					await resumed.credentials.reload();
					if (!removedFirst) await remove(resumed);
					const result = await resumed.keys.getWithCredential(PROVIDER, "s").then(
						resolved => resolved?.apiKey,
						(error: unknown) => error,
					);
					if (result instanceof AIError.MissingApiKeyError && result.message.includes(emailOf(pinned))) {
						return "signed out";
					}
					return typeof result === "string" && result !== `api-${accountId(pinned)}`
						? "served elsewhere"
						: String(result);
				});
				const kept = settings === "none" || settings === "strict";
				expect({ mode, settings, removedFirst, outcome }).toEqual({
					mode,
					settings,
					removedFirst,
					outcome: kept ? "signed out" : "served elsewhere",
				});
			});
		});
	});

	it("strict: a session's account is kept exactly as long as its pin, after an old restore, a removal, a resume, or in a subagent", async () => {
		const PIN_TTL_SEC = 30 * 24 * 60 * 60;
		const pinStates = new Set<boolean>();
		await forAll(CASES, async g => {
			const accounts: Account[] = Array.from({ length: g.int(2, 4) }, () => ({
				usage: { primary: 0.1, secondary: 0.1, secondaryResetMs: 72 * HOUR_MS },
			}));
			// `order` gives a new session account 0, so a session on `pinned` kept its account.
			const pinned = g.int(1, accounts.length - 1);
			const session = g.pick(["s", "child"] as const);
			const variant = g.pick(["kept", "resumed", "removed"] as const);
			// The store checks expiry on the real clock, in whole seconds: every row expires 5 s or
			// more away from now. `pinnedAt(offset)` is a last use whose pin row expires `offset` s from now.
			const offset = () => 10 * g.int(-15, 15) + 5;
			const servedOffset = offset();
			const resumedOffset = offset();
			const restoredAgeMs = 10_000 * g.int(0, 12);
			const removedAfterMs = 10_000 * g.int(0, 12);
			/** Serve `s` about 30 days ago, then restart now; `pinAlive` is false once the pin row expired. */
			const run = (removed: boolean) => {
				setSystemTime();
				const nowSec = Math.floor(Date.now() / 1000);
				const pinnedAt = (offsetSec: number) => (nowSec + offsetSec - PIN_TTL_SEC) * 1000;
				return withPool(accounts, { routing: { mode: "order", stays: "strict" } }, async pool => {
					const { sessions } = pool.authStorage;
					const servedAt = pinnedAt(servedOffset);
					setSystemTime(servedAt);
					const restoredAtMs = servedAt - restoredAgeMs;
					expect(sessions.pin(PROVIDER, "s", pool.ids[pinned]!, { restoredAtMs })).toBe(true);
					expect(await pool.select("s")).toBe(pinned);
					if (session === "child") sessions.inherit("s", "child");
					if (removed) {
						setSystemTime(servedAt + removedAfterMs);
						await pool.authStorage.credentials.removeById(PROVIDER, pool.ids[pinned]!);
						await expect(pool.select(session)).rejects.toBeInstanceOf(AIError.MissingApiKeyError);
					}
					setSystemTime();
					const restart = async () => {
						const restarted = new AuthStorage(pool.store, {
							usageProviderResolver: () => undefined,
							routing: { [PROVIDER]: { mode: "order", stays: "strict" } },
						});
						await restarted.credentials.reload();
						return restarted;
					};
					// A resumed session restores its pin from the session file, with that file's last use.
					let resumedAlive = true;
					if (variant === "resumed" && !removed) {
						const resumed = await restart();
						resumedAlive = resumed.sessions.release(PROVIDER, session);
						const pinOptions = { restoredAtMs: pinnedAt(resumedOffset) };
						expect(resumed.sessions.pin(PROVIDER, session, pool.ids[pinned]!, pinOptions)).toBe(true);
					}
					const restarted = await restart();
					// Dropping the pin leaves the session's strict account, if it is still kept. A pin
					// restored after that account expired does not bring it back.
					const released = restarted.sessions.release(PROVIDER, session);
					const pinAlive = !removed && resumedAlive && released;
					const result = await restarted.keys.getWithCredential(PROVIDER, session).then(
						resolved => resolved?.apiKey,
						(error: unknown) => error,
					);
					const held = removed
						? result instanceof AIError.MissingApiKeyError
						: result === `api-${accountId(pinned)}`;
					return { pinAlive, held };
				});
			};
			const kept = await run(false);
			pinStates.add(kept.pinAlive);
			// A removed account's session fails exactly as long as its pin would have lived.
			const held = variant === "removed" ? (await run(true)).held : kept.held;
			expect({ session, variant, held }).toEqual({ session, variant, held: kept.pinAlive });
		});
		expect([...pinStates].sort()).toEqual([false, true]);
	});

	it("strict: `limits.rotate` and `limits.invalidateMatching` move an explicit pin to a sibling and leave an automatic pin on its account (FR-014)", async () => {
		await forAll(CASES, async g => {
			const mode = g.pick(MODES);
			const source = g.pick(["401", "usage", "invalidate"] as const);
			const explicit = g.chance(0.5);
			const accounts: Account[] = Array.from({ length: g.int(2, 4) }, () => ({
				usage: { primary: g.int(0, 50) / 100, secondary: g.int(0, 50) / 100, secondaryResetMs: 72 * HOUR_MS },
			}));
			const pinned = g.int(0, accounts.length - 1);
			await withPool(accounts, { routing: { mode, stays: "strict" } }, async pool => {
				const { limits, sessions } = pool.authStorage;
				const pinOptions = explicit ? undefined : { restoredAtMs: Date.now() };
				expect(sessions.pin(PROVIDER, "s", pool.ids[pinned]!, pinOptions)).toBe(true);
				expect(await pool.select("s")).toBe(pinned);
				if (source === "invalidate") {
					await limits.invalidateMatching(PROVIDER, `access-${accountId(pinned)}`, { sessionId: "s" });
				} else {
					await limits.rotate(PROVIDER, "s", {
						error: new Error(source === "401" ? "401 Unauthorized" : "429 usage_limit_reached"),
						credentialId: pool.ids[pinned],
					});
				}
				const next = await pool.select("s");
				expect({ mode, source, explicit, moved: next !== pinned && next >= 0 }).toEqual({
					mode,
					source,
					explicit,
					moved: explicit,
				});
			});
		});
	});
});

describe("rotate and weight", () => {
	const lowAccounts = (g: Gen, count: number): Account[] =>
		Array.from({ length: count }, () => ({
			usage: { primary: g.int(0, 80) / 100, secondary: g.int(0, 80) / 100, secondaryResetMs: 72 * HOUR_MS },
		}));

	/**
	 * Fresh-session picks of a `weight` + `strict` pool: `before` picks, then `kept` requests on a
	 * pin to `pinned` while `blocked` accounts are blocked, then `after` picks once the blocks end.
	 */
	async function strictWeightPicks(
		accounts: readonly Account[],
		pinned: number,
		run: { before: number; kept: number; blocked: readonly number[]; after: number },
	): Promise<number[]> {
		const start = Date.now();
		setSystemTime(start);
		return withPool(accounts, { routing: { mode: "weight", stays: "strict" } }, async pool => {
			const picks: number[] = [];
			for (let request = 0; request < run.before; request += 1) picks.push(await pool.select(`f-${picks.length}`));
			expect(pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[pinned]!, { restoredAtMs: Date.now() })).toBe(
				true,
			);
			for (const index of run.blocked) {
				await pool.authStorage.limits.markReached(PROVIDER, undefined, {
					credentialId: pool.ids[index],
					retryAfterMs: HOUR_MS,
				});
			}
			for (let request = 0; request < run.kept; request += 1) expect(await pool.select("s")).toBe(pinned);
			setSystemTime(start + 2 * HOUR_MS);
			for (let request = 0; request < run.after; request += 1) picks.push(await pool.select(`f-${picks.length}`));
			return picks;
		});
	}

	it("weight: requests a strict pin serves while every account is blocked leave the round untouched", async () => {
		await forAll(CASES, async g => {
			const accounts = lowAccounts(g, g.int(2, 4)).map(account => ({ ...account, weight: g.int(1, 4) }));
			const pinned = g.int(0, accounts.length - 1);
			const before = g.int(1, 6);
			const after = g.int(4, 12);
			const everyAccount = accounts.map((_account, index) => index);
			const kept = await strictWeightPicks(accounts, pinned, {
				before,
				kept: g.int(1, 3),
				blocked: everyAccount,
				after,
			});
			const plain = await strictWeightPicks(accounts, pinned, { before, kept: 0, blocked: [], after });
			expect(kept).toEqual(plain);
		});
	});

	it("weight: a kept pin pays for its request the same whether it is in the round or blocked out of it", async () => {
		await forAll(CASES, async g => {
			const accounts = lowAccounts(g, g.int(2, 4)).map(account => ({ ...account, weight: g.int(1, 4) }));
			const pinned = g.int(0, accounts.length - 1);
			// No earlier pick often, so the blocked pin has never been in the round.
			const run = { before: g.chance(0.5) ? 0 : g.int(1, 3), kept: g.int(1, 3), after: g.int(4, 12) };
			const outside = await strictWeightPicks(accounts, pinned, { ...run, blocked: [pinned] });
			const inside = await strictWeightPicks(accounts, pinned, { ...run, blocked: [] });
			expect(outside).toEqual(inside);
		});
	});

	it("rotate and weight: a pin that preflight puts back in front keeps the turn and pays the weight charge, unless only key checks used it", async () => {
		const start = Date.now();
		const low = { primary: 0.1, secondary: 0.1, secondaryResetMs: 72 * HOUR_MS };
		type Case = { mode: "rotate" | "weight"; accounts: Account[]; pin: number; cold: boolean; after: number };
		/**
		 * One request from `requester` while `s` holds a pin, then fresh picks. The pin is explicit
		 * unless `restoredAtMs` is set; with `checked`, a key check makes the automatic pin.
		 */
		const run = (c: Case, requester: string, restoredAtMs?: number, checked = false) => {
			setSystemTime(start);
			return withPool(
				c.accounts,
				{ routing: { mode: c.mode, stays: "auto" }, stickyWarmMs: HOUR_MS },
				async pool => {
					let refreshFails = true;
					vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
						if (refreshFails) throw new Error("fetch failed: ECONNRESET");
						return { ...credential, expires: Date.now() + WEEK_MS };
					});
					// The check pins `s` without serving it. A stale account fails its refresh there too, and
					// the check runs earlier than the 5-minute block that leaves, so the request sees it again.
					if (checked) {
						setSystemTime(start - 6 * 60_000);
						expect(await pool.authStorage.keys.get(PROVIDER, "s", { accountIds: [accountId(c.pin)] })).toBe(
							`api-${accountId(c.pin)}`,
						);
						setSystemTime(start);
					}
					if (!checked || restoredAtMs === undefined) {
						const pinOptions = restoredAtMs === undefined ? undefined : { restoredAtMs };
						expect(pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[c.pin]!, pinOptions)).toBe(true);
					}
					// The request fails when every account fails preflight; only the state it leaves matters.
					const served = await pool.select(requester).catch(() => -1);
					refreshFails = false;
					setSystemTime(start + 10 * 60_000);
					const picks: number[] = [];
					for (let request = 0; request < c.after; request += 1) picks.push(await pool.select(`fresh-${request}`));
					return { served, picks };
				},
			);
		};
		// A warm automatic pin keeps the request unless a sibling that passes preflight is confirmed
		// better (here: the pin is over its cap and the sibling has a report under it). A kept pin
		// leaves rotate and weight state as an explicit pin would; otherwise the request is the
		// mode's pick, as a new session's request would be. A pin only a key check made counts as
		// a new pick: `rotate` takes the turn, and `weight` charges the pin only when no sibling
		// evicted it before preflight.
		const check = async (c: Case, checked = false) => {
			const overCap = c.accounts[c.pin]!.capPct !== undefined;
			const evicts = (account: Account, index: number) => index !== c.pin && overCap && account.usage !== undefined;
			const kept = !c.cold && c.accounts.every((account, index) => !evicts(account, index) || account.stale);
			const asExplicit = kept && (!checked || (c.mode === "weight" && !c.accounts.some(evicts)));
			const actual = await run(c, "s", c.cold ? start - 2 * HOUR_MS : start, checked);
			const expected = asExplicit ? await run(c, "s", undefined, checked) : await run(c, "other", start, checked);
			if (kept && !c.accounts[c.pin]!.stale) expect(actual.served).toBe(c.pin);
			expect({ mode: c.mode, kept, checked, picks: actual.picks }).toEqual({
				mode: c.mode,
				kept,
				checked,
				picks: expected.picks,
			});
		};
		for (const mode of ["rotate", "weight"] as const) {
			// Sign-in order: 0 evicts the pin but its token is stale and fails to refresh,
			// 1 is the pin (over its cap), 2 has no usage report (does not evict).
			const accounts: Account[] = [
				{ usage: low, stale: true },
				{ usage: { ...low, secondary: 0.6 }, capPct: 50 },
				{},
			];
			for (const checked of [false, true]) await check({ mode, accounts, pin: 1, cold: false, after: 2 }, checked);
		}
		await forAll(CASES, async g => {
			const count = 1 + g.pick([0, 1, g.int(2, 3)]);
			const pin = g.int(0, count - 1);
			const overCap = g.chance(0.7);
			const stale = g.int(-1, count - 1); // -1: no token fails
			const mode = g.pick(["rotate", "weight"] as const);
			const accounts = Array.from({ length: count }, (_account, index): Account => ({
				usage: index === pin ? { ...low, secondary: overCap ? 0.6 : 0.1 } : g.chance(0.5) ? low : undefined,
				...(index === pin && overCap ? { capPct: 50 } : {}),
				...(mode === "weight" ? { weight: g.int(1, 3) } : {}),
				...(index === stale ? { stale: true } : {}),
			}));
			// A key check can't pin an account whose token fails to refresh.
			const checked = stale !== pin && g.chance(0.5);
			const cold = !checked && g.chance(0.3);
			await check({ mode, accounts, pin, cold, after: g.int(count, 2 * count + 1) }, checked);
		});
	});

	it("rotate: every block of n selections uses each account once; with turn, each account serves one whole turn", async () => {
		await forAll(CASES, async g => {
			const accounts = lowAccounts(g, g.int(2, 5));
			const count = accounts.length;
			const everyAccount = accounts.map((_account, index) => index);
			await withPool(accounts, { routing: { mode: "rotate", stays: "off" } }, async pool => {
				const picks: number[] = [];
				for (let request = 0; request < 3 * count; request += 1) picks.push(await pool.select("s"));
				for (let block = 0; block < 3; block += 1) {
					expect(picks.slice(block * count, (block + 1) * count).sort()).toEqual(everyAccount);
				}
			});
			await withPool(accounts, { routing: { mode: "rotate", stays: "turn" } }, async pool => {
				const turns: number[] = [];
				for (let turn = 0; turn < 3 * count; turn += 1) {
					const account = await pool.select("s", { withinTurn: false });
					expect(await pool.select("s", { withinTurn: true })).toBe(account);
					expect(await pool.select("s", { withinTurn: true })).toBe(account);
					turns.push(account);
				}
				for (let block = 0; block < 3; block += 1) {
					expect(turns.slice(block * count, (block + 1) * count).sort()).toEqual(everyAccount);
				}
			});
		});
	});

	it("weight: every block of sum(weights) selections matches the weights, and no prefix runs ahead by more than one", async () => {
		await forAll(CASES, async g => {
			const accounts = lowAccounts(g, g.int(2, 4)).map(account => ({ ...account, weight: g.int(1, 6) }));
			const weights = accounts.map(account => account.weight);
			const total = weights.reduce((sum, weight) => sum + weight, 0);
			await withPool(accounts, { routing: { mode: "weight", stays: "off" } }, async pool => {
				const counts = weights.map(() => 0);
				for (let request = 1; request <= 2 * total; request += 1) {
					counts[await pool.select("s")]! += 1;
					for (const [index, weight] of weights.entries()) {
						expect(counts[index]! - (request * weight) / total).toBeLessThanOrEqual(1);
					}
					if (request % total === 0) expect(counts).toEqual(weights.map(weight => (weight * request) / total));
				}
			});
		});
	});

	it("weight: an account blocked or over its cap leaves the round, and the rest keep their exact ratio", async () => {
		await forAll(CASES, async g => {
			const count = g.int(3, 4);
			const out = g.int(0, count - 1);
			const blocked = g.chance(0.5);
			const accounts: Account[] = Array.from({ length: count }, (_account, index) => {
				const low = { primary: g.int(0, 30) / 100, secondary: g.int(0, 30) / 100, secondaryResetMs: 72 * HOUR_MS };
				if (index !== out) return { usage: low, weight: g.int(1, 5) };
				return blocked
					? { usage: { ...low, primary: 1 }, weight: g.int(1, 5) }
					: { usage: { ...low, secondary: 0.6 }, capPct: 50, weight: g.int(1, 5) };
			});
			const weights = accounts.map((account, index) => (index === out ? 0 : account.weight!));
			const total = weights.reduce((sum, weight) => sum + weight, 0);
			await withPool(accounts, { routing: { mode: "weight", stays: "off" } }, async pool => {
				const counts = weights.map(() => 0);
				for (let request = 1; request <= 2 * total; request += 1) {
					counts[await pool.select()]! += 1;
					if (request % total === 0) expect(counts).toEqual(weights.map(weight => (weight * request) / total));
				}
			});
		});
	});

	it("concurrent new sessions spread exactly like sequential ones: rotate n/k each, weight by ratio", async () => {
		await forAll(CASES, async g => {
			const mode = g.pick(["rotate", "weight"] as const);
			const accounts: Account[] = Array.from({ length: g.int(2, 5) }, () => ({
				usage: { primary: 0.1, secondary: 0.1, secondaryResetMs: 72 * HOUR_MS },
				weight: mode === "weight" ? g.int(1, 4) : 1,
			}));
			const weights = accounts.map(account => account.weight!);
			const total = weights.reduce((sum, weight) => sum + weight, 0);
			const rounds = g.int(1, 3);
			const picks = await withPool(accounts, { routing: { mode, stays: "off" } }, pool =>
				Promise.all(Array.from({ length: rounds * total }, (_request, index) => pool.select(`s-${index}`))),
			);
			const counts = weights.map((_weight, index) => picks.filter(pick => pick === index).length);
			expect({ mode, counts }).toEqual({ mode, counts: weights.map(weight => weight * rounds) });
		});
	});

	it("key checks (`keys.get`, `keys.peek`) before and between requests never change which account or key the requests get", async () => {
		await forAll(CASES, async g => {
			const mode = g.pick(["smart", "rotate", "weight", "usage", "pace"] as const);
			// A check before a session's first request pins it; that request still counts as a new pick.
			const stays = g.pick(STAYS);
			const count = g.int(2, 4);
			const weights = Array.from({ length: count }, () => g.int(1, 4));
			// Unknown usage on some accounts, so `usage` and `pace` also learn once.
			const accounts: Account[] = weights.map(weight => ({
				...(g.chance(0.3)
					? {}
					: {
							usage: {
								primary: g.int(0, 80) / 100,
								secondary: g.int(0, 80) / 100,
								secondaryResetMs: 72 * HOUR_MS,
							},
						}),
				weight,
			}));
			const requests = Array.from({ length: g.int(4, 12) }, () => ({
				sessionId: g.chance(0.3) ? undefined : `s-${g.int(0, 2)}`,
				checks: Array.from({ length: g.int(0, 3) }, () => (g.chance(0.5) ? `check-${g.int(0, 2)}` : undefined)),
			}));
			const accountPolicies = weights.map((weight, index): AuthAccountPolicy => ({
				provider: "openrouter",
				account: { keySuffix: keySuffixOf(index) },
				weight,
			}));
			const runs: { accounts: number[]; keys: number[] }[] = [];
			for (const checked of [true, false]) {
				const accountPicks = await withPool(accounts, { routing: { mode, stays } }, async pool => {
					const picks: number[] = [];
					for (const { sessionId, checks } of requests) {
						// The leading check is the request's own session, so every session is checked before its first request.
						for (const check of checked ? [undefined, ...checks] : []) {
							await pool.authStorage.keys.get(PROVIDER, check ?? sessionId);
							await pool.authStorage.keys.peek(PROVIDER);
						}
						picks.push(await pool.select(sessionId));
					}
					return picks;
				});
				const keyPicks = await withKeyPool(
					count,
					{ routing: { mode, stays }, accountPolicies },
					async (select, authStorage) => {
						const picks: number[] = [];
						for (const { sessionId, checks } of requests) {
							for (const check of checked ? [undefined, ...checks] : []) {
								await authStorage.keys.get("openrouter", check ?? sessionId);
								await authStorage.keys.peek("openrouter");
							}
							picks.push(await select(sessionId));
						}
						return picks;
					},
				);
				runs.push({ accounts: accountPicks, keys: keyPicks });
			}
			expect({ mode, stays, ...runs[0] }).toEqual({ mode, stays, ...runs[1]! });
		});
	});

	it("rotate and weight: a pin a key check made stays unserved while other sessions request, and its first request is a new pick its account pays for", async () => {
		await forAll(CASES, async g => {
			const mode = g.pick(["rotate", "weight"] as const);
			const stays = g.pick(STAYS);
			const accounts = lowAccounts(g, g.int(2, 4)).map(account => ({ ...account, weight: g.int(1, 4) }));
			const before = g.int(1, 2 * accounts.length);
			const after = g.int(accounts.length, 2 * accounts.length);
			// Outside a turn, `turn` and `off` don't keep the pin.
			const kept = stays === "auto" || stays === "session" || stays === "strict";
			/** `s` is checked first (unless `fresh`), `before` other sessions request, then `s`, then `after` others. */
			const run = (s: { fresh: true } | { fresh: false; explicitTo?: number }) =>
				withPool(accounts, { routing: { mode, stays } }, async pool => {
					const key = s.fresh ? undefined : await pool.authStorage.keys.get(PROVIDER, "s");
					const picks: number[] = [];
					for (let request = 0; request < before; request += 1) picks.push(await pool.select(`before-${request}`));
					if (!s.fresh && s.explicitTo !== undefined) {
						expect(pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[s.explicitTo]!)).toBe(true);
					}
					const served = await pool.select("s");
					for (let request = 0; request < after; request += 1) picks.push(await pool.select(`after-${request}`));
					return { checked: Number(key?.slice("api-acct-".length)), served, picks };
				});
			const actual = await run({ fresh: false });
			// `rotate` gives the request a turn, as a new session's; `weight` charges a kept pin, as an explicit one.
			const expected =
				mode === "weight" && kept
					? await run({ fresh: false, explicitTo: actual.checked })
					: await run({ fresh: true });
			if (kept) expect({ mode, stays, served: actual.served }).toEqual({ mode, stays, served: actual.checked });
			expect({ mode, stays, picks: actual.picks }).toEqual({ mode, stays, picks: expected.picks });
		});
	});

	it("rotate, strict: a credential change drops a pin only key checks used, a key check puts it back, and the first request is still a new pick", async () => {
		await forAll(CASES, async g => {
			const accounts = lowAccounts(g, g.int(2, 4));
			const after = g.int(accounts.length, 2 * accounts.length + 1);
			const run = (checked: boolean) =>
				withPool(accounts, { routing: { mode: "rotate", stays: "strict" } }, async pool => {
					const key = checked ? await pool.authStorage.keys.get(PROVIDER, "s") : undefined;
					// Another account signs in, which drops every pin.
					await pool.authStorage.credentials.upsert(PROVIDER, {
						type: "oauth",
						...createCredential(accountId(9), emailOf(9)),
					});
					if (checked) expect(await pool.authStorage.keys.get(PROVIDER, "s")).toBe(key);
					const served = await pool.select("s");
					const picks: number[] = [];
					for (let request = 0; request < after; request += 1) picks.push(await pool.select(`after-${request}`));
					return { checked: Number(key?.slice("api-acct-".length)), served, picks };
				});
			const actual = await run(true);
			const plain = await run(false);
			expect({ served: actual.served, picks: actual.picks }).toEqual({ served: actual.checked, picks: plain.picks });
		});
	});

	it("smart: a key check pins its session, so the session's first request gets the checked account after the ranking changes", async () => {
		await forAll(CASES, async g => {
			const stays = g.pick(["auto", "session", "strict"] as const);
			const accounts: Account[] = Array.from({ length: g.int(2, 4) }, () => ({ usage: randomUsage(g, false) }));
			await withPool(accounts, { routing: { mode: "smart", stays } }, async pool => {
				const key = await pool.authStorage.keys.get(PROVIDER, "s");
				const checked = Number(key?.slice("api-acct-".length));
				// The checked account becomes the worst pick: most used, latest reset; the rest are fresh.
				for (const [index, report] of pool.reports.entries()) {
					const worst = index === checked;
					report.limits = reportFor(
						index,
						{
							primary: worst ? 0.8 : 0.1,
							secondary: worst ? 0.8 : 0.1,
							secondaryResetMs: (worst ? 168 : 1) * HOUR_MS,
						},
						false,
					).limits;
				}
				await pool.authStorage.usage.invalidate(PROVIDER);
				const fresh = await pool.select("fresh");
				const served = await pool.select("s");
				expect({ stays, moved: fresh !== checked, served }).toEqual({ stays, moved: true, served: checked });
			});
		});
	});

	it("weight: a two-key pool on a provider without a usage strategy splits every 8 selections 6:2", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const authStorage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
			accountPolicies: [
				{ provider: "openrouter", account: { keySuffix: "aaaa" }, weight: 3 },
				{ provider: "openrouter", account: { keySuffix: "bbbb" }, weight: 1 },
			],
			routing: { openrouter: { mode: "weight", stays: "off" } },
		});
		try {
			await authStorage.credentials.set("openrouter", [
				{ type: "api_key", key: "sk-or-test-aaaa", source: "login" },
				{ type: "api_key", key: "sk-or-test-bbbb", source: "login" },
			]);
			for (let block = 0; block < 3; block += 1) {
				const counts = new Map<string, number>();
				for (let request = 0; request < 8; request += 1) {
					const key = (await authStorage.keys.getWithCredential("openrouter", "s"))?.apiKey ?? "none";
					counts.set(key, (counts.get(key) ?? 0) + 1);
				}
				expect(counts).toEqual(
					new Map([
						["sk-or-test-aaaa", 6],
						["sk-or-test-bbbb", 2],
					]),
				);
			}
		} finally {
			store.close();
		}
	});
});

describe("usage and pace", () => {
	const learn = (account: Account) => account.usage === undefined;
	const pace = (account: Account) =>
		account.usage
			? (1 - account.usage.secondary) /
				(Math.max(Math.min(account.usage.secondaryResetMs, WEEK_MS), 60_000) / HOUR_MS)
			: 1 / 168;

	/** FR-007/FR-008 order over usable accounts, written from the spec. */
	function expectedFirst(mode: "usage" | "pace", accounts: readonly Account[], tokens: readonly number[]) {
		const usable = accounts.map((_account, index) => index).filter(index => !isBlocked(accounts[index]!));
		const learnFirst = (left: number, right: number) =>
			Number(learn(accounts[right]!)) - Number(learn(accounts[left]!));
		const tie = (left: number, right: number) => tokens[left]! - tokens[right]! || left - right;
		if (mode === "usage") {
			return usable.sort(
				(left, right) =>
					learnFirst(left, right) || share(accounts[left]!) - share(accounts[right]!) || tie(left, right),
			)[0];
		}
		const tier = (index: number) => {
			const used = share(accounts[index]!);
			return used >= 0.98 ? 2 : used >= 0.9 ? 1 : 0;
		};
		const bands = new Map<number, number>();
		let band = -1;
		let top = 0;
		const free = usable.filter(index => tier(index) === 0 && !learn(accounts[index]!));
		for (const index of free.sort((left, right) => pace(accounts[right]!) - pace(accounts[left]!))) {
			if (band === -1 || pace(accounts[index]!) < 0.9 * top) {
				band += 1;
				top = pace(accounts[index]!);
			}
			bands.set(index, band);
		}
		return usable.sort(
			(left, right) =>
				tier(left) - tier(right) ||
				(tier(left) === 0
					? learnFirst(left, right) || (bands.get(left) ?? 0) - (bands.get(right) ?? 0)
					: share(accounts[left]!) - share(accounts[right]!)) ||
				tie(left, right),
		)[0];
	}

	for (const mode of ["usage", "pace"] as const) {
		it(`${mode}: picks the account the spec order puts first`, async () => {
			setSystemTime(Date.now());
			await forAll(CASES, async g => {
				const accounts: Account[] = Array.from({ length: g.int(2, 4) }, () =>
					g.chance(0.2) ? {} : { usage: randomUsage(g, true) },
				);
				const tokens = accounts.map(() => (g.chance(0.5) ? g.int(1, 3) * 1000 : 0));
				const expected = expectedFirst(mode, accounts, tokens);
				const pick = await withPool(accounts, { routing: { mode, stays: "off" } }, async pool => {
					for (const [index, input] of tokens.entries()) {
						if (input === 0) continue;
						pool.authStorage.usage.observe({
							provider: PROVIDER,
							model: "gpt-test",
							usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
							credentialId: pool.ids[index],
						});
					}
					return pool.select();
				});
				if (expected !== undefined) expect(pick).toBe(expected);
			});
		});
	}

	it("learn-once: an account without a report goes first exactly once, only when the provider parses headers", async () => {
		await forAll(CASES, async g => {
			const unknown = Array.from({ length: g.int(2, 4) }, () => g.chance(0.5));
			// A week to reset at 0% matches an unknown account's pace, so after learning every account ties.
			const accounts: Account[] = unknown.map(isUnknown =>
				isUnknown ? {} : { usage: { primary: 0, secondary: 0, secondaryResetMs: WEEK_MS } },
			);
			const mode = g.pick(["usage", "pace"] as const);
			for (const headerLearning of [true, false]) {
				const picks = await withPool(accounts, { routing: { mode, stays: "off" }, headerLearning }, async pool => {
					const picks: number[] = [];
					for (let request = 0; request < accounts.length + 2; request += 1) picks.push(await pool.select());
					return picks;
				});
				const learned = headerLearning ? unknown.flatMap((isUnknown, index) => (isUnknown ? [index] : [])) : [];
				expect(picks).toEqual([...learned, ...Array(accounts.length + 2 - learned.length).fill(0)]);
			}
		});
	});

	it("learn-once: a stays pin serving another account does not use up an unknown account's turn", async () => {
		await forAll(CASES, async g => {
			const count = g.int(2, 4);
			const pinned = g.int(0, count - 1);
			const unknown = Array.from({ length: count }, (_account, index) => index !== pinned && g.chance(0.5));
			if (!unknown.includes(true)) unknown[(pinned + 1) % count] = true;
			const accounts: Account[] = unknown.map(isUnknown =>
				isUnknown ? {} : { usage: { primary: 0, secondary: 0, secondaryResetMs: WEEK_MS } },
			);
			const mode = g.pick(["usage", "pace"] as const);
			const pinnedRequests = g.int(1, 3);
			const picks = await withPool(accounts, { routing: { mode, stays: "session" } }, async pool => {
				expect(pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[pinned]!, { restoredAtMs: Date.now() })).toBe(
					true,
				);
				for (let request = 0; request < pinnedRequests; request += 1) expect(await pool.select("s")).toBe(pinned);
				const picks: number[] = [];
				for (let request = 0; request < count + 2; request += 1) picks.push(await pool.select(`fresh-${request}`));
				return picks;
			});
			const learned = unknown.flatMap((isUnknown, index) => (isUnknown ? [index] : []));
			expect(picks).toEqual([...learned, ...Array(count + 2 - learned.length).fill(0)]);
		});
	});

	it("learn-once skips API keys: a key pool on a header-parsing provider always serves the fewest recent tokens", async () => {
		await forAll(CASES, async g => {
			const count = g.int(2, 4);
			const tokens = Array.from({ length: count }, () => g.int(0, 3) * 1000);
			const fewest = tokens.indexOf(Math.min(...tokens));
			const mode = g.pick(["usage", "pace"] as const);
			const { authStorage, store } = await createRoutingStorage({
				credentials: [],
				usageByAccount: new Map(),
				routing: { [PROVIDER]: { mode, stays: "off" } },
			});
			try {
				await authStorage.credentials.set(
					PROVIDER,
					tokens.map((_tokens, index) => ({
						type: "api_key" as const,
						key: keyOf(index),
						source: "login" as const,
					})),
				);
				const ids = authStorage.credentials.list(PROVIDER).map(row => row.id);
				for (const [index, input] of tokens.entries()) {
					if (input === 0) continue;
					authStorage.usage.observe({
						provider: PROVIDER,
						model: "gpt-test",
						usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
						credentialId: ids[index],
					});
				}
				const picks: Array<string | undefined> = [];
				for (let request = 0; request < count + 1; request += 1) {
					picks.push((await authStorage.keys.getWithCredential(PROVIDER))?.apiKey);
				}
				expect(picks).toEqual(Array(count + 1).fill(keyOf(fewest)));
			} finally {
				vi.restoreAllMocks();
				store.close();
			}
		});
	});
});

describe("caps", () => {
	it("no mode selects an account over a cap or past its allowance while a usable account exists", async () => {
		await forAll(CASES, async g => {
			const mode = g.pick(MODES);
			const defaultReservePct = g.int(0, 50);
			const accounts: Account[] = Array.from({ length: g.int(2, 4) }, () => {
				const spent = g.chance(0.15);
				const usage = randomUsage(g, true);
				return {
					usage: spent ? { ...usage, secondary: 1 } : usage,
					spent,
					...(g.chance(0.5) ? { capPct: g.int(30, 99) } : {}),
					...(g.chance(0.4) ? { windowCapPct: { [g.pick(["1h", "7d"])]: g.int(30, 99) } } : {}),
				};
			});
			const poolHasPolicy = accounts.some(hasPolicy);
			const routable = accounts.map(
				account =>
					!isBlocked(account) && !account.spent && !isOverCap(account, mode, defaultReservePct, poolHasPolicy),
			);
			const pick = await withPool(accounts, { routing: { mode, stays: "off" }, defaultReservePct }, pool =>
				pool.select(),
			);
			if (routable.includes(true)) expect({ mode, routable: routable[pick] }).toEqual({ mode, routable: true });
		});
	});

	it("a window cap overrides capPct on that window", async () => {
		const usage = { primary: 0.1, secondary: 0.5, secondaryResetMs: 72 * HOUR_MS };
		const sibling: Account = { usage: { ...usage, secondary: 0.2 } };
		const tighter = await withPool(
			[{ usage, capPct: 90, windowCapPct: { "7d": 40 } }, sibling],
			{ routing: { mode: "order" } },
			pool => pool.select(),
		);
		const looser = await withPool(
			[{ usage, capPct: 40, windowCapPct: { "7d": 95 } }, sibling],
			{ routing: { mode: "order" } },
			pool => pool.select(),
		);
		expect([tighter, looser]).toEqual([1, 0]);
	});

	it("a 5-hour window cap stops applying once that window resets", async () => {
		const fiveHour = { windowId: "5h", windowLabel: "5 Hour", durationMs: 5 * HOUR_MS };
		await forAll(CASES, async g => {
			const start = Date.now();
			setSystemTime(start);
			const cap = g.int(30, 90);
			const resetInMs = g.int(1, 5 * 60) * 60_000;
			const report = (index: number, used: number) =>
				createCodexUsageReport({
					accountId: accountId(index),
					primary: { usedFraction: used, resetInMs },
					secondary: { usedFraction: 0.1, resetInMs: 72 * HOUR_MS },
					primaryWindow: fiveHour,
				});
			const { authStorage, store } = await createRoutingStorage({
				credentials: [0, 1].map(index => createCredential(accountId(index), emailOf(index))),
				usageByAccount: new Map([
					[accountId(0), report(0, g.int(cap + 1, 99) / 100)],
					[accountId(1), report(1, 0.1)],
				]),
				accountPolicies: [{ provider: PROVIDER, account: { email: emailOf(0) }, windowCapPct: { "5h": cap } }],
				routing: { [PROVIDER]: { mode: "order", stays: "off" } },
			});
			try {
				const picks: Array<string | undefined> = [await authStorage.keys.get(PROVIDER)];
				setSystemTime(start + resetInMs + g.int(0, 120) * 60_000);
				picks.push(await authStorage.keys.get(PROVIDER));
				expect({ cap, picks }).toEqual({ cap, picks: [`api-${accountId(1)}`, `api-${accountId(0)}`] });
			} finally {
				vi.restoreAllMocks();
				store.close();
				setSystemTime(start);
			}
		});
	});

	it("an account cap routes exactly like the same global reserve, including a pool entirely over it", async () => {
		await forAll(CASES, async g => {
			const cap = g.int(30, 90);
			const allOver = g.chance(0.3);
			const accounts: Account[] = Array.from({ length: g.int(2, 4) }, () => ({
				usage: {
					primary: g.int(0, 99) / 100,
					secondary: allOver ? g.int(cap, 99) / 100 : g.int(0, 99) / 100,
					secondaryResetMs: g.int(1, 168) * HOUR_MS,
				},
			}));
			const capped = await withPool(
				accounts.map(account => ({ ...account, capPct: cap })),
				{ routing: { mode: "smart" } },
				pool => pool.select(),
			);
			const reserved = await withPool(
				accounts.map(account => ({ ...account, priority: 0 })),
				{ routing: { mode: "smart" }, defaultReservePct: 100 - cap },
				pool => pool.select(),
			);
			expect(capped).toBe(reserved);
		});
	});
});

describe("sink", () => {
	const lowAccounts = (count: number): Account[] =>
		Array.from({ length: count }, () => ({
			usage: { primary: 0.1, secondary: 0.1, secondaryResetMs: 72 * HOUR_MS },
		}));

	it("puts refused accounts behind every account not refused since", async () => {
		await forAll(CASES, async g => {
			const accounts = lowAccounts(g.int(2, 4));
			const mode = g.pick(["smart", "order", "usage", "pace"] as const);
			const refusals = Array.from({ length: g.int(1, accounts.length - 1) }, () => g.int(0, accounts.length - 1));
			const pick = await withPool(accounts, { routing: { mode, sink: true, stays: "off" } }, async pool => {
				for (const index of refusals) pool.authStorage.limits.noteRateLimited(PROVIDER, pool.ids[index]!);
				return pool.select();
			});
			const fresh = accounts.map((_account, index) => index).filter(index => !refusals.includes(index));
			expect(refusals.includes(pick)).toBe(false);
			if (mode === "order" || mode === "usage" || mode === "pace") expect(pick).toBe(fresh[0]!);
		});
	});

	it("sinks an account refused with quota left once its backoff ends", async () => {
		const start = Date.now();
		setSystemTime(start);
		for (const sink of [true, false]) {
			const pick = await withPool(lowAccounts(2), { routing: { mode: "order", sink } }, async pool => {
				await pool.authStorage.limits.markReached(PROVIDER, undefined, {
					credentialId: pool.ids[0],
					retryAfterMs: 1000,
				});
				setSystemTime(start + 2000);
				return pool.select();
			});
			setSystemTime(start);
			expect({ sink, pick }).toEqual({ sink, pick: sink ? 1 : 0 });
		}
	});

	it("rotate and weight ignore the sink", async () => {
		await forAll(CASES, async g => {
			const mode = g.pick(["rotate", "weight"] as const);
			const accounts = lowAccounts(g.int(2, 4)).map(account => ({ ...account, weight: g.int(1, 4) }));
			const refusals = Array.from({ length: 2 * accounts.length }, () => g.int(0, accounts.length - 1));
			const sequences: number[][] = [];
			for (const refuse of [true, false]) {
				sequences.push(
					await withPool(accounts, { routing: { mode, sink: true, stays: "off" } }, async pool => {
						const picks: number[] = [];
						for (const index of refusals) {
							if (refuse) pool.authStorage.limits.noteRateLimited(PROVIDER, pool.ids[index]!);
							picks.push(await pool.select());
						}
						return picks;
					}),
				);
			}
			expect(sequences[0]).toEqual(sequences[1]!);
		});
	});

	it("smart without a usage strategy puts refused keys and accounts behind the rest", async () => {
		await forAll(CASES, async g => {
			const count = g.int(2, 4);
			const refused = [...new Set(Array.from({ length: g.int(1, count - 1) }, () => g.int(0, count - 1)))];
			const routing = { mode: "smart", sink: true, stays: g.pick(STAYS) } as const;
			const sessions = Array.from({ length: 2 * count }, (_session, index) =>
				g.chance(0.2) ? undefined : `s-${index}`,
			);
			const keyPicks = await withKeyPool(count, { routing }, async (select, authStorage) => {
				const ids = authStorage.credentials.list("openrouter").map(row => row.id);
				for (const index of refused) authStorage.limits.noteRateLimited("openrouter", ids[index]!);
				const picks: number[] = [];
				for (const sessionId of sessions) picks.push(await select(sessionId));
				return picks;
			});
			const store = new SqliteAuthCredentialStore(new Database(":memory:"));
			const authStorage = new AuthStorage(store, {
				usageProviderResolver: () => undefined,
				rankingStrategyResolver: () => undefined,
				routing: { [PROVIDER]: routing },
			});
			vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
				const credential = credentials[PROVIDER] as OAuthCredentials;
				return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
			});
			const accountPicks: number[] = [];
			try {
				await authStorage.credentials.set(
					PROVIDER,
					Array.from({ length: count }, (_account, index) => ({
						type: "oauth" as const,
						...createCredential(accountId(index), emailOf(index)),
					})),
				);
				const ids = authStorage.credentials.list(PROVIDER).map(row => row.id);
				for (const index of refused) authStorage.limits.noteRateLimited(PROVIDER, ids[index]!);
				for (const sessionId of sessions) {
					const key = (await authStorage.keys.getWithCredential(PROVIDER, sessionId))?.apiKey;
					accountPicks.push(key === undefined ? -1 : Number(key.slice("api-acct-".length)));
				}
			} finally {
				vi.restoreAllMocks();
				store.close();
			}
			for (const picks of [keyPicks, accountPicks]) {
				expect({ refused, picks, sunkServed: picks.some(pick => pick < 0 || refused.includes(pick)) }).toEqual({
					refused,
					picks,
					sunkServed: false,
				});
			}
		});
	});

	it("clears the list once every usable account is on it, and when the credential set changes", async () => {
		await withPool(lowAccounts(3), { routing: { mode: "order", sink: true } }, async pool => {
			const note = (index: number) => pool.authStorage.limits.noteRateLimited(PROVIDER, pool.ids[index]!);
			note(2);
			note(1);
			note(0);
			expect(await pool.select()).toBe(0);
			note(0);
			expect(await pool.select()).toBe(1);
			await pool.authStorage.credentials.upsert(PROVIDER, {
				type: "oauth",
				...createCredential(accountId(3), emailOf(3)),
			});
			expect(await pool.select()).toBe(0);
		});
	});
});

describe("preview", () => {
	it("names the next pick without advancing rotate or weight state", async () => {
		await forAll(CASES, async g => {
			const mode = g.pick(["rotate", "weight"] as const);
			const accounts: Account[] = Array.from({ length: g.int(2, 4) }, () => ({
				usage: { primary: 0.1, secondary: 0.1, secondaryResetMs: 72 * HOUR_MS },
				weight: g.int(1, 4),
			}));
			await withPool(accounts, { routing: { mode, stays: "off" } }, async pool => {
				for (let request = 0; request < 2 * accounts.length; request += 1) {
					const first = pool.authStorage.routing.preview(PROVIDER, pool.reports);
					expect(pool.authStorage.routing.preview(PROVIDER, pool.reports)).toEqual(first);
					expect(first.next?.label).toBe(emailOf(await pool.select()));
				}
			});
		});
	});

	it("smart without usage reports names no next pick: the real pick hashes the session or rotates", async () => {
		await forAll(CASES, async g => {
			const accounts: Account[] = Array.from({ length: g.int(2, 4) }, () => ({}));
			const preview = await withPool(accounts, { routing: { mode: "smart", stays: g.pick(STAYS) } }, async pool =>
				pool.authStorage.routing.preview(PROVIDER, pool.reports),
			);
			expect(preview.next).toBeUndefined();
		});
	});
});

describe("mixed and blocked pools", () => {
	it("a pool of OAuth accounts and an API key serves OAuth first in every mode and stays", async () => {
		await forAll(CASES, async g => {
			const mode = g.pick(MODES);
			const stays = g.pick(STAYS);
			const accounts: Account[] = Array.from({ length: g.int(1, 3) }, () => ({ usage: randomUsage(g, true) }));
			const { picks, next } = await withPool(accounts, { routing: { mode, stays } }, async pool => {
				// Keys resolve as `api-acct-<n>`, so this key reads as account 99.
				await pool.authStorage.credentials.upsert(PROVIDER, {
					type: "api_key",
					key: "api-acct-99",
					source: "login",
				});
				// OAuth goes first, so the preview names an OAuth account even when there is only one.
				const next = pool.authStorage.routing.preview(PROVIDER, pool.reports).next?.label;
				const picks: number[] = [];
				for (let request = 0; request < 3; request += 1) picks.push(await pool.select(`s-${g.int(0, 1)}`));
				return { picks, next };
			});
			expect({
				mode,
				stays,
				oauth: picks.every(pick => pick >= 0 && pick < accounts.length),
				previewOAuth: accounts.some((_account, index) => emailOf(index) === next),
			}).toEqual({
				mode,
				stays,
				oauth: true,
				previewOAuth: true,
			});
		});
	});

	it("an all-blocked pool serves the account that unblocks first in every mode", async () => {
		await forAll(CASES, async g => {
			const mode = g.pick(MODES);
			const hours = new Set<number>();
			const count = g.int(2, 4);
			while (hours.size < count) hours.add(g.int(1, 168));
			const resets = [...hours];
			const accounts: Account[] = resets.map(hoursLeft => ({
				usage: { primary: 0.1, secondary: 1, secondaryResetMs: hoursLeft * HOUR_MS },
			}));
			const pick = await withPool(accounts, { routing: { mode, stays: g.pick(STAYS) } }, pool => pool.select("s"));
			expect({ mode, pick }).toEqual({ mode, pick: resets.indexOf(Math.min(...resets)) });
		});
	});
});

describe("API-key pools without a usage strategy", () => {
	it("rotate serves each key once per block; order always serves the highest-priority key", async () => {
		await forAll(CASES, async g => {
			const count = g.int(2, 5);
			const everyKey = Array.from({ length: count }, (_key, index) => index);
			const rotated = await withKeyPool(count, { routing: { mode: "rotate", stays: "off" } }, async select => {
				const picks: number[] = [];
				for (let request = 0; request < 3 * count; request += 1) picks.push(await select(`s-${g.int(0, 2)}`));
				return picks;
			});
			for (let block = 0; block < 3; block += 1) {
				expect(rotated.slice(block * count, (block + 1) * count).sort()).toEqual(everyKey);
			}
			const priorities = everyKey.map(() => (g.chance(0.5) ? g.int(0, 3) : undefined));
			const first = [...everyKey].sort(
				(left, right) => (priorities[right] ?? 0) - (priorities[left] ?? 0) || left - right,
			)[0];
			const accountPolicies = priorities.flatMap((priority, index): AuthAccountPolicy[] =>
				priority === undefined
					? []
					: [{ provider: "openrouter", account: { keySuffix: keySuffixOf(index) }, priority }],
			);
			const ordered = await withKeyPool(count, { routing: { mode: "order" }, accountPolicies }, async select => {
				const picks: number[] = [];
				for (let request = 0; request < 5; request += 1) picks.push(await select(`s-${request}`));
				return picks;
			});
			expect(ordered).toEqual(Array(5).fill(first));
		});
	});

	it("concurrent selections spread exactly: rotate evenly, weight 3:1", async () => {
		const accountPolicies: AuthAccountPolicy[] = [
			{ provider: "openrouter", account: { keySuffix: keySuffixOf(0) }, weight: 3 },
			{ provider: "openrouter", account: { keySuffix: keySuffixOf(1) }, weight: 1 },
		];
		for (const mode of ["rotate", "weight"] as const) {
			const counts = await withKeyPool(2, { routing: { mode, stays: "off" }, accountPolicies }, async select => {
				const picks = await Promise.all(Array.from({ length: 16 }, () => select()));
				return [0, 1].map(index => picks.filter(pick => pick === index).length);
			});
			expect({ mode, counts }).toEqual({ mode, counts: mode === "rotate" ? [8, 8] : [12, 4] });
		}
	});

	it("capPct or windowCapPct on a provider without usage reports raises the contract error", async () => {
		for (const cap of [{ capPct: 50 }, { windowCapPct: { "7d": 40 } }]) {
			for (const count of [1, 2]) {
				const field = "capPct" in cap ? "capPct" : "windowCapPct";
				await withKeyPool(
					count,
					{
						routing: { mode: "order" },
						accountPolicies: [{ provider: "openrouter", account: { keySuffix: keySuffixOf(0) }, ...cap }],
					},
					async select => {
						await expect(select("s")).rejects.toThrow(
							`auth.accountPolicies[0].${field} requires a usage provider for openrouter`,
						);
					},
				);
			}
		}
	});

	it("a live cap on a provider without usage reports is rejected, the previous settings stay, and it applies once usage registers", async () => {
		await forAll(CASES, async g => {
			const count = g.int(2, 5);
			const priorities = Array.from({ length: count }, () => g.int(0, 3));
			const first = priorities.indexOf(Math.max(...priorities));
			const accountPolicies = priorities.map((priority, index): AuthAccountPolicy => ({
				provider: "openrouter",
				account: { keySuffix: keySuffixOf(index) },
				priority,
			}));
			const capped = g.int(0, count - 1);
			const field = g.pick(["capPct", "windowCapPct"] as const);
			const next = {
				accountPolicies: accountPolicies.map((policy, index) =>
					index !== capped
						? policy
						: {
								...policy,
								...(field === "capPct" ? { capPct: g.int(1, 100) } : { windowCapPct: { "7d": g.int(1, 100) } }),
							},
				),
				defaultReservePct: g.int(0, 50),
				routing: { openrouter: { mode: "rotate" as const } },
			};
			await withKeyPool(count, { routing: { mode: "order" }, accountPolicies }, async (select, authStorage) => {
				expect(() => authStorage.setAccountPolicies(next)).toThrow(
					`auth.accountPolicies[${capped}].${field} requires a usage provider for openrouter`,
				);
				expect(authStorage.routing.config("openrouter").mode).toBe("order");
				for (let request = 0; request < count; request += 1) expect(await select(`s-${request}`)).toBe(first);
				authStorage.usage.setProvider("openrouter", { id: "openrouter", fetchUsage: async () => null });
				authStorage.setAccountPolicies(next);
				expect(authStorage.routing.config("openrouter").mode).toBe("rotate");
			});
		});
	});
});

describe("disabled accounts", () => {
	const lowAccounts = (count: number): Account[] =>
		Array.from({ length: count }, () => ({
			usage: { primary: 0.1, secondary: 0.1, secondaryResetMs: 72 * HOUR_MS },
		}));
	const emails = (count: number) => Array.from({ length: count }, (_account, index) => emailOf(index));
	/** Contract E3. */
	const noKeyText = (provider: string, labels: readonly string[]) =>
		`No API key for provider: ${provider} (auth.accountPolicies disables ${labels.join(", ")}, and no other account or key can serve. Remove a disabled mark to use this provider.)`;
	/** Contract E2. */
	const strictText = (sessionId: string, label: string) =>
		`No API key for provider: ${PROVIDER} (session ${sessionId} stays on ${label} under \`stays: strict\`, and auth.accountPolicies disables that account. Remove its disabled mark, change \`stays\`, or pin another account to this session.)`;
	/** A request's value, or its error. */
	const settle = (promise: Promise<unknown>): Promise<unknown> =>
		promise.then(
			value => value,
			(error: unknown) => error,
		);
	const errorText = (value: unknown) =>
		value instanceof AIError.MissingApiKeyError ? value.message : `not a missing-key error: ${String(value)}`;
	const marked = (accounts: readonly Account[], disabled: (index: number) => boolean): Account[] =>
		accounts.map((account, index) => ({ ...account, disabled: disabled(index) }));
	/** Apply `accounts`' policies live, as a settings reload does. */
	const applyPolicies = (
		authStorage: AuthStorage,
		accounts: readonly Account[],
		routing: ProviderRouting,
		extra: readonly AuthAccountPolicy[] = [],
	) =>
		authStorage.setAccountPolicies({
			accountPolicies: [...policiesFor(accounts), ...extra],
			defaultReservePct: DEFAULT_USAGE_RESERVE_PCT,
			routing: { [PROVIDER]: routing },
		});
	/** Account ids the OAuth exchange serves from now on. */
	const recordServed = () => {
		const served: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials[PROVIDER] as OAuthCredentials;
			served.push(credential.accountId!);
			return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
		});
		return served;
	};
	const listen = (authStorage: AuthStorage) => {
		const events: SessionAccountDisabledEvent[] = [];
		authStorage.sessions.onAccountDisabled(event => events.push(event));
		return events;
	};

	it("no mode selects a disabled account, not even when every enabled account is blocked or past its cap, and removing the mark makes it selectable again (FR-002)", async () => {
		await withoutEnvKeys([PROVIDER], () =>
			forAll(CASES, async g => {
				const mode = g.pick(MODES);
				const routing: ProviderRouting = { mode, stays: "off" };
				const allDisabled = g.chance(0.15);
				// Every enabled account is blocked or over its cap, so only a last fallback can serve.
				const unusable = g.chance(0.3);
				const accounts: Account[] = Array.from({ length: g.int(1, 6) }, () => {
					const account: Account = {
						usage: randomUsage(g, true),
						disabled: allDisabled || g.chance(0.4),
						...(g.chance(0.5) ? { priority: g.int(0, 3) } : {}),
						...(g.chance(0.3) ? { weight: g.int(1, 5) } : {}),
						...(g.chance(0.4) ? { capPct: g.int(30, 99) } : {}),
					};
					if (unusable && !account.disabled) {
						if (g.chance(0.5)) {
							account.usage = { ...account.usage!, primary: 1 };
						} else {
							account.capPct = g.int(30, 90);
							account.usage = { ...account.usage!, primary: 0.1, secondary: account.capPct / 100 + 0.05 };
						}
					}
					return account;
				});
				const disabled = accounts.map(account => account.disabled === true);
				await withPool(accounts, { routing }, async pool => {
					for (let request = 0; request < 5; request += 1) {
						const served = await settle(pool.select(`s-${g.int(0, 2)}`));
						if (disabled.every(Boolean)) {
							expect({ mode, error: errorText(served) }).toEqual({
								mode,
								error: noKeyText(PROVIDER, emails(accounts.length)),
							});
						} else {
							const enabled = typeof served === "number" && served >= 0 && !disabled[served];
							expect({ mode, unusable, disabled, served, enabled }).toEqual({
								mode,
								unusable,
								disabled,
								served,
								enabled: true,
							});
						}
					}
					// The marks go: each account that had one serves again from its stored row, with no new sign-in.
					applyPolicies(
						pool.authStorage,
						marked(accounts, () => false),
						routing,
					);
					const unmarked = await pool.select("unmarked");
					expect({ mode, unmarked: unmarked >= 0 && unmarked < accounts.length }).toEqual({
						mode,
						unmarked: true,
					});
					for (const [index, wasDisabled] of disabled.entries()) {
						if (!wasDisabled) continue;
						applyPolicies(
							pool.authStorage,
							marked(accounts, other => other !== index),
							routing,
						);
						expect({ mode, index, served: await pool.select(`back-${index}`) }).toEqual({
							mode,
							index,
							served: index,
						});
					}
					expect(pool.authStorage.credentials.list(PROVIDER).map(row => row.id)).toEqual(pool.ids);
				});
			}),
		);
	});

	it("no mode selects a disabled API key, not even when every enabled key is blocked, and removing the mark makes it selectable again (FR-002)", async () => {
		await withoutEnvKeys(["openrouter"], () =>
			forAll(CASES, async g => {
				const mode = g.pick(MODES);
				const routing: ProviderRouting = { mode, stays: "off" };
				const allDisabled = g.chance(0.15);
				// Every enabled key is blocked, so only a last fallback can serve.
				const unusable = g.chance(0.3);
				const keys = Array.from({ length: g.int(1, 6) }, () => ({
					disabled: allDisabled || g.chance(0.4),
					priority: g.chance(0.5) ? g.int(0, 3) : undefined,
					weight: g.chance(0.3) ? g.int(1, 5) : undefined,
					blocked: unusable || g.chance(0.2),
				}));
				const disabled = keys.map(key => key.disabled);
				const policies = (isDisabled: (index: number) => boolean) =>
					keys.map((key, index): AuthAccountPolicy => ({
						provider: "openrouter",
						account: { keySuffix: keySuffixOf(index) },
						...(key.priority === undefined ? {} : { priority: key.priority }),
						...(key.weight === undefined ? {} : { weight: key.weight }),
						...(isDisabled(index) ? { disabled: true } : {}),
					}));
				await withKeyPool(
					keys.length,
					{ routing, accountPolicies: policies(index => disabled[index]!) },
					async (select, authStorage) => {
						const ids = authStorage.credentials.list("openrouter").map(row => row.id);
						for (const [index, key] of keys.entries()) {
							if (!key.blocked) continue;
							await authStorage.limits.markReached("openrouter", undefined, {
								credentialId: ids[index],
								retryAfterMs: HOUR_MS,
							});
						}
						const labels = keys.map((_key, index) => `key …${keyOf(index).slice(-4)}`);
						for (let request = 0; request < 5; request += 1) {
							const served = await settle(select(`s-${g.int(0, 2)}`));
							if (disabled.every(Boolean)) {
								expect({ mode, error: errorText(served) }).toEqual({
									mode,
									error: noKeyText("openrouter", labels),
								});
							} else {
								const enabled = typeof served === "number" && served >= 0 && !disabled[served];
								expect({ mode, unusable, disabled, served, enabled }).toEqual({
									mode,
									unusable,
									disabled,
									served,
									enabled: true,
								});
							}
						}
						const setPolicies = (isDisabled: (index: number) => boolean) =>
							authStorage.setAccountPolicies({
								accountPolicies: policies(isDisabled),
								defaultReservePct: DEFAULT_USAGE_RESERVE_PCT,
								routing: { openrouter: routing },
							});
						setPolicies(() => false);
						const unmarked = await select("unmarked");
						expect({ mode, unmarked: unmarked >= 0 && unmarked < keys.length }).toEqual({ mode, unmarked: true });
						for (const [index, wasDisabled] of disabled.entries()) {
							if (!wasDisabled) continue;
							setPolicies(other => other !== index);
							expect({ mode, index, served: await select(`back-${index}`) }).toEqual({
								mode,
								index,
								served: index,
							});
						}
						expect(authStorage.credentials.list("openrouter").map(row => row.id)).toEqual(ids);
					},
				);
			}),
		);
	});

	it("with every OAuth account disabled, the provider's enabled API key serves; with that key disabled too, the error names all of them", async () => {
		await withoutEnvKeys([PROVIDER], () =>
			forAll(CASES, async g => {
				const mode = g.pick(MODES);
				const stays = g.pick(STAYS);
				const routing: ProviderRouting = { mode, stays };
				const accounts: Account[] = Array.from({ length: g.int(1, 3) }, () => ({
					usage: randomUsage(g, true),
					disabled: true,
				}));
				const keyDisabled = g.chance(0.5);
				await withPool(accounts, { routing }, async pool => {
					// Keys resolve as `api-acct-<n>`, so this key reads as account 99.
					await pool.authStorage.credentials.upsert(PROVIDER, {
						type: "api_key",
						key: "api-acct-99",
						source: "login",
					});
					if (keyDisabled) {
						applyPolicies(pool.authStorage, accounts, routing, [
							{ provider: PROVIDER, account: { keySuffix: "t-99" }, disabled: true },
						]);
					}
					const results: unknown[] = [];
					for (let request = 0; request < 3; request += 1)
						results.push(await settle(pool.select(`s-${g.int(0, 1)}`)));
					const expected = keyDisabled ? noKeyText(PROVIDER, [...emails(accounts.length), "key …t-99"]) : 99;
					expect({
						mode,
						stays,
						keyDisabled,
						results: results.map(result => (typeof result === "number" ? result : errorText(result))),
					}).toEqual({ mode, stays, keyDisabled, results: [expected, expected, expected] });
				});
			}),
		);
	});

	it("describe() agrees with source() and the served account: it never names a disabled account", async () => {
		await withoutEnvKeys([PROVIDER], () =>
			forAll(CASES, async g => {
				const mode = g.pick(MODES);
				const allDisabled = g.chance(0.25);
				const accounts: Account[] = Array.from({ length: g.int(1, 4) }, () => ({
					usage: randomUsage(g, true),
					disabled: allDisabled || g.chance(0.5),
				}));
				await withPool(accounts, { routing: { mode, stays: "session" } }, async pool => {
					const { keys } = pool.authStorage;
					const enabled = accounts.flatMap((account, index) => (account.disabled ? [] : [emailOf(index)]));
					if (enabled.length === 0) {
						expect({ mode, source: keys.source(PROVIDER), describe: keys.describe(PROVIDER) }).toEqual({
							mode,
							source: undefined,
							describe: undefined,
						});
						return;
					}
					const named = (text: string | undefined) => /\(([^)]+)\)$/.exec(text ?? "")?.[1];
					const served = emailOf(await pool.select("s"));
					expect({
						mode,
						unpinned: enabled.includes(named(keys.describe(PROVIDER)) ?? ""),
						pinned: named(keys.describe(PROVIDER, "s")),
					}).toEqual({ mode, unpinned: true, pinned: served });
				});
			}),
		);
	});

	it("accessAll resolves every enabled account and never a disabled one", async () => {
		await forAll(CASES, async g => {
			const accounts: Account[] = Array.from({ length: g.int(1, 4) }, () => ({
				usage: randomUsage(g, true),
				disabled: g.chance(0.5),
			}));
			await withPool(accounts, { routing: { mode: g.pick(MODES) } }, async pool => {
				const enabled = accounts.flatMap((account, index) => (account.disabled ? [] : [emailOf(index)]));
				const resolved = await pool.authStorage.oauth.accessAll(PROVIDER);
				expect(resolved.map(access => access.email)).toEqual(enabled);
			});
		});
	});

	it("an unpinned session's active account is never a disabled one", async () => {
		await withoutEnvKeys([PROVIDER], () =>
			forAll(CASES, async g => {
				const accounts: Account[] = Array.from({ length: g.int(1, 4) }, () => ({
					usage: randomUsage(g, true),
					disabled: g.chance(0.5),
				}));
				await withPool(accounts, { routing: { mode: g.pick(MODES) } }, async pool => {
					const enabled = accounts.flatMap((account, index) => (account.disabled ? [] : [emailOf(index)]));
					const email = pool.authStorage.oauth.identity(PROVIDER, "unpinned")?.email;
					expect({ enabled, email: enabled.length === 0 ? email : enabled.includes(email ?? "") }).toEqual({
						enabled,
						email: enabled.length === 0 ? undefined : true,
					});
				});
			}),
		);
	});

	it("a pinned account that becomes disabled stops being the active account, unless strict holds it", async () => {
		await withoutEnvKeys([PROVIDER], () =>
			forAll(CASES, async g => {
				const stays = g.pick(STAYS);
				const routing: ProviderRouting = { mode: g.pick(MODES), stays };
				const accounts: Account[] = Array.from({ length: g.int(1, 4) }, () => ({ usage: randomUsage(g, true) }));
				const explicit = g.chance(0.5);
				await withPool(accounts, { routing }, async pool => {
					const pinned = explicit ? g.int(0, accounts.length - 1) : await pool.select("s");
					if (explicit) expect(pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[pinned]!)).toBe(true);
					const disabled = new Set([pinned, ...accounts.flatMap((_a, index) => (g.chance(0.4) ? [index] : []))]);
					applyPolicies(
						pool.authStorage,
						marked(accounts, index => disabled.has(index)),
						routing,
					);
					const held = stays === "strict" && !explicit;
					const enabled = accounts.flatMap((_a, index) => (disabled.has(index) ? [] : [emailOf(index)]));
					const identity = pool.authStorage.oauth.identity(PROVIDER, "s")?.email;
					const active = pool.authStorage.oauth.accounts(PROVIDER, "s").find(account => account.active)?.email;
					expect({
						stays,
						explicit,
						identity: held ? identity : identity === undefined || enabled.includes(identity),
						active,
					}).toEqual({
						stays,
						explicit,
						identity: held ? emailOf(pinned) : true,
						active: held ? emailOf(pinned) : undefined,
					});
				});
			}),
		);
	});

	describe("token refresh (FR-003)", () => {
		type RefreshingPool = {
			authStorage: AuthStorage;
			store: SqliteAuthCredentialStore;
			ids: number[];
			/** Account ids the fake token endpoint refreshed, in call order. */
			refreshed: string[];
			/** Wait for every refresh the fake started, then for the save that follows it. */
			settle(): Promise<void>;
		};

		/** A real SQLite store and save path, with the token endpoint faked through `refreshOAuthCredential`. */
		async function withRefreshingPool(
			accounts: ReadonlyArray<{ disabled: boolean; expires: number }>,
			run: (pool: RefreshingPool) => Promise<void>,
		): Promise<void> {
			const refreshed: string[] = [];
			const pending: Promise<unknown>[] = [];
			vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
				const credential = credentials[PROVIDER] as OAuthCredentials;
				return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
			});
			const store = new SqliteAuthCredentialStore(new Database(":memory:"));
			const authStorage = new AuthStorage(store, {
				usageProviderResolver: () => undefined,
				accountPolicies: policiesFor(accounts.map(({ disabled }) => ({ disabled }))),
				routing: { [PROVIDER]: { mode: "order", stays: "off" } },
				refreshOAuthCredential: (_provider, _credentialId, credential) => {
					refreshed.push(credential.accountId!);
					const promise = Promise.resolve({
						...credential,
						access: `access-${credential.accountId}-new`,
						refresh: `refresh-${credential.accountId}-new`,
						expires: Date.now() + WEEK_MS,
					});
					pending.push(promise);
					return promise;
				},
			});
			try {
				await authStorage.credentials.set(
					PROVIDER,
					accounts.map((account, index) => ({
						type: "oauth" as const,
						...createCredential(accountId(index), emailOf(index)),
						expires: account.expires,
					})),
				);
				await run({
					authStorage,
					store,
					ids: authStorage.credentials.list(PROVIDER).map(row => row.id),
					refreshed,
					async settle() {
						await Promise.allSettled(pending);
						// `refreshStored` saves the row in a promise chain the selector does not return, after
						// the fake resolves. One zero-delay yield drains it; there is no promise to await instead.
						await Bun.sleep(0);
					},
				});
			} finally {
				vi.restoreAllMocks();
				store.close();
			}
		}

		const storedTokens = (pool: RefreshingPool, index: number) => {
			const credential = pool.store
				.listAuthCredentials(PROVIDER)
				.find(row => row.id === pool.ids[index])?.credential;
			return credential?.type === "oauth" ? { access: credential.access, refresh: credential.refresh } : undefined;
		};

		it("a disabled account whose token is near expiry is refreshed once and its row saves the new tokens, while another account serves", async () => {
			for (const disabledIndex of [0, 1]) {
				const accounts = [0, 1].map(index => ({
					disabled: index === disabledIndex,
					expires: Date.now() + (index === disabledIndex ? OAUTH_REFRESH_SKEW_MS / 2 : WEEK_MS),
				}));
				await withRefreshingPool(accounts, async pool => {
					const served = await pool.authStorage.keys.getWithCredential(PROVIDER, "s");
					await pool.settle();
					expect({
						disabledIndex,
						served: served?.apiKey,
						refreshed: pool.refreshed,
						row: storedTokens(pool, disabledIndex),
					}).toEqual({
						disabledIndex,
						served: `api-${accountId(1 - disabledIndex)}`,
						refreshed: [accountId(disabledIndex)],
						row: {
							access: `access-${accountId(disabledIndex)}-new`,
							refresh: `refresh-${accountId(disabledIndex)}-new`,
						},
					});
				});
			}
		});

		it("with every account disabled and expired, a request fails with the error that names them, and each account is still refreshed once", async () => {
			await withoutEnvKeys([PROVIDER], async () => {
				for (const count of [1, 2, 3]) {
					const accounts = Array.from({ length: count }, () => ({ disabled: true, expires: Date.now() - 1 }));
					await withRefreshingPool(accounts, async pool => {
						const result = await settle(pool.authStorage.keys.getWithCredential(PROVIDER, "s"));
						await pool.settle();
						expect({ count, error: errorText(result), refreshed: pool.refreshed.toSorted() }).toEqual({
							count,
							error: noKeyText(PROVIDER, emails(count)),
							refreshed: accounts.map((_account, index) => accountId(index)),
						});
					});
				}
			});
		});

		it("a disabled account whose token is fresh is not refreshed", async () => {
			const accounts = [0, 1].map(index => ({ disabled: index === 0, expires: Date.now() + WEEK_MS }));
			await withRefreshingPool(accounts, async pool => {
				const served = await pool.authStorage.keys.getWithCredential(PROVIDER, "s");
				await pool.settle();
				expect({ served: served?.apiKey, refreshed: pool.refreshed }).toEqual({
					served: `api-${accountId(1)}`,
					refreshed: [],
				});
			});
		});
	});

	describe("sessions", () => {
		it("an automatic pin on an account that becomes disabled moves to an enabled account under auto, session, turn, and off", async () => {
			await forAll(CASES, async g => {
				const mode = g.pick(MODES);
				const stays = g.pick(STAYS.filter(value => value !== "strict"));
				const routing: ProviderRouting = { mode, stays };
				const accounts = lowAccounts(g.int(2, 4));
				await withPool(accounts, { routing }, async pool => {
					const events = listen(pool.authStorage);
					const pinned = await pool.select("s");
					// The pinned account and maybe others are disabled; one stays enabled.
					const others = accounts.map((_account, index) => index).filter(index => index !== pinned);
					const kept = g.pick(others);
					const disabled = new Set([pinned, ...others.filter(index => index !== kept && g.chance(0.5))]);
					applyPolicies(
						pool.authStorage,
						marked(accounts, index => disabled.has(index)),
						routing,
					);
					const picks: number[] = [];
					for (let request = 0; request < 3; request += 1)
						picks.push(await pool.select("s", { withinTurn: true }));
					expect({
						mode,
						stays,
						picks,
						enabled: picks.every(pick => pick >= 0 && !disabled.has(pick)),
						events,
					}).toEqual({ mode, stays, picks, enabled: true, events: [] });
				});
			});
		});

		/** An explicit pin on an account that becomes disabled moves, and one warning names both accounts. */
		const explicitPinMoves = async (g: Gen, stays: StaysMode) => {
			const mode = g.pick(MODES);
			const routing: ProviderRouting = { mode, stays };
			const accounts = lowAccounts(g.int(2, 4));
			const pinned = g.int(0, accounts.length - 1);
			await withPool(accounts, { routing }, async pool => {
				const events = listen(pool.authStorage);
				expect(pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[pinned]!)).toBe(true);
				expect(await pool.select("s")).toBe(pinned);
				applyPolicies(
					pool.authStorage,
					marked(accounts, index => index === pinned),
					routing,
				);
				const picks: number[] = [];
				for (let request = 0; request < 5; request += 1) picks.push(await pool.select("s"));
				expect({ mode, stays, picks, enabled: picks.every(pick => pick >= 0 && pick !== pinned), events }).toEqual({
					mode,
					stays,
					picks,
					enabled: true,
					events: [{ provider: PROVIDER, sessionId: "s", label: emailOf(pinned), nextLabel: emailOf(picks[0]!) }],
				});
			});
		};

		it("an explicit pin on an account that becomes disabled moves to an enabled account and warns exactly once over 5 requests", async () => {
			await forAll(CASES, g => explicitPinMoves(g, g.pick(STAYS.filter(value => value !== "strict"))));
		});

		it("strict: an explicit pin on an account that becomes disabled moves to an enabled account and warns exactly once", async () => {
			await forAll(CASES, g => explicitPinMoves(g, "strict"));
		});

		it("strict: an automatic pin on an account that becomes disabled fails every request with the strict error and uses no other credential, until the mark goes", async () => {
			await withEnvKey(async () => {
				await forAll(CASES, async g => {
					const mode = g.pick(MODES);
					const routing: ProviderRouting = { mode, stays: "strict" };
					const accounts = lowAccounts(g.int(2, 4));
					const pinned = g.int(0, accounts.length - 1);
					await withPool(accounts, { routing }, async pool => {
						// Keys resolve as `api-acct-<n>`: the login key reads as 99, the env key as 98.
						await pool.authStorage.credentials.upsert(PROVIDER, {
							type: "api_key",
							key: "api-acct-99",
							source: "login",
						});
						const events = listen(pool.authStorage);
						expect(
							pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[pinned]!, { restoredAtMs: Date.now() }),
						).toBe(true);
						expect(await pool.select("s")).toBe(pinned);
						const served = recordServed();
						applyPolicies(
							pool.authStorage,
							marked(accounts, index => index === pinned),
							routing,
						);
						const errors: string[] = [];
						for (let request = 0; request < 3; request += 1)
							errors.push(errorText(await settle(pool.select("s"))));
						expect({ mode, errors, served, events }).toEqual({
							mode,
							errors: Array(3).fill(strictText("s", emailOf(pinned))),
							served: [],
							events: [],
						});
						applyPolicies(pool.authStorage, accounts, routing);
						expect({ mode, back: await pool.select("s") }).toEqual({ mode, back: pinned });
					});
				});
			});
		});

		it("with every account disabled, a request fails with the error that names them, whatever the pin; a strict automatic pin gets the strict error", async () => {
			await withoutEnvKeys([PROVIDER], () =>
				forAll(CASES, async g => {
					const mode = g.pick(MODES);
					const stays = g.pick(STAYS);
					const routing: ProviderRouting = { mode, stays };
					const accounts = lowAccounts(g.int(1, 4));
					const pin = g.pick(["none", "explicit", "automatic"] as const);
					const pinned = g.int(0, accounts.length - 1);
					await withPool(accounts, { routing }, async pool => {
						const events = listen(pool.authStorage);
						if (pin !== "none") {
							const pinOptions = pin === "automatic" ? { restoredAtMs: Date.now() } : undefined;
							expect(pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[pinned]!, pinOptions)).toBe(true);
							const first = await pool.select("s");
							if (pin === "explicit" || stays === "strict") expect(first).toBe(pinned);
						}
						applyPolicies(
							pool.authStorage,
							marked(accounts, () => true),
							routing,
						);
						const expected =
							stays === "strict" && pin === "automatic"
								? strictText("s", emailOf(pinned))
								: noKeyText(PROVIDER, emails(accounts.length));
						const errors = [errorText(await settle(pool.select("s"))), errorText(await settle(pool.select("s")))];
						expect({ mode, stays, pin, errors, events }).toEqual({
							mode,
							stays,
							pin,
							errors: [expected, expected],
							events: [],
						});
					});
				}),
			);
		});

		it("a pin restored on a disabled account moves to an enabled account on the first request, with no warning", async () => {
			await forAll(CASES, async g => {
				const mode = g.pick(MODES);
				const stays = g.pick(STAYS.filter(value => value !== "strict"));
				const count = g.int(2, 4);
				const pinned = g.int(0, count - 1);
				const accounts = marked(lowAccounts(count), index => index === pinned);
				await withPool(accounts, { routing: { mode, stays } }, async pool => {
					const events = listen(pool.authStorage);
					expect(
						pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[pinned]!, { restoredAtMs: Date.now() }),
					).toBe(true);
					const first = await pool.select("s", { withinTurn: true });
					expect({ mode, stays, first, moved: first >= 0 && first !== pinned, events }).toEqual({
						mode,
						stays,
						first,
						moved: true,
						events: [],
					});
				});
			});
		});

		it("strict: a pin restored on a disabled account fails with the strict error and does not move, until the mark goes", async () => {
			await forAll(CASES, async g => {
				const mode = g.pick(MODES);
				const routing: ProviderRouting = { mode, stays: "strict" };
				const count = g.int(2, 4);
				const pinned = g.int(0, count - 1);
				const accounts = lowAccounts(count);
				await withPool(
					marked(accounts, index => index === pinned),
					{ routing },
					async pool => {
						const events = listen(pool.authStorage);
						const served = recordServed();
						expect(
							pool.authStorage.sessions.pin(PROVIDER, "s", pool.ids[pinned]!, { restoredAtMs: Date.now() }),
						).toBe(true);
						const errors: string[] = [];
						for (let request = 0; request < 3; request += 1)
							errors.push(errorText(await settle(pool.select("s"))));
						expect({ mode, errors, served, events }).toEqual({
							mode,
							errors: Array(3).fill(strictText("s", emailOf(pinned))),
							served: [],
							events: [],
						});
						applyPolicies(pool.authStorage, accounts, routing);
						expect({ mode, back: await pool.select("s") }).toEqual({ mode, back: pinned });
					},
				);
			});
		});

		it("a subagent that inherits its parent's pins never uses the disabled account, whether it inherits before or after the mark", async () => {
			await forAll(CASES, async g => {
				const mode = g.pick(MODES);
				const stays = g.pick(STAYS);
				const routing: ProviderRouting = { mode, stays };
				const accounts = lowAccounts(g.int(2, 4));
				const pinned = g.int(0, accounts.length - 1);
				const explicit = g.chance(0.5);
				const inheritFirst = g.chance(0.5);
				await withPool(accounts, { routing }, async pool => {
					const { sessions } = pool.authStorage;
					const pinOptions = explicit ? undefined : { restoredAtMs: Date.now() };
					expect(sessions.pin(PROVIDER, "parent", pool.ids[pinned]!, pinOptions)).toBe(true);
					await pool.select("parent");
					if (inheritFirst) sessions.inherit("parent", "child");
					applyPolicies(
						pool.authStorage,
						marked(accounts, index => index === pinned),
						routing,
					);
					if (!inheritFirst) sessions.inherit("parent", "child");
					const outcomes: string[] = [];
					for (let request = 0; request < 3; request += 1) {
						const result = await settle(pool.select("child"));
						outcomes.push(
							typeof result === "number"
								? result >= 0 && result !== pinned
									? "enabled account"
									: `account ${result}`
								: result instanceof AIError.MissingApiKeyError
									? "no key"
									: String(result),
						);
					}
					// A strict automatic pin never moves, so the child gets no key rather than the disabled account.
					const expected = stays === "strict" && !explicit ? "no key" : "enabled account";
					expect({ mode, stays, explicit, inheritFirst, outcomes }).toEqual({
						mode,
						stays,
						explicit,
						inheritFirst,
						outcomes: [expected, expected, expected],
					});
				});
			});
		});
	});
});
