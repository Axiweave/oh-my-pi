/**
 * Session inbox end to end: real AgentSessions with a scripted model, real
 * IPC endpoints in a private temp registry. The target model answers
 * `echo:<first line of the last input>`, so an automatic answer names the run
 * it came from. The hosts talk over real IPC sockets, so fake timers cannot
 * drive them; a short real sleep only proves that nothing more arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { InboxHost, type ReplyOutcome, type SendOutcome, THREAD_ID_RE } from "@oh-my-pi/pi-coding-agent/inbox/host";
import {
	callInbox,
	INBOX_VERSION,
	MAX_REPLY_TEXT_BYTES,
	MAX_TEXT_BYTES,
} from "@oh-my-pi/pi-coding-agent/inbox/registry";
import { RpcPromptResults } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-prompt-results";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CostGate } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import { buildInboxReplyBatchMessage, type InboxReply } from "@oh-my-pi/pi-coding-agent/session/inbox-reply";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgSessionMaxCost } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { SessionInboxTool } from "@oh-my-pi/pi-coding-agent/tools/session-inbox";
import type { ExtensionAskDialogResult } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

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

function seeded(name: string, seed: number): () => number {
	console.log(`${name}: seed=0x${seed.toString(16)}`);
	return rng(seed);
}

/** Text of the last input message; an agent-attributed custom message reaches the model as `developer`. */
function lastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user" && message.role !== "developer") continue;
		if (typeof message.content === "string") return message.content;
		return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
	}
	return "";
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(block => (block?.type === "text" ? String(block.text) : "")).join("");
}

/** The last thread id that the model input names. */
function threadIn(context: Context): string {
	const ids = [...JSON.stringify(context.messages).matchAll(/\[thread (t-[0-9a-f]{8}) /g)];
	const id = ids.at(-1)?.[1];
	if (!id) throw new Error("no thread in the model input");
	return id;
}

/** The footer of a message from the opener (contracts/session-inbox-tool.md, FR-007). */
function footer(thread: string): string {
	return `Answer with session_inbox reply, thread "${thread}", without progress. Use progress: true only for "on it". A progress note does not stop your last answer from going back.`;
}

/** The harness-tag starts that a peer must never place in model-visible content (FR-013). */
const HARNESS_TAG_RE = /<(?=\s*\/?\s*(?:irc|system-[a-z][a-z-]*)(?![\w-]))/gi;

function opened(result: SendOutcome | ReplyOutcome): string {
	if ((result.status === "delivered" || result.status === "queued") && result.thread) return result.thread;
	throw new Error(`no thread opened: ${JSON.stringify(result)}`);
}

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
	/** Context of every model call, in order. */
	calls: Context[];
	/** Messages to the opener that this peer received (queueInboxReply spied). */
	replies: InboxReply[];
	/** `Date.now()` at each entry of `replies`. */
	replyAt: number[];
}

/** The automatic messages a peer received. */
const decisions = (target: Peer) => target.replies.filter(reply => reply.type === "auto" || reply.type === "failure");

/** Request-path content in `target`'s conversation, in order. */
function prompts(target: Peer): string[] {
	return target.session.messages.flatMap(message =>
		message.role === "custom" && message.customType === COLLAB_PROMPT_MESSAGE_TYPE ? [textOf(message.content)] : [],
	);
}

/** Reply-path notices in `target`'s conversation (real delivery), in order. */
function notices(target: Peer): string[] {
	return target.session.messages.flatMap(message =>
		message.role === "custom" && message.customType === "inbox-reply" ? [textOf(message.content)] : [],
	);
}

const unix = it.skipIf(process.platform === "win32");

describe("session inbox", () => {
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const peers: Peer[] = [];
	const servers: net.Server[] = [];

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-inbox-"));
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const peer of peers.splice(0)) {
			await peer.host.stop();
			await peer.session.dispose();
		}
		for (const server of servers.splice(0)) server.close();
		authStorage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	/**
	 * `delays[i]` delays the i-th model call. `script` replaces the echo answer of
	 * a call when it returns one. `spyReplies: false` keeps the real reply
	 * delivery (the reply then starts a model call of its own).
	 */
	async function peer(
		env: NodeJS.ProcessEnv,
		options: {
			delays?: number[];
			script?: (index: number, context: Context) => MockResponse | undefined | Promise<MockResponse | undefined>;
			tools?: AgentTool[];
			spyReplies?: boolean;
			costGate?: CostGate;
			settings?: Settings;
			/** A UI for tools that open dialogs (`ask`). */
			ui?: ExtensionUIContext;
			/** Session name, the `name` the peer sends. */
			name?: string;
		} = {},
	): Promise<Peer> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const calls: Context[] = [];
		const delays = options.delays ?? [];
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: options.tools ?? [], messages: [] },
			convertToLlm,
			getToolContext: toolCall =>
				({ toolCall, ui: options.ui, hasUI: options.ui !== undefined, abort: () => {} }) as AgentToolContext,
			streamFn: createMockModel({
				handler: async context => {
					const index = calls.length;
					calls.push({ ...context, messages: structuredClone(context.messages) });
					const delayMs = delays[index] ?? 0;
					const scripted = await options.script?.(index, context);
					return scripted ?? { content: [`echo:${lastUserText(context).split("\n")[0]}`], delayMs };
				},
			}).stream,
		});
		const settings = options.settings ?? Settings.isolated({ "compaction.enabled": false });
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			costGate: options.costGate,
			toolRegistry: new Map((options.tools ?? []).map(tool => [tool.name, tool])),
		});
		if (options.name) await session.setSessionName(options.name, "user");
		const host = new InboxHost(session, { dir, env });
		await host.start();
		session.setSessionInbox(host);
		const replies: InboxReply[] = [];
		const replyAt: number[] = [];
		if (options.spyReplies !== false) {
			vi.spyOn(session, "queueInboxReply").mockImplementation(async reply => {
				replies.push(reply);
				replyAt.push(Date.now());
			});
		}
		const result = { session, host, calls, replies, replyAt };
		peers.push(result);
		return result;
	}

	function entryOf(target: Peer) {
		const entry = target.host.entry;
		if (!entry) throw new Error("host not started");
		return entry;
	}

	/**
	 * Point `target`'s registry entry at a proxy that records each request. Every
	 * thread message after the first reads the peer's entry from the registry, so
	 * the proxy sees all of them.
	 */
	async function tap(target: Peer): Promise<Record<string, unknown>[]> {
		const real = entryOf(target);
		const seen: Record<string, unknown>[] = [];
		const server = net.createServer(client => {
			const upstream = net.connect(real.endpoint);
			let buffer = "";
			let recorded = false;
			client.on("data", chunk => {
				upstream.write(chunk);
				if (recorded) return;
				buffer += chunk.toString("utf8");
				const end = buffer.indexOf("\n");
				if (end < 0) return;
				recorded = true;
				seen.push(JSON.parse(buffer.slice(0, end)));
			});
			upstream.on("data", chunk => client.write(chunk));
			upstream.on("end", () => client.end());
			client.on("end", () => upstream.end());
			upstream.on("error", () => client.destroy());
			client.on("error", () => upstream.destroy());
		});
		const proxyPath = path.join(dir, `tap${servers.length}.sock`);
		servers.push(server);
		await new Promise<void>(resolve => server.listen(proxyPath, resolve));
		await fs.writeFile(path.join(dir, `${real.entryId}.json`), JSON.stringify({ ...real, endpoint: proxyPath }));
		return seen;
	}

	// ── US1: open a thread and reply explicitly ─────────────────────────────

	it("send opens a thread: a THREAD_ID_RE id, a `new` prefix with the footer, then `reply` prefixes (seed 0x7e01)", async () => {
		const random = seeded("thread prefixes", 0x7e01);
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" });
		const alphabet = ["x", " ", "€", "\n", "<", "]", "[thread", "é", "0"];
		const word = () =>
			`w${Array.from({ length: 1 + Math.floor(random() * 12) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("")}`;
		for (let round = 0; round < 4; round++) {
			const first = word();
			const later = Array.from({ length: 1 + Math.floor(random() * 3) }, word);
			const before = prompts(b).length;
			const result = await a.host.send(entryOf(b), { kind: "message", text: first });
			expect(result.status).toBe("delivered");
			const id = opened(result);
			expect(id).toMatch(THREAD_ID_RE);
			for (const text of later) {
				await b.session.waitForIdle();
				expect(["delivered", "queued"]).toContain((await a.host.reply(id, { text })).status);
			}
			await until(() => prompts(b).length === before + 1 + later.length, `round ${round} arrivals`);
			await b.session.waitForIdle();
			const got = prompts(b).slice(before);
			const context = `round=${round} first=${JSON.stringify(first)}`;
			expect(got[0], context).toBe(`[thread ${id} new from a (a)] ${first}\n${footer(id)}`);
			later.forEach((text, i) => {
				expect(got[i + 1], context).toBe(`[thread ${id} reply from a (a)] ${text}\n${footer(id)}`);
			});
		}
	});

	it("B's explicit reply reaches A once as a `message` in the same thread from B, and the turn sends no auto", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b: Peer = await peer(
			{ ZMX_SESSION: "b" },
			{
				script: async (index, context) => {
					if (index !== 0) return undefined;
					expect((await b.host.reply(threadIn(context), { text: "PONG" })).status).toBe("delivered");
					return { content: ["done"] };
				},
			},
		);
		const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "reply with PONG" }));
		await until(() => a.replies.length === 1, "reply");
		await b.session.waitForIdle();
		await Bun.sleep(100);
		expect(a.replies).toEqual([{ thread: id, from: { address: "b", name: "b" }, type: "message", text: "PONG" }]);
	});

	it("an explicit reply shows in an idle opener's conversation within 1 s of the reply call (SC-004)", async () => {
		const a = await peer({ ZMX_SESSION: "a" }, { spyReplies: false });
		const b = await peer({ ZMX_SESSION: "b" });
		const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "ping" }));
		await until(() => notices(a).length === 1, "automatic answer");
		await until(() => a.calls.length === 1, "a's turn on it");
		await a.session.waitForIdle();
		await b.session.waitForIdle();

		expect((await b.host.reply(id, { text: "PONG" })).status).toBe("delivered");
		const returned = Date.now();
		await until(() => notices(a).some(text => text.includes(`Thread ${id}, reply from b`)), "reply notice", 1000);
		expect(Date.now() - returned).toBeLessThan(1000);
	});

	unix("accepts a reply that arrives before the opener's send call returns", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b: Peer = await peer(
			{ ZMX_SESSION: "b" },
			{
				script: async (index, context) => {
					if (index !== 0) return undefined;
					await b.host.reply(threadIn(context), { text: "PONG" });
					return { content: ["done"] };
				},
			},
		);
		// A proxy in front of b holds b's send result until a has the reply.
		let replyCameFirst = false;
		const proxy = net.createServer(client => {
			client.once("data", request => {
				const upstream = net.connect(entryOf(b).endpoint);
				upstream.write(request);
				upstream.once("data", async response => {
					await until(() => a.replies.length === 1, "reply before the send result", 3000).catch(() => {});
					replyCameFirst = a.replies.length === 1;
					client.end(response);
					upstream.destroy();
				});
			});
		});
		servers.push(proxy);
		const proxyPath = path.join(dir, "px.sock");
		await new Promise<void>(resolve => proxy.listen(proxyPath, resolve));
		const result = await a.host.send({ ...entryOf(b), endpoint: proxyPath }, { kind: "message", text: "ping" });
		expect(replyCameFirst).toBe(true);
		expect(result.status).toBe("delivered");
		const id = opened(result);
		await b.session.waitForIdle();
		await Bun.sleep(50);
		expect(a.replies).toEqual([{ thread: id, from: { address: "b", name: "b" }, type: "message", text: "PONG" }]);
	});

	it("a send that ends not_delivered or gone leaves no thread: a reply on its id is unknown_thread", async () => {
		// The opener makes the id before the call; record each one it makes.
		const ids: string[] = [];
		const randomBytes = crypto.randomBytes.bind(crypto);
		vi.spyOn(crypto, "randomBytes").mockImplementation(((size: number) => {
			const bytes = randomBytes(size);
			if (size === 4) ids.push(`t-${bytes.toString("hex")}`);
			return bytes;
		}) as typeof crypto.randomBytes);
		const settings = Settings.isolated({ "compaction.enabled": false, "session.maxCost": 1 });
		const a = await peer({ ZMX_SESSION: "a" });
		const capped = await peer({ ZMX_SESSION: "capped" }, { settings, costGate: new CostGate(settings, 2, () => {}) });
		const ended = await peer({ ZMX_SESSION: "ended" });
		const endedEntry = entryOf(ended);
		await ended.host.stop();

		expect(await a.host.send(entryOf(capped), { kind: "message", text: "ping" })).toEqual({
			status: "not_delivered",
			reason: "cost_cap",
		});
		expect(await a.host.send(endedEntry, { kind: "message", text: "ping" })).toEqual({ status: "gone" });
		expect(ids).toHaveLength(2);
		for (const id of ids) expect(await a.host.reply(id, { text: "again" })).toEqual({ status: "unknown_thread" });
		expect(capped.calls).toHaveLength(0);
	});

	// ── 023 properties kept: dialogs, the editor, tools, notifications ──────

	it("a steered message enters a running turn at its next step and the turn's answer comes back", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: [200] });
		const work = b.session.prompt("work");
		await until(() => b.calls.length === 1, "b's first model call");

		const result = await a.host.send(entryOf(b), { kind: "message", text: "ping" });
		expect(result.status).toBe("queued");
		const id = opened(result);
		await work;
		await until(() => a.replies.length === 1, "auto");

		// One run, two steps: the steer joined the run that was already going.
		expect(b.calls).toHaveLength(2);
		expect(lastUserText(b.calls[1])).toBe(`[thread ${id} new from a (a)] ping\n${footer(id)}`);
		expect(a.replies[0]).toMatchObject({
			thread: id,
			from: { address: "b" },
			type: "auto",
			text: `echo:[thread ${id} new from a (a)] ping`,
		});
	});

	it("a steered message does not stop a running tool: the tool returns its own result", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		let started = false;
		let steerReason: unknown;
		let hardAborted = false;
		const slow: AgentTool = {
			name: "slow",
			label: "slow",
			description: "slow tool",
			parameters: type({}),
			async execute(_id, _args, signal, _onUpdate, context) {
				started = true;
				const steering = context?.toolCall?.steeringSignal;
				steering?.addEventListener("abort", () => {
					steerReason = steering.reason;
				});
				signal?.addEventListener("abort", () => {
					hardAborted = true;
				});
				await gate;
				return { content: [{ type: "text", text: "slow done" }] };
			},
		};
		const b = await peer(
			{ ZMX_SESSION: "b" },
			{
				tools: [slow],
				script: index =>
					index === 0 ? { content: [{ type: "toolCall", name: "slow", arguments: {} }] } : undefined,
			},
		);
		const work = b.session.prompt("work");
		await until(() => started, "slow tool start");

		const result = await a.host.send(entryOf(b), { kind: "message", text: "ping" });
		expect(result.status).toBe("queued");
		await Bun.sleep(50);
		release();
		await work;
		await until(() => a.replies.length === 1, "auto");

		// The tool saw the steer as a soft signal only; nothing hard-aborted it.
		expect(steerReason).toBeDefined();
		expect(hardAborted).toBe(false);
		const toolResult = b.session.messages.find(message => message.role === "toolResult");
		expect(toolResult).toMatchObject({
			toolName: "slow",
			isError: false,
			content: [{ type: "text", text: "slow done" }],
		});
	});

	it("a steered message leaves an open ask dialog open; ask returns the user's answer", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		let dialogSignal: AbortSignal | undefined;
		let answer!: (result: ExtensionAskDialogResult) => void;
		let dialogOpened = false;
		const ui = {
			askDialog: (_questions: unknown, dialogOptions?: { signal?: AbortSignal }) => {
				dialogOpened = true;
				dialogSignal = dialogOptions?.signal;
				return new Promise<ExtensionAskDialogResult>(resolve => {
					answer = resolve;
				});
			},
		} as unknown as ExtensionUIContext;
		const settings = Settings.isolated({ "compaction.enabled": false });
		const ask = new AskTool({ settings, getPlanModeState: () => undefined } as unknown as ToolSession);
		const question = { id: "q", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] };
		const b = await peer(
			{ ZMX_SESSION: "b" },
			{
				ui,
				settings,
				tools: [ask as unknown as AgentTool],
				script: index =>
					index === 0
						? { content: [{ type: "toolCall", name: "ask", arguments: { questions: [question] } }] }
						: undefined,
			},
		);
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("theme unavailable");
		setThemeInstance(dark);
		const work = b.session.prompt("work");
		await until(() => dialogOpened, "ask dialog");

		const result = await a.host.send(entryOf(b), { kind: "message", text: "ping" });
		expect(result.status).toBe("queued");
		const id = opened(result);
		await Bun.sleep(100);
		expect(dialogSignal?.aborted).toBe(false);
		expect(b.session.messages.some(message => message.role === "toolResult")).toBe(false);

		answer({
			kind: "submit",
			results: [{ id: "q", question: "Proceed?", options: ["yes", "no"], multi: false, selectedOptions: ["yes"] }],
		});
		await work;
		await until(() => a.replies.length === 1, "auto");
		const toolResult = b.session.messages.find(message => message.role === "toolResult");
		expect(toolResult).toMatchObject({ toolName: "ask", isError: false });
		expect(JSON.stringify(toolResult)).toContain("yes");
		expect(a.replies[0].text).toBe(`echo:[thread ${id} new from a (a)] ping`);
	});

	it("a message never reaches the target's editor: the prompt-drop hook stays silent, even for a cut turn", async () => {
		// InteractiveMode writes the editor only from its own submit path and from this
		// hook (it restores a dropped typed prompt into an empty editor).
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: [3000] });
		const dropped: unknown[] = [];
		b.session.setPromptDropped(prompt => dropped.push(prompt));
		void b.session.prompt("work").catch(() => {});
		await until(() => b.calls.length === 1, "b's first model call");
		await a.host.send(entryOf(b), { kind: "message", text: "steer me" });
		await a.host.send(entryOf(b), { kind: "message", text: "later", delivery: "after_turn" });

		await b.session.newSession();
		await until(() => a.replies.length === 2, "failures");
		expect(a.replies.map(reply => [reply.type, reply.outcome])).toEqual([
			["failure", "aborted"],
			["failure", "aborted"],
		]);
		expect(dropped).toEqual([]);
	});

	it("checks a request in contract order: malformed, protocol, token, operation; the 023 reply op is gone", async () => {
		const b = await peer({ ZMX_SESSION: "b" });
		const entry = entryOf(b);
		const order = ["unsupported_protocol", "authentication_failed", "invalid_operation"] as const;
		// Every combination of the three faults reports the first one in contract order.
		for (let mask = 1; mask < 8; mask++) {
			const request = {
				...(mask & 1 ? {} : { v: INBOX_VERSION }),
				token: mask & 2 ? "wrong" : entry.token,
				op: mask & 4 ? "bogus" : "snapshot",
			};
			const expected = order[[1, 2, 4].findIndex(bit => mask & bit)];
			// queryEndpoint adds v/token; send through a copy of the entry with the token under test.
			const result = await callInbox({ ...entry, token: request.token }, { op: request.op, v: request.v }, 1000);
			expect(result, `mask=${mask}`).toEqual({ status: "skip", error: expected });
		}
		const reply = { id: "x", from: { address: "a", name: "a" }, outcome: "completed", text: "x" };
		expect(await callInbox(entry, { op: "reply", reply }, 1000)).toEqual({
			status: "skip",
			error: "invalid_operation",
		});
		expect(b.calls).toHaveLength(0);
	});

	it("refuses invalid and oversized messages before anything reaches the session", async () => {
		const b = await peer({ ZMX_SESSION: "b" });
		const from = { address: "a", name: "a", entryId: "0123456789abcdef" };
		const send = (message: Record<string, unknown>) => callInbox(entryOf(b), { op: "send", message }, 1000);
		const base = { id: "1", from, kind: "thread", thread: "t-0123abcd", type: "message", first: true, text: "hi" };
		const invalid = { status: "skip", error: "invalid" } as const;
		expect(await send({ ...base, level: "nit" })).toEqual(invalid);
		expect(await send({ ...base, kind: "notification", delivery: "steer" })).toEqual(invalid);
		expect(await send({ ...base, text: "" })).toEqual(invalid);
		expect(await send({ ...base, thread: "t-0123ABCD" })).toEqual(invalid);
		expect(await send({ ...base, kind: "request" })).toEqual(invalid);
		// Byte limit, not character limit: a 3-byte character one past the boundary.
		expect(await send({ ...base, text: "x".repeat(MAX_TEXT_BYTES - 2) + "€" })).toEqual({
			status: "skip",
			error: "too_large",
		});
		expect(b.calls).toHaveLength(0);
	});

	it("a nit to an idle target is only shown; a blocker starts a turn; neither replies", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" });
		const nit = await a.host.send(entryOf(b), { kind: "notification", text: "rename x" });
		expect(nit).toMatchObject({ status: "delivered", shown: true });
		expect(nit).not.toHaveProperty("thread");
		await Bun.sleep(50);
		expect(b.calls).toHaveLength(0);

		const blocker = await a.host.send(entryOf(b), {
			kind: "notification",
			text: "stop: wrong file",
			level: "blocker",
		});
		expect(blocker.status).toBe("delivered");
		expect(blocker).not.toHaveProperty("shown");
		await until(() => b.calls.length === 1, "b's turn");
		await b.session.waitForIdle();
		await Bun.sleep(50);
		expect(a.replies).toHaveLength(0);
	});

	it("interrupt stops a busy target with a notice and leaves an idle one alone", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: [3000] });
		const seen: string[] = [];
		b.session.subscribe(event => {
			if (event.type === "notice") seen.push(event.message);
		});
		const abort = vi.spyOn(b.session, "abort");
		expect(await a.host.interrupt(entryOf(b))).toBe("idle");
		expect(abort).not.toHaveBeenCalled();

		void b.session.prompt("work").catch(() => {});
		await until(() => b.calls.length === 1, "b's first model call");
		expect(await a.host.interrupt(entryOf(b))).toBe("interrupted");
		await until(() => seen.includes("a interrupted"), "interrupt notice");
		expect(b.session.isStreaming).toBe(false);
	});

	it("two sessions without zmx reach each other as omp-<pid> and an automatic answer starts the opener's turn", async () => {
		const a = await peer({}, { spyReplies: false });
		const b = await peer({});
		const listed = await a.host.list();
		expect(listed.map(session => session.entry.address)).toEqual([`omp-${process.pid}`]);
		expect(listed[0].entry.entryId).toBe(entryOf(b).entryId);
		expect(listed[0].entry.parent).toBeNull();
		expect(a.host.parent).toBeNull();

		const id = opened(await a.host.send(listed[0].entry, { kind: "message", text: "ping" }));
		await until(() => a.calls.length === 1, "a's turn on the answer");
		const seen = JSON.stringify(a.calls[0].messages);
		expect(seen).toContain(`Thread ${id}, automatic answer (no final reply) from omp-${process.pid}`);
		expect(seen).toContain(`echo:[thread ${id} new from`);
	});

	it("list shows exactly the live sessions minus the caller, with link flags only for a real parent pair", async () => {
		const random = seeded("list", 0x11);
		const parent = await peer({ ZMX_SESSION: "p" });
		const child = await peer({ ZMX_SESSION: "c", OMP_SPAWN_PARENT: "p" });
		const others = await Promise.all(Array.from({ length: 6 }, (_, i) => peer({ ZMX_SESSION: `x${i}` })));
		const stopped = others.filter(() => random() < 0.5);
		for (const other of stopped) await other.host.stop();
		const live = [child, ...others.filter(other => !stopped.includes(other))];

		const listed = await parent.host.list();
		expect(new Set(listed.map(session => session.entry.entryId))).toEqual(
			new Set(live.map(other => entryOf(other).entryId)),
		);

		const listText = async (from: Peer) => {
			const tool = new SessionInboxTool({ getSessionInbox: () => from.host } as unknown as ToolSession);
			const result = await tool.execute("call", { op: "list" });
			const block = result.content[0];
			if (block?.type !== "text") throw new Error("expected a text result");
			return block.text.split("\n");
		};
		const fromParent = await listText(parent);
		for (const line of fromParent) {
			expect(line.includes("started-by-you"), line).toBe(line.startsWith("c "));
			expect(line.includes("started-you"), line).toBe(false);
		}
		const fromChild = await listText(child);
		for (const line of fromChild) {
			expect(line.includes("started-you"), line).toBe(line.startsWith("p "));
			expect(line.includes("started-by-you"), line).toBe(false);
		}
	});

	it("N new threads in a row (N 1..20) reach the target in send order (seed 0x0b5e)", async () => {
		const random = seeded("N in a row", 0x0b5e);
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: Array(1000).fill(3) });
		const arrivals = () =>
			prompts(b).flatMap(text => text.match(/^\[thread t-[0-9a-f]{8} new from a \(a\)\] (m\d+)/)?.[1] ?? []);
		const sent: string[] = [];
		for (let n = 1; n <= 20; n++) {
			const delivery = random() < 0.5 ? "steer" : "after_turn";
			for (let i = 0; i < n; i++) {
				const text = `m${sent.length}`;
				sent.push(text);
				const result = await a.host.send(entryOf(b), { kind: "message", text, delivery });
				expect(["delivered", "queued"], `n=${n} ${delivery} ${text}`).toContain(result.status);
			}
			await until(() => arrivals().length === sent.length, `n=${n} arrivals`, 10_000);
			await b.session.waitForIdle();
		}
		expect(arrivals()).toEqual(sent);
	}, 60_000);

	it("a concern starts a turn in an idle target, but only shows after a remote interrupt or in plan mode", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const idle = await peer({ ZMX_SESSION: "idle" });
		const result = await a.host.send(entryOf(idle), { kind: "notification", text: "check x", level: "concern" });
		expect(result.status).toBe("delivered");
		expect(result).not.toHaveProperty("shown");
		await until(() => idle.calls.length === 1, "concern turn");

		const stopped = await peer({ ZMX_SESSION: "stopped" }, { delays: [3000] });
		void stopped.session.prompt("work").catch(() => {});
		await until(() => stopped.calls.length === 1, "stopped's first model call");
		expect(await a.host.interrupt(entryOf(stopped))).toBe("interrupted");
		await until(() => !stopped.session.isStreaming, "stopped idle");
		expect(
			await a.host.send(entryOf(stopped), { kind: "notification", text: "check x", level: "concern" }),
		).toMatchObject({ status: "delivered", shown: true });

		const planning = await peer({ ZMX_SESSION: "planning" });
		planning.session.setPlanModeState({
			enabled: true,
			planFilePath: path.join(dir, "plan.md"),
			workflow: "parallel",
		});
		expect(
			await a.host.send(entryOf(planning), { kind: "notification", text: "check x", level: "concern" }),
		).toMatchObject({ status: "delivered", shown: true });

		await Bun.sleep(100);
		expect(stopped.calls).toHaveLength(1);
		expect(planning.calls).toHaveLength(0);
	});

	it("after the opener's own user interrupt, a message to it joins its conversation and starts no turn", async () => {
		const a = await peer({ ZMX_SESSION: "a" }, { spyReplies: false, delays: [3000] });
		const b = await peer({ ZMX_SESSION: "b" });
		void a.session.prompt("work").catch(() => {});
		await until(() => a.calls.length === 1, "a's first model call");
		await a.session.abort({ reason: USER_INTERRUPT_LABEL });
		await until(() => !a.session.isStreaming, "a idle");

		const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "ping" }));
		await until(() => notices(a).some(text => text.includes(`Thread ${id}`)), "notice in a's conversation");
		await Bun.sleep(100);
		expect(a.calls).toHaveLength(1);
	});

	it("a sender that is gone before the target's turn ends gets nothing, and the target stays as it was", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const c = await peer({ ZMX_SESSION: "c" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: [300] });
		expect((await a.host.send(entryOf(b), { kind: "message", text: "ping" })).status).toBe("delivered");
		await a.host.stop();

		await until(() => b.calls.length === 1, "b's turn");
		await b.session.waitForIdle();
		const settled = b.session.messages.length;
		await Bun.sleep(150);
		expect(b.session.messages).toHaveLength(settled);
		expect(b.calls).toHaveLength(1);
		expect(a.replies).toHaveLength(0);

		// The target still serves the next sender normally.
		const id = opened(await c.host.send(entryOf(b), { kind: "message", text: "next" }));
		await until(() => c.replies.length === 1, "c's answer");
		expect(c.replies[0].text).toBe(`echo:[thread ${id} new from c (c)] next`);
	});

	// ── US2: one thread over many turns ──────────────────────────────────────

	it("K messages (K 1..10) from both sides in one thread reach each side in send order with one thread id (seed 0x0d3e)", async () => {
		const random = seeded("thread order", 0x0d3e);
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" });
		for (let k = 1; k <= 10; k++) {
			const senders = Array.from({ length: k }, () => (random() < 0.5 ? a : b));
			const open = `k${k}-open`;
			const id = opened(await a.host.send(entryOf(b), { kind: "message", text: open }));
			const toB = [open];
			const toA: string[] = [];
			for (let i = 0; i < k; i++) {
				const text = `k${k}-m${i}`;
				const result = await senders[i].host.reply(id, { text });
				const context = `k=${k} i=${i} from=${senders[i] === a ? "a" : "b"}`;
				expect(["delivered", "queued"], context).toContain(result.status);
				(senders[i] === a ? toB : toA).push(text);
			}
			const atB = () => prompts(b).filter(text => text.includes(`] k${k}-`));
			const atA = () => a.replies.filter(reply => reply.type === "message" && reply.text.startsWith(`k${k}-`));
			await until(() => atB().length === toB.length && atA().length === toA.length, `k=${k} arrivals`);
			const context = `k=${k} senders=${senders.map(s => (s === a ? "a" : "b")).join("")}`;
			expect(
				atB().map(text => text.match(/^\[thread (t-[0-9a-f]{8}) (?:new|reply) from a \(a\)\] (\S+)/)?.slice(1)),
				context,
			).toEqual(toB.map(text => [id, text]));
			expect(
				atA().map(reply => [reply.thread, reply.text]),
				context,
			).toEqual(toA.map(text => [id, text]));
			await b.session.waitForIdle();
		}
	}, 30_000);

	it("progress: B's note shows in A as `progress (the answer follows later)`; A's note shows in B with no footer", async () => {
		const a = await peer({ ZMX_SESSION: "a" }, { spyReplies: false });
		const b: Peer = await peer(
			{ ZMX_SESSION: "b" },
			{
				script: async (index, context) => {
					if (index === 0) await b.host.reply(threadIn(context), { text: "on it", progress: true });
					return undefined;
				},
			},
		);
		const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "ping" }));
		await until(
			() =>
				notices(a).some(text =>
					text.includes(`Thread ${id}, progress (the answer follows later) from b ("b"):\non it`),
				),
			"progress notice",
		);
		await b.session.waitForIdle();
		expect((await a.host.reply(id, { text: "noted", progress: true })).status).toMatch(/^(delivered|queued)$/);
		await until(() => prompts(b).length === 2, "a's progress in b");
		expect(prompts(b)[1]).toBe(`[thread ${id} progress from a (a)] noted`);
	});

	it("the opener's reply: after_turn waits for B's turn to end; the default steer enters at B's next step", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		let release = () => {};
		let started = false;
		const slow: AgentTool = {
			name: "slow",
			label: "slow",
			description: "slow tool",
			parameters: type({}),
			async execute() {
				started = true;
				const gate = Promise.withResolvers<void>();
				release = gate.resolve;
				await gate.promise;
				return { content: [{ type: "text", text: "slow done" }] };
			},
		};
		const b = await peer(
			{ ZMX_SESSION: "b" },
			{
				tools: [slow],
				script: (_index, context) =>
					lastUserText(context) === "work" && context.messages.at(-1)?.role !== "toolResult"
						? { content: [{ type: "toolCall", name: "slow", arguments: {} }] }
						: undefined,
			},
		);
		const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "open" }));
		await until(() => a.replies.length === 1, "first auto");
		await b.session.waitForIdle();

		for (const delivery of ["steer", "after_turn"] as const) {
			started = false;
			const first = b.calls.length;
			const work = b.session.prompt("work");
			await until(() => started, `${delivery}: slow tool start`);
			const text = `late-${delivery}`;
			expect((await a.host.reply(id, { text, delivery })).status).toBe("queued");
			release();
			await work;
			await b.session.waitForIdle();
			// Call `first` asks for the tool; `first + 1` is the step after it; `first + 2` follows the turn's end.
			const seenAt = b.calls.findIndex((call, i) => i >= first && JSON.stringify(call.messages).includes(text));
			expect(seenAt - first, delivery).toBe(delivery === "steer" ? 1 : 2);
		}
	});

	// ── US3: the automatic answer and the failure notice ─────────────────────

	it("an idle target starts a turn and the auto is that turn's answer, not an earlier one", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" });
		await b.session.prompt("earlier");
		await b.session.waitForIdle();

		const result = await a.host.send(entryOf(b), { kind: "message", text: "ping" });
		const id = opened(result);
		expect(result).toEqual({
			status: "delivered",
			conversationId: b.session.sessionManager.getSessionId(),
			thread: id,
		});
		await until(() => a.replies.length === 1, "auto");
		expect(a.replies[0]).toMatchObject({ type: "auto", thread: id, text: `echo:[thread ${id} new from a (a)] ping` });
		expect(b.calls).toHaveLength(2);
	});

	it("an auto arrives at the opener within 2 s of the end of B's turn", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: [100] });
		let endedAt = 0;
		b.session.subscribe(event => {
			if (event.type === "agent_end" && (event.yielded ?? event.isTerminal !== false)) endedAt = Date.now();
		});
		await a.host.send(entryOf(b), { kind: "message", text: "ping" });
		await until(() => a.replies.length === 1, "auto");
		expect(endedAt).toBeGreaterThan(0);
		expect(a.replyAt[0] - endedAt).toBeLessThan(2000);
	});

	it("an after_turn message to a busy target waits for the turn and gets its own run's answer", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: [150] });
		const work = b.session.prompt("work");
		await until(() => b.calls.length === 1, "b's first model call");

		const result = await a.host.send(entryOf(b), { kind: "message", text: "later", delivery: "after_turn" });
		expect(result.status).toBe("queued");
		const id = opened(result);
		await work;
		await until(() => a.replies.length === 1, "auto");
		expect(lastUserText(b.calls[0])).toBe("work");
		expect(a.replies[0].text).toBe(`echo:[thread ${id} new from a (a)] later`);
	});

	it("a turn with only a progress note still sends exactly one auto", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b: Peer = await peer(
			{ ZMX_SESSION: "b" },
			{
				script: async (index, context) => {
					if (index === 0) await b.host.reply(threadIn(context), { text: "on it", progress: true });
					return undefined;
				},
			},
		);
		const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "ping" }));
		await until(() => a.replies.length === 2, "progress and auto");
		await b.session.waitForIdle();
		await Bun.sleep(100);
		expect(a.replies.map(reply => [reply.thread, reply.type])).toEqual([
			[id, "progress"],
			[id, "auto"],
		]);
	});

	it("a failed turn sends one failure with the error text, even after a reply; an interrupted turn sends aborted", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		const failing: Peer = await peer(
			{ ZMX_SESSION: "failing" },
			{
				settings,
				script: async (_index, context) => {
					await failing.host.reply(threadIn(context), { text: "PONG" });
					return { stopReason: "error", errorMessage: "400 invalid_request_error: bad input" };
				},
			},
		);
		const failed = opened(await a.host.send(entryOf(failing), { kind: "message", text: "ping" }));
		await until(() => a.replies.length === 2, "reply and failure");
		await failing.session.waitForIdle();
		await Bun.sleep(50);
		expect(a.replies.map(reply => [reply.thread, reply.type])).toEqual([
			[failed, "message"],
			[failed, "failure"],
		]);
		expect(a.replies[1].outcome).toBe("error");
		expect(a.replies[1].error).toContain("bad input");

		const busy = await peer({ ZMX_SESSION: "busy" }, { delays: [3000] });
		const cut = opened(await a.host.send(entryOf(busy), { kind: "message", text: "ping" }));
		await until(() => busy.calls.length === 1, "busy's turn");
		expect(await a.host.interrupt(entryOf(busy))).toBe("interrupted");
		await until(() => a.replies.length === 3, "aborted failure");
		await Bun.sleep(50);
		expect(a.replies.slice(2)).toEqual([
			expect.objectContaining({ thread: cut, type: "failure", outcome: "aborted" }) as InboxReply,
		]);
	});

	it("K messages (K 1..10) of one thread in one turn give exactly one decision (seed 0x5eed)", async () => {
		const random = seeded("one decision", 0x5eed);
		const a = await peer({ ZMX_SESSION: "a" });
		for (let k = 1; k <= 10; k++) {
			// B starts idle, so message 1 starts its own run and its ticket reports at settle().
			const b = await peer({ ZMX_SESSION: `b${k}` }, { delays: [300] });
			const deliveries = Array.from({ length: k - 1 }, (): "steer" | "after_turn" =>
				random() < 0.5 ? "steer" : "after_turn",
			);
			const context = `k=${k} deliveries=${deliveries.join(",")}`;
			const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "m0" }));
			await until(() => b.calls.length === 1, `b's run (${context})`);
			for (const [i, delivery] of deliveries.entries()) {
				expect((await a.host.reply(id, { text: `m${i + 1}`, delivery })).status, context).toBe("queued");
			}
			await until(() => decisions(a).some(reply => reply.thread === id), `decision (${context})`);
			await b.session.waitForIdle();
			await Bun.sleep(50);
			expect(
				decisions(a).filter(reply => reply.thread === id),
				context,
			).toHaveLength(1);
			expect(prompts(b), context).toHaveLength(k);
		}
	}, 30_000);

	it("K threads (K 1..5) whose messages enter one turn get one decision each (seed 0x5eee)", async () => {
		const random = seeded("one decision per thread", 0x5eee);
		for (let k = 1; k <= 5; k++) {
			const b = await peer({ ZMX_SESSION: `b${k}` }, { delays: [150] });
			const senders = await Promise.all(Array.from({ length: k }, (_, i) => peer({ ZMX_SESSION: `s${k}-${i}` })));
			const deliveries = senders.map((): "steer" | "after_turn" => (random() < 0.5 ? "steer" : "after_turn"));
			const work = b.session.prompt("work");
			await until(() => b.calls.length === 1, "b's first model call");
			const results = await Promise.all(
				senders.map((sender, i) =>
					sender.host.send(entryOf(b), { kind: "message", text: `m${i}`, delivery: deliveries[i] }),
				),
			);
			const context = `k=${k} deliveries=${deliveries.join(",")}`;
			expect(
				results.map(result => result.status),
				context,
			).toEqual(senders.map(() => "queued"));
			await work;
			await b.session.waitForIdle();
			await until(() => senders.every(sender => sender.replies.length >= 1), `answers (${context})`);
			await Bun.sleep(30);
			senders.forEach((sender, i) => {
				expect(sender.replies, context).toEqual([
					expect.objectContaining({ thread: opened(results[i]), type: "auto" }) as InboxReply,
				]);
			});
		}
	});

	it("back-to-back turns: a message that starts turn 2 inside turn 1's settle gap gets its own auto", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: [100, 100] });
		let id = "";
		let fired = false;
		// Hold turn 1's own-run ticket at settle() until message 2 is in B's conversation.
		const settle = RpcPromptResults.prototype.settle;
		let held = false;
		vi.spyOn(RpcPromptResults.prototype, "settle").mockImplementation(function (this: RpcPromptResults, ticket) {
			if (held) return settle.call(this, ticket);
			held = true;
			void until(() => prompts(b).length === 2, "message 2 in b").then(() => settle.call(this, ticket));
		});
		b.session.subscribe(event => {
			if (fired || event.type !== "agent_end" || !(event.yielded ?? event.isTerminal !== false)) return;
			fired = true;
			void a.host.reply(id, { text: "two" });
		});
		id = opened(await a.host.send(entryOf(b), { kind: "message", text: "one" }));
		await until(() => a.replies.length === 2, "two autos");
		await b.session.waitForIdle();
		await Bun.sleep(100);
		expect(held).toBe(true);
		expect(a.replies.map(reply => [reply.type, reply.text])).toEqual([
			["auto", `echo:[thread ${id} new from a (a)] one`],
			["auto", `echo:[thread ${id} reply from a (a)] two`],
		]);
	});

	// Case 1: B replies in run 0, not in the tail. Case 2: B replies only in the tail.
	// Case 3: a message from A opens a ticket during the tail, and B never replies.
	it.each([1, 2, 3] as const)(
		"tail runs, case %d: run 0 and its tail are one turn: a reply in either stops the auto, a tail message adds no decision",
		async tailCase => {
			const a = await peer({ ZMX_SESSION: `a${tailCase}` });
			const b: Peer = await peer(
				{ ZMX_SESSION: `b${tailCase}` },
				{
					script: async (_index, context) => {
						const last = lastUserText(context);
						if (last === "work") return { content: ["working"], delayMs: 200 };
						if (last.includes("] m0")) {
							if (tailCase === 1) await b.host.reply(threadIn(context), { text: "in run 0" });
							return { content: ["run 0"] };
						}
						if (last === "tail") {
							if (tailCase === 2) await b.host.reply(threadIn(context), { text: "in the tail" });
							return { content: ["tail"], delayMs: tailCase === 3 ? 300 : 0 };
						}
						return undefined;
					},
				},
			);
			// The tail: a message that reaches B's queue as run 0 ends.
			let tailed = false;
			b.session.agent.subscribe(event => {
				if (tailed || event.type !== "agent_end") return;
				tailed = true;
				b.session.agent.followUp({
					role: "user",
					content: [{ type: "text", text: "tail" }],
					timestamp: Date.now(),
				});
			});
			const ends: AgentSessionEvent[] = [];
			b.session.subscribe(event => {
				if (event.type === "agent_end") ends.push(event);
			});
			const work = b.session.prompt("work");
			await until(() => b.calls.length === 1, `case ${tailCase}: b's run 0`);
			const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "m0" }));
			if (tailCase === 3) {
				await until(() => b.calls.some(call => lastUserText(call) === "tail"), "case 3: the tail run");
				expect((await a.host.reply(id, { text: "m1" })).status).toBe("queued");
			}
			await work;
			await until(() => ends.length >= 2, `case ${tailCase}: the tail's end`);
			await b.session.waitForIdle();
			await Bun.sleep(100);
			const context = `case ${tailCase}`;
			expect(ends[0], context).toMatchObject({ type: "agent_end", isTerminal: false });
			if (tailCase === 3) {
				expect(prompts(b), context).toHaveLength(2);
				expect(decisions(a), context).toHaveLength(1);
			} else {
				expect(decisions(a), context).toEqual([]);
				expect(
					a.replies.map(reply => reply.type),
					context,
				).toEqual(["message"]);
			}
		},
	);

	it("100 turns in one thread: one auto for progress-only and no reply, one failure for error and abort, none for a reply (seed 0x100)", async () => {
		const random = seeded("100 turns", 0x100);
		const kinds = ["reply", "progress", "none", "error", "abort"] as const;
		const plan = Array.from({ length: 100 }, () => kinds[Math.floor(random() * kinds.length)]);
		const expected: Record<(typeof kinds)[number], string[]> = {
			reply: ["message"],
			progress: ["progress", "auto"],
			none: ["auto"],
			error: ["failure:error"],
			abort: ["failure:aborted"],
		};
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		const a = await peer({ ZMX_SESSION: "a" });
		const b: Peer = await peer(
			{ ZMX_SESSION: "b" },
			{
				settings,
				script: async (_index, context) => {
					const turn = Number(lastUserText(context).match(/\] turn-(\d+)/)?.[1]);
					const id = threadIn(context);
					switch (plan[turn]) {
						case "reply":
							await b.host.reply(id, { text: `r${turn}` });
							return { content: [`answer ${turn}`] };
						case "progress":
							await b.host.reply(id, { text: `p${turn}`, progress: true });
							return undefined;
						case "none":
							return { content: [`answer ${turn}`] };
						case "error":
							return { stopReason: "error", errorMessage: `e${turn}` };
						case "abort":
							setTimeout(() => void a.host.interrupt(entryOf(b)), 20);
							return { content: ["never"], delayMs: 5000 };
					}
				},
			},
		);
		let id = "";
		for (let turn = 0; turn < plan.length; turn++) {
			const before = a.replies.length;
			const text = `turn-${turn}`;
			const result =
				turn === 0 ? await a.host.send(entryOf(b), { kind: "message", text }) : await a.host.reply(id, { text });
			if (turn === 0) id = opened(result);
			const want = expected[plan[turn]];
			await until(() => a.replies.length >= before + want.length, `turn ${turn} (${plan[turn]})`).catch(() => {});
			await b.session.waitForIdle();
			await Bun.sleep(30);
			const got = a.replies
				.slice(before)
				.map(reply => (reply.type === "failure" ? `failure:${reply.outcome}` : reply.type));
			if (JSON.stringify(got) !== JSON.stringify(want) || a.replies.slice(before).some(r => r.thread !== id)) {
				throw new Error(
					`first wrong turn ${turn} (${plan[turn]}): got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
				);
			}
		}
	}, 60_000);

	unix(
		"100 turns of the opener on replies to it send nothing back (seed 0x101)",
		async () => {
			const random = seeded("100 opener turns", 0x101);
			const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
			const plan = Array.from({ length: 100 }, () => (random() < 0.5 ? "none" : "error"));
			const c = await peer(
				{ ZMX_SESSION: "c" },
				{
					settings,
					spyReplies: false,
					script: index =>
						index > 0 && plan[index - 1] === "error" ? { stopReason: "error", errorMessage: "boom" } : undefined,
				},
			);
			const d = await peer({ ZMX_SESSION: "d" });
			const id = opened(await c.host.send(entryOf(d), { kind: "message", text: "open" }));
			await until(() => c.calls.length === 1, "c's turn on the auto");
			await c.session.waitForIdle();
			await d.session.waitForIdle();
			const toD = await tap(d);
			for (let turn = 0; turn < plan.length; turn++) {
				expect((await d.host.reply(id, { text: `r${turn}` })).status, `turn ${turn}`).toBe("delivered");
				await until(() => c.calls.length === turn + 2, `c's turn ${turn} (${plan[turn]})`);
				await c.session.waitForIdle();
			}
			await Bun.sleep(100);
			expect(toD).toEqual([]);
			expect(prompts(d)).toHaveLength(1);
		},
		60_000,
	);

	unix(
		"clarification B: the opener's turn on a reply sends nothing when it ends without a reply, fails or is cut",
		async () => {
			const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
			// oxlint-disable-next-line prefer-const -- a's script reads b, which is made after a.
			let b!: Peer;
			const a = await peer(
				{ ZMX_SESSION: "a" },
				{
					settings,
					spyReplies: false,
					script: index => {
						if (index === 1) return { stopReason: "error", errorMessage: "boom" };
						if (index === 2) {
							setTimeout(() => void b.host.interrupt(entryOf(a)), 20);
							return { content: ["never"], delayMs: 5000 };
						}
						return undefined;
					},
				},
			);
			b = await peer(
				{ ZMX_SESSION: "b" },
				{
					script: async (index, context) => {
						if (index === 0) await b.host.reply(threadIn(context), { text: "r0" });
						return undefined;
					},
				},
			);
			const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "ping" }));
			await until(() => a.calls.length === 1, "a's turn on r0");
			await b.session.waitForIdle();
			const toB = await tap(b);
			await a.session.waitForIdle();
			for (const [turn, text] of ["r1", "r2"].entries()) {
				expect((await b.host.reply(id, { text })).status).toBe("delivered");
				await until(() => a.calls.length === turn + 2, `a's turn on ${text}`);
				await until(() => !a.session.isStreaming, `a idle after ${text}`);
			}
			await Bun.sleep(150);
			expect(toB).toEqual([]);
			expect(prompts(b)).toHaveLength(1);
			expect(b.calls).toHaveLength(1);
		},
	);

	it("progress from the opener: B's turn on it sends nothing when it ends without a reply, fails or is cut", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		const a = await peer({ ZMX_SESSION: "a" });
		const b: Peer = await peer(
			{ ZMX_SESSION: "b" },
			{
				settings,
				script: index => {
					if (index === 2) return { stopReason: "error", errorMessage: "boom" };
					if (index === 3) {
						setTimeout(() => void a.host.interrupt(entryOf(b)), 20);
						return { content: ["never"], delayMs: 5000 };
					}
					return undefined;
				},
			},
		);
		const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "ping" }));
		await until(() => a.replies.length === 1, "first auto");
		await b.session.waitForIdle();
		for (let turn = 1; turn <= 3; turn++) {
			expect((await a.host.reply(id, { text: `on it ${turn}`, progress: true })).status).toBe("delivered");
			await until(() => b.calls.length === turn + 1, `b's turn ${turn}`);
			await until(() => !b.session.isStreaming, `b idle after ${turn}`);
		}
		await Bun.sleep(150);
		expect(a.replies.map(reply => reply.type)).toEqual(["auto"]);
	});

	unix("an auto never causes another automatic message", async () => {
		const a = await peer({ ZMX_SESSION: "a" }, { spyReplies: false });
		const b = await peer({ ZMX_SESSION: "b" });
		opened(await a.host.send(entryOf(b), { kind: "message", text: "ping" }));
		const toB = await tap(b);
		await until(() => a.calls.length === 1, "a's turn on the auto");
		await a.session.waitForIdle();
		await b.session.waitForIdle();
		await Bun.sleep(100);
		expect(toB).toEqual([]);
		expect(b.calls).toHaveLength(1);
		expect(b.replies).toHaveLength(0);
	});

	it("an auto is cut to the longest whole-character prefix within 16 KiB, and only when it is longer", async () => {
		const exact = "x".repeat(MAX_REPLY_TEXT_BYTES);
		const long = "€".repeat(6000);
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { script: index => ({ content: [index === 0 ? exact : long] }) });
		const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "first" }));
		await until(() => a.replies.length === 1, "first auto");
		await b.session.waitForIdle();
		await a.host.reply(id, { text: "second" });
		await until(() => a.replies.length === 2, "second auto");

		expect(a.replies[0].text).toBe(exact);
		expect(a.replies[0].truncated).toBeUndefined();
		const cut = a.replies[1];
		expect(cut.truncated).toBe(true);
		expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(MAX_REPLY_TEXT_BYTES);
		expect(long.startsWith(cut.text)).toBe(true);
		// One more 3-byte character would pass the limit.
		expect(Buffer.byteLength(cut.text) + 3).toBeGreaterThan(MAX_REPLY_TEXT_BYTES);
	});

	it("a target at its cost cap answers not_delivered cost_cap and sends nothing", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false, "session.maxCost": 1 });
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { settings, costGate: new CostGate(settings, 2, () => {}) });

		const result = await a.host.send(entryOf(b), { kind: "message", text: "ping" });
		expect(result).toEqual({ status: "not_delivered", reason: "cost_cap" });
		await Bun.sleep(50);
		expect(b.calls).toHaveLength(0);
		expect(a.replies).toHaveLength(0);
	});

	it("a cost-capped message in a thread leaks no ticket: the next message still gets its own auto", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { settings, costGate: new CostGate(settings, 2, () => {}) });
		const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "one" }));
		await until(() => a.replies.length === 1, "first auto");
		await b.session.waitForIdle();

		cfgSessionMaxCost.override(settings, 1);
		expect(await a.host.reply(id, { text: "two" })).toEqual({ status: "not_delivered", reason: "cost_cap", to: "b" });
		cfgSessionMaxCost.override(settings, 100);
		expect((await a.host.reply(id, { text: "three" })).status).toBe("delivered");
		await until(() => a.replies.length === 2, "second auto");
		await b.session.waitForIdle();
		await Bun.sleep(50);
		expect(a.replies.map(reply => [reply.type, reply.text])).toEqual([
			["auto", `echo:[thread ${id} new from a (a)] one`],
			["auto", `echo:[thread ${id} reply from a (a)] three`],
		]);
	});

	it("a message whose ticket settles without a run sends one aborted failure; the next one gets its own decision", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" });
		const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "one" }));
		await until(() => a.replies.length === 1, "first auto");
		await b.session.waitForIdle();

		// Hold B's next prompt before dispatch and abort it there.
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementationOnce(async (...args) => {
			reached.resolve();
			await release.promise;
			return getApiKey(...args);
		});
		const pending = a.host.reply(id, { text: "two" });
		await reached.promise;
		const abort = b.session.abort();
		release.resolve();
		await abort;
		expect((await pending).status).toBe("delivered");
		await until(() => a.replies.length === 2, "aborted failure");
		expect(b.calls).toHaveLength(1);

		expect((await a.host.reply(id, { text: "three" })).status).toBe("delivered");
		await until(() => a.replies.length === 3, "third decision");
		await b.session.waitForIdle();
		await Bun.sleep(50);
		expect(a.replies.map(reply => [reply.type, reply.type === "failure" ? reply.outcome : reply.text])).toEqual([
			["auto", `echo:[thread ${id} new from a (a)] one`],
			["failure", "aborted"],
			["auto", `echo:[thread ${id} reply from a (a)] three`],
		]);
	});

	// ── US4: threads outlive /new; an ended session fails clearly ──────────

	it("the receiver checks a crafted thread message against its threads (seed 0x7a11)", async () => {
		const random = seeded("crafted wire", 0x7a11);
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" });
		const c = await peer({ ZMX_SESSION: "c" });
		const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "open" }));
		await until(() => a.replies.length === 1, "auto");
		await b.session.waitForIdle();

		const identity = (p: Peer, address: string) => ({ address, name: address, entryId: entryOf(p).entryId });
		const send = (message: Record<string, unknown>) =>
			callInbox(entryOf(b), { op: "send", message: { id: crypto.randomUUID(), text: "x", ...message } }, 1000);
		const result = (reason: string) => ({
			status: "ok" as const,
			value: { v: INBOX_VERSION, ok: true, result: { status: "not_delivered", reason } },
		});
		const hex = () =>
			Math.floor(random() * 0x100000000)
				.toString(16)
				.padStart(8, "0");
		for (let i = 0; i < 10; i++) {
			const unknown = `t-${hex()}`;
			if (unknown === id) continue;
			for (const type of ["message", "progress"]) {
				expect(await send({ from: identity(a, "a"), kind: "thread", thread: unknown, type }), unknown).toEqual(
					result("unknown_thread"),
				);
			}
		}
		for (const from of [identity(a, "a"), identity(c, "c")]) {
			expect(await send({ from, kind: "thread", thread: id, type: "message", first: true })).toEqual(
				result("thread_conflict"),
			);
		}
		expect(await send({ from: identity(c, "c"), kind: "thread", thread: id, type: "message" })).toEqual(
			result("unknown_thread"),
		);
		expect(await send({ from: identity(a, "a"), kind: "thread", thread: id, type: "auto" })).toEqual({
			status: "skip",
			error: "invalid",
		});
		expect(
			await send({
				from: identity(a, "a"),
				kind: "thread",
				thread: id,
				type: "failure",
				outcome: "error",
				text: "",
			}),
		).toEqual({ status: "skip", error: "invalid" });
		await Bun.sleep(50);
		expect(prompts(b)).toHaveLength(1);
		expect(b.calls).toHaveLength(1);
	});

	it("/new in B while it owes A in two threads sends one aborted failure in each; later messages get their own auto", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: [3000] });
		void b.session.prompt("work").catch(() => {});
		await until(() => b.calls.length === 1, "b's first model call");
		const first = opened(await a.host.send(entryOf(b), { kind: "message", text: "one", delivery: "after_turn" }));
		const second = opened(await a.host.send(entryOf(b), { kind: "message", text: "two" }));

		const before = b.session.sessionManager.getSessionId();
		await b.session.newSession();
		await until(() => a.replies.length === 2, "failures");
		await Bun.sleep(50);
		expect(new Set(a.replies.map(reply => `${reply.thread} ${reply.type} ${reply.outcome}`))).toEqual(
			new Set([`${first} failure aborted`, `${second} failure aborted`]),
		);
		expect(b.session.sessionManager.getSessionId()).not.toBe(before);

		for (const [i, id] of [first, second].entries()) {
			const result = await a.host.reply(id, { text: `again${i}` });
			expect(result).toMatchObject({ status: "delivered", conversationId: b.session.sessionManager.getSessionId() });
			await until(() => a.replies.length === 3 + i, `auto ${i}`);
			await b.session.waitForIdle();
			expect(a.replies[2 + i]).toMatchObject({
				thread: id,
				type: "auto",
				text: `echo:[thread ${id} reply from a (a)] again${i}`,
			});
		}
		await Bun.sleep(50);
		expect(a.replies).toHaveLength(4);
	});

	it("/new in A, then B's reply reaches A's new conversation in the same thread", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" });
		const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "ping" }));
		await until(() => a.replies.length === 1, "auto");
		await b.session.waitForIdle();
		const before = a.session.sessionManager.getSessionId();
		await a.session.newSession();
		const now = a.session.sessionManager.getSessionId();
		expect(now).not.toBe(before);

		expect(await b.host.reply(id, { text: "PONG" })).toEqual({
			status: "delivered",
			conversationId: now,
			thread: id,
			to: "a",
		});
		expect(a.replies.at(-1)).toEqual({
			thread: id,
			from: { address: "b", name: "b" },
			type: "message",
			text: "PONG",
		});
	});

	unix("/new sends nothing in a thread that owes no answer", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" });
		opened(await a.host.send(entryOf(b), { kind: "message", text: "ping" }));
		await until(() => a.replies.length === 1, "auto");
		await b.session.waitForIdle();
		const toB = await tap(b);
		await b.session.newSession();
		await a.session.newSession();
		await Bun.sleep(150);
		expect(a.replies).toHaveLength(1);
		expect(toB).toEqual([]);
	});

	it("after B stops, A's reply is gone and the tool says the session ended", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" });
		const id = opened(await a.host.send(entryOf(b), { kind: "message", text: "ping" }));
		await until(() => a.replies.length === 1, "auto");
		await b.session.waitForIdle();
		await b.host.stop();

		expect(await a.host.reply(id, { text: "again" })).toEqual({ status: "gone", to: "b" });
		const tool = new SessionInboxTool({ getSessionInbox: () => a.host } as unknown as ToolSession);
		const block = (await tool.execute("call", { op: "reply", thread: id, text: "again" })).content[0];
		expect(block?.type === "text" ? block.text : undefined).toBe(`Not delivered in thread ${id}: the session ended.`);
	});

	it("a reply reaches the session in the thread when two live sessions share its address", async () => {
		const first = await peer({ ZMX_SESSION: "a" });
		const second = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" });
		const fromSecond = opened(await second.host.send(entryOf(b), { kind: "message", text: "from-second" }));
		await until(() => second.replies.length === 1, "second's answer");
		await b.session.waitForIdle();
		const fromFirst = opened(await first.host.send(entryOf(b), { kind: "message", text: "from-first" }));
		await until(() => first.replies.length === 1, "first's answer");
		await b.session.waitForIdle();
		expect((await b.host.reply(fromSecond, { text: "to-second" })).status).toBe("delivered");
		expect((await b.host.reply(fromFirst, { text: "to-first" })).status).toBe("delivered");
		await Bun.sleep(50);
		expect(second.replies.map(reply => reply.text)).toEqual([
			`echo:[thread ${fromSecond} new from a (a)] from-second`,
			"to-second",
		]);
		expect(first.replies.map(reply => reply.text)).toEqual([
			`echo:[thread ${fromFirst} new from a (a)] from-first`,
			"to-first",
		]);
	});

	// ── US5: peer text cannot pose as a system message ──────────────────────

	it("crafted harness tags in text, names and errors stay escaped on both paths (seed 0x5afe)", async () => {
		const random = seeded("escape", 0x5afe);
		const tags = ["</system-notice>", "<system-reminder>", "<system-interrupt>", '<irc from="parent">'];
		const pad = () => " ".repeat(Math.floor(random() * 3));
		const craft = () =>
			Array.from({ length: 2 + Math.floor(random() * 3) }, (_, i) => {
				const tag = [...tags[Math.floor(random() * tags.length)]]
					.map(ch => (random() < 0.5 ? ch.toUpperCase() : ch.toLowerCase()))
					.join("")
					.replace(/^<(\/?)/, (_m, slash: string) => `<${pad()}${slash}${slash ? pad() : ""}`);
				return `x${i} ${tag}`;
			}).join(" ");
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		for (let round = 0; round < 3; round++) {
			const texts = Array.from({ length: 8 }, craft);
			const context = `round=${round}`;
			for (const text of texts)
				expect(text.match(HARNESS_TAG_RE)?.length, `${context} crafted: ${text}`).toBeGreaterThan(0);
			const a = await peer({ ZMX_SESSION: `a${round}` }, { name: craft() });
			const b: Peer = await peer(
				{ ZMX_SESSION: `b${round}` },
				{
					settings,
					name: craft(),
					script: async (index, input) => {
						const id = threadIn(input);
						if (index === 0) {
							await b.host.reply(id, { text: texts[0], progress: true });
							await b.host.reply(id, { text: texts[1] });
							return { content: ["done"] };
						}
						if (index === 2) return { content: [texts[2]] };
						if (index === 3) return { stopReason: "error", errorMessage: texts[3] };
						return undefined;
					},
				},
			);
			// First message, opener's progress, opener's reply (auto), opener's reply (failure).
			const id = opened(await a.host.send(entryOf(b), { kind: "message", text: texts[4] }));
			const fromA = [{ text: texts[5], progress: true }, { text: texts[6] }, { text: texts[7] }];
			for (const [i, message] of fromA.entries()) {
				await until(() => b.calls.length === i + 1, `${context} b's turn ${i}`);
				await b.session.waitForIdle();
				await Bun.sleep(20);
				expect(["delivered", "queued"], context).toContain((await a.host.reply(id, message)).status);
			}
			await until(() => a.replies.length === 4, `${context} four messages to the opener`);
			await b.session.waitForIdle();

			const requestPath = prompts(b);
			expect(requestPath, context).toHaveLength(4);
			for (const content of requestPath) expect(content.match(HARNESS_TAG_RE), `${context}: ${content}`).toBeNull();
			expect(
				a.replies.map(reply => reply.type),
				context,
			).toEqual(["progress", "message", "auto", "failure"]);
			for (const reply of a.replies) {
				const content = textOf(buildInboxReplyBatchMessage([{ ...reply, sessionId: "s" }])?.content);
				expect(content.match(HARNESS_TAG_RE)?.length, `${context}: ${content}`).toBe(2);
			}
		}
	}, 30_000);
});
