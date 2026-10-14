import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { credentialPinHash } from "@oh-my-pi/pi-ai/auth/affinity";
import { resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";
import { recordCredentialPin, seedCredentialPins } from "../src/session/credential-pin";
import { SessionManager } from "../src/session/session-manager";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

function mintOAuthCredential(suffix: string, extra?: { orgId?: string }) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
		...extra,
	};
}

function assistantMessage(provider: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "hi" }],
		api: "anthropic-messages",
		provider,
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp,
	};
}

describe("credential pins", () => {
	let tempDir: TempDir;
	let storage: AuthStorage;

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = TempDir.createSync("@pi-credential-pin-");
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		await store.saveOAuth("anthropic", mintOAuthCredential("a"));
		await store.saveOAuth("anthropic", mintOAuthCredential("b"));
		storage = new AuthStorage(store);
		await storage.credentials.reload();
	});

	afterEach(() => {
		for (const key of ANTHROPIC_ENV) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		tempDir[Symbol.dispose]();
	});

	test("pin entries survive a session reload and the latest pin per provider wins", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("anthropic", Date.now()));
		manager.appendCredentialPin("anthropic", "hash-old");
		manager.appendCredentialPin("openai-codex", "hash-codex");
		manager.appendCredentialPin("anthropic", "hash-new");
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");

		const reopened = await SessionManager.open(file);
		const pins = reopened.getCredentialPins();
		expect(pins.get("anthropic")?.hash).toBe("hash-new");
		expect(pins.get("openai-codex")?.hash).toBe("hash-codex");
	});

	test("later assistant turns advance the pin's effective last-use; other providers and new pins do not", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const pinId = manager.appendCredentialPin("anthropic", "hash-a");
		const pinnedAt = new Date(manager.getEntry(pinId)!.timestamp).getTime();

		// Long session on one account: no new pin entries, only assistant turns.
		const lastTurnAt = pinnedAt + 3 * 60 * 60 * 1000;
		manager.appendMessage(assistantMessage("anthropic", pinnedAt + 60_000));
		manager.appendMessage(assistantMessage("anthropic", lastTurnAt));
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(lastTurnAt);

		// A different provider's turn never advances this provider's pin.
		manager.appendMessage(assistantMessage("openai-codex", lastTurnAt + 60_000));
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(lastTurnAt);

		// An account change re-bases last-use at the new pin.
		const newPinId = manager.appendCredentialPin("anthropic", "hash-b");
		const newPinnedAt = new Date(manager.getEntry(newPinId)!.timestamp).getTime();
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(newPinnedAt);
	});

	test("seeding re-pins the recorded account in a store with no session stickiness", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		if (!hash) throw new Error("expected a pin hash");
		manager.appendCredentialPin("anthropic", hash);

		// Fresh process: no sticky exists yet (the broker-mode resume scenario).
		expect(storage.oauth.accounts("anthropic", sessionId).some(account => account.active)).toBe(false);

		seedCredentialPins(storage, manager, sessionId);

		const active = storage.oauth.accounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-b");
	});

	test("pins are org-scoped: the same account in two orgs re-pins the matching org credential", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		await store.saveOAuth("anthropic", mintOAuthCredential("x", { orgId: "org-1" }));
		await store.saveOAuth("anthropic", mintOAuthCredential("x", { orgId: "org-2" }));
		const orgStorage = new AuthStorage(store);
		await orgStorage.credentials.reload();

		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const identity = { accountId: "account-x", email: "x@example.com" };
		const orgTwoHash = credentialPinHash("anthropic", { ...identity, orgId: "org-2" });
		if (!orgTwoHash) throw new Error("expected a pin hash");
		expect(orgTwoHash).not.toBe(credentialPinHash("anthropic", { ...identity, orgId: "org-1" }));
		manager.appendCredentialPin("anthropic", orgTwoHash);

		seedCredentialPins(orgStorage, manager, sessionId);

		const active = orgStorage.oauth.accounts("anthropic", sessionId).find(account => account.active);
		expect(active?.orgId).toBe("org-2");
	});

	test("seeding never clobbers a live sticky from the same process", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accounts = storage.oauth.accounts("anthropic", sessionId);
		const accountA = accounts.find(account => account.accountId === "account-a");
		expect(storage.sessions.pin("anthropic", sessionId, accountA!.credentialId)).toBe(true);

		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hash!);
		seedCredentialPins(storage, manager, sessionId);

		const active = storage.oauth.accounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-a");
	});

	test("seeding advances a same-account sticky that is older than the session-file pin", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hash!);
		const pinLastUsedAt = manager.getCredentialPins().get("anthropic")!.lastUsedAt;
		const accountB = storage.oauth
			.accounts("anthropic", sessionId)
			.find(account => account.accountId === "account-b");
		// A lazily-persisted sticky for the same account, older than the session's last turn.
		storage.sessions.pin("anthropic", sessionId, accountB!.credentialId, { restoredAtMs: pinLastUsedAt - 600_000 });

		seedCredentialPins(storage, manager, sessionId);

		const active = storage.oauth.accounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-b");
		expect(active?.lastUsedAtMs).toBe(pinLastUsedAt);
	});

	test("seeding never rewinds a same-account sticky that is newer than the pin", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hash!);
		const newerUse = manager.getCredentialPins().get("anthropic")!.lastUsedAt + 60_000;
		const accountB = storage.oauth
			.accounts("anthropic", sessionId)
			.find(account => account.accountId === "account-b");
		storage.sessions.pin("anthropic", sessionId, accountB!.credentialId, { restoredAtMs: newerUse });

		seedCredentialPins(storage, manager, sessionId);

		expect(storage.oauth.accounts("anthropic", sessionId).find(account => account.active)?.lastUsedAtMs).toBe(
			newerUse,
		);
	});

	test("seeding is a no-op when the pinned account is no longer stored", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-gone" });
		manager.appendCredentialPin("anthropic", hash!);

		seedCredentialPins(storage, manager, sessionId);

		expect(storage.oauth.accounts("anthropic", sessionId).some(account => account.active)).toBe(false);
	});

	test("recording appends the serving account's hash once and dedupes repeats", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accounts = storage.oauth.accounts("anthropic", sessionId);
		const accountA = accounts.find(account => account.accountId === "account-a");
		storage.sessions.pin("anthropic", sessionId, accountA!.credentialId);

		recordCredentialPin(storage, manager, sessionId, "anthropic");
		recordCredentialPin(storage, manager, sessionId, "anthropic");

		const entries = manager.getBranch().filter(entry => entry.type === "credential_pin");
		expect(entries).toHaveLength(1);
		const identity = storage.oauth.identity("anthropic", sessionId);
		expect(manager.getCredentialPins().get("anthropic")?.hash).toBe(credentialPinHash("anthropic", identity!));
	});

	test("a strict session whose account is gone keeps failing after a restart that lost the store's hold", async () => {
		// Contract (FR-013): a remote broker keeps the strict hold in memory only. On resume, the
		// session file's pin brings it back without naming the account. The session goes back to
		// that account when it signs in again. Any other change in the provider's accounts, a
		// session that is not strict, or a pin past its lifetime leaves the session to pick as one
		// with no recorded account would. A broker client whose account pool hides the account
		// cannot tell it from a removed one, so it stays held too. A session pool (`restrict`) keeps
		// the hold only while an account in the pool has the pin's hash, so a pool without the
		// account (even once that account signs out again), or a pool set while the account is gone,
		// picks within the pool. A hold the store still has is never replaced. Seeded: mode, 0-3
		// accounts left, which account was pinned, and the case.
		const SEED = Number(process.env.ROUTING_SEED ?? 20_260_511);
		let state = SEED >>> 0;
		const next = (n: number) => {
			state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
			// The low bits of this generator cycle quickly; draw from the high ones.
			return (state >>> 16) % n;
		};
		const cases = [
			"strict",
			"signs-in-again",
			"other-signs-in",
			"removal",
			"not-strict",
			"account-pool",
			"store-hold",
			"stale",
			"pool-with-it",
			"pool-while-gone",
			"pool-without-it",
			"pool-without-it-then-removed",
		] as const;
		const pinTtlMs = 30 * 24 * 60 * 60 * 1000;
		const account = (suffix: string) => ({
			...mintOAuthCredential(suffix),
			expires: Date.now() + 2 * pinTtlMs,
		});
		for (let run = 0; run < 72; run++) {
			const mode = (["order", "rotate", "weight"] as const)[next(3)];
			const left = next(4);
			const pinned = next(left + 1);
			const kase = cases[run % cases.length];
			const stays = kase === "not-strict" ? "turn" : "strict";
			const db = new Database(":memory:");
			// One process: the credentials persist in `db`; the cache lives as long as `cache`.
			const start = async (cache: Map<string, string>, staysMode: "strict" | "turn", hidePinned = false) => {
				const store = new SqliteAuthCredentialStore(db);
				store.getCache = key => cache.get(key) ?? null;
				store.setCache = (key, value) => void (value === "" ? cache.delete(key) : cache.set(key, value));
				store.deleteCachePrefix = prefix => {
					for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
				};
				store.cleanExpiredCache = () => {};
				if (hidePinned) {
					// A broker account pool: this client never sees the pinned account, which still exists.
					const list = store.listAuthCredentials.bind(store);
					store.listAuthCredentials = provider =>
						list(provider).filter(
							row => row.credential.type !== "oauth" || row.credential.accountId !== `account-k${pinned}`,
						);
				}
				const auth = new AuthStorage(store);
				await auth.credentials.reload();
				auth.setAccountPolicies({
					accountPolicies: [],
					defaultReservePct: 10,
					routing: { anthropic: { mode, stays: staysMode } },
				});
				return auth;
			};
			const outcomeOf = (auth: AuthStorage, sessionId: string) =>
				auth.keys.get("anthropic", sessionId).then(
					key => key ?? "none",
					(error: Error) =>
						error.message.includes("the account this session used")
							? "held"
							: error.message.includes(`k${pinned}@example.com`)
								? "held by the store"
								: `error: ${error.message}`,
				);
			try {
				const seedStore = new SqliteAuthCredentialStore(db);
				for (let i = 0; i <= left; i++) await seedStore.saveOAuth("anthropic", account(`k${i}`));
				const manager = SessionManager.create(tempDir.path(), tempDir.path());
				const sessionId = manager.getSessionId();

				// Before the restart: the session stays on its account, which then signs out.
				const firstCache = new Map<string, string>();
				const first = await start(firstCache, "strict");
				const credentialId = first.oauth
					.accounts("anthropic", sessionId)
					.find(summary => summary.accountId === `account-k${pinned}`)?.credentialId;
				if (credentialId === undefined) throw new Error(`Expected account-k${pinned}`);
				first.sessions.pin("anthropic", sessionId, credentialId, { restoredAtMs: Date.now() });
				expect(await first.keys.get("anthropic", sessionId)).toBe(`access-k${pinned}`);
				recordCredentialPin(first, manager, sessionId, "anthropic");
				if (kase !== "account-pool") await first.credentials.removeById("anthropic", credentialId);

				// The restart: a local store keeps its cache; a broker's is gone.
				if (kase === "stale") setSystemTime(new Date(Date.now() + pinTtlMs + 60_000));
				const resumed = await start(kase === "store-hold" ? firstCache : new Map(), stays, kase === "account-pool");
				seedCredentialPins(resumed, manager, sessionId);
				const remaining = resumed.oauth.accounts("anthropic", sessionId);
				// The session pool: every account left, plus the pinned one unless the case leaves it out.
				const pool = Array.from({ length: left + 1 }, (_, i) => i)
					.filter(i => !kase.startsWith("pool-without-it") || i !== pinned)
					.map(i => resolveCredentialIdentityKey("anthropic", account(`k${i}`))!);
				const restrict = (auth: AuthStorage) => {
					if (kase.startsWith("pool-")) auth.sessions.restrict("anthropic", sessionId, pool);
				};
				if (kase === "pool-while-gone") restrict(resumed);
				if (kase === "signs-in-again" || kase.startsWith("pool-")) {
					await resumed.credentials.upsert("anthropic", account(`k${pinned}`));
				}
				if (kase === "other-signs-in") await resumed.credentials.upsert("anthropic", account("new"));
				if (kase === "removal" && remaining.length > 0) {
					await resumed.credentials.removeById("anthropic", remaining[next(remaining.length)]!.credentialId);
				}
				if (kase !== "pool-while-gone") restrict(resumed);
				if (kase === "pool-without-it-then-removed") {
					// The account outside the pool signs out again before any request: the ids are back
					// to the ones the restored hold recorded, so only `restrict` can have dropped it.
					const again = resumed.oauth
						.accounts("anthropic")
						.find(summary => summary.accountId === `account-k${pinned}`)?.credentialId;
					if (again === undefined) throw new Error(`Expected account-k${pinned} back`);
					await resumed.credentials.removeById("anthropic", again);
				}
				const outcome = await outcomeOf(resumed, sessionId);
				// The same session in a process that never saw its session file.
				const control = await start(new Map(), stays);
				restrict(control);
				const unrecorded = await outcomeOf(control, sessionId);
				const expected =
					kase === "strict" || kase === "account-pool" || (kase === "removal" && remaining.length === 0)
						? "held"
						: kase === "store-hold"
							? "held by the store"
							: kase === "signs-in-again" || kase === "pool-with-it"
								? `access-k${pinned}`
								: unrecorded;
				if (outcome !== expected) {
					throw new Error(
						`ROUTING_SEED=${SEED} run=${run} case=${kase} mode=${mode} left=${left} pinned=${pinned}: ` +
							`got ${outcome}, want ${expected}`,
					);
				}
			} finally {
				setSystemTime();
				db.close();
			}
		}
	});
});
