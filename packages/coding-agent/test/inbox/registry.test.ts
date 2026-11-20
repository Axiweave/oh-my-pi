import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InboxHost, truncateUtf8 } from "@oh-my-pi/pi-coding-agent/inbox/host";
import {
	callInbox,
	INBOX_VERSION,
	type InboxEntry,
	inboxAddress,
	listInboxEntries,
	parseInboxEntry,
	publishInboxEntry,
	readInboxEntry,
} from "@oh-my-pi/pi-coding-agent/inbox/registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { InboxReply } from "@oh-my-pi/pi-coding-agent/session/inbox-reply";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { IpcConnection } from "@oh-my-pi/pi-natives";

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

const sample: InboxEntry = {
	version: INBOX_VERSION,
	entryId: "0123456789abcdef",
	pid: 4242,
	endpoint: "/nonexistent/inbox.sock",
	token: "t".repeat(64),
	address: "cci-x",
	parent: null,
	createdAt: 1,
};

describe("inbox registry", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-inbox-reg-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("addresses a session by its zmx name, else by omp-<pid>", () => {
		expect(inboxAddress({ ZMX_SESSION: "cci-a" }, 7)).toBe("cci-a");
		expect(inboxAddress({ ZMX_SESSION: "" }, 7)).toBe("omp-7");
		expect(inboxAddress({}, 7)).toBe("omp-7");
	});

	it("rejects an entry with any required field missing or mistyped", () => {
		expect(parseInboxEntry(JSON.stringify(sample))).toEqual(sample);
		for (const key of Object.keys(sample) as (keyof InboxEntry)[]) {
			const { [key]: _dropped, ...rest } = sample;
			expect(parseInboxEntry(JSON.stringify(rest)), `without ${key}`).toBeNull();
			expect(parseInboxEntry(JSON.stringify({ ...sample, [key]: [] })), `${key} as array`).toBeNull();
		}
		expect(parseInboxEntry(JSON.stringify({ ...sample, entryId: "../../etc/x" }))).toBeNull();
		expect(parseInboxEntry("not json")).toBeNull();
	});

	it("reads an entry only by a well-formed ID inside the registry", async () => {
		await fs.writeFile(path.join(dir, `${sample.entryId}.json`), JSON.stringify(sample));
		await fs.writeFile(path.join(dir, "..", "escape.json"), JSON.stringify(sample));
		try {
			expect(await readInboxEntry(sample.entryId, dir)).toEqual(sample);
			expect(await readInboxEntry("../escape", dir)).toBeNull();
			expect(await readInboxEntry("fedcba9876543210", dir)).toBeNull();
		} finally {
			await fs.rm(path.join(dir, "..", "escape.json"), { force: true });
		}
	});

	it("prunes an entry whose endpoint is gone and lists nothing", async () => {
		const meta = { ...sample, endpoint: path.join(dir, `${sample.entryId}.sock`) };
		await fs.writeFile(path.join(dir, `${sample.entryId}.json`), JSON.stringify(meta), { mode: 0o600 });
		expect(await listInboxEntries({ dir })).toEqual([]);
		expect(await fs.readdir(dir)).toEqual([]);
	});

	it("cuts text to the longest whole-character prefix within the byte limit (seed 0xc0de)", () => {
		const random = rng(0xc0de);
		const alphabet = ["a", "é", "€", "𝄞", "\n"];
		for (let round = 0; round < 500; round++) {
			const text = Array.from({ length: Math.floor(random() * 40) }, () => alphabet[Math.floor(random() * 5)]).join(
				"",
			);
			const max = Math.floor(random() * 50);
			const { text: cut, truncated } = truncateUtf8(text, max);
			const context = `round=${round} max=${max} text=${JSON.stringify(text)}`;
			const bytes = Buffer.byteLength(text);
			expect(truncated, context).toBe(bytes > max);
			expect(text.startsWith(cut), context).toBe(true);
			expect(Buffer.byteLength(cut), context).toBeLessThanOrEqual(max);
			if (truncated) {
				const next = String.fromCodePoint(text.codePointAt(cut.length) ?? 0);
				expect(Buffer.byteLength(cut + next), context).toBeGreaterThan(max);
			}
		}
	});

	it.skipIf(process.platform === "win32")("publishes the endpoint socket with mode 0600", async () => {
		const publication = await publishInboxEntry({
			address: "a",
			parent: null,
			dir,
			onConnection: connection => connection.end(),
		});
		try {
			const stat = await fs.stat(publication.entry.endpoint);
			expect(stat.isSocket()).toBe(true);
			expect(stat.mode & 0o777).toBe(0o600);
		} finally {
			await publication.close();
		}
	});

	it("a list over foreign entries never touches a file in the sibling collab-hosts dir", async () => {
		const inbox = path.join(dir, "run", "session-inbox");
		const collab = path.join(dir, "run", "collab-hosts");
		await fs.mkdir(inbox, { recursive: true, mode: 0o700 });
		await fs.mkdir(collab, { recursive: true, mode: 0o700 });
		const decoy = path.join(collab, "d.sock");
		// A missing socket whose bind lock exists: the probe finds the endpoint dead and prunes.
		// Short names: a socket path past SUN_LEN probes as skip, not dead, and is never pruned.
		const lockDecoy = path.join(collab, "l.sock.bind.lock");
		const decoys = { [decoy]: "collab decoy", [lockDecoy]: "collab lock decoy" };
		for (const [file, content] of Object.entries(decoys)) await fs.writeFile(file, content);
		const foreign = (entryId: string, fields: Partial<InboxEntry>) =>
			fs.writeFile(path.join(inbox, `${entryId}.json`), JSON.stringify({ ...sample, entryId, ...fields }));
		const deadPid = 0x3fffffff;
		// Other version, owner gone: pruned without a probe, endpoint is the decoy itself.
		await foreign("1111111111111111", { version: INBOX_VERSION + 1, pid: deadPid, endpoint: decoy });
		await foreign("2222222222222222", {
			version: INBOX_VERSION + 1,
			pid: deadPid,
			endpoint: `${inbox}/../collab-hosts/d.sock`,
		});
		// Current version, endpoint dead: pruned with its endpoint files, which escape the inbox dir.
		await foreign("3333333333333333", { endpoint: lockDecoy.slice(0, -".bind.lock".length) });
		// Malformed: pruned with no endpoint at all.
		await fs.writeFile(path.join(inbox, "5555555555555555.json"), JSON.stringify({ endpoint: decoy }));

		expect(await listInboxEntries({ dir: inbox, timeoutMs: 500 })).toEqual([]);
		expect(await fs.readdir(inbox)).toEqual([]);
		for (const [file, content] of Object.entries(decoys)) expect(await fs.readFile(file, "utf8"), file).toBe(content);
	});
});

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

/** Write one raw line to `endpoint` and return the one line it answers. */
async function rawRequest(endpoint: string, line: string): Promise<unknown> {
	const connection = await IpcConnection.connect(endpoint, {
		framing: "lines",
		timeoutMs: 1000,
		maxFrameBytes: 1 << 20,
	});
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const timer = setTimeout(() => reject(new Error("no answer")), 2000);
	connection.start(
		answer => resolve(JSON.parse(answer)),
		() => reject(new Error("closed without an answer")),
	);
	connection.send(line);
	try {
		return await promise;
	} finally {
		clearTimeout(timer);
		connection.destroy();
	}
}

describe("inbox endpoint security", () => {
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const cleanup: Array<() => Promise<void>> = [];

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-inbox-sec-"));
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const step of cleanup.splice(0)) await step();
		authStorage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	/** A real AgentSession on a mock model that answers `echo:<last user text>`, with its InboxHost. */
	async function peer(address: string, delayMs = 0) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const calls: Context[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			getToolContext: toolCall => ({ toolCall }) as AgentToolContext,
			streamFn: createMockModel({
				handler: context => {
					calls.push({ ...context, messages: structuredClone(context.messages) });
					return { content: [`echo:${lastUserText(context)}`], delayMs };
				},
			}).stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map(),
		});
		const host = new InboxHost(session, { dir, env: { ZMX_SESSION: address } });
		await host.start();
		session.setSessionInbox(host);
		cleanup.push(async () => {
			await host.stop();
			await session.dispose();
		});
		const replies: InboxReply[] = [];
		vi.spyOn(session, "queueInboxReply").mockImplementation(async reply => {
			replies.push(reply);
		});
		const entry = host.entry;
		if (!entry) throw new Error("host not started");
		return { session, host, calls, replies, entry };
	}

	it("refuses a wrong-token send, interrupt and reply and leaves the target session unchanged", async () => {
		const a = await peer("a");
		const b = await peer("b", 400);
		const abort = vi.spyOn(b.session, "abort");
		const id = "00000000-0000-4000-8000-000000000001";
		vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(id);
		// a's real request starts a turn in b; a now waits for the reply to `id`.
		expect((await a.host.send(b.entry, { kind: "request", text: "ping" })).status).not.toBe("not_delivered");
		await until(() => b.calls.length === 1, "b's first model call");
		expect(b.session.isStreaming).toBe(true);

		const from = { address: "a", name: "a", entryId: a.entry.entryId };
		const forged = (target: InboxEntry, request: Record<string, unknown>) =>
			callInbox({ ...target, token: "f".repeat(64) }, request, 1000);
		const message = { id: crypto.randomUUID(), from, kind: "request", text: "forged" };
		const refused = { status: "skip", error: "authentication_failed" } as const;
		expect(await forged(b.entry, { op: "send", message })).toEqual(refused);
		expect(await forged(b.entry, { op: "interrupt", from })).toEqual(refused);
		const reply = { id, from: { address: "b", name: "b" }, outcome: "completed", text: "forged" };
		expect(await forged(a.entry, { op: "reply", reply })).toEqual(refused);

		// The real turn runs to its end and its answer is the only reply a gets.
		await until(() => a.replies.length === 1, "real reply");
		expect(a.replies[0]).toMatchObject({ id, outcome: "completed", text: "echo:[from a (a)] ping" });
		expect(abort).not.toHaveBeenCalled();
		expect(b.calls).toHaveLength(1);
		expect(JSON.stringify(b.session.messages)).not.toContain("forged");
		expect(a.calls).toHaveLength(0);
	});

	it("answers malformed_request to a non-JSON or non-object line", async () => {
		const b = await peer("b");
		for (const line of [
			"not json",
			"{",
			"[]",
			"42",
			"null",
			'"text"',
			"true",
			JSON.stringify([{ v: INBOX_VERSION }]),
		]) {
			expect(await rawRequest(b.entry.endpoint, line), line).toEqual({
				v: INBOX_VERSION,
				ok: false,
				error: "malformed_request",
			});
		}
		expect(b.calls).toHaveLength(0);
	});
});
