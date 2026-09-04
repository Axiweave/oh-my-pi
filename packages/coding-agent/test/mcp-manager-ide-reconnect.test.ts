import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import * as mcpConfig from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig, MCPServerConnection, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

class FakeTransport implements MCPTransport {
	connected = true;
	onClose?: () => void;

	request<T>(): Promise<T> {
		throw new Error("Unexpected transport request");
	}

	async notify(): Promise<void> {}

	async close(): Promise<void> {
		this.connected = false;
	}
}

function fakeConnection(
	name: string,
	config: MCPServerConfig,
): { connection: MCPServerConnection; transport: FakeTransport } {
	const transport = new FakeTransport();
	return {
		connection: {
			name,
			config,
			transport,
			serverInfo: { name: "fake", version: "1.0.0" },
			capabilities: { tools: {} },
		},
		transport,
	};
}

const RECONNECT_DELAYS = [500, 1000, 2000, 4000] as const;

async function exhaustBoundedReconnect(
	transport: FakeTransport,
	callStarted: Array<PromiseWithResolvers<void>>,
): Promise<void> {
	transport.onClose?.();
	await callStarted[1]?.promise;
	for (let index = 0; index < RECONNECT_DELAYS.length; index++) {
		for (let flush = 0; flush < 5; flush++) await Promise.resolve();
		vi.advanceTimersByTime(RECONNECT_DELAYS[index]);
		await callStarted[index + 2]?.promise;
	}
	for (let flush = 0; flush < 5; flush++) await Promise.resolve();
}

describe("MCPManager IDE reconnect", () => {
	let root = "";
	let home = "";
	let project = "";
	let lockfilePath = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		vi.useFakeTimers();
		clearFsCache();
		originalHome = process.env.HOME;
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-ide-reconnect-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		lockfilePath = path.join(home, ".omp", "ide", "emacs.json");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await fs.mkdir(path.dirname(lockfilePath), { recursive: true });
		await fs.mkdir(project, { recursive: true });
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		clearFsCache();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(root);
	});

	test("uses a replacement IDE endpoint on the next bounded reconnect attempt", async () => {
		const urlA = "http://127.0.0.1:1001/mcp";
		const urlB = "http://127.0.0.1:1002/mcp";
		await Bun.write(lockfilePath, JSON.stringify({ transport: "sse", url: urlA }));
		const initialConfig: MCPServerConfig = { type: "sse", url: urlA };
		const initial = fakeConnection("ide", initialConfig);
		const rebound = fakeConnection("ide", { type: "sse", url: urlB });
		const firstReconnectStarted = Promise.withResolvers<void>();
		const reconnectConnected = Promise.withResolvers<void>();
		const attemptedUrls: string[] = [];
		vi.spyOn(mcpClient, "connectToServer").mockImplementation((_name, config) => {
			attemptedUrls.push("url" in config ? config.url : "stdio");
			if (attemptedUrls.length === 1) return Promise.resolve(initial.connection);
			if (attemptedUrls.length === 2) {
				firstReconnectStarted.resolve();
				return Promise.reject(new Error("old IDE endpoint unavailable"));
			}
			return Promise.resolve(rebound.connection);
		});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		const manager = new MCPManager(project);

		try {
			await manager.connectServers(
				{ ide: initialConfig },
				{ ide: { provider: "ide", providerName: "IDE", path: lockfilePath, level: "user" } },
			);
			manager.addConnectionStatusListener(event => {
				if (event.type === "connected") reconnectConnected.resolve();
			});
			initial.transport.onClose?.();
			await firstReconnectStarted.promise;
			await Bun.write(lockfilePath, JSON.stringify({ transport: "sse", url: urlB }));
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();
			vi.advanceTimersByTime(500);
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();
			await reconnectConnected.promise;

			expect(attemptedUrls).toEqual([urlA, urlA, urlB]);
			expect(manager.getServerConfig("ide")).toEqual({ type: "sse", url: urlB });
		} finally {
			await manager.disconnectAll();
		}
	});

	test("polls after bounded retries and reconnects to the unchanged IDE address", async () => {
		const url = "http://127.0.0.1:1001/mcp";
		await Bun.write(lockfilePath, JSON.stringify({ transport: "sse", url }));
		const config: MCPServerConfig = { type: "sse", url };
		const initial = fakeConnection("ide", config);
		const callStarted = Array.from({ length: 7 }, () => Promise.withResolvers<void>());
		const failed = Promise.withResolvers<void>();
		const connected = Promise.withResolvers<void>();
		const attemptedUrls: string[] = [];
		let reachable = false;
		vi.spyOn(mcpClient, "connectToServer").mockImplementation((_name, attemptedConfig) => {
			const index = attemptedUrls.push("url" in attemptedConfig ? attemptedConfig.url : "stdio") - 1;
			callStarted[index]?.resolve();
			if (index === 0) return Promise.resolve(initial.connection);
			if (!reachable) return Promise.reject(new Error("IDE endpoint unavailable"));
			return Promise.resolve(fakeConnection("ide", attemptedConfig).connection);
		});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		const manager = new MCPManager(project);

		try {
			await manager.connectServers(
				{ ide: config },
				{ ide: { provider: "ide", providerName: "IDE", path: lockfilePath, level: "user" } },
			);
			manager.addConnectionStatusListener(event => {
				if (event.type === "failed") failed.resolve();
				if (event.type === "connected") connected.resolve();
			});
			await exhaustBoundedReconnect(initial.transport, callStarted);
			await failed.promise;
			expect(vi.getTimerCount()).toBe(1);

			reachable = true;
			vi.advanceTimersByTime(7_000);
			await callStarted[6]?.promise;
			await connected.promise;

			expect(attemptedUrls).toEqual([url, url, url, url, url, url, url]);
			expect(manager.getConnectionStatus("ide")).toBe("connected");
		} finally {
			await manager.disconnectAll();
		}
	});

	test("keeps polling an absent IDE lockfile without dialing the old endpoint", async () => {
		const url = "http://127.0.0.1:1001/mcp";
		await Bun.write(lockfilePath, JSON.stringify({ transport: "sse", url }));
		const config: MCPServerConfig = { type: "sse", url };
		const initial = fakeConnection("ide", config);
		const callStarted = Array.from({ length: 6 }, () => Promise.withResolvers<void>());
		const failed = Promise.withResolvers<void>();
		let connectCalls = 0;
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(() => {
			const index = connectCalls++;
			callStarted[index]?.resolve();
			if (index === 0) return Promise.resolve(initial.connection);
			return Promise.reject(new Error("IDE endpoint unavailable"));
		});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		const manager = new MCPManager(project);

		try {
			await manager.connectServers(
				{ ide: config },
				{ ide: { provider: "ide", providerName: "IDE", path: lockfilePath, level: "user" } },
			);
			manager.addConnectionStatusListener(event => {
				if (event.type === "failed") failed.resolve();
			});
			await exhaustBoundedReconnect(initial.transport, callStarted);
			await failed.promise;
			expect(vi.getTimerCount()).toBe(1);
			await fs.rm(lockfilePath);

			const realLoad = mcpConfig.loadAllMCPConfigs;
			const pollLoads = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
			const pendingPollLoads = [...pollLoads];
			vi.spyOn(mcpConfig, "loadAllMCPConfigs").mockImplementation(async (...args) => {
				const result = await realLoad(...args);
				pendingPollLoads.shift()?.resolve();
				return result;
			});
			for (const pollLoad of pollLoads) {
				vi.advanceTimersByTime(7_000);
				await pollLoad.promise;
				for (let flush = 0; flush < 5; flush++) await Promise.resolve();
				expect(connectCalls).toBe(6);
				expect(vi.getTimerCount()).toBe(1);
			}
		} finally {
			await manager.disconnectAll();
		}
	});

	test("does not restore IDE state when disconnectAll wins a polling reload race", async () => {
		const url = "http://127.0.0.1:1001/mcp";
		await Bun.write(lockfilePath, JSON.stringify({ transport: "sse", url }));
		const config: MCPServerConfig = { type: "sse", url };
		const source = { provider: "ide", providerName: "IDE", path: lockfilePath, level: "user" } as const;
		const initial = fakeConnection("ide", config);
		const callStarted = Array.from({ length: 6 }, () => Promise.withResolvers<void>());
		const failed = Promise.withResolvers<void>();
		let connectCalls = 0;
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(() => {
			const index = connectCalls++;
			callStarted[index]?.resolve();
			if (index === 0) return Promise.resolve(initial.connection);
			return Promise.reject(new Error("IDE endpoint unavailable"));
		});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		const manager = new MCPManager(project);

		try {
			await manager.connectServers({ ide: config }, { ide: source });
			manager.addConnectionStatusListener(event => {
				if (event.type === "failed") failed.resolve();
			});
			await exhaustBoundedReconnect(initial.transport, callStarted);
			await failed.promise;
			expect(vi.getTimerCount()).toBe(1);

			const reloadStarted = Promise.withResolvers<void>();
			const reload = Promise.withResolvers<mcpConfig.LoadMCPConfigsResult>();
			vi.spyOn(mcpConfig, "loadAllMCPConfigs").mockImplementation(() => {
				reloadStarted.resolve();
				return reload.promise;
			});
			vi.advanceTimersByTime(7_000);
			await reloadStarted.promise;
			await manager.disconnectAll();
			reload.resolve({ configs: { ide: config }, sources: { ide: source }, exaApiKeys: [] });
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();
			vi.advanceTimersByTime(21_000);
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();

			expect(connectCalls).toBe(6);
			expect(manager.getServerConfig("ide")).toBeUndefined();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await manager.disconnectAll();
		}
	});

	test("restores polling after a disconnected manual reconnect fails", async () => {
		const url = "http://127.0.0.1:1001/mcp";
		await Bun.write(lockfilePath, JSON.stringify({ transport: "sse", url }));
		const config: MCPServerConfig = { type: "sse", url };
		const initial = fakeConnection("ide", config);
		const callStarted = Array.from({ length: 12 }, () => Promise.withResolvers<void>());
		const connected = Promise.withResolvers<void>();
		let connectCalls = 0;
		let reachable = false;
		vi.spyOn(mcpClient, "connectToServer").mockImplementation((_name, attemptedConfig) => {
			const index = connectCalls++;
			callStarted[index]?.resolve();
			if (index === 0) return Promise.resolve(initial.connection);
			if (!reachable) return Promise.reject(new Error("IDE endpoint unavailable"));
			return Promise.resolve(fakeConnection("ide", attemptedConfig).connection);
		});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		const manager = new MCPManager(project);

		try {
			await manager.connectServers(
				{ ide: config },
				{ ide: { provider: "ide", providerName: "IDE", path: lockfilePath, level: "user" } },
			);
			manager.addConnectionStatusListener(event => {
				if (event.type === "connected") connected.resolve();
			});
			await exhaustBoundedReconnect(initial.transport, callStarted);
			expect(vi.getTimerCount()).toBe(1);

			const manual = manager.reconnectServer("ide", { manual: true });
			await callStarted[6]?.promise;
			expect(vi.getTimerCount()).toBe(0);
			for (let index = 0; index < RECONNECT_DELAYS.length; index++) {
				for (let flush = 0; flush < 5; flush++) await Promise.resolve();
				vi.advanceTimersByTime(RECONNECT_DELAYS[index]);
				await callStarted[index + 7]?.promise;
			}
			await manual;
			expect(vi.getTimerCount()).toBe(1);

			reachable = true;
			vi.advanceTimersByTime(7_000);
			await callStarted[11]?.promise;
			await connected.promise;

			expect(connectCalls).toBe(12);
			expect(manager.getConnectionStatus("ide")).toBe("connected");
		} finally {
			await manager.disconnectAll();
		}
	});
	test("keeps polling when an IDE auth reconnect cannot run", async () => {
		const url = "http://127.0.0.1:1001/mcp";
		await Bun.write(lockfilePath, JSON.stringify({ transport: "sse", url }));
		const config: MCPServerConfig = { type: "sse", url };
		const initial = fakeConnection("ide", config);
		const callStarted = Array.from({ length: 7 }, () => Promise.withResolvers<void>());
		const connected = Promise.withResolvers<void>();
		let connectCalls = 0;
		let reachable = false;
		vi.spyOn(mcpClient, "connectToServer").mockImplementation((_name, attemptedConfig) => {
			const index = connectCalls++;
			callStarted[index]?.resolve();
			if (index === 0) return Promise.resolve(initial.connection);
			if (!reachable) return Promise.reject(new Error("IDE endpoint unavailable"));
			return Promise.resolve(fakeConnection("ide", attemptedConfig).connection);
		});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		const manager = new MCPManager(project);

		try {
			await manager.connectServers(
				{ ide: config },
				{ ide: { provider: "ide", providerName: "IDE", path: lockfilePath, level: "user" } },
			);
			manager.addConnectionStatusListener(event => {
				if (event.type === "connected") connected.resolve();
			});
			await exhaustBoundedReconnect(initial.transport, callStarted);
			expect(vi.getTimerCount()).toBe(1);

			expect(
				await manager.reconnectServer("ide", {
					authChallenge: { wwwAuthenticate: ["Bearer"] },
				}),
			).toBeNull();
			expect(connectCalls).toBe(6);
			expect(vi.getTimerCount()).toBe(1);

			reachable = true;
			vi.advanceTimersByTime(7_000);
			await callStarted[6]?.promise;
			await connected.promise;

			expect(manager.getConnectionStatus("ide")).toBe("connected");
		} finally {
			await manager.disconnectAll();
		}
	});

	test("polls an IDE server after the reconnect circuit breaker opens", async () => {
		const url = "http://127.0.0.1:1001/mcp";
		await Bun.write(lockfilePath, JSON.stringify({ transport: "sse", url }));
		const config: MCPServerConfig = { type: "sse", url };
		const initial = fakeConnection("ide", config);
		let connectCalls = 0;
		vi.spyOn(mcpClient, "connectToServer").mockImplementation((_name, attemptedConfig) => {
			connectCalls += 1;
			if (connectCalls === 1) return Promise.resolve(initial.connection);
			return Promise.resolve(fakeConnection("ide", attemptedConfig).connection);
		});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		const manager = new MCPManager(project);

		try {
			await manager.connectServers(
				{ ide: config },
				{ ide: { provider: "ide", providerName: "IDE", path: lockfilePath, level: "user" } },
			);
			for (let attempt = 0; attempt < 5; attempt++) {
				expect(await manager.reconnectServer("ide")).not.toBeNull();
			}
			const timerCountBeforeBreaker = vi.getTimerCount();
			expect(await manager.reconnectServer("ide")).toBeNull();

			expect(connectCalls).toBe(6);
			expect(manager.getConnectionStatus("ide")).toBe("disconnected");
			expect(vi.getTimerCount()).toBe(timerCountBeforeBreaker + 1);
		} finally {
			await manager.disconnectAll();
		}
	});
});
