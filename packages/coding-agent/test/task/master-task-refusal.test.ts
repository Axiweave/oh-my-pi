/**
 * Contracts: `task` under master mode.
 *
 * 1. With the state on, a call that would run in the foreground (an agent type with
 *    `blocking: true`, or `async.enabled` off) returns the refusal and starts no run.
 * 2. With the state off, the same calls run.
 * 3. A streamed foreground item starts no speculative run under the state; a background item does.
 * 4. FR-009: a subagent session has no master state, so its own `edit`, foreground `bash`, and
 *    foreground `task` are not refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolCall, SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { MASTER_TASK_REFUSAL } from "@oh-my-pi/pi-coding-agent/session/master-mode";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import type { TaskLaunchSession } from "@oh-my-pi/pi-coding-agent/task/speculative-launch";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const workerAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const scoutAgent: AgentDefinition = {
	name: "scout",
	description: "Read-only scout",
	systemPrompt: "You are a scout.",
	source: "bundled",
	blocking: true,
};

const sink: SpeculativeOperationSink = {
	maxInFlight: 2,
	admit: async () => undefined,
	authorizeLaunch: async () => ({ allowed: true }),
	close: () => {},
};

function createSession(options: {
	manager?: AsyncJobManager;
	asyncEnabled?: boolean;
	masterEnabled: boolean;
}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": options.asyncEnabled ?? true, "task.batch": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => null,
		asyncJobManager: options.manager,
		getMasterModeState: () => (options.masterEnabled ? { enabled: true } : undefined),
	} as unknown as ToolSession;
}

function makeResult(id: string, agent: string): SingleResult {
	return {
		index: 0,
		id,
		agent,
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: `${id} output.`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

const call = (agent: string): TaskParams =>
	({ context: "ctx", tasks: [{ name: "Item", agent, task: "Do it." }] }) as TaskParams;

describe("task under master mode", () => {
	const managers: AsyncJobManager[] = [];
	let runs: string[];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		runs = [];
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [workerAgent, scoutAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			runs.push(id);
			return makeResult(id, options.agent.name);
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("refuses a blocking agent type and starts no run", async () => {
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, masterEnabled: true }));

		const result = await tool.execute("tc-blocking", call("scout"));

		expect(result.isError).toBe(true);
		expect(firstText(result)).toBe(MASTER_TASK_REFUSAL);
		expect(runs).toEqual([]);
		expect(manager.getJob("Item")).toBeUndefined();
	});

	it("refuses every call when async.enabled is off and starts no run", async () => {
		const tool = await TaskTool.create(createSession({ asyncEnabled: false, masterEnabled: true }));

		const result = await tool.execute("tc-async-off", call("task"));

		expect(result.isError).toBe(true);
		expect(firstText(result)).toBe(MASTER_TASK_REFUSAL);
		expect(runs).toEqual([]);
	});

	it("refuses a call with no async job manager", async () => {
		const tool = await TaskTool.create(createSession({ masterEnabled: true }));

		const result = await tool.execute("tc-no-manager", call("task"));

		expect(result.isError).toBe(true);
		expect(firstText(result)).toBe(MASTER_TASK_REFUSAL);
		expect(runs).toEqual([]);
	});

	it("refuses a mixed call as a whole and starts no run", async () => {
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, masterEnabled: true }));

		const result = await tool.execute("tc-mixed", {
			context: "ctx",
			tasks: [
				{ name: "Scout", agent: "scout", task: "Look." },
				{ name: "Worker", agent: "task", task: "Build." },
			],
		} as TaskParams);

		expect(firstText(result)).toBe(MASTER_TASK_REFUSAL);
		expect(runs).toEqual([]);
		expect(manager.getJob("Worker")).toBeUndefined();
	});

	it("runs a background item under the state", async () => {
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, masterEnabled: true }));

		const result = await tool.execute("tc-background", call("task"));

		expect(result.isError).not.toBe(true);
		expect(firstText(result)).toContain("Spawned agent `Item`");
		await manager.getJob("Item")!.promise;
		expect(runs).toEqual(["Item"]);
	});

	it("runs the same foreground calls when the state is off", async () => {
		const manager = createManager();
		const blocking = await TaskTool.create(createSession({ manager, masterEnabled: false }));
		const blockingResult = await blocking.execute("tc-off-blocking", call("scout"));
		expect(firstText(blockingResult)).toContain("Item output.");

		const syncTool = await TaskTool.create(createSession({ asyncEnabled: false, masterEnabled: false }));
		const syncResult = await syncTool.execute("tc-off-sync", call("task"));
		expect(firstText(syncResult)).toContain("Item output.");
		expect(runs).toEqual(["Item", "Item"]);
	});

	describe("speculative launch", () => {
		const toolCall: AgentToolCall = { type: "toolCall", id: "tc-spec", name: "task", arguments: {} };

		/** Streams the first of two items and waits for the launch queue to drain. Returns how many launches reached `allocate`. */
		async function streamItem(masterEnabled: boolean, agent: string): Promise<number> {
			const allocate = vi.spyOn(AgentOutputManager.prototype, "allocate");
			const manager = createManager();
			const tool = await TaskTool.create(createSession({ manager, masterEnabled }));
			const session = (await tool.speculation.stream?.open({
				coordinator: sink,
				parentToolCallId: toolCall.id,
			})) as TaskLaunchSession | undefined;
			if (!session) throw new Error("expected a task launch session");
			const args = {
				context: "ctx",
				tasks: [
					{ name: "Item", agent, task: "Do it." },
					{ name: "Pad", agent, task: "Pad." },
				],
			};
			const json = JSON.stringify(args);
			session.update(toolCall, json.slice(0, json.indexOf('{"name":"Pad"') + 10));
			await session.adopt([]);
			return allocate.mock.calls.length;
		}

		it("starts a foreground item speculatively when the state is off", async () => {
			expect(await streamItem(false, "scout")).toBe(1);
		});

		it("starts no foreground run while the arguments stream under the state", async () => {
			expect(await streamItem(true, "scout")).toBe(0);
		});

		it("still starts a background item under the state", async () => {
			expect(await streamItem(true, "task")).toBe(1);
		});
	});

	it("leaves a subagent session unguarded (FR-009)", async () => {
		using tempDir = TempDir.createSync("@pi-master-subagent-");
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		// The same entry point the executor uses to build a subagent session.
		const { session: parent } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "async.enabled": true }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read"],
		});
		const { session: child } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "async.enabled": true }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read"],
		});
		try {
			parent.setMasterModeState({ enabled: true });
			expect(child.getMasterModeState()).toBeUndefined();
			const readTool = child.getToolByName("read");
			if (!readTool) throw new Error("child has no read tool");

			const context = (name: string, args: Record<string, unknown>) => ({
				assistantMessage: { timestamp: 0 },
				toolCall: { type: "toolCall", id: "c", name, arguments: args },
				tool: { ...readTool, name },
				args,
				context: { systemPrompt: [], messages: [], tools: [] },
			});
			const parentHook = parent.agent.beforeToolCall;
			const childHook = child.agent.beforeToolCall;
			if (!parentHook || !childHook) throw new Error("session has no beforeToolCall");
			expect(await parentHook(context("edit", { path: "a.ts" }) as never)).toMatchObject({ block: true });
			for (const [name, args] of [
				["edit", { path: "a.ts" }],
				["bash", { command: "ls" }],
				["task", {}],
			] as const) {
				expect(await childHook(context(name, args) as never), name).toBeUndefined();
			}

			// The child's TaskTool reads the child's state, so a foreground call runs.
			const childToolSession = {
				...createSession({ asyncEnabled: false, masterEnabled: false }),
				getMasterModeState: () => child.getMasterModeState(),
			} as ToolSession;
			const childTask = await TaskTool.create(childToolSession);
			const childResult = await childTask.execute("tc-child", call("task"));
			expect(firstText(childResult)).toContain("Item output.");
		} finally {
			await parent.dispose();
			await child.dispose();
			authStorage.close();
		}
	});
});
