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
import { setImmediate } from "node:timers/promises";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as unexpectedStopClassifier from "@oh-my-pi/pi-coding-agent/session/unexpected-stop-classifier";
import * as titleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";

import { cfgCompletionNotify, cfgErrorNotify } from "@oh-my-pi/pi-coding-agent/modes/settings";

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

/** Wait one event-loop turn to drain notification and settlement continuations. */
async function flushMicrotasks(): Promise<void> {
	await setImmediate();
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
		hasPostPromptWork: false,
		queuedMessageCount: 0,
		waitForIdle: async () => {},
		messages: [] as AssistantMessage[],
		getLastAssistantMessage: () => options.lastAssistantMessage,
		hasPendingAsyncWork: () => false,
		hasRunningAsyncJobs: () => false,
		hasPendingAsyncDelivery: () => false,
		getContextUsage: () => undefined,
		agent: { getPendingToolResults: () => [] },
	};
	const viewSession = options.focusedSubagent ? { ...session, isStreaming: true } : session;
	return {
		isInitialized: true,
		keybindings: KeybindingsManager.inMemory(),
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
		settings: Settings.instance,
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

	it("does not publish for a non-terminal agent_end with queued input", async () => {
		const fake = fakeIdeManager();
		const ctx = makeTurnEndContext(fake.manager);
		Object.assign(ctx.session, { queuedMessageCount: 1 });
		const controller = new EventController(ctx);

		await controller.handleEvent({
			...makeAgentEndEvent([makeAssistantMessage("stop")]),
			isTerminal: false,
		} as Extract<AgentSessionEvent, { type: "agent_end" }>);
		await flushMicrotasks();

		expect(fake.sent).toEqual([]);
	});

	it("publishes the drained async turn outcome only while the main session remains visible", async () => {
		const cases: Array<[StopReason, boolean, string[]]> = [
			["stop", false, ["working", "done"]],
			["aborted", false, ["working", "idle"]],
			["stop", true, ["working"]],
		];
		for (const [stopReason, focusSubagent, expected] of cases) {
			const fake = fakeIdeManager();
			const ctx = makeTurnEndContext(fake.manager);
			const drained = Promise.withResolvers<void>();
			let pending = true;
			Object.assign(ctx.session, {
				hasPendingAsyncWork: () => pending,
				settleAsyncWork: () => drained.promise,
			});
			const controller = new EventController(ctx);

			await controller.handleEvent({ type: "agent_start" });
			// The final reply lands while the job runs: the run is not finished, so no early `done`.
			await controller.handleEvent({
				type: "turn_end",
				message: makeAssistantMessage(stopReason),
				toolResults: [],
			} as Extract<AgentSessionEvent, { type: "turn_end" }>);
			await controller.handleEvent({
				...makeAgentEndEvent([makeAssistantMessage(stopReason)]),
				isTerminal: false,
				awaitingAsyncWork: true,
			});
			await flushMicrotasks();
			expect(fake.sent).toEqual(["working"]);

			if (focusSubagent) Object.assign(ctx, { viewSession: { ...ctx.session } });
			pending = false;
			drained.resolve();
			await flushMicrotasks();

			expect(fake.sent).toEqual(expected);
		}
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
		cfgCompletionNotify.override(settings, "off");
		cfgErrorNotify.override(settings, "off");
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

describe("EventController background-job settle judge", () => {
	type AgentEnd = Extract<AgentSessionEvent, { type: "agent_end" }>;

	/** A main session whose own jobs run until `drain()`; the final reply settles with `awaitingAsyncWork`. */
	function jobWaitHarness() {
		const fake = fakeIdeManager();
		const ctx = makeTurnEndContext(fake.manager);
		const drained = Promise.withResolvers<void>();
		let running = true;
		let lastReply: AssistantMessage | undefined;
		Object.assign(ctx.session, {
			hasPendingAsyncWork: () => running,
			hasRunningAsyncJobs: () => running,
			settleAsyncWork: () => drained.promise,
			getLastAssistantMessage: () => lastReply,
		});
		const controller = new EventController(ctx);
		const notify = vi.spyOn(controller, "sendCompletionNotification").mockImplementation(() => {});
		const settle = (message: AssistantMessage = makeAssistantMessage("stop")): AgentEnd => {
			lastReply = message;
			return { ...makeAgentEndEvent([message]), isTerminal: false, awaitingAsyncWork: true };
		};
		/** The session's last reply changes, as `/new` (none) or `/resume` (another session's) makes it. */
		const replaceLastReply = (message: AssistantMessage | undefined) => {
			lastReply = message;
		};
		const drain = async () => {
			running = false;
			drained.resolve();
			await flushMicrotasks();
		};
		return { fake, ctx, controller, notify, settle, drain, replaceLastReply };
	}

	it("settles a reply that needs the user as needs-input once, and the job drain keeps it", async () => {
		vi.spyOn(unexpectedStopClassifier, "classifyNeedsUser").mockResolvedValue(true);
		const h = jobWaitHarness();

		await h.controller.handleEvent({ type: "agent_start" });
		await h.controller.handleEvent(h.settle());
		await flushMicrotasks();
		expect(h.fake.sent).toEqual(["working", "needs-input"]);
		expect(h.controller.jobWaitNeedsInput).toBe(true);
		expect(h.notify).toHaveBeenCalledTimes(1);

		// The jobs end with no wake: the settled state is not demoted and not announced twice.
		await h.drain();
		expect(h.fake.sent).toEqual(["working", "needs-input"]);
		expect(h.notify).toHaveBeenCalledTimes(1);

		// The user replies: the verdict ends with the new run.
		await h.controller.handleEvent({ type: "agent_start" });
		await flushMicrotasks();
		expect(h.controller.jobWaitNeedsInput).toBe(false);
		expect(h.fake.sent).toEqual(["working", "needs-input", "working"]);
	});

	it("keeps the job wait for a no or a missing verdict", async () => {
		for (const verdict of [false, undefined]) {
			vi.spyOn(unexpectedStopClassifier, "classifyNeedsUser").mockResolvedValue(verdict);
			const h = jobWaitHarness();

			await h.controller.handleEvent({ type: "agent_start" });
			await h.controller.handleEvent(h.settle());
			await flushMicrotasks();
			expect(h.fake.sent).toEqual(["working"]);
			expect(h.notify).not.toHaveBeenCalled();

			await h.drain();
			expect(h.fake.sent).toEqual(["working", "done"]);
			expect(h.notify).toHaveBeenCalledTimes(1);
		}
	});

	it("drops a yes verdict that lands after a new run started", async () => {
		const verdict = Promise.withResolvers<boolean | undefined>();
		vi.spyOn(unexpectedStopClassifier, "classifyNeedsUser").mockReturnValue(verdict.promise);
		const h = jobWaitHarness();

		await h.controller.handleEvent({ type: "agent_start" });
		await h.controller.handleEvent(h.settle());
		await h.controller.handleEvent({ type: "agent_start" });
		verdict.resolve(true);
		await flushMicrotasks();

		expect(h.fake.sent).toEqual(["working"]);
		expect(h.controller.jobWaitNeedsInput).toBe(false);
		expect(h.notify).not.toHaveBeenCalled();
	});

	it("ends the verdict when the session's last reply changes, as after /new or /resume", async () => {
		const other = { ...makeAssistantMessage("stop"), timestamp: Date.now() + 60_000 } as AssistantMessage;
		for (const [label, nextReply] of [
			["new session", undefined],
			["resumed session", other],
		] as const) {
			vi.spyOn(unexpectedStopClassifier, "classifyNeedsUser").mockResolvedValue(true);
			const h = jobWaitHarness();
			await h.controller.handleEvent({ type: "agent_start" });
			await h.controller.handleEvent(h.settle());
			await flushMicrotasks();
			expect({ label, before: h.controller.jobWaitNeedsInput }).toEqual({ label, before: true });

			h.replaceLastReply(nextReply);
			expect({ label, after: h.controller.jobWaitNeedsInput }).toEqual({ label, after: false });
		}
	});

	it("drops a yes verdict that lands after the session changed", async () => {
		const verdict = Promise.withResolvers<boolean | undefined>();
		vi.spyOn(unexpectedStopClassifier, "classifyNeedsUser").mockReturnValue(verdict.promise);
		const h = jobWaitHarness();

		await h.controller.handleEvent({ type: "agent_start" });
		await h.controller.handleEvent(h.settle());
		h.replaceLastReply(undefined);
		verdict.resolve(true);
		await flushMicrotasks();

		expect(h.fake.sent).toEqual(["working"]);
		expect(h.notify).not.toHaveBeenCalled();
	});

	it("drops a yes verdict while a queued message waits for its turn", async () => {
		const verdict = Promise.withResolvers<boolean | undefined>();
		vi.spyOn(unexpectedStopClassifier, "classifyNeedsUser").mockReturnValue(verdict.promise);
		const h = jobWaitHarness();

		await h.controller.handleEvent({ type: "agent_start" });
		await h.controller.handleEvent(h.settle());
		Object.assign(h.ctx.session, { queuedMessageCount: 1 });
		verdict.resolve(true);
		await flushMicrotasks();

		expect(h.fake.sent).toEqual(["working"]);
		expect(h.controller.jobWaitNeedsInput).toBe(false);
	});

	it("keeps the verdict while the user views a running subagent and comes back", async () => {
		vi.spyOn(unexpectedStopClassifier, "classifyNeedsUser").mockResolvedValue(true);
		const h = jobWaitHarness();
		await h.controller.handleEvent({ type: "agent_start" });
		await h.controller.handleEvent(h.settle());
		await flushMicrotasks();

		// Focusing a streaming subagent replays its `agent_start` into the same controller.
		const main = h.ctx.viewSession;
		Object.assign(h.ctx, { viewSession: { ...h.ctx.session } });
		await h.controller.handleEvent({ type: "agent_start" });
		Object.assign(h.ctx, { viewSession: main });

		expect(h.controller.jobWaitNeedsInput).toBe(true);
	});

	it("asks no judge for a settle outside the trigger rules", async () => {
		const toolCall = {
			...makeAssistantMessage("stop"),
			content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
		} as unknown as AssistantMessage;
		// Each case breaks one rule of an otherwise judged settle `event`.
		const cases: Array<[string, (ctx: InteractiveModeContext, event: AgentEnd) => AgentEnd]> = [
			["no awaited async work", (_ctx, event) => ({ ...event, awaitingAsyncWork: false })],
			["aborted reply", (_ctx, event) => ({ ...event, messages: [makeAssistantMessage("aborted")] })],
			["error reply", (_ctx, event) => ({ ...event, messages: [makeAssistantMessage("error")] })],
			["reply with a tool call", (_ctx, event) => ({ ...event, messages: [toolCall] })],
			[
				"subagent view focused",
				(ctx, event) => {
					Object.assign(ctx, { viewSession: { ...ctx.session } });
					return event;
				},
			],
			[
				"speckit-auto run active",
				(ctx, event) => {
					Object.assign(ctx, { speckitAutoRunActive: true });
					return event;
				},
			],
			[
				"finished job result about to wake",
				(ctx, event) => {
					Object.assign(ctx.session, { hasPendingAsyncDelivery: () => true });
					return event;
				},
			],
			[
				"only another owner's work pending",
				(ctx, event) => {
					Object.assign(ctx.session, { hasRunningAsyncJobs: () => false });
					return event;
				},
			],
		];
		for (const [label, breakRule] of cases) {
			const judge = vi.spyOn(unexpectedStopClassifier, "classifyNeedsUser").mockResolvedValue(true);
			const h = jobWaitHarness();
			await h.controller.handleEvent({ type: "agent_start" });
			await h.controller.handleEvent(breakRule(h.ctx, h.settle()));
			await flushMicrotasks();
			expect({ label, calls: judge.mock.calls.length }).toEqual({ label, calls: 0 });
			expect(h.controller.jobWaitNeedsInput).toBe(false);
			judge.mockRestore();
		}
	});
});
