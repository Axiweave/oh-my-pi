/**
 * Regression tests for `ExtensionUiController`'s IDE session-state
 * publishing: `#presentDialog` is the single modal surface for approvals,
 * the `ask` tool, and extension `select`/`input`/`editor`/`askDialog`
 * prompts, so driving it through `showHookSelector` covers every caller.
 */
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { setKeybindings } from "@oh-my-pi/pi-tui";

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

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(theme);
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
});

type TestContext = InteractiveModeContext & {
	editorContainer: {
		children: unknown[];
		clear: () => void;
		addChild: (child: unknown) => void;
	};
};

function createControllerContext() {
	const editor = { id: "core-editor" };
	const editorContainer = {
		children: [] as unknown[],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
	const ui = {
		requestRender: vi.fn(),
		setFocus: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		terminal: { columns: 120 },
	} as unknown as TestContext["ui"] & {
		setFocus: Mock<any>;
		requestRender: Mock<any>;
	};
	const ctx = {
		editor,
		editorContainer,
		ui,
		hookEditor: undefined,
	} as unknown as TestContext;

	return { ctx, editor, editorContainer, ui };
}

type SelectorController = {
	showHookSelector: (
		title: string,
		options: string[],
		dialogOptions?: { signal?: AbortSignal },
	) => Promise<string | undefined>;
};

/** `createControllerContext()` plus the IDE-state wiring every test in this file needs. */
function makeHarness(
	isStreaming: boolean,
	messages: { role: string; stopReason?: string }[] = [],
): { ctx: TestContext; fake: FakeIdeManager; controller: SelectorController } {
	const { ctx } = createControllerContext();
	const fake = fakeIdeManager();
	ctx.mcpManager = fake.manager;
	ctx.session = { isStreaming, messages } as unknown as AgentSession;
	const controller = new ExtensionUiController(ctx) as unknown as SelectorController;
	return { ctx, fake, controller };
}

describe("ExtensionUiController IDE session-state publishing", () => {
	it("a presented dialog reports needs-input and settling returns to working while streaming", async () => {
		const { fake, controller } = makeHarness(true);

		const abortA = new AbortController();
		const promiseA = controller.showHookSelector("A", ["a1", "a2"], { signal: abortA.signal });
		await flushMicrotasks();
		expect(fake.sent).toEqual(["needs-input"]);

		abortA.abort();
		await promiseA;
		await flushMicrotasks();
		expect(fake.sent).toEqual(["needs-input", "working"]);
	});

	it("queued dialogs stay needs-input with no intermediate working", async () => {
		const { fake, controller } = makeHarness(true);

		const abortA = new AbortController();
		const abortB = new AbortController();
		const promiseA = controller.showHookSelector("A", ["a1", "a2"], { signal: abortA.signal });
		const promiseB = controller.showHookSelector("B", ["b1", "b2"], { signal: abortB.signal });
		await flushMicrotasks();
		expect(fake.sent).toEqual(["needs-input"]);

		abortA.abort();
		await promiseA;
		await flushMicrotasks();
		expect(fake.sent).toEqual(["needs-input"]);

		abortB.abort();
		await promiseB;
		await flushMicrotasks();
		expect(fake.sent).toEqual(["needs-input", "working"]);
	});

	it("settling outside a turn returns to idle when nothing has run", async () => {
		const { fake, controller } = makeHarness(false);

		const abortA = new AbortController();
		const promiseA = controller.showHookSelector("A", ["a1", "a2"], { signal: abortA.signal });
		await flushMicrotasks();
		expect(fake.sent).toEqual(["needs-input"]);

		abortA.abort();
		await promiseA;
		await flushMicrotasks();
		expect(fake.sent).toEqual(["needs-input", "idle"]);
	});

	it("settling outside a turn restores how the last turn ended", async () => {
		const { fake, controller } = makeHarness(false, [{ role: "assistant", stopReason: "stop" }]);

		const abortA = new AbortController();
		const promiseA = controller.showHookSelector("A", ["a1"], { signal: abortA.signal });
		await flushMicrotasks();
		abortA.abort();
		await promiseA;
		await flushMicrotasks();
		expect(fake.sent).toEqual(["needs-input", "done"]);
	});

	it("a dialog aborted before its turn never reports", async () => {
		const { fake, controller } = makeHarness(true);

		const abortA = new AbortController();
		const abortB = new AbortController();
		const promiseA = controller.showHookSelector("A", ["a1"], { signal: abortA.signal });
		const promiseB = controller.showHookSelector("B", ["b1"], { signal: abortB.signal });
		await flushMicrotasks();
		expect(fake.sent).toEqual(["needs-input"]);

		abortB.abort();
		await promiseB;
		await flushMicrotasks();
		expect(fake.sent).toEqual(["needs-input"]);

		abortA.abort();
		await promiseA;
		await flushMicrotasks();
		expect(fake.sent).toEqual(["needs-input", "working"]);
	});
});
