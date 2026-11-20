/**
 * Session inbox end to end: real AgentSessions with a scripted model, real
 * IPC endpoints in a private temp registry. The target model answers
 * `echo:<last user text>`, so a reply names the run it came from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InboxHost } from "@oh-my-pi/pi-coding-agent/inbox/host";
import {
	callInbox,
	INBOX_VERSION,
	MAX_REPLY_TEXT_BYTES,
	MAX_TEXT_BYTES,
} from "@oh-my-pi/pi-coding-agent/inbox/registry";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CostGate } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import type { InboxReply } from "@oh-my-pi/pi-coding-agent/session/inbox-reply";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { SessionInboxTool } from "@oh-my-pi/pi-coding-agent/tools/session-inbox";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
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
	/** Replies this peer received (queueInboxReply spied). */
	replies: InboxReply[];
}

describe("session inbox", () => {
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const peers: Peer[] = [];

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
			script?: (index: number) => MockResponse | undefined;
			tools?: AgentTool[];
			spyReplies?: boolean;
			costGate?: CostGate;
			settings?: Settings;
			/** A UI for tools that open dialogs (`ask`). */
			ui?: ExtensionUIContext;
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
				handler: context => {
					const index = calls.length;
					calls.push({ ...context, messages: structuredClone(context.messages) });
					const delayMs = delays[index] ?? 0;
					return options.script?.(index) ?? { content: [`echo:${lastUserText(context)}`], delayMs };
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
		const host = new InboxHost(session, { dir, env });
		await host.start();
		session.setSessionInbox(host);
		const replies: InboxReply[] = [];
		if (options.spyReplies !== false) {
			vi.spyOn(session, "queueInboxReply").mockImplementation(async reply => {
				replies.push(reply);
			});
		}
		const result = { session, host, calls, replies };
		peers.push(result);
		return result;
	}

	function entryOf(target: Peer) {
		const entry = target.host.entry;
		if (!entry) throw new Error("host not started");
		return entry;
	}

	it("a steered request enters a running turn at its next step and the turn's answer comes back", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: [200] });
		const work = b.session.prompt("work");
		await until(() => b.calls.length === 1, "b's first model call");

		const result = await a.host.send(entryOf(b), { kind: "request", text: "ping" });
		expect(result.status).toBe("queued");
		await work;
		await until(() => a.replies.length === 1, "reply");

		// One run, two steps: the steer joined the run that was already going.
		expect(b.calls).toHaveLength(2);
		expect(lastUserText(b.calls[1])).toBe("[from a (a)] ping");
		expect(a.replies[0]).toMatchObject({
			from: { address: "b" },
			outcome: "completed",
			text: "echo:[from a (a)] ping",
		});
	});

	it("a steered request does not stop a running tool: the tool returns its own result", async () => {
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

		const result = await a.host.send(entryOf(b), { kind: "request", text: "ping" });
		expect(result.status).toBe("queued");
		await Bun.sleep(50);
		release();
		await work;
		await until(() => a.replies.length === 1, "reply");

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

	it("a steered request leaves an open ask dialog open; ask returns the user's answer", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		let dialogSignal: AbortSignal | undefined;
		let answer!: (result: ExtensionAskDialogResult) => void;
		let opened = false;
		const ui = {
			askDialog: (_questions: unknown, dialogOptions?: { signal?: AbortSignal }) => {
				opened = true;
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
		await until(() => opened, "ask dialog");

		const result = await a.host.send(entryOf(b), { kind: "request", text: "ping" });
		expect(result.status).toBe("queued");
		await Bun.sleep(100);
		expect(dialogSignal?.aborted).toBe(false);
		expect(b.session.messages.some(message => message.role === "toolResult")).toBe(false);

		answer({
			kind: "submit",
			results: [{ id: "q", question: "Proceed?", options: ["yes", "no"], multi: false, selectedOptions: ["yes"] }],
		});
		await work;
		await until(() => a.replies.length === 1, "reply");
		const toolResult = b.session.messages.find(message => message.role === "toolResult");
		expect(toolResult).toMatchObject({ toolName: "ask", isError: false });
		expect(JSON.stringify(toolResult)).toContain("yes");
		expect(a.replies[0].text).toBe("echo:[from a (a)] ping");
	});

	it("an idle target starts a turn and the reply is that turn's answer, not an earlier one", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" });
		await b.session.prompt("earlier");
		await b.session.waitForIdle();

		const result = await a.host.send(entryOf(b), { kind: "request", text: "ping" });
		expect(result).toEqual({ status: "delivered", conversationId: b.session.sessionManager.getSessionId() });
		await until(() => a.replies.length === 1, "reply");
		expect(a.replies[0].text).toBe("echo:[from a (a)] ping");
		expect(b.calls).toHaveLength(2);
	});

	it("an after_turn request to a busy target waits for the turn and gets its own run's answer", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: [150] });
		const work = b.session.prompt("work");
		await until(() => b.calls.length === 1, "b's first model call");

		const result = await a.host.send(entryOf(b), { kind: "request", text: "later", delivery: "after_turn" });
		expect(result.status).toBe("queued");
		await work;
		await until(() => a.replies.length === 1, "reply");
		expect(lastUserText(b.calls[0])).toBe("work");
		expect(a.replies[0].text).toBe("echo:[from a (a)] later");
	});

	it("a target at its cost cap answers not_delivered with cost_cap and sends no reply", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false, "session.maxCost": 1 });
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { settings, costGate: new CostGate(settings, 2, () => {}) });

		const result = await a.host.send(entryOf(b), { kind: "request", text: "ping" });
		expect(result).toEqual({ status: "not_delivered", reason: "cost_cap" });
		await Bun.sleep(50);
		expect(b.calls).toHaveLength(0);
		expect(a.replies).toHaveLength(0);
	});

	it("K senders whose requests enter one turn each get exactly one reply (seed 0x5eed)", async () => {
		const random = rng(0x5eed);
		for (let k = 1; k <= 5; k++) {
			const b = await peer({ ZMX_SESSION: `b${k}` }, { delays: [150] });
			const senders = await Promise.all(Array.from({ length: k }, (_, i) => peer({ ZMX_SESSION: `s${k}-${i}` })));
			const deliveries = senders.map((): "steer" | "after_turn" => (random() < 0.5 ? "steer" : "after_turn"));
			const work = b.session.prompt("work");
			await until(() => b.calls.length === 1, "b's first model call");
			const results = await Promise.all(
				senders.map((sender, i) =>
					sender.host.send(entryOf(b), { kind: "request", text: `m${i}`, delivery: deliveries[i] }),
				),
			);
			const context = `k=${k} deliveries=${deliveries.join(",")}`;
			expect(
				results.map(result => result.status),
				context,
			).toEqual(senders.map(() => "queued"));
			await work;
			await b.session.waitForIdle();
			await until(() => senders.every(sender => sender.replies.length >= 1), `replies (${context})`);
			await Bun.sleep(30);
			for (const sender of senders) {
				expect(sender.replies, context).toHaveLength(1);
				expect(sender.replies[0].outcome, context).toBe("completed");
			}
		}
	});

	it("/new in the target answers its open requests with aborted", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: [3000] });
		void b.session.prompt("work").catch(() => {});
		await until(() => b.calls.length === 1, "b's first model call");
		const result = await a.host.send(entryOf(b), { kind: "request", text: "ping", delivery: "after_turn" });
		expect(result.status).toBe("queued");

		await b.session.newSession();
		await until(() => a.replies.length === 1, "reply");
		expect(a.replies[0].outcome).toBe("aborted");
	});

	it("accepts a reply only for an ID it sent, once", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" });
		const reply = { id: "never-sent", from: { address: "b", name: "b" }, outcome: "completed", text: "x" };
		const forged = await callInbox(entryOf(a), { op: "reply", reply }, 1000);
		expect(forged).toEqual({ status: "skip", error: "unknown_id" });

		await a.host.send(entryOf(b), { kind: "request", text: "ping" });
		await until(() => a.replies.length === 1, "reply");
		const replay = await callInbox(entryOf(a), { op: "reply", reply: { ...reply, id: a.replies[0].id } }, 1000);
		expect(replay).toEqual({ status: "skip", error: "unknown_id" });
		expect(a.replies).toHaveLength(1);
	});

	it("checks a request in contract order: malformed, protocol, token, operation", async () => {
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
		expect(b.calls).toHaveLength(0);
	});

	it("refuses invalid and oversized messages before anything reaches the session", async () => {
		const b = await peer({ ZMX_SESSION: "b" });
		const from = { address: "a", name: "a", entryId: "0123456789abcdef" };
		const send = (message: Record<string, unknown>) => callInbox(entryOf(b), { op: "send", message }, 1000);
		const base = { id: "1", from, kind: "request", text: "hi" };
		expect(await send({ ...base, level: "nit" })).toEqual({ status: "skip", error: "invalid" });
		expect(await send({ ...base, kind: "notification", delivery: "steer" })).toEqual({
			status: "skip",
			error: "invalid",
		});
		expect(await send({ ...base, text: "" })).toEqual({ status: "skip", error: "invalid" });
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
		const notices: string[] = [];
		b.session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});
		const abort = vi.spyOn(b.session, "abort");
		expect(await a.host.interrupt(entryOf(b))).toBe("idle");
		expect(abort).not.toHaveBeenCalled();

		void b.session.prompt("work").catch(() => {});
		await until(() => b.calls.length === 1, "b's first model call");
		expect(await a.host.interrupt(entryOf(b))).toBe("interrupted");
		await until(() => notices.includes("a interrupted"), "interrupt notice");
		expect(b.session.isStreaming).toBe(false);
	});

	it("two sessions without zmx reach each other as omp-<pid> and a reply starts the sender's turn", async () => {
		const a = await peer({}, { spyReplies: false });
		const b = await peer({});
		const listed = await a.host.list();
		expect(listed.map(session => session.entry.address)).toEqual([`omp-${process.pid}`]);
		expect(listed[0].entry.entryId).toBe(entryOf(b).entryId);
		expect(listed[0].entry.parent).toBeNull();
		expect(a.host.parent).toBeNull();

		await a.host.send(listed[0].entry, { kind: "request", text: "ping" });
		await until(() => a.calls.length === 1, "a's reply turn");
		const replyText = lastUserText(a.calls[0]) || JSON.stringify(a.calls[0].messages.at(-1));
		expect(replyText).toContain(`Reply from omp-${process.pid}`);
		expect(replyText).toContain("echo:[from");
	});

	it("list shows exactly the live sessions minus the caller, with link flags only for a real parent pair", async () => {
		const random = rng(0x11);
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

	/** Texts of the inbox requests from `a` that reached `target`'s conversation, in order. */
	function requestsFromA(target: Peer): string[] {
		return target.session.messages.flatMap(message => {
			if (message.role !== "custom") return [];
			const match = JSON.stringify(message.content).match(/\[from a \(a\)\] (m\d+)/);
			return match ? [match[1]] : [];
		});
	}

	it("N requests in a row (N 1..20) reach the target in send order, each with one result (seed 0x0b5e)", async () => {
		const seed = 0x0b5e;
		console.log(`seed=0x${seed.toString(16)}`);
		const random = rng(seed);
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: Array(1000).fill(3) });
		const sent: string[] = [];
		for (let n = 1; n <= 20; n++) {
			const delivery = random() < 0.5 ? "steer" : "after_turn";
			for (let i = 0; i < n; i++) {
				const text = `m${sent.length}`;
				sent.push(text);
				const result = await a.host.send(entryOf(b), { kind: "request", text, delivery });
				expect(["delivered", "queued"], `n=${n} ${delivery} ${text}`).toContain(result.status);
			}
			await until(() => requestsFromA(b).length === sent.length, `n=${n} arrivals`, 10_000);
			await b.session.waitForIdle();
		}
		expect(requestsFromA(b)).toEqual(sent);
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

	it("/new in the sender drops a reply that is still pending", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: [300] });
		void b.session.prompt("work").catch(() => {});
		await until(() => b.calls.length === 1, "b's first model call");
		const result = await a.host.send(entryOf(b), { kind: "request", text: "ping", delivery: "after_turn" });
		expect(result.status).toBe("queued");

		await a.session.newSession();
		await until(() => b.calls.length === 2, "b's turn on the request");
		await b.session.waitForIdle();
		await Bun.sleep(100);
		expect(a.replies).toHaveLength(0);
	});

	it.skipIf(process.platform === "win32")(
		"accepts a reply that arrives before the sender's send call returns",
		async () => {
			const a = await peer({ ZMX_SESSION: "a" });
			const b = await peer({ ZMX_SESSION: "b" });
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
			const proxyPath = path.join(dir, "px.sock");
			await new Promise<void>(resolve => proxy.listen(proxyPath, resolve));
			try {
				const result = await a.host.send({ ...entryOf(b), endpoint: proxyPath }, { kind: "request", text: "ping" });
				expect(replyCameFirst).toBe(true);
				expect(result.status).toBe("delivered");
				expect(a.replies.map(reply => reply.text)).toEqual(["echo:[from a (a)] ping"]);
			} finally {
				proxy.close();
			}
		},
	);

	it("after the sender's own user interrupt, a reply joins its conversation and starts no turn", async () => {
		const a = await peer({ ZMX_SESSION: "a" }, { spyReplies: false, delays: [3000] });
		const b = await peer({ ZMX_SESSION: "b" });
		void a.session.prompt("work").catch(() => {});
		await until(() => a.calls.length === 1, "a's first model call");
		await a.session.abort({ reason: USER_INTERRUPT_LABEL });
		await until(() => !a.session.isStreaming, "a idle");

		await a.host.send(entryOf(b), { kind: "request", text: "ping" });
		await until(
			() => a.session.messages.some(message => JSON.stringify(message).includes("Reply from b")),
			"reply in a's conversation",
		);
		await Bun.sleep(100);
		expect(a.calls).toHaveLength(1);
	});

	it("a reply never causes another reply", async () => {
		const a = await peer({ ZMX_SESSION: "a" }, { spyReplies: false });
		const b = await peer({ ZMX_SESSION: "b" });
		await a.host.send(entryOf(b), { kind: "request", text: "ping" });
		await until(() => a.calls.length === 1, "a's reply turn");
		await a.session.waitForIdle();
		await b.session.waitForIdle();
		await Bun.sleep(100);
		expect(b.calls).toHaveLength(1);
		expect(b.replies).toHaveLength(0);
	});

	it("a reply reaches the session that sent the request when two live sessions share its address", async () => {
		const first = await peer({ ZMX_SESSION: "a" });
		const second = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" });
		await second.host.send(entryOf(b), { kind: "request", text: "from-second" });
		await until(() => second.replies.length === 1, "second's reply");
		await b.session.waitForIdle();
		await first.host.send(entryOf(b), { kind: "request", text: "from-first" });
		await until(() => first.replies.length === 1, "first's reply");
		await Bun.sleep(50);
		expect(second.replies.map(reply => reply.text)).toEqual(["echo:[from a (a)] from-second"]);
		expect(first.replies.map(reply => reply.text)).toEqual(["echo:[from a (a)] from-first"]);
	});

	it("a reply is cut to the longest whole-character prefix within 16 KiB, and only when it is longer", async () => {
		const exact = "x".repeat(MAX_REPLY_TEXT_BYTES);
		const long = "€".repeat(6000);
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { script: index => ({ content: [index === 0 ? exact : long] }) });
		await a.host.send(entryOf(b), { kind: "request", text: "first" });
		await until(() => a.replies.length === 1, "first reply");
		await b.session.waitForIdle();
		await a.host.send(entryOf(b), { kind: "request", text: "second" });
		await until(() => a.replies.length === 2, "second reply");

		expect(a.replies[0].text).toBe(exact);
		expect(a.replies[0].truncated).toBeUndefined();
		const cut = a.replies[1];
		expect(cut.truncated).toBe(true);
		expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(MAX_REPLY_TEXT_BYTES);
		expect(long.startsWith(cut.text)).toBe(true);
		// One more 3-byte character would pass the limit.
		expect(Buffer.byteLength(cut.text) + 3).toBeGreaterThan(MAX_REPLY_TEXT_BYTES);
	});

	it("a request never reaches the target's editor: the prompt-drop hook stays silent, even for a dropped request", async () => {
		// InteractiveMode writes the editor only from its own submit path and from this
		// hook (it restores a dropped typed prompt into an empty editor).
		const a = await peer({ ZMX_SESSION: "a" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: [3000] });
		const dropped: unknown[] = [];
		b.session.setPromptDropped(prompt => dropped.push(prompt));
		void b.session.prompt("work").catch(() => {});
		await until(() => b.calls.length === 1, "b's first model call");
		await a.host.send(entryOf(b), { kind: "request", text: "steer me" });
		await a.host.send(entryOf(b), { kind: "request", text: "later", delivery: "after_turn" });

		await b.session.newSession();
		await until(() => a.replies.length === 2, "aborted replies");
		expect(a.replies.map(reply => reply.outcome)).toEqual(["aborted", "aborted"]);
		expect(dropped).toEqual([]);
	});

	it("a turn that fails sends back outcome error with the error text", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		const b = await peer(
			{ ZMX_SESSION: "b" },
			{ settings, script: () => ({ stopReason: "error", errorMessage: "400 invalid_request_error: bad input" }) },
		);
		await a.host.send(entryOf(b), { kind: "request", text: "ping" });
		await until(() => a.replies.length === 1, "reply");
		expect(a.replies[0].outcome).toBe("error");
		expect(a.replies[0].error).toContain("bad input");
	});

	it("a sender that is gone before the target's turn ends gets no reply, and the target stays as it was", async () => {
		const a = await peer({ ZMX_SESSION: "a" });
		const c = await peer({ ZMX_SESSION: "c" });
		const b = await peer({ ZMX_SESSION: "b" }, { delays: [300] });
		expect((await a.host.send(entryOf(b), { kind: "request", text: "ping" })).status).toBe("delivered");
		await a.host.stop();

		await until(() => b.calls.length === 1, "b's turn");
		await b.session.waitForIdle();
		const settled = b.session.messages.length;
		await Bun.sleep(150);
		expect(b.session.messages).toHaveLength(settled);
		expect(b.calls).toHaveLength(1);
		expect(a.replies).toHaveLength(0);

		// The target still serves the next sender normally.
		expect((await c.host.send(entryOf(b), { kind: "request", text: "next" })).status).toBe("delivered");
		await until(() => c.replies.length === 1, "c's reply");
		expect(c.replies[0].text).toBe("echo:[from c (c)] next");
	});
});
