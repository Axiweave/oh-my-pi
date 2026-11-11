/**
 * Contracts: master mode guard and per-turn message.
 *
 * 1. `masterRefusal` classifies every row of the contract "Guard" table.
 * 2. Any tool name off the allowlist is refused (seeded property).
 * 3. Every refusal says master mode is on, names an allowed way, and forbids a workaround.
 * 4. With the state on, the session's `beforeToolCall` blocks `edit` and allows `read`; a
 *    refused `write` through the real agent loop leaves the file unchanged.
 * 5. A prompt turn holds exactly one hidden master message, never saved; turning the mode off
 *    removes every copy.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type BeforeToolCallContext, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	MASTER_FILE_CHANGE_REFUSAL,
	MASTER_FOREGROUND_BASH_REFUSAL,
	MASTER_MODE_CONTEXT_MESSAGE_TYPE,
	MASTER_SERVICE_BASH_REFUSAL,
	MASTER_WAIT_REFUSAL,
	masterRefusal,
} from "@oh-my-pi/pi-coding-agent/session/master-mode";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const ALLOWED_NAMES = ["task", "read", "grep", "glob", "find", "todo", "ask", "goal", "loop"];
const SUFFIX = "Do not retry or route around this block.";

const ALLOW = "allow";
type Expected = typeof ALLOW | "file-change" | "foreground-bash" | "service-bash" | "wait" | "other";

const TEXT_BY_KIND: Record<Exclude<Expected, typeof ALLOW | "other">, string> = {
	"file-change": MASTER_FILE_CHANGE_REFUSAL,
	"foreground-bash": MASTER_FOREGROUND_BASH_REFUSAL,
	"service-bash": MASTER_SERVICE_BASH_REFUSAL,
	wait: MASTER_WAIT_REFUSAL,
};

const GUARD_TABLE: Array<[string, unknown, Expected]> = [
	["task", {}, ALLOW],
	["task", { tasks: [] }, ALLOW],
	["bash", { command: "bun test", async: true }, ALLOW],
	["bash", { command: "bun test", async: true, name: "  " }, ALLOW],
	["bash", { command: "bun test" }, "foreground-bash"],
	["bash", { command: "bun test", async: false }, "foreground-bash"],
	["bash", { command: "bun test", async: "true" }, "foreground-bash"],
	["bash", { command: "bun dev", async: true, name: "dev" }, "service-bash"],
	...ALLOWED_NAMES.filter(name => name !== "task").map((name): [string, unknown, Expected] => [name, {}, ALLOW]),
	["write", { path: "agent://worker-1", content: "hi" }, ALLOW],
	["write", { path: "out://reply", content: "hi" }, ALLOW],
	["write", { path: "local://notes.md", content: "hi" }, ALLOW],
	["write", { path: "proc://bg_1/kill" }, ALLOW],
	["write", { path: "proc://bg_1/stdin", content: "x" }, "file-change"],
	["write", { path: "src/a.ts", content: "x" }, "file-change"],
	["write", { path: "/etc/hosts", content: "x" }, "file-change"],
	["write", { path: "xd://edit", content: "{}" }, "file-change"],
	["write", { path: "src/a.ts:nonsense:sel", content: "x" }, "file-change"],
	["write", { content: "x" }, "file-change"],
	["write", { path: 42 }, "file-change"],
	["write", undefined, "file-change"],
	["edit", { path: "src/a.ts" }, "file-change"],
	["ast_edit", {}, "file-change"],
	["wait", {}, "wait"],
	...[
		"eval",
		"web_search",
		"browser",
		"computer",
		"lsp",
		"debug",
		"ida",
		"github",
		"checkpoint",
		"rewind",
		"new_context",
		"context_notes",
		"ast_grep",
		"think",
		"spawn_session",
		"mcp__srv__tool",
		"some_extension_tool",
		"constructor",
		"",
	].map((name): [string, unknown, Expected] => [name, {}, "other"]),
];

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("masterRefusal", () => {
	it.each(GUARD_TABLE)("%s %j -> %s", (tool, args, expected) => {
		const result = masterRefusal(tool, args);
		if (expected === ALLOW) {
			expect(result).toBeUndefined();
		} else if (expected === "other") {
			expect(result).toContain(`The tool \`${tool}\` is not available to the main agent.`);
		} else {
			expect(result).toBe(TEXT_BY_KIND[expected]);
		}
	});

	it("refuses every tool name off the allowlist (seeded property)", () => {
		const seed = Number(Bun.env.MASTER_GUARD_SEED ?? Math.floor(Math.random() * 2 ** 32));
		console.log(`master-mode-guard property seed: ${seed}`);
		const random = mulberry32(seed);
		const alphabet = "abcdefghijklmnopqrstuvwxyz_:/-.0123456789";
		let checked = 0;
		while (checked < 500) {
			const length = Math.floor(random() * 12);
			let name = "";
			for (let i = 0; i < length; i++) name += alphabet[Math.floor(random() * alphabet.length)];
			if (ALLOWED_NAMES.includes(name) || name === "bash" || name === "write") continue;
			const args = random() < 0.5 ? { async: true, path: "agent://x", command: "x" } : {};
			expect(masterRefusal(name, args), `seed ${seed}, name ${JSON.stringify(name)}`).toBeString();
			checked++;
		}
	});

	it("gives every refusal the same frame and an allowed way", () => {
		const refusals = GUARD_TABLE.map(([tool, args]) => masterRefusal(tool, args)).filter(
			(text): text is string => text !== undefined,
		);
		expect(refusals.length).toBeGreaterThan(10);
		for (const text of refusals) {
			expect(text.startsWith("Master mode is on.")).toBe(true);
			expect(text.endsWith(SUFFIX)).toBe(true);
			expect(text).toMatch(/`task`|`bash`|Do not wait/);
		}
	});
});

function stubTool(name: string, onExecute?: (args: Record<string, unknown>) => void): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ "path?": "string", "content?": "string" }),
		strict: true,
		async execute(_id, args) {
			onExecute?.(args as Record<string, unknown>);
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function toolContext(tool: AgentTool, args: Record<string, unknown>): BeforeToolCallContext {
	return {
		assistantMessage: createAssistantMessage(""),
		toolCall: { type: "toolCall", id: "call-1", name: tool.name, arguments: args },
		tool,
		args,
		context: { systemPrompt: [], messages: [], tools: [] },
	} as unknown as BeforeToolCallContext;
}

describe("AgentSession master mode", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let streamFn: StreamFn | undefined;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-master-guard-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: (...args) => {
					if (!streamFn) throw new Error("No test stream configured");
					return streamFn(...args);
				},
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry: new Map(),
			builtInToolNames: [],
		});
	});

	afterEach(async () => {
		await session?.dispose();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("blocks edit and allows read with the state on, and allows edit with it off", async () => {
		const beforeToolCall = session.agent.beforeToolCall;
		if (!beforeToolCall) throw new Error("session did not install beforeToolCall");
		const edit = toolContext(stubTool("edit"), { path: "a.ts" });
		const read = toolContext(stubTool("read"), { path: "a.ts" });

		session.setMasterModeState({ enabled: true });
		expect(await beforeToolCall(edit)).toEqual({ block: true, reason: MASTER_FILE_CHANGE_REFUSAL });
		expect(await beforeToolCall(read)).toBeUndefined();

		session.setMasterModeState(undefined);
		expect(await beforeToolCall(edit)).toBeUndefined();
	});

	it("leaves a file unchanged when the loop refuses a write to it", async () => {
		const target = path.join(tempDir.path(), "refused.txt");
		let executed = 0;
		session.agent.setTools([stubTool("write", () => executed++)]);
		session.setMasterModeState({ enabled: true });
		let calls = 0;
		const contexts: string[] = [];
		streamFn = (_model, context) => {
			calls++;
			contexts.push(JSON.stringify(context));
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (calls === 1) {
					const message = createAssistantMessage("");
					const toolCall = {
						type: "toolCall",
						id: "call-write-1",
						name: "write",
						arguments: { path: target, content: "changed" },
					} as const;
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall as never, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}
			});
			return stream;
		};

		await session.prompt("Edit the file yourself");

		expect(calls).toBe(2);
		expect(executed).toBe(0);
		expect(fs.existsSync(target)).toBe(false);
		expect(contexts[1]).toContain("Master mode is on. You do not change files yourself.");
	});

	it("holds one hidden master message per prompt turn, never saves it, and removes it on exit", async () => {
		const seen: string[] = [];
		streamFn = (_model, context) => {
			seen.push(JSON.stringify(context));
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
			});
			return stream;
		};
		const count = (text: string): number => text.split("<master-mode>").length - 1;
		const masterMessages = () =>
			session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === MASTER_MODE_CONTEXT_MESSAGE_TYPE,
			);

		session.setMasterModeState({ enabled: true });
		await session.prompt("Plan the work");

		expect(count(seen[0])).toBe(1);
		const held = masterMessages();
		expect(held).toHaveLength(1);
		expect(held[0].role === "custom" && held[0].display).toBe(false);
		expect(JSON.stringify(session.sessionManager.getEntries())).not.toContain("<master-mode>");

		session.setMasterModeState(undefined);
		expect(masterMessages()).toHaveLength(0);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
		expect(session.agent.peekFollowUpQueue()).toHaveLength(0);
		await session.prompt("Carry on");
		expect(count(seen[1])).toBe(0);
	});
});
