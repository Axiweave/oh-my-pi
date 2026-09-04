/**
 * Regression tests for the real approval composition driving IDE session
 * state end to end: `ExtensionToolWrapper.execute` -> `ExtensionRunner`'s
 * `getUIContext().select` -> `ExtensionUiController.showCollabAwareSelector`
 * -> `#presentDialog`. Unlike the unit tests in extension-ui-controller-ide-
 * state.test.ts, this file drives the dialog through the actual approval
 * gate so the wire states line up with what a user approving a tool call
 * over MCP would see.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionRuntime, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { getEditorTheme, getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Container, setKeybindings } from "@oh-my-pi/pi-tui";

/** Fake `ide` MCP connection returned by {@link fakeIdeManager}. */
interface FakeIdeManager {
	manager: MCPManager;
	sent: unknown[];
	listeners: Array<(event: McpConnectionStatusEvent) => void>;
	fire: (event: McpConnectionStatusEvent) => void;
}

/** Shared fake `ide` MCP connection: `sent` collects `params.state` in call order. */
function fakeIdeManager({
	connected = true,
	notify,
}: {
	connected?: boolean;
	notify?: (method: string, params: Record<string, unknown>) => Promise<void>;
} = {}): FakeIdeManager {
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
				const index = listeners.indexOf(fn);
				if (index !== -1) listeners.splice(index, 1);
			};
		},
	} as unknown as MCPManager;
	return {
		manager,
		sent,
		listeners,
		fire: (event: McpConnectionStatusEvent) => {
			for (const listener of listeners) listener(event);
		},
	};
}

/** Drain the notify → then/catch → finally (→ re-flush) microtask chain deterministically. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** The approval dialog is presented synchronously, but poll (no real timer) to stay robust. */
async function waitForHookSelector(ctx: InteractiveModeContext): Promise<void> {
	for (let i = 0; i < 20 && !ctx.hookSelector; i++) await Promise.resolve();
}

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme");
	setThemeInstance(dark);
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
});

/** `makeHarness()` from extension-ui-controller.test.ts, plus IDE-state and streaming wiring. */
function makeHarness(): {
	editor: CustomEditor;
	editorContainer: Container;
	controller: ExtensionUiController;
	ctx: InteractiveModeContext;
	fake: FakeIdeManager;
	init: () => Promise<ExtensionUIContext>;
} {
	const editor = new CustomEditor(getEditorTheme());
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const requestRender = vi.fn();
	const setFocus = vi.fn();
	const addAutocompleteProvider = vi.fn();
	const fakeHandle = {
		hide: vi.fn(),
		setHidden: vi.fn(),
		isHidden: vi.fn(() => false),
	};
	const showOverlay = vi.fn(() => fakeHandle);
	const fake = fakeIdeManager();
	let uiContext: ExtensionUIContext | undefined;
	const ctx = {
		editor,
		ui: {
			requestRender,
			setFocus,
			showOverlay,
			terminal: { rows: 40 },
		},
		editorContainer,
		session: {
			extensionRunner: undefined,
			setUsageFallbackConfirmer: vi.fn(),
			isStreaming: true,
		},
		mcpManager: fake.manager,
		setToolUIContext(context: ExtensionUIContext, hasUI: boolean): void {
			expect(hasUI).toBe(true);
			uiContext = context;
		},
		addAutocompleteProvider,
		syncComposerShape: vi.fn(),
	} as unknown as InteractiveModeContext;

	const controller = new ExtensionUiController(ctx);

	return {
		editor,
		editorContainer,
		controller,
		ctx,
		fake,
		async init(): Promise<ExtensionUIContext> {
			await controller.initHooksAndCustomTools();
			expect(uiContext).toBeDefined();
			return uiContext!;
		},
	};
}

/** `createRunner()` from extension-context-async-jobs.test.ts: an ExtensionRunner with no extensions. */
function createRunner(): ExtensionRunner {
	const runtime = {
		flagValues: new Map(),
		pendingProviderRegistrations: [],
	} as unknown as ExtensionRuntime;
	return new ExtensionRunner([], runtime, "/tmp", fakeSessionManager, {} as never);
}

const actions = {
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	setLabel: () => {},
	getActiveTools: () => [],
	getAllTools: () => [],
	setActiveTools: async () => {},
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => undefined,
	setThinkingLevel: () => {},
	getSessionName: () => undefined,
	setSessionName: async () => {},
};

const contextActions = {
	getModel: () => undefined,
	isIdle: () => true,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => {},
	getContextUsage: () => undefined,
	compact: async () => {},
	getSystemPrompt: () => [],
};

/** `approvalTool` from extensions-runner.test.ts, with a caller-controlled execute so the test can
 *  observe IDE state between approval and tool completion. */
function makeApprovalTool() {
	const executeDeferred = Promise.withResolvers<void>();
	const tool = {
		name: "dangerous_tool",
		label: "Dangerous Tool",
		description: "Test tool",
		parameters: {} as never,
		approval: "exec" as const,
		execute: () => executeDeferred.promise.then(() => ({ content: [{ type: "text" as const, text: "ok" }] })),
	} as unknown as AgentTool;
	return { tool, executeDeferred };
}

const fakeSessionManager = { getCwd: () => "/tmp", getSessionId: () => "test-session" } as never;
const modelRegistry = {} as never;

/** The execute-time `AgentToolContext` literal from extensions-runner.test.ts, generalized for approval-mode/policy overrides. */
function context(extra: Record<string, unknown> & { approval?: Record<string, unknown> } = {}): AgentToolContext {
	return {
		sessionManager: fakeSessionManager,
		modelRegistry,
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		settings: {
			get: (key: string) =>
				key === "tools.approvalMode" ? "always-ask" : key === "tools.approval" ? (extra.approval ?? {}) : {},
		} as never,
		...extra,
	} as unknown as AgentToolContext;
}

describe("Approval flow IDE session-state publishing", () => {
	it("an ordinary approval reports needs-input and returns to working before the tool finishes", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const runner = createRunner();
		runner.initialize(actions, contextActions, undefined, ui);
		expect(runner.hasUI()).toBe(true);

		const { tool, executeDeferred } = makeApprovalTool();
		const wrapper = new ExtensionToolWrapper(tool, runner) as ExtensionToolWrapper<any>;

		const execution = wrapper.execute("call-1", {}, undefined, undefined, context({}));
		await waitForHookSelector(harness.ctx);
		expect(harness.fake.sent).toEqual(["needs-input"]);

		harness.ctx.hookSelector!.handleInput("\n");
		await flushMicrotasks();
		expect(harness.fake.sent).toEqual(["needs-input", "working"]);

		executeDeferred.resolve();
		await execution;
		expect(harness.fake.sent).toEqual(["needs-input", "working"]);
	});

	it("pending provider safety checks report needs-input even under yolo", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const runner = createRunner();
		runner.initialize(actions, contextActions, undefined, ui);

		const { tool, executeDeferred } = makeApprovalTool();
		const wrapper = new ExtensionToolWrapper(tool, runner) as ExtensionToolWrapper<any>;

		const toolContext = context({
			settings: { get: (key: string) => (key === "tools.approvalMode" ? "yolo" : {}) },
			toolCall: {
				batchId: "b",
				index: 0,
				total: 1,
				toolCalls: [{ id: "call-2", name: "dangerous_tool" }],
				providerMetadata: {
					type: "computer",
					providerItemId: "item",
					actions: [],
					pendingSafetyChecks: [{ id: "sc-1", code: "malicious_instructions", message: "check" }],
				},
			},
		});
		const execution = wrapper.execute("call-2", {}, undefined, undefined, toolContext);
		await waitForHookSelector(harness.ctx);
		expect(harness.fake.sent).toEqual(["needs-input"]);

		harness.ctx.hookSelector!.handleInput("\n");
		await flushMicrotasks();
		expect(harness.fake.sent).toEqual(["needs-input", "working"]);
		expect(toolContext.providerSafetyApproved).toBe(true);

		// Let the tool call settle so it does not leak into the next test.
		executeDeferred.resolve();
		await execution;
	});

	it("an xd:// tier bypass reports nothing while an explicit prompt policy still reports needs-input", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const runner = createRunner();
		runner.initialize(actions, contextActions, undefined, ui);

		const bypassed = makeApprovalTool();
		const bypassedWrapper = new ExtensionToolWrapper(bypassed.tool, runner) as ExtensionToolWrapper<any>;
		const bypassExecution = bypassedWrapper.execute(
			"call-3",
			{},
			undefined,
			undefined,
			context({ xdevApproved: true }),
		);
		bypassed.executeDeferred.resolve();
		await bypassExecution;
		expect(harness.fake.sent).toEqual([]);
		expect(harness.ctx.hookSelector).toBeUndefined();

		const prompted = makeApprovalTool();
		const promptedWrapper = new ExtensionToolWrapper(prompted.tool, runner) as ExtensionToolWrapper<any>;
		const promptedExecution = promptedWrapper.execute(
			"call-4",
			{},
			undefined,
			undefined,
			context({ xdevApproved: true, approval: { dangerous_tool: "prompt" } }),
		);
		await waitForHookSelector(harness.ctx);
		expect(harness.fake.sent).toEqual(["needs-input"]);

		harness.ctx.hookSelector!.handleInput("\n");
		await flushMicrotasks();
		expect(harness.fake.sent).toEqual(["needs-input", "working"]);

		prompted.executeDeferred.resolve();
		await promptedExecution;
	});

	it("a denied approval returns to working and rejects", async () => {
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.down": "ctrl+n" }));
		const harness = makeHarness();
		const ui = await harness.init();
		const runner = createRunner();
		runner.initialize(actions, contextActions, undefined, ui);

		const { tool } = makeApprovalTool();
		const wrapper = new ExtensionToolWrapper(tool, runner) as ExtensionToolWrapper<any>;

		const execution = wrapper.execute("call-1", {}, undefined, undefined, context({}));
		await waitForHookSelector(harness.ctx);
		expect(harness.fake.sent).toEqual(["needs-input"]);

		harness.ctx.hookSelector!.handleInput("\x0e"); // Ctrl+N: move down to "Deny"
		harness.ctx.hookSelector!.handleInput("\n");
		await flushMicrotasks();

		await expect(execution).rejects.toThrow("Tool call denied by user");
		expect(harness.fake.sent).toEqual(["needs-input", "working"]);
	});
});
