/**
 * Regression tests for `EventController`'s IDE session-state publishing:
 * `working` on `agent_start`, and `done`/`failed`/`idle` on a terminal
 * `agent_end`, gated the same way as `sendErrorNotification` (retry-pending,
 * non-terminal `agent_end`), but independent of the desktop notification
 * settings that gate `sendCompletionNotification`/`sendErrorNotification`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as titleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";

/** Shared fake `ide` MCP connection: `sent` collects `params.state` in call order. */
function fakeIdeManager({
	connected = true,
	notify,
}: {
	connected?: boolean;
	notify?: (method: string, params: Record<string, unknown>) => Promise<void>;
} = {}): {
	manager: MCPManager;
	sent: unknown[];
	listeners: Array<(event: McpConnectionStatusEvent) => void>;
	fire: (event: McpConnectionStatusEvent) => void;
} {
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

const originalWarpProtocolVersion = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;

function restoreWarpProtocolEnvironment(): void {
	if (originalWarpProtocolVersion === undefined) {
		delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
	} else {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = originalWarpProtocolVersion;
	}
}

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ide-state-ec-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
	vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	restoreWarpProtocolEnvironment();
});

type StopReason = "stop" | "aborted" | "error";

function makeAssistantMessage(stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		stopReason,
		usage: { inputTokens: 0, outputTokens: 0 },
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function makeAgentEndEvent(messages: AssistantMessage[]): Extract<AgentSessionEvent, { type: "agent_end" }> {
	return { type: "agent_end", messages } as Extract<AgentSessionEvent, { type: "agent_end" }>;
}

/** Full context needed to drive `#handleAgentEnd` -> `#finishAgentEnd` end to end. */
function makeTurnEndContext(
	mcpManager: MCPManager | undefined,
	options: { lastAssistantMessage?: AssistantMessage; focusedSubagent?: boolean } = {},
): InteractiveModeContext {
	const session = {
		isStreaming: false,
		isCompacting: false,
		messages: [] as AssistantMessage[],
		getLastAssistantMessage: () => options.lastAssistantMessage,
		getContextUsage: () => undefined,
	};
	const viewSession = options.focusedSubagent ? { ...session, isStreaming: true } : session;
	return {
		isInitialized: true,
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		focusedAgentId: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map<string, unknown>(),
		flushPendingModelSwitch: async () => {},
		flushPendingCommandOutput: () => {},
		syncRetryHintRow: () => {},
		ui: { requestRender: () => {}, requestComponentRender: () => {} },
		chatContainer: { removeChild: () => {} },
		statusContainer: { clear: () => {}, disposeChildren: () => {}, addChild: () => {} },
		statusLine: { markActivityEnd: () => {}, markActivityStart: () => {} },
		editor: { getText: () => "" },
		sessionManager: { getSessionName: () => "test-session" },
		clearPinnedError: () => {},
		ensureLoadingAnimation: () => {},
		showError: () => {},
		session,
		viewSession,
		mcpManager,
	} as unknown as InteractiveModeContext;
}

describe("EventController IDE session-state publishing", () => {
	it("publishes working on agent_start", async () => {
		const fake = fakeIdeManager();
		const controller = new EventController(makeTurnEndContext(fake.manager));

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await flushMicrotasks();

		expect(fake.sent).toEqual(["working"]);
	});

	it("publishes nothing while a subagent is focused", async () => {
		const fake = fakeIdeManager();
		const controller = new EventController(makeTurnEndContext(fake.manager, { focusedSubagent: true }));

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("stop")]));
		await flushMicrotasks();

		expect(fake.sent).toEqual([]);
	});

	it("publishes done, failed, or idle for a terminal agent_end depending on stop reason", async () => {
		const cases: Array<[StopReason, string]> = [
			["stop", "done"],
			["error", "failed"],
			["aborted", "idle"],
		];
		for (const [stopReason, expected] of cases) {
			const fake = fakeIdeManager();
			const controller = new EventController(makeTurnEndContext(fake.manager));

			await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage(stopReason)]));
			await flushMicrotasks();

			expect(fake.sent).toEqual([expected]);
		}
	});

	it("does not publish for a non-terminal agent_end", async () => {
		const fake = fakeIdeManager();
		const controller = new EventController(makeTurnEndContext(fake.manager));

		await controller.handleEvent({
			...makeAgentEndEvent([makeAssistantMessage("stop")]),
			isTerminal: false,
		} as Extract<AgentSessionEvent, { type: "agent_end" }>);
		await flushMicrotasks();

		expect(fake.sent).toEqual([]);
	});

	it("suppresses agent_end publishes while a retry is pending, then publishes once settled", async () => {
		const fake = fakeIdeManager();
		const controller = new EventController(makeTurnEndContext(fake.manager));

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		await flushMicrotasks();
		expect(fake.sent).toEqual([]);

		await controller.handleEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 2,
			finalError: "still overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_end" }>);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		await flushMicrotasks();
		expect(fake.sent).toEqual(["failed"]);
	});

	it("publishes done regardless of desktop notification settings and the Warp CLI protocol gate", async () => {
		settings.override("completion.notify", "off");
		settings.override("error.notify", "off");
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
		const fake = fakeIdeManager();
		const controller = new EventController(makeTurnEndContext(fake.manager));

		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("stop")]));
		await flushMicrotasks();

		expect(fake.sent).toEqual(["done"]);
	});

	it("publishes the turn result at turn_end, before agent_end waits on advisor catch-up", async () => {
		const fake = fakeIdeManager();
		const controller = new EventController(makeTurnEndContext(fake.manager));
		const message = makeAssistantMessage("stop");

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await controller.handleEvent({ type: "turn_end", message, toolResults: [] } as Extract<
			AgentSessionEvent,
			{ type: "turn_end" }
		>);
		await flushMicrotasks();
		expect(fake.sent).toEqual(["working", "done"]);

		// agent_end repeats the same state; the publisher dedupes it.
		await controller.handleEvent(makeAgentEndEvent([message]));
		await flushMicrotasks();
		expect(fake.sent).toEqual(["working", "done"]);
	});

	it("keeps working through a tool batch or pause_turn, and re-asserts it on a follow-up turn", async () => {
		const fake = fakeIdeManager();
		const controller = new EventController(makeTurnEndContext(fake.manager));
		const paused = { ...makeAssistantMessage("stop"), stopDetails: { type: "pause_turn" } } as AssistantMessage;

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await controller.handleEvent({
			type: "turn_end",
			message: makeAssistantMessage("stop"),
			toolResults: [{ role: "toolResult" }],
		} as unknown as Extract<AgentSessionEvent, { type: "turn_end" }>);
		await controller.handleEvent({ type: "turn_end", message: paused, toolResults: [] } as Extract<
			AgentSessionEvent,
			{ type: "turn_end" }
		>);
		await flushMicrotasks();
		expect(fake.sent).toEqual(["working"]);

		await controller.handleEvent({
			type: "turn_end",
			message: makeAssistantMessage("stop"),
			toolResults: [],
		} as Extract<AgentSessionEvent, { type: "turn_end" }>);
		await controller.handleEvent({ type: "turn_start" } as Extract<AgentSessionEvent, { type: "turn_start" }>);
		await flushMicrotasks();
		expect(fake.sent).toEqual(["working", "done", "working"]);
	});
});
