import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MessageChannel } from "node:worker_threads";
import {
	type AuthAccountPolicy,
	AuthStorage,
	type ProviderRouting,
	type RoutingMode,
	type SessionAccountDisabledEvent,
	type StaysMode,
	SqliteAuthCredentialStore,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import { credentialPinHash } from "@oh-my-pi/pi-ai/auth/affinity";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { ModelRegistry } from "../../src/config/model-registry";
import { anthropicSlowModeLanes } from "../../src/session/anthropic-slow-mode";
import type { MainThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { WorkerPeer } from "../../src/thread/services";
import { authService } from "../../src/thread/services/auth";
import type { AuthProbe, AuthTestGlobals } from "../fixtures/auth-service-worker";

const PROVIDER = "unit-oauth-thread";
const KEYS_PROVIDER = "unit-keys-thread";
const EMPTY_PROVIDER = "unit-empty-thread";
const LANE = "cred:thread-test";
const MODES: readonly RoutingMode[] = ["smart", "order", "rotate", "weight", "usage", "pace"];
const STAYS: readonly StaysMode[] = ["auto", "session", "turn", "off", "strict"];
const HOUR_MS = 60 * 60_000;
const SEED = Number(process.env.AUTH_THREAD_SEED ?? 20_260_520);

type Gen = {
	int(min: number, max: number): number;
	pick<T>(items: readonly T[]): T;
	chance(probability: number): boolean;
};

/** mulberry32: small and seedable; `AUTH_THREAD_SEED` replays a failure. */
function gen(seed: number): Gen {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
	return {
		int: (min, max) => min + Math.floor(next() * (max - min + 1)),
		pick: items => items[Math.floor(next() * items.length)]!,
		chance: probability => next() < probability,
	};
}

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("auth thread service", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let registry: ModelRegistry;
	let worker: Worker | undefined;
	let link: MainThreadLink | undefined;
	let peer: WorkerPeer;
	let probe: AuthProbe;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-thread-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		const modelsPath = path.join(tempDir, "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					"unit-mirror": {
						baseUrl: "https://unit-mirror.example.invalid/v1",
						api: "openai-completions",
						apiKey: "mirror-config-key",
						models: [{ id: "mirror-model", name: "Mirror Model" }],
					},
				},
			}),
		);
		registry = new ModelRegistry(storage, modelsPath, { cacheDbPath: path.join(tempDir, "models.db") });

		const spawned = new Worker(new URL("../fixtures/auth-service-worker.ts", import.meta.url).href, {
			type: "module",
		});
		worker = spawned;
		const channel = new MessageChannel();
		const counter = new SharedArrayBuffer(4);
		const { promise: ready, resolve: onReady } = Promise.withResolvers<void>();
		const readyListener = (event: MessageEvent): void => {
			if (event.data?.ready) {
				spawned.removeEventListener("message", readyListener);
				onReady();
			}
		};
		spawned.addEventListener("message", readyListener);
		spawned.postMessage({ sync: channel.port2, counter }, [channel.port2]);
		await ready;
		const mainLink: MainThreadLink = new RpcLink(
			{
				send: frame => spawned.postMessage(frame),
				listen: handler => {
					const listener = (event: MessageEvent<RpcFrame>): void => handler(event.data);
					spawned.addEventListener("message", listener);
					return () => spawned.removeEventListener("message", listener);
				},
			},
			{ name: "main↔auth-fixture", syncReplies: { port: channel.port1, counter: new Int32Array(counter) } },
		);
		link = mainLink;
		mainLink.handle("ping", nonce => nonce);
		peer = { threadId: "w1", link: mainLink };
		authService.installMain?.(peer);
		const { promise: probed, resolve: onProbe } = Promise.withResolvers<AuthProbe>();
		const test: AuthTestGlobals = { storage, ready: received => onProbe(received) };
		await mainLink.call("boot", { [authService.name]: authService.globals?.(peer), test });
		probe = await probed;
	});

	afterEach(async () => {
		link?.close("test done");
		link = undefined;
		await worker?.terminate();
		worker = undefined;
		anthropicSlowModeLanes.lane(LANE).reset();
		vi.restoreAllMocks();
		storage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function storeAccounts(): Promise<{ a: number; b: number }> {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [a, b] = storage.oauth.accounts(PROVIDER);
		if (!a || !b) throw new Error("expected two stored accounts");
		return { a: a.credentialId, b: b.credentialId };
	}

	it("hands the worker one canonical AuthStorage that resolves on the main instance", async () => {
		const { b } = await storeAccounts();
		expect(await probe.sameStorage(storage)).toBe(true);
		expect(storage.sessions.pin(PROVIDER, "pinned", b)).toBe(true);

		expect(await probe.key(PROVIDER, "pinned")).toBe("access-b");
		expect(await probe.accountId(PROVIDER, "pinned")).toBe("acc-b");
	});

	it("restricts main lookups with a worker lease until the worker unrestricts", async () => {
		const { a, b } = await storeAccounts();
		const handle = await probe.restrict(PROVIDER, "child", ["account:acc-b"]);

		expect(storage.sessions.permits(PROVIDER, "child", a)).toBe(false);
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-b");
		expect(await probe.key(PROVIDER, "child")).toBe("access-b");

		await probe.unrestrict(PROVIDER, "child", handle);
		expect(storage.sessions.permits(PROVIDER, "child", a)).toBe(true);
		expect(storage.sessions.permits(PROVIDER, "child", b)).toBe(true);
	});

	it("rebuilds main-thread auth errors by class in the worker", async () => {
		await storeAccounts();
		await probe.restrict(PROVIDER, "nowhere", ["account:acc-z"]);

		const outcome = await probe.keyError(PROVIDER, "nowhere");
		expect(outcome.missingApiKey).toBe(true);
		expect(outcome.message).toContain(`No API key for provider: ${PROVIDER}`);
	});

	it("releases every lease a worker holds when it exits", async () => {
		const { a } = await storeAccounts();
		await probe.restrict(PROVIDER, "orphan", ["account:acc-b"]);
		expect(storage.sessions.permits(PROVIDER, "orphan", a)).toBe(false);

		authService.onWorkerExit?.(peer, "crashed");
		expect(storage.sessions.permits(PROVIDER, "orphan", a)).toBe(true);
	});

	it("delivers main credential events to worker listeners until they unsubscribe", async () => {
		await probe.watchGenerations();
		await storeAccounts();
		// Frames to the worker are ordered: the listener call lands before this read.
		expect((await probe.generations()).at(-1)).toBe(storage.credentials.generation);

		await probe.unwatchGenerations();
		const seen = (await probe.generations()).length;
		await storage.credentials.remove(PROVIDER);
		expect((await probe.generations()).length).toBe(seen);
	});

	it("answers worker auth availability from one cached batch until main's credentials change", async () => {
		// Main lists stored providers once per batch.
		const batches = vi.spyOn(storage.credentials, "all");
		const keyless = vi.spyOn(storage.keys, "keyless");
		// The first lookup brings every bundled provider along with the asked one.
		expect(await probe.sourceKinds([PROVIDER, "anthropic", "openai"])).toHaveLength(3);
		expect(batches).toHaveBeenCalledTimes(1);
		const answered = new Set(keyless.mock.calls.map(([provider]) => provider));
		for (const provider of [PROVIDER, "anthropic", "openai"]) expect(answered.has(provider)).toBe(true);

		// A provider main did not list costs an answer of its own, not another batch.
		expect(await probe.sourceKinds([PROVIDER, "unit-other"])).toEqual([undefined, undefined]);
		expect(await probe.sourceKinds([PROVIDER, "unit-other", "anthropic"])).toHaveLength(3);
		expect(batches).toHaveBeenCalledTimes(1);

		// The generation bump reaches the worker before this probe call (frames are ordered).
		await storeAccounts();
		expect(await probe.sourceKinds([PROVIDER, "unit-other"])).toEqual(["oauth", undefined]);
		expect(batches).toHaveBeenCalledTimes(2);
	});

	it("resolves a worker's OAuth identity from main once main stores an account after the worker saw none", async () => {
		expect(await probe.accountId(PROVIDER, "pinned")).toBeUndefined();

		const { b } = await storeAccounts();
		expect(storage.sessions.pin(PROVIDER, "pinned", b)).toBe(true);
		expect(await probe.key(PROVIDER, "pinned")).toBe("access-b");
		expect(await probe.accountId(PROVIDER, "pinned")).toBe("acc-b");
	});

	it("mirrors the main ModelRegistry locally over the shared AuthStorage", async () => {
		const first = await probe.registry(registry);
		expect(first).toEqual({
			local: true,
			canonical: true,
			sharesAuth: true,
			hasModel: true,
			apiKey: "mirror-config-key",
		});
		expect((await probe.registry(registry)).canonical).toBe(true);
		// The mirror never clears or reinstalls the key config main's registry owns.
		expect(await storage.keys.get("unit-mirror")).toBe("mirror-config-key");
	});

	it("shares the main thread's slow-mode lane state", async () => {
		const observed = await probe.observeWrapUp(LANE);
		expect(observed).toEqual({ remoteLane: true, stage: "wrap_up" });
		expect(anthropicSlowModeLanes.lane(LANE).status()?.stage).toBe("wrap_up");
	});

	it("answers worker routing calls exactly as main's storage does", async () => {
		console.log(`AUTH_THREAD_SEED=${SEED}`);
		const providers = [PROVIDER, KEYS_PROVIDER, EMPTY_PROVIDER];
		const sessionKinds = ["none", "fresh", "explicit", "automatic"] as const;
		for (let run = 0; run < 48; run++) {
			const g = gen(SEED + run);
			// 0 (empty pool), 1 (single), or several of each credential kind.
			const oauthCount = g.int(0, 3);
			const keyCount = g.int(0, 3);
			const oauth = Array.from({ length: oauthCount }, (_x, index) => oauthCredential(`r${run}-${index}`));
			const keys = Array.from({ length: keyCount }, (_x, index) => ({
				type: "api_key" as const,
				key: `sk-unit-${run}-${index}-${String(run * 10 + index).padStart(4, "0")}`,
			}));
			if (oauthCount > 0) await storage.credentials.set(PROVIDER, oauth);
			else await storage.credentials.remove(PROVIDER);
			if (keyCount > 0) await storage.credentials.set(KEYS_PROVIDER, keys);
			else await storage.credentials.remove(KEYS_PROVIDER);

			// Each provider: no routing entry, or any subset of mode, stays and sink. Every
			// other cycle of session kinds runs the OAuth provider under `stays: strict`,
			// where an explicit pin is the one case that reads differently per session.
			const strictCycle = Math.floor(run / sessionKinds.length) % 2 === 0;
			const routing: Record<string, ProviderRouting> = {};
			for (const provider of providers) {
				if (!(strictCycle && provider === PROVIDER) && g.chance(0.2)) continue;
				routing[provider] = {
					...(g.chance(0.8) ? { mode: g.pick(MODES) } : {}),
					...(strictCycle && provider === PROVIDER
						? { stays: "strict" as const }
						: g.chance(0.8)
							? { stays: g.pick(STAYS) }
							: {}),
					...(g.chance(0.5) ? { sink: g.chance(0.5) } : {}),
				};
			}
			// Weights at both ends of 1–1000, inside, or unset; some accounts and keys disabled.
			const keyPolicies = keys.map(() => ({
				weight: g.pick([undefined, 1, 1000, g.int(2, 999)]),
				disabled: g.chance(0.25),
			}));
			const oauthDisabled = oauth.map(() => g.chance(0.25));
			const accountPolicies: AuthAccountPolicy[] = [
				...keys.flatMap(({ key }, index) => {
					const { weight, disabled } = keyPolicies[index]!;
					return weight === undefined && !disabled
						? []
						: [
								{
									provider: KEYS_PROVIDER,
									account: { keySuffix: key.slice(-4) },
									...(weight === undefined ? {} : { weight }),
									...(disabled ? { disabled } : {}),
								},
							];
				}),
				...oauth.flatMap(({ accountId }, index) =>
					oauthDisabled[index] ? [{ provider: PROVIDER, account: { accountId }, disabled: true }] : [],
				),
			];
			storage.setAccountPolicies({ accountPolicies, defaultReservePct: g.pick([0, 10, 100]), routing });

			// 0–3 usage reports, each naming a stored account or key. Odd runs aim the first
			// one at a disabled account or key when there is one.
			const targets = [
				...oauth.map(({ accountId, email }, index) => ({
					provider: PROVIDER,
					disabled: oauthDisabled[index]!,
					metadata: { accountId, email },
				})),
				...keys.map(({ key }, index) => ({
					provider: KEYS_PROVIDER,
					disabled: keyPolicies[index]!.disabled,
					metadata: { label: `key …${key.slice(-4)}` },
				})),
			];
			const disabledTargets = targets.filter(target => target.disabled);
			const nowMs = Date.now();
			const reports: UsageReport[] =
				targets.length === 0
					? []
					: Array.from({ length: g.int(0, 3) }, (_x, index): UsageReport => {
							const target =
								index === 0 && run % 2 === 1 && disabledTargets.length > 0
									? g.pick(disabledTargets)
									: g.pick(targets);
							// Exact usage steps and whole-hour resets. The test provider has no ranking
							// strategy, so its pace is a constant. Usage percentages come from these steps
							// alone, orderings compare absolute reset times, and every reset is at least
							// an hour away: a few seconds between main's and the worker's clock change nothing.
							const usedFraction = g.pick([0, 0.25, 0.5, 0.75, 1]);
							const hours = g.pick([1, 7 * 24]);
							return {
								provider: target.provider,
								fetchedAt: nowMs,
								limits: [
									{
										id: `${target.provider}:primary`,
										label: "Primary",
										scope: { provider: target.provider, windowId: "primary", shared: true },
										window: {
											id: "primary",
											label: "Primary",
											durationMs: hours * HOUR_MS,
											resetsAt: nowMs + g.int(1, hours) * HOUR_MS,
										},
										amount: {
											unit: "percent",
											used: usedFraction * 100,
											limit: 100,
											remaining: 100 - usedFraction * 100,
											usedFraction,
											remainingFraction: 1 - usedFraction,
										},
										status: usedFraction >= 1 ? "exhausted" : "ok",
									},
								],
								metadata: target.metadata,
							};
						});

			// No session, a fresh one, an explicit pin, or an automatic pin, in turn.
			const session = sessionKinds[run % sessionKinds.length]!;
			const sessionId = session === "none" ? undefined : `s-${run}-${session}`;
			const stored = storage.oauth.accounts(PROVIDER);
			if (sessionId && stored.length > 0 && (session === "explicit" || session === "automatic")) {
				const target = g.pick(stored).credentialId;
				const options = session === "automatic" ? { restoredAtMs: Date.now() } : undefined;
				expect(storage.sessions.pin(PROVIDER, sessionId, target, options)).toBe(true);
			}

			for (const provider of providers) {
				const where = { seed: SEED, run, provider, session, oauthCount, keyCount, reports: reports.length };
				const worker = await probe.routing(provider, sessionId, reports);
				expect({ where, answer: worker }).toEqual({
					where,
					answer: {
						config: storage.routing.config(provider),
						preview: storage.routing.preview(provider, reports),
						strict: storage.routing.strict(provider, sessionId),
						weights: storage.routing.weights(provider),
					},
				});
			}
		}
	});

	it("holds a strict session on an account the worker reports gone", async () => {
		const { b } = await storeAccounts();
		storage.setAccountPolicies({
			accountPolicies: [],
			defaultReservePct: 0,
			routing: { [PROVIDER]: { mode: "order", stays: "strict" } },
		});
		await storage.credentials.removeById(PROVIDER, b);
		const hash = credentialPinHash(PROVIDER, oauthCredential("b"));
		if (!hash) throw new Error("expected a pin hash");

		// The hold is a one-way notify; the probe's reply arrives after it on the same port.
		await probe.holdGone(PROVIDER, "gone", { hash, lastUsedAt: Date.now() });

		const refused = await storage.keys.get(PROVIDER, "gone").then(
			key => key,
			(error: unknown) => error,
		);
		expect(refused).toBeInstanceOf(MissingApiKeyError);
		expect((refused as Error).message).toContain("the account this session used");
		// A session the worker did not name still resolves the remaining account.
		expect(await storage.keys.get(PROVIDER, "fresh")).toBe("access-a");
	});

	it("delivers main's account-disabled events to a worker listener until it unsubscribes", async () => {
		const { b } = await storeAccounts();
		const onMain: SessionAccountDisabledEvent[] = [];
		storage.sessions.onAccountDisabled(event => onMain.push(event));
		await probe.watchAccountDisabled();
		const disable = (disabled: boolean) =>
			storage.setAccountPolicies({
				accountPolicies: disabled ? [{ provider: PROVIDER, account: { accountId: "acc-b" }, disabled }] : [],
				defaultReservePct: 0,
				routing: {},
			});

		expect(storage.sessions.pin(PROVIDER, "moved", b)).toBe(true);
		expect(await storage.keys.get(PROVIDER, "moved")).toBe("access-b");
		disable(true);
		expect(await storage.keys.get(PROVIDER, "moved")).toBe("access-a");
		expect(onMain).toHaveLength(1);
		expect(onMain[0]).toMatchObject({ provider: PROVIDER, sessionId: "moved" });
		// Frames to the worker are ordered: the listener call lands before this read.
		expect(await probe.accountDisabled()).toEqual(onMain);

		await probe.unwatchAccountDisabled();
		disable(false);
		expect(storage.sessions.pin(PROVIDER, "moved-again", b)).toBe(true);
		expect(await storage.keys.get(PROVIDER, "moved-again")).toBe("access-b");
		disable(true);
		expect(await storage.keys.get(PROVIDER, "moved-again")).toBe("access-a");
		expect(onMain).toHaveLength(2);
		expect(await probe.accountDisabled()).toEqual(onMain.slice(0, 1));
	});
});
