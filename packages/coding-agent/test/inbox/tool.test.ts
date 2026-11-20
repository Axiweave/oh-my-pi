/**
 * SessionInboxTool against real InboxHosts in a private temp registry
 * (contracts/session-inbox-tool.md). Each host wraps a real AgentSession with
 * a scripted model.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InboxHost } from "@oh-my-pi/pi-coding-agent/inbox/host";
import { MAX_TEXT_BYTES } from "@oh-my-pi/pi-coding-agent/inbox/registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SessionInboxTool, type SessionInboxInput } from "@oh-my-pi/pi-coding-agent/tools/session-inbox";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** mulberry32: small, fixed-seed PRNG so a failing case reproduces. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Polls a condition: the hosts talk over real IPC sockets, so fake timers cannot drive them. */
async function until(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(5);
	}
}

interface Peer {
	session: AgentSession;
	host: InboxHost;
	calls: number;
}

function toolFor(host: InboxHost | undefined): SessionInboxTool {
	return new SessionInboxTool({ getSessionInbox: () => host } as unknown as ToolSession);
}

async function text(tool: SessionInboxTool, params: SessionInboxInput): Promise<string> {
	const block = (await tool.execute("call", params)).content[0];
	if (block?.type !== "text") throw new Error("expected a text result");
	return block.text;
}

/** The ToolError message the call throws; fails when it throws anything else or nothing. */
async function toolError(tool: SessionInboxTool, params: SessionInboxInput): Promise<string> {
	try {
		await tool.execute("call", params);
	} catch (error) {
		expect(error).toBeInstanceOf(ToolError);
		return (error as ToolError).message;
	}
	throw new Error("expected a ToolError");
}

describe("SessionInboxTool", () => {
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const peers: Peer[] = [];

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-inbox-tool-"));
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const peer of peers.splice(0)) {
			await peer.host.stop();
			await peer.session.dispose();
		}
		authStorage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	/** A started host; every model call takes `delayMs`. */
	async function peer(env: NodeJS.ProcessEnv, delayMs = 0): Promise<Peer> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const result = { calls: 0 } as Peer;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			getToolContext: toolCall => ({ toolCall }) as AgentToolContext,
			streamFn: createMockModel({
				handler: () => {
					result.calls++;
					return { content: ["ok"], delayMs };
				},
			}).stream,
		});
		result.session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map(),
		});
		result.host = new InboxHost(result.session, { dir, env });
		await result.host.start();
		peers.push(result);
		return result;
	}

	it("refuses a send or interrupt to the caller's own address", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		await peer({ ZMX_SESSION: "b" });
		const tool = toolFor(a.host);
		expect(await toolError(tool, { op: "send", to: "a", text: "hi" })).toContain("own address");
		expect(await toolError(tool, { op: "interrupt", to: "a" })).toContain("own address");
	});

	it("an unknown address throws 'No reachable session'", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		await peer({ ZMX_SESSION: "b" });
		expect(await toolError(toolFor(a.host), { op: "send", to: "nobody", text: "hi" })).toBe(
			'No reachable session nobody. Use op "list".',
		);
		expect(await toolError(toolFor(a.host), { op: "interrupt", to: "nobody" })).toContain(
			"No reachable session nobody",
		);
	});

	it("two live entries with one address give an ambiguous error that lists both", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b1 = await peer({ ZMX_SESSION: "b" });
		const b2 = await peer({ ZMX_SESSION: "b" });
		const message = await toolError(toolFor(a.host), { op: "send", to: "b", text: "hi" });
		const lines = message.split("\n");
		expect(lines[0]).toBe("b matches 2 sessions:");
		expect(lines.slice(1)).toHaveLength(2);
		for (const line of lines.slice(1)) expect(line).toStartWith("- b  ");
		// Both entries are in the list: each line carries its session's cwd (same here) and the pid.
		expect(b1.host.entry?.entryId).not.toBe(b2.host.entry?.entryId);
		for (const line of lines.slice(1)) expect(line).toEndWith(`(pid ${process.pid})`);
		// Interrupt resolves the address the same way.
		expect(await toolError(toolFor(a.host), { op: "interrupt", to: "b" })).toStartWith("b matches 2 sessions:");
	});

	it("text size is checked in UTF-8 bytes: exactly MAX_TEXT_BYTES passes, one byte more names the limit", async () => {
		const seed = 0x039;
		console.log(`text size seed: ${seed}`);
		const random = rng(seed);
		const a = await peer({ ZMX_SESSION: "a" });
		const tool = toolFor(a.host);
		const chars = ["a", "é", "€", "😀"]; // 1, 2, 3, 4 UTF-8 bytes
		for (let round = 0; round < 8; round++) {
			// Random multi-byte text up to the last 4 bytes, then ASCII to land exactly on the limit.
			const parts: string[] = [];
			let bytes = 0;
			while (bytes < MAX_TEXT_BYTES - 4) {
				const index = Math.floor(random() * chars.length);
				parts.push(chars[index]);
				bytes += index + 1;
			}
			const exact = parts.join("") + "a".repeat(MAX_TEXT_BYTES - bytes);
			expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_TEXT_BYTES);
			expect(exact.length).toBeLessThan(MAX_TEXT_BYTES);
			// Passes the size check, so it fails later, at the address lookup.
			expect(await toolError(tool, { op: "send", to: "nobody", text: exact })).toContain("No reachable session");
			// One more byte, whether as one ASCII char or by widening the last char to two bytes.
			const over = [exact + "a", `${exact.slice(0, -1)}é`];
			for (const big of over) {
				expect(Buffer.byteLength(big, "utf8")).toBe(MAX_TEXT_BYTES + 1);
				expect(await toolError(tool, { op: "send", to: "nobody", text: big })).toContain(
					`${MAX_TEXT_BYTES / 1024} KiB`,
				);
			}
		}
	});

	it("interrupt reports 'Interrupted <to>.' for a busy target and '<to> was idle; nothing to interrupt.' for an idle one", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, 3000);
		const tool = toolFor(a.host);
		expect(await text(tool, { op: "interrupt", to: "b" })).toBe("b was idle; nothing to interrupt.");

		void b.session.prompt("work").catch(() => {});
		await until(() => b.calls === 1, "b's first model call");
		expect(await text(tool, { op: "interrupt", to: "b" })).toBe("Interrupted b.");
		await until(() => !b.session.isStreaming, "b's turn to stop");
	});

	it("two no-zmx hosts list each other with no link flags", async () => {
		// Both hosts share this process's pid, so both get `omp-<pid>`. InboxHost.list()
		// drops the caller by entryId, not by address, so each still sees the other.
		const env = { HOME: process.env.HOME };
		const a = await peer(env);
		const b = await peer(env);
		const address = `omp-${process.pid}`;
		expect(a.host.address).toBe(address);
		expect(b.host.address).toBe(address);
		expect(a.host.parent).toBeNull();
		expect(b.host.parent).toBeNull();

		for (const [self, other] of [
			[a, b],
			[b, a],
		]) {
			const listed = await self.host.list();
			expect(listed.map(session => session.entry.entryId)).toEqual([String(other.host.entry?.entryId)]);
			const lines = (await text(toolFor(self.host), { op: "list" })).split("\n");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toStartWith(`${address}  `);
			expect(lines[0]).not.toContain("started-by-you");
			expect(lines[0]).not.toContain("started-you");
		}
		// The shared address equals the caller's own, so the tool cannot address the other by name.
		expect(await toolError(toolFor(a.host), { op: "send", to: address, text: "hi" })).toContain("own address");
	});

	it("throws 'Session inbox is off.' when the host is stopped or absent", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		await peer({ ZMX_SESSION: "b" });
		const params: SessionInboxInput[] = [
			{ op: "list" },
			{ op: "send", to: "b", text: "hi" },
			{ op: "interrupt", to: "b" },
		];
		const unset = new SessionInboxTool({} as unknown as ToolSession);
		await a.host.stop();
		expect(a.host.started).toBe(false);
		for (const p of params) {
			expect(await toolError(toolFor(a.host), p)).toBe("Session inbox is off.");
			expect(await toolError(toolFor(undefined), p)).toBe("Session inbox is off.");
			expect(await toolError(unset, p)).toBe("Session inbox is off.");
		}
	});
});
