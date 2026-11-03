import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionConfig } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	FORK_START_CUSTOM_TYPE,
	FORK_START_REMINDER_CUSTOM_TYPE,
	type ForkStartFacts,
	pendingForkStart,
	renderForkStartReminder,
} from "@oh-my-pi/pi-coding-agent/session/fork-start-reminder";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type SessionEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgToolsXdevDocs, cfgToolsXdevInlineDevices } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const SEED = 0x5eed_f0c5;
const PROVIDER = "openai";

type SourceKind = "empty" | "completed" | "unanswered" | "pendingTool" | "repairedResults";
const SOURCE_KINDS: readonly SourceKind[] = ["empty", "completed", "unanswered", "pendingTool", "repairedResults"];

let temp: TempDir;
let auth: AuthStorage;
let sources = 0;
const sessions: AgentSession[] = [];

beforeEach(async () => {
	temp = TempDir.createSync("@pi-fork-start-reminder-");
	auth = await AuthStorage.create(":memory:");
});

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	auth.close();
	temp.removeSync();
});

function assistant(content: unknown[], stopReason: string) {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: PROVIDER,
		model: "gpt-test",
		stopReason,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function sourceMessages(kind: SourceKind): unknown[] {
	const user = { role: "user", content: "source task", timestamp: Date.now() };
	const call = { type: "toolCall", id: "call_src", name: "bash", arguments: { command: "make" } };
	const result = {
		role: "toolResult",
		toolCallId: "call_src",
		toolName: "bash",
		content: [{ type: "text", text: "built" }],
		isError: false,
		timestamp: Date.now(),
	};
	switch (kind) {
		case "empty":
			return [];
		case "completed":
			return [user, assistant([{ type: "text", text: "done" }], "stop")];
		case "unanswered":
			return [user];
		case "pendingTool":
			return [user, assistant([call], "toolUse")];
		case "repairedResults":
			return [user, assistant([call], "toolUse"), result];
	}
}

/** Writes a source session file in `kind`'s shape and forks it as the CLI `--fork` does. */
async function forkOf(kind: SourceKind): Promise<SessionManager> {
	const id = `source-${++sources}`;
	const cwd = temp.path();
	const sourceFile = path.join(cwd, "sources", `${id}.jsonl`);
	const timestamp = new Date().toISOString();
	const lines: unknown[] = [{ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd }];
	let parentId: string | null = null;
	for (const [index, message] of sourceMessages(kind).entries()) {
		const entryId = `${id}-m${index}`;
		lines.push({ type: "message", id: entryId, parentId, timestamp, message });
		parentId = entryId;
	}
	await Bun.write(sourceFile, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return SessionManager.forkFrom(sourceFile, cwd, path.join(cwd, "forks"), undefined, {
		suppressBreadcrumb: true,
		repairInterruptedTail: true,
		startReminder: true,
	});
}

function startSession(
	manager: SessionManager,
	extra: { tools?: AgentTool[]; config?: Partial<AgentSessionConfig> } = {},
): { session: AgentSession; requests: Message[][] } {
	const mock = createMockModel({ provider: PROVIDER, id: "gpt-test", handler: { content: ["OK"] } });
	const requests: Message[][] = [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock.model,
			systemPrompt: ["Test"],
			tools: extra.tools ?? [],
			messages: manager.buildSessionContext().messages,
		},
		convertToLlm,
		streamFn: (model, context, options) => {
			requests.push(structuredClone(context.messages));
			return mock.stream(model, context, options);
		},
	});
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
	settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: new ModelRegistry(auth),
		toolRegistry: new Map(),
		...extra.config,
	});
	sessions.push(session);
	return { session, requests };
}

async function send(session: AgentSession, text: string): Promise<void> {
	await session.prompt(text);
	await session.waitForIdle();
}

function marker(manager: SessionManager): CustomEntry<ForkStartFacts> {
	const found = manager
		.getEntries()
		.filter(
			(entry): entry is CustomEntry<ForkStartFacts> =>
				entry.type === "custom" && entry.customType === FORK_START_CUSTOM_TYPE,
		);
	expect(found.length).toBe(1);
	return found[0]!;
}

function storedReminders(manager: SessionManager): SessionEntry[] {
	return manager
		.getEntries()
		.filter(entry => entry.type === "custom_message" && entry.customType === FORK_START_REMINDER_CUSTOM_TYPE);
}

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

/** The model-bound form of the reminder for `entry`; independent of how the prompt words it. */
function reminderLlm(entry: CustomEntry<ForkStartFacts>): Message {
	const [converted] = convertToLlm([renderForkStartReminder(entry.id, entry.data!)]);
	return converted!;
}

function indexesOfReminder(request: Message[], expected: Message): number[] {
	const indexes: number[] = [];
	for (const [index, message] of request.entries()) {
		if (message.role === expected.role && Bun.deepEquals(message.content, expected.content)) indexes.push(index);
	}
	return indexes;
}

function indexOfText(request: Message[], text: string): number {
	return request.findIndex(message => messageText(message).includes(text));
}

function expectHistoryThenReminderThenPrompt(
	request: Message[],
	history: Message[],
	reminder: Message,
	promptText: string,
): void {
	const [reminderIndex, ...extra] = indexesOfReminder(request, reminder);
	expect(extra).toEqual([]);
	expect(reminderIndex).toBeDefined();
	expect(indexOfText(request, promptText)).toBe(reminderIndex! + 1);
	// Every copied/recovered history message precedes the reminder, in order.
	const project = (messages: Message[]) => messages.map(message => ({ role: message.role, content: message.content }));
	expect(project(request.slice(0, reminderIndex).slice(0, history.length))).toEqual(project(history));
}

describe("fork start reminder across the prompt lifecycle", () => {
	beforeEach(() => auth.keys.setRuntime(PROVIDER, "test-key"));

	it("sends the reminder after copied and recovered history, directly before the first prompt, and stores it once", async () => {
		const manager = await forkOf("pendingTool");
		const forkMarker = marker(manager);
		const history = convertToLlm(manager.buildSessionContext().messages);
		expect(history.length).toBeGreaterThan(0);
		const { session, requests } = startSession(manager);

		await send(session, "FIRST-PROMPT");

		expect(requests.length).toBe(1);
		expectHistoryThenReminderThenPrompt(requests[0]!, history, reminderLlm(forkMarker), "FIRST-PROMPT");
		const reminders = storedReminders(manager);
		expect(reminders.length).toBe(1);
		expect(reminders[0]?.type === "custom_message" && reminders[0].details).toEqual({ markerId: forkMarker.id });
	});

	it("does not add a second reminder on later prompts", async () => {
		const manager = await forkOf("completed");
		const reminder = reminderLlm(marker(manager));
		const { session, requests } = startSession(manager);

		await send(session, "FIRST-PROMPT");
		await send(session, "SECOND-PROMPT");

		expect(storedReminders(manager).length).toBe(1);
		const second = requests.at(-1)!;
		const [index, ...extra] = indexesOfReminder(second, reminder);
		expect(extra).toEqual([]);
		expect(index).toBe(indexOfText(second, "FIRST-PROMPT") - 1);
		expect(index!).toBeLessThan(indexOfText(second, "SECOND-PROMPT"));
	});

	it("keeps the reminder pending when a prompt is refused before assembly", async () => {
		auth.keys.removeRuntime(PROVIDER);
		const manager = await forkOf("completed");
		const forkMarker = marker(manager);
		const history = convertToLlm(manager.buildSessionContext().messages);
		const { session, requests } = startSession(manager);

		await expect(session.prompt("REFUSED-PROMPT")).rejects.toThrow();
		expect(requests.length).toBe(0);
		expect(storedReminders(manager).length).toBe(0);

		auth.keys.setRuntime(PROVIDER, "test-key");
		await send(session, "ACCEPTED-PROMPT");

		expect(requests.length).toBe(1);
		expectHistoryThenReminderThenPrompt(requests[0]!, history, reminderLlm(forkMarker), "ACCEPTED-PROMPT");
		expect(storedReminders(manager).length).toBe(1);
	});

	it("does not add a duplicate after the session file is reopened", async () => {
		const manager = await forkOf("completed");
		const reminder = reminderLlm(marker(manager));
		const file = manager.getSessionFile()!;
		const first = startSession(manager);
		await send(first.session, "FIRST-PROMPT");
		await manager.flush();
		await first.session.dispose();

		const reopened = await SessionManager.open(file, path.join(temp.path(), "forks"));
		const second = startSession(reopened);
		await send(second.session, "AFTER-REOPEN");

		expect(storedReminders(reopened).length).toBe(1);
		const request = second.requests.at(-1)!;
		const [index, ...extra] = indexesOfReminder(request, reminder);
		expect(extra).toEqual([]);
		expect(index).toBe(indexOfText(request, "FIRST-PROMPT") - 1);
	});

	it("does not bring the reminder back after compaction drops it from context", async () => {
		const manager = await forkOf("completed");
		const reminder = reminderLlm(marker(manager));
		const file = manager.getSessionFile()!;
		const first = startSession(manager);
		await send(first.session, "FIRST-PROMPT");
		await send(first.session, "SECOND-PROMPT");
		const keep = manager
			.getBranch()
			.findLast(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					messageText(entry.message as Message).includes("SECOND-PROMPT"),
			);
		manager.appendCompaction("summary of earlier work", undefined, keep!.id, 1000);
		await manager.flush();
		await first.session.dispose();

		const reopened = await SessionManager.open(file, path.join(temp.path(), "forks"));
		const second = startSession(reopened);
		await send(second.session, "AFTER-COMPACTION");

		const request = second.requests.at(-1)!;
		expect(indexOfText(request, "FIRST-PROMPT")).toBe(-1);
		expect(indexesOfReminder(request, reminder)).toEqual([]);
		expect(storedReminders(reopened).length).toBe(1);
	});

	it("counts a promptCustomMessage start as the first prompt", async () => {
		const manager = await forkOf("unanswered");
		const forkMarker = marker(manager);
		const history = convertToLlm(manager.buildSessionContext().messages);
		const { session, requests } = startSession(manager);

		await session.promptCustomMessage({
			customType: "test-start",
			content: "CUSTOM-START",
			display: true,
			attribution: "user",
		});
		await session.waitForIdle();
		await send(session, "TYPED-PROMPT");

		expectHistoryThenReminderThenPrompt(requests[0]!, history, reminderLlm(forkMarker), "CUSTOM-START");
		expect(storedReminders(manager).length).toBe(1);
		expect(indexesOfReminder(requests.at(-1)!, reminderLlm(forkMarker)).length).toBe(1);
	});

	it("never sends a reminder for a marker owned by another session", async () => {
		const manager = SessionManager.inMemory(temp.path());
		manager.appendMessage({ role: "user", content: "copied task", timestamp: Date.now() });
		const facts: ForkStartFacts = { sessionId: "another-session", unfinished: true, sharedCwd: true };
		const markerId = manager.appendCustomEntry(FORK_START_CUSTOM_TYPE, facts);
		const reminder = convertToLlm([renderForkStartReminder(markerId, facts)])[0]!;
		const { session, requests } = startSession(manager);

		await send(session, "FIRST-PROMPT");
		await send(session, "SECOND-PROMPT");

		expect(requests.length).toBe(2);
		for (const request of requests) expect(indexesOfReminder(request, reminder)).toEqual([]);
		expect(storedReminders(manager).length).toBe(0);
	});

	it("sends the reminder when the fork file is reopened before any prompt", async () => {
		const forked = await forkOf("pendingTool");
		const forkMarker = marker(forked);
		const file = forked.getSessionFile()!;
		const unused = startSession(forked);
		await unused.session.dispose();
		expect(unused.requests.length).toBe(0);

		const reopened = await SessionManager.open(file, path.join(temp.path(), "forks"));
		const history = convertToLlm(reopened.buildSessionContext().messages);
		const { session, requests } = startSession(reopened);
		await send(session, "FIRST-PROMPT");

		expect(requests.length).toBe(1);
		expectHistoryThenReminderThenPrompt(requests[0]!, history, reminderLlm(forkMarker), "FIRST-PROMPT");
		const reminders = storedReminders(reopened);
		expect(reminders.length).toBe(1);
		expect(reminders[0]?.type === "custom_message" && reminders[0].details).toEqual({ markerId: forkMarker.id });
	});
});

function mcpDevice(mcpToolName: string): CustomTool {
	return {
		name: `mcp__nucleus_${mcpToolName}`,
		label: `nucleus/${mcpToolName}`,
		description: `${mcpToolName} nucleus`,
		parameters: type({ q: "string" }),
		strict: true,
		mcpServerName: "nucleus",
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	} as CustomTool;
}

function builtinTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
}

/** A session wired like the xd:// mount-notice tests: MCP devices inlined under "builtins" docs. */
function startXdevSession(manager: SessionManager): { session: AgentSession; requests: Message[][] } {
	const xdev: XdevState = {
		tools: new Map(),
		mountedNames: new Set(),
		builtInNames: new Set(["read", "write"]),
		isActive: () => true,
	};
	const tools = [builtinTool("read"), builtinTool("write"), mcpDevice("search") as unknown as AgentTool];
	for (const tool of tools) xdev.tools.set(tool.name, tool);
	const started = startSession(manager, {
		tools,
		config: {
			toolRegistry: xdev.tools,
			builtInToolNames: ["read", "write"],
			ensureWriteRegistered: async () => true,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
			xdev,
		},
	});
	cfgToolsXdevDocs.set(started.session.settings, "builtins");
	cfgToolsXdevInlineDevices.set(started.session.settings, ["mcp__nucleus_*"]);
	return started;
}

/** mulberry32: small seeded PRNG so a failing case can be replayed from the printed seed. */
function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Runs `body` per generated case and names the seed and case in any failure. */
async function runSeededCases<T>(
	label: string,
	seed: number,
	generate: (random: () => number) => T[],
	body: (testCase: T) => Promise<void>,
): Promise<void> {
	console.log(`${label} seed=0x${seed.toString(16)}`);
	for (const [caseIndex, testCase] of generate(prng(seed)).entries()) {
		try {
			await body(testCase);
		} catch (error) {
			throw new Error(
				`${label} seed=0x${seed.toString(16)} case #${caseIndex} ${JSON.stringify(testCase)} failed: ${(error as Error).message}`,
			);
		}
	}
}

function pick<T>(random: () => number, items: readonly T[]): T {
	return items[Math.floor(random() * items.length)]!;
}

describe("fork start reminder lifecycle property", () => {
	beforeEach(() => auth.keys.setRuntime(PROVIDER, "test-key"));

	it("stores one reminder and sends it once, before the first prompt, for generated fork histories", async () => {
		await runSeededCases(
			"fork start reminder property",
			SEED,
			random => {
				const cases = SOURCE_KINDS.map(kind => ({ kind, prompts: 1 }));
				for (let index = 0; index < 10; index++) {
					cases.push({ kind: pick(random, SOURCE_KINDS), prompts: 1 + Math.floor(random() * 3) });
				}
				return cases;
			},
			async testCase => {
				const manager = await forkOf(testCase.kind);
				const forkMarker = marker(manager);
				const reminder = reminderLlm(forkMarker);
				const history = convertToLlm(manager.buildSessionContext().messages);
				const { session, requests } = startSession(manager);

				for (let prompt = 1; prompt <= testCase.prompts; prompt++) await send(session, `GEN-PROMPT-${prompt}`);

				const reminders = storedReminders(manager);
				expect(reminders.length).toBe(1);
				expect(reminders[0]?.type === "custom_message" && reminders[0].details).toEqual({
					markerId: forkMarker.id,
				});
				expect(requests.length).toBe(testCase.prompts);
				expectHistoryThenReminderThenPrompt(requests[0]!, history, reminder, "GEN-PROMPT-1");
				for (const [requestIndex, request] of requests.entries()) {
					const [index, ...extra] = indexesOfReminder(request, reminder);
					expect(extra).toEqual([]);
					expect(index).toBe(indexOfText(request, "GEN-PROMPT-1") - 1);
					expect(index!).toBeLessThan(indexOfText(request, `GEN-PROMPT-${requestIndex + 1}`));
				}
			},
		);
	});

	it("keeps xd:// mount notices ahead of the reminder and the reminder directly before the first prompt", async () => {
		const extraDevices = ["fetch", "list", "status"] as const;
		await runSeededCases(
			"fork start reminder xd:// notice property",
			SEED ^ 0x033,
			random => {
				const cases: { kind: SourceKind; devices: string[] | null }[] = SOURCE_KINDS.flatMap(kind => [
					{ kind, devices: null },
					{ kind, devices: ["search"] },
				]);
				for (let index = 0; index < 6; index++) {
					const devices = random() < 0.25 ? null : ["search", ...extraDevices.filter(() => random() < 0.5)];
					cases.push({ kind: pick(random, SOURCE_KINDS), devices });
				}
				return cases;
			},
			async testCase => {
				const manager = await forkOf(testCase.kind);
				const forkMarker = marker(manager);
				const reminder = reminderLlm(forkMarker);
				const history = convertToLlm(manager.buildSessionContext().messages);
				const { session, requests } = startXdevSession(manager);
				if (testCase.devices) await session.refreshMCPTools(testCase.devices.map(mcpDevice));

				await send(session, "FIRST-PROMPT");

				const request = requests[0]!;
				expectHistoryThenReminderThenPrompt(request, history, reminder, "FIRST-PROMPT");
				const notices = request.flatMap((message, index) =>
					messageText(message).includes("xd:// device inventory changed.") ? [index] : [],
				);
				expect(notices.length).toBe(testCase.devices ? 1 : 0);
				const reminderIndex = indexesOfReminder(request, reminder)[0]!;
				for (const noticeIndex of notices) {
					expect(noticeIndex).toBeGreaterThanOrEqual(history.length);
					expect(noticeIndex).toBeLessThan(reminderIndex);
					for (const device of testCase.devices!.slice(1)) {
						expect(messageText(request[noticeIndex]!)).toContain(`xd://mcp__nucleus_${device}`);
					}
				}
				expect(storedReminders(manager).length).toBe(1);
			},
		);
	});

	it("leaves the reminder pending through local commands and refused prompts until the first accepted prompt", async () => {
		type Step = { kind: "command"; withKey: boolean } | { kind: "refused" };
		await runSeededCases(
			"fork start reminder local command property",
			SEED ^ 0x034,
			random => {
				const cases: { kind: SourceKind; steps: Step[] }[] = [
					{ kind: "completed", steps: [] },
					{ kind: "completed", steps: [{ kind: "command", withKey: true }] },
					{ kind: "unanswered", steps: [{ kind: "refused" }] },
				];
				for (let index = 0; index < 9; index++) {
					const steps = Array.from({ length: Math.floor(random() * 5) }, (): Step =>
						random() < 0.5 ? { kind: "command", withKey: random() < 0.5 } : { kind: "refused" },
					);
					cases.push({ kind: pick(random, SOURCE_KINDS), steps });
				}
				return cases;
			},
			async testCase => {
				const manager = await forkOf(testCase.kind);
				const forkMarker = marker(manager);
				const history = convertToLlm(manager.buildSessionContext().messages);
				let commandRuns = 0;
				const runtime = new ExtensionRuntime();
				const extension = await loadExtensionFromFactory(
					pi => {
						pi.registerCommand("thecmd", {
							handler: async () => {
								commandRuns++;
							},
						});
					},
					temp.path(),
					new EventBus(),
					runtime,
					"fork-reminder-command",
				);
				const modelRegistry = new ModelRegistry(auth);
				const extensionRunner = new ExtensionRunner([extension], runtime, temp.path(), manager, modelRegistry);
				const { session, requests } = startSession(manager, { config: { modelRegistry, extensionRunner } });

				for (const step of testCase.steps) {
					if (step.kind === "command") {
						if (step.withKey) auth.keys.setRuntime(PROVIDER, "test-key");
						else auth.keys.removeRuntime(PROVIDER);
						const runsBefore = commandRuns;
						expect(await session.prompt("/thecmd")).toBe(false);
						expect(commandRuns).toBe(runsBefore + 1);
					} else {
						auth.keys.removeRuntime(PROVIDER);
						await expect(session.prompt("REFUSED-PROMPT")).rejects.toThrow();
					}
					await session.waitForIdle();
					expect(requests.length).toBe(0);
					expect(storedReminders(manager).length).toBe(0);
					expect(
						pendingForkStart(manager.getBranch(), manager.getEntries(), manager.getSessionId())?.markerId,
					).toBe(forkMarker.id);
				}

				auth.keys.setRuntime(PROVIDER, "test-key");
				await send(session, "ACCEPTED-PROMPT");

				expect(requests.length).toBe(1);
				expectHistoryThenReminderThenPrompt(requests[0]!, history, reminderLlm(forkMarker), "ACCEPTED-PROMPT");
				const reminders = storedReminders(manager);
				expect(reminders.length).toBe(1);
				expect(reminders[0]?.type === "custom_message" && reminders[0].details).toEqual({
					markerId: forkMarker.id,
				});
			},
		);
	});
});
