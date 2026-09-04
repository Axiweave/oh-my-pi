import { afterEach, describe, expect, it } from "bun:test";
import { ideTurnState, publishIdeSessionState, subscribeIdeState } from "@oh-my-pi/pi-coding-agent/mcp/ide-state";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";

/** Shared fake `ide` MCP connection: `sent` collects `params.state` in call order. */
function fakeIdeManager({
	connected = true,
	notify,
}: {
	connected?: boolean;
	notify?: (method: string, params: Record<string, unknown>) => Promise<void>;
} = {}): {
	manager: MCPManager;
	sent: unknown[];
	listeners: Array<(event: McpConnectionStatusEvent) => void>;
	fire: (event: McpConnectionStatusEvent) => void;
} {
	const sent: unknown[] = [];
	const listeners: Array<(event: McpConnectionStatusEvent) => void> = [];
	const manager = {
		getConnection: (name: string) =>
			connected && name === "ide"
				? {
						transport: {
							notify: async (method: string, params: Record<string, unknown>) => {
								sent.push(params.state);
								await notify?.(method, params);
							},
						},
					}
				: undefined,
		addConnectionStatusListener: (fn: (event: McpConnectionStatusEvent) => void) => {
			listeners.push(fn);
			return () => {
				listeners.splice(listeners.indexOf(fn), 1);
			};
		},
	} as unknown as MCPManager;
	return {
		manager,
		sent,
		listeners,
		fire: event => {
			for (const listener of listeners) listener(event);
		},
	};
}

/** Drain the notify → then/catch → finally (→ re-flush) microtask chain deterministically. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

const originalZmxSession = process.env.ZMX_SESSION;
const originalBufferName = process.env.EMACS_BUFFER_NAME;

afterEach(() => {
	if (originalZmxSession === undefined) delete process.env.ZMX_SESSION;
	else process.env.ZMX_SESSION = originalZmxSession;
	if (originalBufferName === undefined) delete process.env.EMACS_BUFFER_NAME;
	else process.env.EMACS_BUFFER_NAME = originalBufferName;
});

describe("ideTurnState", () => {
	it("maps the last assistant stop reason, idle when nothing ran", () => {
		expect(ideTurnState([])).toBe("idle");
		expect(ideTurnState([{ role: "user" }])).toBe("idle");
		expect(ideTurnState([{ role: "assistant", stopReason: "stop" }, { role: "user" }])).toBe("done");
		expect(ideTurnState([{ role: "assistant", stopReason: "toolUse" }])).toBe("done");
		expect(ideTurnState([{ role: "assistant", stopReason: "error" }])).toBe("failed");
		expect(ideTurnState([{ role: "assistant", stopReason: "aborted" }])).toBe("idle");
	});
});

describe("publishIdeSessionState / subscribeIdeState", () => {
	it("posts the state with the Emacs identity env vars", async () => {
		process.env.ZMX_SESSION = "cci-omp-proj-x";
		process.env.EMACS_BUFFER_NAME = "*omp[proj]*";
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const { manager, sent } = fakeIdeManager({
			notify: async (method, params) => {
				calls.push({ method, params });
			},
		});

		publishIdeSessionState(manager, "needs-input");
		await flushMicrotasks();

		expect(sent).toEqual(["needs-input"]);
		expect(calls).toEqual([
			{
				method: "session_state_changed",
				params: { state: "needs-input", zmxSession: "cci-omp-proj-x", bufferName: "*omp[proj]*" },
			},
		]);
	});

	it("delivers the newest state in order while an earlier send is in flight", async () => {
		const deferred = Promise.withResolvers<void>();
		let callIndex = 0;
		const { manager, sent } = fakeIdeManager({
			notify: async () => {
				if (callIndex++ === 0) return deferred.promise;
			},
		});

		publishIdeSessionState(manager, "working");
		publishIdeSessionState(manager, "done");
		publishIdeSessionState(manager, "idle");
		deferred.resolve();
		await flushMicrotasks();

		expect(sent).toEqual(["working", "idle"]);
	});

	it("re-announces the latest state when the ide server reconnects", async () => {
		const { manager, sent, fire } = fakeIdeManager();

		publishIdeSessionState(manager, "done");
		await flushMicrotasks();
		expect(sent).toEqual(["done"]);

		const unsubscribe = subscribeIdeState(manager);
		fire({ type: "connected", serverName: "ide" });
		await flushMicrotasks();
		expect(sent).toEqual(["done", "done"]);

		fire({ type: "connected", serverName: "other" });
		await flushMicrotasks();
		expect(sent).toEqual(["done", "done"]);

		unsubscribe();
		fire({ type: "connected", serverName: "ide" });
		await flushMicrotasks();
		expect(sent).toEqual(["done", "done"]);
	});

	it("keeps state per manager", async () => {
		const a = fakeIdeManager();
		const b = fakeIdeManager();

		publishIdeSessionState(a.manager, "failed");
		await flushMicrotasks();

		subscribeIdeState(b.manager);
		await flushMicrotasks();

		expect(b.sent).toEqual(["idle"]);
		expect(a.sent).toEqual(["failed"]);
	});

	it("installs one reconnect listener per shared manager", async () => {
		const { manager, sent, listeners, fire } = fakeIdeManager();

		const unsubscribeFirst = subscribeIdeState(manager);
		const unsubscribeSecond = subscribeIdeState(manager);
		expect(listeners.length).toBe(1);
		await flushMicrotasks();

		const before = sent.length;
		fire({ type: "connected", serverName: "ide" });
		await flushMicrotasks();
		expect(sent.length).toBe(before + 1);

		unsubscribeFirst();
		expect(listeners.length).toBe(1);
		unsubscribeSecond();
		expect(listeners.length).toBe(0);
	});

	it("sends nothing without an ide server", async () => {
		const { manager, sent, fire } = fakeIdeManager({ connected: false });

		publishIdeSessionState(manager, "done");
		await flushMicrotasks();
		expect(sent).toEqual([]);

		subscribeIdeState(manager);
		fire({ type: "connected", serverName: "ide" });
		await flushMicrotasks();
		expect(sent).toEqual([]);
	});

	it("resends a state whose send failed on the next publish and on reconnect", async () => {
		// The first attempt to send "done" (call #2 overall: #1 is the "working"
		// send below, which succeeds) fails; every other call succeeds. This is
		// what makes the later "publish done again" resend observable: `done`
		// never gets marked delivered until its retried send succeeds.
		let callIndex = 0;
		const { manager, sent, listeners, fire } = fakeIdeManager({
			notify: async () => {
				callIndex++;
				if (callIndex === 2) throw new Error("HTTP 502: bad gateway");
			},
		});

		publishIdeSessionState(manager, "working");
		publishIdeSessionState(manager, "done");
		await flushMicrotasks();
		expect(sent).toEqual(["working", "done"]);
		await flushMicrotasks();
		expect(sent).toEqual(["working", "done"]);

		publishIdeSessionState(manager, "done");
		await flushMicrotasks();
		expect(sent).toEqual(["working", "done", "done"]);

		subscribeIdeState(manager);
		fire({ type: "connected", serverName: "ide" });
		await flushMicrotasks();
		expect(sent).toEqual(["working", "done", "done", "done"]);
		expect(listeners.length).toBe(1);

		publishIdeSessionState(manager, "done");
		await flushMicrotasks();
		expect(sent).toEqual(["working", "done", "done", "done"]);
	});

	it("flushes a newer state after a failed send", async () => {
		const deferred = Promise.withResolvers<void>();
		let callIndex = 0;
		const { manager, sent } = fakeIdeManager({
			notify: async () => {
				if (callIndex++ === 0) return deferred.promise;
			},
		});

		publishIdeSessionState(manager, "working");
		publishIdeSessionState(manager, "done");
		deferred.reject(new Error("boom"));
		await flushMicrotasks();
		expect(sent).toEqual(["working", "done"]);

		publishIdeSessionState(manager, "working");
		await flushMicrotasks();
		expect(sent).toEqual(["working", "done", "working"]);
	});

	for (const outcome of ["fulfilled", "rejected"] as const) {
		it(`re-sends the latest state when the ide server reconnects while a send is ${outcome}-pending`, async () => {
			const deferred = Promise.withResolvers<void>();
			let callIndex = 0;
			const { manager, sent, fire } = fakeIdeManager({
				notify: async () => {
					if (callIndex++ === 1) return deferred.promise;
				},
			});
			subscribeIdeState(manager);
			await flushMicrotasks();
			expect(sent).toEqual(["idle"]);

			publishIdeSessionState(manager, "done");
			await flushMicrotasks();
			expect(sent).toEqual(["idle", "done"]);

			fire({ type: "connected", serverName: "ide" });
			await flushMicrotasks();
			expect(sent).toEqual(["idle", "done"]);

			if (outcome === "fulfilled") deferred.resolve();
			else deferred.reject(new Error("HTTP 502: bad gateway"));
			await flushMicrotasks();
			expect(sent).toEqual(["idle", "done", "done"]);

			publishIdeSessionState(manager, "done");
			await flushMicrotasks();
			expect(sent).toEqual(["idle", "done", "done"]);
		});
	}
});
