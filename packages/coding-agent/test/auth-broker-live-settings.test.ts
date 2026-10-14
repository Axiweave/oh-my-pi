import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AuthStorage, type RoutingMode, SqliteAuthCredentialStore, type UsageReport } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	authSettingsApplied,
	createAuthStorageSettingsSync,
	loadEffectiveAuthAccountPolicyConfig,
} from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { TempDir } from "@oh-my-pi/pi-utils";

import {
	cfgAuthAccountPolicies,
	cfgAuthBrokerUrl,
	cfgAuthRouting,
} from "@oh-my-pi/pi-coding-agent/config/model-settings";

const PROVIDER = "live-broker-test";
const TOKEN = "live-broker-bearer";
const BROKER_ENV = ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN", "OMP_AUTH_BROKER_SNAPSHOT_TTL_MS"] as const;

interface Broker {
	handle: AuthBrokerServerHandle;
	storage: AuthStorage;
}

async function startBroker(dir: string, apiKey: string): Promise<Broker> {
	const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(dir, `${apiKey}.db`)));
	await storage.credentials.set(PROVIDER, { type: "api_key", key: apiKey });
	const handle = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [TOKEN], disableRefresher: true });
	return { handle, storage };
}

const ROUTED_PROVIDER = "live-routing-provider";

/** One 7-day window, `usedFraction` used. */
function weeklyUsage(accountId: string, usedFraction: number): UsageReport {
	const used = usedFraction * 100;
	return {
		provider: ROUTED_PROVIDER,
		fetchedAt: Date.now(),
		metadata: { accountId },
		limits: [
			{
				id: `${ROUTED_PROVIDER}:7d`,
				label: "7 Day",
				scope: { provider: ROUTED_PROVIDER, windowId: "7d", shared: true },
				window: { id: "7d", label: "7 Day", durationMs: 7 * 24 * 60 * 60_000, resetsAt: Date.now() + 60 * 60_000 },
				amount: {
					unit: "percent",
					used,
					limit: 100,
					remaining: 100 - used,
					usedFraction,
					remainingFraction: 1 - usedFraction,
				},
				status: "ok",
			},
		],
	};
}

/**
 * Account A (priority 100) is 95% used, inside the 10% global reserve; B (priority 10) is 10% used.
 * `smart` holds A in reserve and picks B; `order` ignores the global reserve and picks A.
 */
async function openRoutedStorage(dir: string, settings: Settings): Promise<AuthStorage> {
	const usedByAccount: Record<string, number> = { "account-a": 0.95, "account-b": 0.1 };
	const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(dir, "routed.db")), {
		...(await loadEffectiveAuthAccountPolicyConfig({ settings })),
		usageProviderResolver: provider =>
			provider === ROUTED_PROVIDER
				? {
						id: ROUTED_PROVIDER,
						async fetchUsage({ credential }) {
							const accountId = credential.accountId;
							return accountId ? weeklyUsage(accountId, usedByAccount[accountId] ?? 0) : null;
						},
					}
				: undefined,
	});
	await storage.credentials.set(
		ROUTED_PROVIDER,
		["a", "b"].map(suffix => ({
			type: "oauth" as const,
			access: `access-${suffix}`,
			refresh: `refresh-${suffix}`,
			expires: Date.now() + 60 * 60_000,
			accountId: `account-${suffix}`,
		})),
	);
	return storage;
}

function routedConfig(routing = ""): string {
	return [
		"auth:",
		"  accountPolicies:",
		`    - { provider: ${ROUTED_PROVIDER}, account: { accountId: account-a }, priority: 100 }`,
		`    - { provider: ${ROUTED_PROVIDER}, account: { accountId: account-b }, priority: 10 }`,
		routing,
		"",
	].join("\n");
}

describe("auth broker settings take effect live", () => {
	let tempDir: TempDir;
	const brokers: Broker[] = [];
	const cleanups: Array<() => void> = [];
	const savedEnv: Partial<Record<(typeof BROKER_ENV)[number], string>> = {};

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-auth-broker-live-");
		for (const key of BROKER_ENV) {
			const value = process.env[key];
			if (value !== undefined) savedEnv[key] = value;
			delete process.env[key];
		}
		// No snapshot cache: every connection must hit its broker.
		process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "0";
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		for (const broker of brokers.splice(0)) {
			await broker.handle.close();
			broker.storage.close();
		}
		for (const key of BROKER_ENV) {
			delete process.env[key];
			const value = savedEnv[key];
			if (value !== undefined) process.env[key] = value;
		}
		// `Settings.loadIsolated` opened `<agentDir>/agent.db`; Windows cannot delete it while open.
		AgentStorage.close();
		tempDir.removeSync();
	});

	it("resolves credentials from the new broker after auth.broker.url changes", async () => {
		const brokerA = await startBroker(tempDir.path(), "key-from-a");
		const brokerB = await startBroker(tempDir.path(), "key-from-b");
		brokers.push(brokerA, brokerB);
		const agentDir = tempDir.join("agent");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			`auth:\n  broker:\n    url: ${brokerA.handle.url}\n    token: ${TOKEN}\n`,
		);
		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });
		const authStorage = await discoverAuthStorage(agentDir, { settings });
		cleanups.push(() => authStorage.close());
		const sync = createAuthStorageSettingsSync(settings, authStorage);
		cleanups.push(() => sync.stop());
		expect(await authStorage.keys.get(PROVIDER)).toBe("key-from-a");

		cfgAuthBrokerUrl.set(settings, brokerB.handle.url);
		// The coalesced listener delivers the change on the next microtask.
		await Promise.resolve();
		await sync.settled();

		expect(await authStorage.keys.get(PROVIDER)).toBe("key-from-b");
	});

	it("selects with the new routing mode after auth.routing changes", async () => {
		const agentDir = tempDir.join("agent");
		await Bun.write(path.join(agentDir, "config.yml"), routedConfig());
		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });
		const authStorage = await openRoutedStorage(tempDir.path(), settings);
		cleanups.push(() => authStorage.close());
		const sync = createAuthStorageSettingsSync(settings, authStorage);
		cleanups.push(() => sync.stop());
		expect(await authStorage.keys.get(ROUTED_PROVIDER, "before-change")).toBe("access-b");

		cfgAuthRouting.set(settings, { [ROUTED_PROVIDER]: { mode: "order" } });
		await Promise.resolve();
		await sync.settled();

		expect(await authStorage.keys.get(ROUTED_PROVIDER, "after-change")).toBe("access-a");
	});

	it("keeps the previous routing when a new routing mode is invalid", async () => {
		const agentDir = tempDir.join("agent");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			routedConfig(`  routing: { ${ROUTED_PROVIDER}: { mode: order } }`),
		);
		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });
		const authStorage = await openRoutedStorage(tempDir.path(), settings);
		cleanups.push(() => authStorage.close());
		const sync = createAuthStorageSettingsSync(settings, authStorage);
		cleanups.push(() => sync.stop());
		expect(await authStorage.keys.get(ROUTED_PROVIDER, "before-change")).toBe("access-a");

		expect(() => cfgAuthRouting.set(settings, { [ROUTED_PROVIDER]: { mode: "fastest" as RoutingMode } })).toThrow(
			`auth.routing.${ROUTED_PROVIDER}.mode must be one of smart, order, rotate, weight, usage, pace`,
		);
		await Promise.resolve();
		await sync.settled();

		expect(authStorage.routing.config(ROUTED_PROVIDER).mode).toBe("order");
		expect(await authStorage.keys.get(ROUTED_PROVIDER, "after-change")).toBe("access-a");
	});

	it("rejects a bad live auth.accountPolicies value naming the field, and keeps the previous policies", async () => {
		// Contract (FR-020, SC-007): a bad value is a configuration error naming the
		// setting, like a bad auth.routing value, and the previous policies stay.
		// Seeded: which of 1-3 policies is bad, and which field breaks it (boundary
		// and over-limit values).
		const SEED = Number(process.env.ROUTING_SEED ?? 20_260_511);
		let state = SEED >>> 0;
		const next = (n: number) => {
			state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
			// The low bits of this generator cycle quickly; draw from the high ones.
			return (state >>> 16) % n;
		};
		const breaks: Record<string, [patch: Record<string, unknown>, field: string]> = {
			"weight 0": [{ weight: 0 }, "weight"],
			"weight 1001": [{ weight: 1001 }, "weight"],
			"weight 1.5": [{ weight: 1.5 }, "weight"],
			"capPct 0": [{ capPct: 0 }, "capPct"],
			"capPct 101": [{ capPct: 101 }, "capPct"],
			"window cap 0": [{ windowCapPct: { "7d": 0 } }, "windowCapPct.7d"],
			"window cap 101": [{ windowCapPct: { "7d": 101 } }, "windowCapPct.7d"],
			"priority NaN": [{ priority: Number.NaN }, "priority"],
			"empty account": [{ account: {} }, "account"],
			"short key suffix": [{ account: { keySuffix: "abc" } }, "account.keySuffix"],
			"empty provider": [{ provider: "" }, "provider"],
		};
		const agentDir = tempDir.join("agent");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			routedConfig(`  routing: { ${ROUTED_PROVIDER}: { mode: order } }`),
		);
		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });
		const authStorage = await openRoutedStorage(tempDir.path(), settings);
		cleanups.push(() => authStorage.close());
		const sync = createAuthStorageSettingsSync(settings, authStorage);
		cleanups.push(() => sync.stop());
		const previous = cfgAuthAccountPolicies.get(settings);

		for (let run = 0; run < 24; run++) {
			const names = Object.keys(breaks);
			const name = names[next(names.length)];
			const [patch, field] = breaks[name];
			// Each edit would put account-b first, so a policy that slipped through shows in selection.
			const policies = [
				{ provider: ROUTED_PROVIDER, account: { accountId: "account-b" }, priority: 100 },
				{ provider: ROUTED_PROVIDER, account: { accountId: "account-a" }, priority: 10 },
				{ provider: ROUTED_PROVIDER, account: { email: "c@example.com" } },
			].slice(0, 1 + next(3));
			const bad = next(policies.length);
			policies[bad] = { ...policies[bad], ...patch } as (typeof policies)[number];
			const context = `ROUTING_SEED=${SEED} run=${run} ${name} at [${bad}] of ${policies.length}`;

			expect(() => cfgAuthAccountPolicies.set(settings, policies), context).toThrow(
				`auth.accountPolicies[${bad}].${field}`,
			);
			await Promise.resolve();
			await sync.settled();

			expect(cfgAuthAccountPolicies.get(settings), context).toEqual(previous);
			expect(await authStorage.keys.get(ROUTED_PROVIDER, `after-${run}`), context).toBe("access-a");
		}
	});

	it("reports a cap on a provider without usage reports on /reload-config, and keeps the previous policies", async () => {
		// Contract (FR-020): the usage check needs the live auth storage, so it runs
		// after the reload; `authSettingsApplied` (awaited by /reload-config) reports it.
		const agentDir = tempDir.join("agent");
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(configPath, routedConfig(`  routing: { ${ROUTED_PROVIDER}: { mode: order } }`));
		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });
		const authStorage = await openRoutedStorage(tempDir.path(), settings);
		cleanups.push(() => authStorage.close());
		const sync = createAuthStorageSettingsSync(settings, authStorage);
		cleanups.push(() => sync.stop());

		// Swaps the priorities and adds a cap on a provider with no usage reports.
		const refusedMessage = "auth.accountPolicies[2].capPct requires a usage provider for no-usage-provider";
		const policyLines = [
			"auth:",
			"  accountPolicies:",
			`    - { provider: ${ROUTED_PROVIDER}, account: { accountId: account-a }, priority: 10 }`,
			`    - { provider: ${ROUTED_PROVIDER}, account: { accountId: account-b }, priority: 100 }`,
		];
		const routingLine = `  routing: { ${ROUTED_PROVIDER}: { mode: order } }`;
		await Bun.write(
			configPath,
			[
				...policyLines,
				"    - { provider: no-usage-provider, account: { accountId: account-c }, capPct: 50 }",
				routingLine,
				"",
			].join("\n"),
		);
		await settings.reloadFromDisk();

		await expect(authSettingsApplied(settings)).rejects.toThrow(refusedMessage);
		expect(await authStorage.keys.get(ROUTED_PROVIDER, "after-change")).toBe("access-a");
		// Reloading the same bad file changes no setting, and still reports the refusal.
		await settings.reloadFromDisk();
		await expect(authSettingsApplied(settings)).rejects.toThrow(refusedMessage);

		// A good file applies (account-b first now) and clears the report.
		await Bun.write(configPath, [...policyLines, routingLine, ""].join("\n"));
		await settings.reloadFromDisk();
		await expect(authSettingsApplied(settings)).resolves.toBeUndefined();
		expect(await authStorage.keys.get(ROUTED_PROVIDER, "after-fix")).toBe("access-b");
	});
});
