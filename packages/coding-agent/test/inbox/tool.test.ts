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
import { InboxHost, type ReplyOutcome, type SendOutcome } from "@oh-my-pi/pi-coding-agent/inbox/host";
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

/** Every SendOutcome status; delivered/queued carry a thread as a "message" send gives. */
const SEND_OUTCOMES: SendOutcome[] = [
	{ status: "delivered", conversationId: "c-1", thread: "t-0000000a" },
	{ status: "delivered", conversationId: "c-1", shown: true, thread: "t-0000000a" },
	{ status: "queued", conversationId: "c-2", thread: "t-0000000b" },
	{ status: "not_delivered", reason: "busy elsewhere" },
	{ status: "gone" },
	{ status: "no_answer" },
];

/** A stub host: records calls, answers lookup with one entry for "b", and returns the set outcomes. */
function stubHost(outcomes: { send?: SendOutcome; reply?: ReplyOutcome } = {}) {
	const calls = {
		send: [] as { target: unknown; message: unknown }[],
		reply: [] as { thread: string; message: unknown }[],
		lookup: 0,
		interrupt: 0,
	};
	const entry = { address: "b", entryId: "e-b" };
	const host = {
		started: true,
		address: "a",
		parent: null,
		list: async () => [],
		lookup: async () => {
			calls.lookup++;
			return { status: "found", session: { entry, snapshot: {} } };
		},
		send: async (target: unknown, message: unknown) => {
			calls.send.push({ target, message });
			return outcomes.send ?? SEND_OUTCOMES[0];
		},
		reply: async (thread: string, message: unknown) => {
			calls.reply.push({ thread, message });
			return outcomes.reply ?? { status: "unknown_thread" };
		},
		interrupt: async () => {
			calls.interrupt++;
			return "idle";
		},
	} as unknown as InboxHost;
	return { host, calls };
}

describe("SessionInboxTool field rules and result texts (stub host)", () => {
	it("reply needs thread and text, and refuses to, kind, and level", async () => {
		const { host, calls } = stubHost();
		const tool = toolFor(host);
		expect(await toolError(tool, { op: "reply", text: "hi" })).toBe("op reply needs thread.");
		expect(await toolError(tool, { op: "reply", thread: "t-0000000a" })).toBe("op reply needs text.");
		expect(await toolError(tool, { op: "reply", thread: "t-0000000a", text: "  " })).toBe("op reply needs text.");
		const extras: Partial<SessionInboxInput>[] = [
			{ to: "b" },
			{ kind: "message" },
			{ kind: "notification" },
			{ level: "nit" },
		];
		for (const extra of extras) {
			expect(await toolError(tool, { op: "reply", thread: "t-0000000a", text: "hi", ...extra })).toBe(
				"op reply takes no to, kind, or level.",
			);
		}
		expect(await toolError(tool, { op: "reply", thread: "t-0000000a", text: "a".repeat(MAX_TEXT_BYTES + 1) })).toBe(
			`text is over ${MAX_TEXT_BYTES / 1024} KiB.`,
		);
		expect(calls.reply).toHaveLength(0);
	});

	it("thread and progress are refused on list, send, and interrupt", async () => {
		const { host, calls } = stubHost();
		const tool = toolFor(host);
		const bases: SessionInboxInput[] = [
			{ op: "list" },
			{ op: "send", to: "b", text: "hi" },
			{ op: "interrupt", to: "b" },
		];
		for (const base of bases) {
			const threadError = await toolError(tool, { ...base, thread: "t-0000000a" });
			const progressErrors = [
				await toolError(tool, { ...base, progress: true }),
				await toolError(tool, { ...base, progress: false }),
			];
			if (base.op === "list") {
				expect(threadError).toBe("op list takes no other fields.");
				for (const error of progressErrors) expect(error).toBe("op list takes no other fields.");
			} else {
				expect(threadError).toBe("thread is only for op reply.");
				for (const error of progressErrors) expect(error).toBe("progress is only for op reply.");
			}
		}
		expect(calls).toEqual({ send: [], reply: [], lookup: 0, interrupt: 0 });
	});

	it("delivery is refused on a notification, and level on a message", async () => {
		const { host, calls } = stubHost();
		const tool = toolFor(host);
		for (const delivery of ["steer", "after_turn"] as const) {
			expect(await toolError(tool, { op: "send", to: "b", text: "hi", kind: "notification", delivery })).toBe(
				"delivery is only for a message.",
			);
		}
		for (const kind of [undefined, "message"] as const) {
			expect(await toolError(tool, { op: "send", to: "b", text: "hi", kind, level: "nit" })).toBe(
				"level is only for a notification.",
			);
		}
		expect(calls.send).toHaveLength(0);
	});

	it("reply on a thread the inbox does not have throws 'Unknown thread <id>.'", async () => {
		const { host, calls } = stubHost({ reply: { status: "unknown_thread" } });
		expect(await toolError(toolFor(host), { op: "reply", thread: "t-deadbeef", text: "hi" })).toBe(
			"Unknown thread t-deadbeef.",
		);
		// The host got the call and reported nothing sent: no send, no lookup.
		expect(calls.reply).toEqual([
			{ thread: "t-deadbeef", message: { text: "hi", progress: undefined, delivery: undefined } },
		]);
		expect(calls.send).toHaveLength(0);
		expect(calls.lookup).toBe(0);
	});

	it("reply passes text, progress, and delivery to inbox.reply", async () => {
		const { host, calls } = stubHost({ reply: { status: "delivered", conversationId: "c", to: "b" } });
		await text(toolFor(host), {
			op: "reply",
			thread: "t-0000000a",
			text: "on it",
			progress: true,
			delivery: "after_turn",
		});
		expect(calls.reply).toEqual([
			{ thread: "t-0000000a", message: { text: "on it", progress: true, delivery: "after_turn" } },
		]);
	});

	it("send passes a message by default and a notification with its level", async () => {
		const { host, calls } = stubHost();
		const tool = toolFor(host);
		await text(tool, { op: "send", to: "b", text: "hi", delivery: "after_turn" });
		await text(tool, { op: "send", to: "b", text: "careful", kind: "notification", level: "concern" });
		expect(calls.send.map(call => call.message)).toEqual([
			{ kind: "message", text: "hi", delivery: "after_turn" },
			{ kind: "notification", text: "careful", level: "concern" },
		]);
	});

	it("each send outcome gives the contract text, for a message and a notification", async () => {
		for (const outcome of SEND_OUTCOMES) {
			for (const kind of ["message", "notification"] as const) {
				const { host } = stubHost({ send: outcome });
				const result = await text(toolFor(host), { op: "send", to: "b", text: "hi", kind });
				switch (outcome.status) {
					case "delivered":
					case "queued": {
						const verb = outcome.status === "delivered" ? "Delivered to" : "Queued in";
						let expected = `${verb} b (${outcome.conversationId}).`;
						if (outcome.shown) expected += " (shown, no turn started)";
						if (kind === "message") expected += ` Thread ${outcome.thread}. The answer comes in this thread.`;
						expect(result).toBe(expected);
						break;
					}
					case "not_delivered":
						expect(result).toBe(`Not delivered to b: ${outcome.reason}.`);
						break;
					case "gone":
						expect(result).toBe("Not delivered to b: the session ended.");
						break;
					case "no_answer":
						expect(result).toBe("No answer from b yet; the message may still arrive.");
						break;
				}
			}
		}
	});

	it("each reply outcome gives the contract text", async () => {
		const thread = "t-3f2a9c1b";
		const peer = "cci-omp-upload-k3x9q1";
		const expected: Record<SendOutcome["status"], string> = {
			delivered: `Replied in thread ${thread} to ${peer}.`,
			queued: `Queued in thread ${thread} for ${peer}.`,
			not_delivered: `Not delivered in thread ${thread}: busy elsewhere.`,
			gone: `Not delivered in thread ${thread}: the session ended.`,
			no_answer: `No answer from ${peer} yet; the reply may still arrive.`,
		};
		const outcomes: ReplyOutcome[] = [
			...SEND_OUTCOMES.map(outcome => ({ ...outcome, to: peer }) as ReplyOutcome),
			{ status: "not_delivered", reason: "unknown_thread", to: peer },
		];
		for (const outcome of outcomes) {
			if (outcome.status === "unknown_thread") continue;
			const { host } = stubHost({ reply: outcome });
			const result = await text(toolFor(host), { op: "reply", thread, text: "PONG" });
			if (outcome.status === "not_delivered")
				expect(result).toBe(`Not delivered in thread ${thread}: ${outcome.reason}.`);
			else expect(result).toBe(expected[outcome.status]);
		}
	});
});
