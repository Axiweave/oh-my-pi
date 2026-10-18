import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { LoopTool, type LoopStartRequest } from "@oh-my-pi/pi-coding-agent/tools/loop";
import { TempDir } from "@oh-my-pi/pi-utils";

type Harness = {
	mode: InteractiveMode;
	session: AgentSession;
	cleanup: () => Promise<void>;
};

async function createHarness(): Promise<Harness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-guided-loop-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const settings = Settings.isolated({ "compaction.enabled": false, "goal.enabled": true });
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	const toolSessionBase: ToolSession = {
		cwd: tempDir.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
	const initialTools = await createTools(toolSessionBase, ["read"]);
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: initialTools, messages: [] } }),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	// Mirror sdk.ts: `loop` is pre-registered (inactive) so the interview can activate it by name.
	const loopTool = new LoopTool({
		...toolSessionBase,
		peekLoopStartHandler: () => session.peekLoopStartHandler(),
		setLoopStartHandler: handler => session.setLoopStartHandler(handler),
	});
	toolRegistry.set("loop", loopTool as unknown as Tool);
	const mode = new InteractiveMode(session, "test");
	vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
	vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	mode.ui.requestRender = vi.fn();
	vi.spyOn(vcs, "repo").mockReturnValue(null);
	vi.spyOn(vcs, "git").mockReturnValue(null);
	await mode.init({ suppressWelcomeIntro: true });
	return {
		mode,
		session,
		cleanup: async () => {
			mode.speckitAutoEnabled = false;
			mode.disableLoopMode();
			mode.stop();
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
			resetSettingsForTest();
		},
	};
}

function assistantTurn(content: AssistantMessage["content"]): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolCallTurn(name: string): AgentMessage {
	return assistantTurn([{ type: "toolCall", id: `call-${name}`, name, arguments: {} }]);
}

/** Let fire-and-forget work (tool set changes) finish: drain microtasks, no wall-clock wait. */
async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Emit `agent_end` through the agent and wait until the session delivered it to subscribers. */
async function endTurn(h: Harness, messages: AgentMessage[]): Promise<void> {
	const delivered = Promise.withResolvers<void>();
	const unsubscribe = h.session.subscribe(event => {
		if (event.type === "agent_end") delivered.resolve();
	});
	try {
		h.session.agent.emitExternalEvent({ type: "agent_end", messages });
		await delivered.promise;
	} finally {
		unsubscribe();
	}
	await settle();
}

/** The four observable facts of a running guided-loop interview. */
function interviewFacts(h: Harness) {
	return {
		flag: h.mode.isGuidedLoopInterviewActive(),
		interviewActive: h.mode.interviewActive,
		handler: h.session.peekLoopStartHandler() !== undefined,
		loopTool: h.session.getEnabledToolNames().includes("loop"),
	};
}

const ACTIVE = { flag: true, interviewActive: true, handler: true, loopTool: true };
const ENDED = { flag: false, interviewActive: false, handler: false, loopTool: false };

function stubPrompt(h: Harness) {
	return vi.spyOn(h.session, "prompt").mockResolvedValue(true);
}

function stubFollowUp(h: Harness) {
	return vi.spyOn(h.session, "followUp").mockResolvedValue();
}

function stubConfirm(h: Harness, answer: boolean) {
	return vi.spyOn(h.mode, "showHookConfirm").mockResolvedValue(answer);
}

async function request(h: Harness, req: LoopStartRequest) {
	const handler = h.session.peekLoopStartHandler();
	if (!handler) throw new Error("Expected an installed loop start handler");
	return await handler(req);
}

/** Loop on with prompt "tick", 5 iterations, every 2 minutes — set up the same way a typed `/loop` does. */
async function startOldLoop(h: Harness): Promise<void> {
	const loopPrompt = await h.mode.handleLoopCommand("5 every 2m tick");
	expect(loopPrompt).toBe("tick");
	h.mode.setLoopPrompt(loopPrompt!);
	expect(h.mode.loopModeEnabled).toBe(true);
	expect(h.mode.loopModePaused).toBe(false);
	expect(h.mode.loopPrompt).toBe("tick");
}

describe("guided loop", () => {
	let h: Harness | undefined;

	beforeAll(() => {
		initTheme();
	});

	afterEach(async () => {
		await h?.cleanup();
		h = undefined;
		vi.restoreAllMocks();
	});

	describe("kickoff", () => {
		it("sends one synthetic prompt that keeps the slash command visible and carries the rough idea", async () => {
			h = await createHarness();
			const promptSpy = stubPrompt(h);
			const followUp = stubFollowUp(h);

			expect(await h.mode.handleGuidedLoopCommand("check CI")).toBe(true);

			expect(followUp).not.toHaveBeenCalled();
			expect(promptSpy).toHaveBeenCalledTimes(1);
			const [text, options] = promptSpy.mock.calls[0]!;
			expect(text).toContain("check CI");
			expect(options).toMatchObject({ synthetic: true, displayText: "/guided-loop check CI", userInitiated: true });
		});

		it("queues the kickoff as a synthetic follow-up while the agent is streaming", async () => {
			h = await createHarness();
			Object.defineProperty(h.session, "isStreaming", { configurable: true, get: () => true });
			const promptSpy = stubPrompt(h);
			const followUp = stubFollowUp(h);

			expect(await h.mode.handleGuidedLoopCommand("check CI")).toBe(true);

			expect(promptSpy).not.toHaveBeenCalled();
			expect(followUp).toHaveBeenCalledTimes(1);
			const [text, , options] = followUp.mock.calls[0]!;
			expect(text).toContain("check CI");
			expect(options).toEqual({ synthetic: true, displayText: "/guided-loop check CI", userInitiated: true });
			Reflect.deleteProperty(h.session, "isStreaming");
		});
	});

	describe("begin", () => {
		it("turns on the interview, installs the handler, and exposes the loop tool", async () => {
			h = await createHarness();
			stubPrompt(h);
			expect(interviewFacts(h)).toEqual(ENDED);

			await h.mode.handleGuidedLoopCommand("check CI");

			expect(interviewFacts(h)).toEqual(ACTIVE);
		});
	});

	describe("confirm", () => {
		it("yes: starts the loop, queues its first run once, and ends the interview", async () => {
			h = await createHarness();
			stubPrompt(h);
			await h.mode.handleGuidedLoopCommand("check CI");
			const followUp = stubFollowUp(h);
			const before = h.mode.chatContainer.children.length;
			stubConfirm(h, true);

			expect(await request(h, { op: "start", args: "2 every 1m check CI" })).toBe("started");

			expect(h.mode.loopModeEnabled).toBe(true);
			expect(h.mode.loopModePaused).toBe(false);
			expect(h.mode.loopLimit).toMatchObject({ kind: "iterations", initial: 2, remaining: 2 });
			expect(h.mode.loopIntervalMs).toBe(60_000);
			expect(h.mode.loopPrompt).toBe("check CI");
			expect(followUp.mock.calls.map(call => call[0])).toEqual(["check CI"]);
			// The copyable line stays as its own row; the enable message must not overwrite it.
			const transcript = h.mode.chatContainer.children
				.slice(before)
				.flatMap(child => child.render(200))
				.join("\n");
			expect(transcript).toContain("/loop 2 every 1m check CI");
			expect(transcript).toContain("Loop mode enabled.");
			await settle();
			expect(interviewFacts(h)).toEqual(ENDED);
		});

		it("counts the first interval from when the queued first run starts, not from the tool call", async () => {
			const MINUTE = 60_000;
			const TOOL_TAIL = 20_000;
			h = await createHarness();
			stubPrompt(h);
			stubFollowUp(h);
			await h.mode.handleGuidedLoopCommand("check CI");
			stubConfirm(h, true);
			vi.useFakeTimers();
			try {
				const toolCallAt = Date.now();
				expect(await request(h, { op: "start", args: "every 1m check CI" })).toBe("started");
				// The rest of the tool turn runs before the queued first run reaches the agent.
				vi.advanceTimersByTime(TOOL_TAIL);
				const runStartedAt = Date.now();
				h.session.agent.emitExternalEvent({
					type: "message_start",
					message: { role: "user", content: "check CI", timestamp: runStartedAt },
				});
				await settle();

				const runs: number[] = [];
				void h.mode.getUserInput().then(() => runs.push(Date.now()));
				vi.advanceTimersByTime(toolCallAt + MINUTE - Date.now());
				await settle();
				expect(runs).toEqual([]);
				vi.advanceTimersByTime(runStartedAt + MINUTE - Date.now());
				await settle();
				expect(runs).toEqual([runStartedAt + MINUTE]);
			} finally {
				vi.useRealTimers();
			}
		});

		it("no: declines without touching loop state and keeps the interview", async () => {
			h = await createHarness();
			stubPrompt(h);
			await h.mode.handleGuidedLoopCommand("check CI");
			const followUp = stubFollowUp(h);
			stubConfirm(h, false);

			expect(await request(h, { op: "start", args: "2 every 1m check CI" })).toBe("declined");

			expect(h.mode.loopModeEnabled).toBe(false);
			expect(h.mode.loopPrompt).toBeUndefined();
			expect(h.mode.loopLimit).toBeUndefined();
			expect(h.mode.loopIntervalMs).toBeUndefined();
			expect(followUp).not.toHaveBeenCalled();
			expect(interviewFacts(h)).toEqual(ACTIVE);
		});

		it("asks with the loop line, defaults to No, and passes the tool call signal", async () => {
			h = await createHarness();
			stubPrompt(h);
			await h.mode.handleGuidedLoopCommand("check CI");
			const confirm = stubConfirm(h, false);
			const signal = new AbortController().signal;

			await request(h, { op: "start", args: "2 every 1m check CI", signal });

			expect(confirm).toHaveBeenCalledTimes(1);
			const [title, message, options] = confirm.mock.calls[0]!;
			expect(title).toBe("Start this loop?");
			expect(message.startsWith("/loop 2 every 1m check CI")).toBe(true);
			expect(message).not.toContain("This replaces the current loop");
			expect(options?.initialIndex).toBe(1);
			expect(options?.signal).toBe(signal);
		});

		it("names the paused loop that a new setup replaces", async () => {
			h = await createHarness();
			stubPrompt(h);
			await startOldLoop(h);
			await h.mode.handleGuidedLoopCommand("check CI");
			const confirm = stubConfirm(h, false);

			await request(h, { op: "start", args: "2 every 1m check CI" });

			const [, message] = confirm.mock.calls[0]!;
			expect(message.startsWith("/loop 2 every 1m check CI")).toBe(true);
			expect(message).toContain("This replaces the current loop (");
			expect(message).toContain("5 of 5 iterations");
		});
	});

	describe("refusals", () => {
		it("refuses while speckit-auto mode is on and sends nothing", async () => {
			h = await createHarness();
			const promptSpy = stubPrompt(h);
			const followUp = stubFollowUp(h);
			h.mode.speckitAutoEnabled = true;

			expect(await h.mode.handleGuidedLoopCommand("check CI")).toBe(false);

			expect(promptSpy).not.toHaveBeenCalled();
			expect(followUp).not.toHaveBeenCalled();
			expect(interviewFacts(h)).toEqual(ENDED);
		});

		it("refuses during a guided goal interview", async () => {
			h = await createHarness();
			const promptSpy = stubPrompt(h);
			await h.mode.handleGuidedGoalCommand("ship it");
			expect(h.mode.isGuidedGoalInterviewActive()).toBe(true);
			const warning = vi.spyOn(h.mode, "showWarning");

			expect(await h.mode.handleGuidedLoopCommand("check CI")).toBe(false);

			expect(warning).toHaveBeenCalledWith("Finish the guided goal interview first.");
			expect(promptSpy).toHaveBeenCalledTimes(1);
			expect(h.mode.isGuidedLoopInterviewActive()).toBe(false);
			expect(h.session.peekLoopStartHandler()).toBeUndefined();
		});

		it("/guided-goal refuses during a guided loop interview", async () => {
			h = await createHarness();
			const promptSpy = stubPrompt(h);
			await h.mode.handleGuidedLoopCommand("check CI");
			const warning = vi.spyOn(h.mode, "showWarning");

			expect(await h.mode.handleGuidedGoalCommand("ship it")).toBe(false);

			expect(warning).toHaveBeenCalledWith("Finish the guided loop interview first.");
			expect(promptSpy).toHaveBeenCalledTimes(1);
			expect(h.mode.isGuidedGoalInterviewActive()).toBe(false);
			expect(interviewFacts(h)).toEqual(ACTIVE);
		});
	});

	describe("leave", () => {
		it("cancel ends the interview without a loop", async () => {
			h = await createHarness();
			stubPrompt(h);
			const followUp = stubFollowUp(h);
			await h.mode.handleGuidedLoopCommand("check CI");

			expect(await request(h, { op: "cancel" })).toBe("cancelled");

			expect(interviewFacts(h)).toEqual(ENDED);
			expect(h.mode.loopModeEnabled).toBe(false);
			expect(followUp).not.toHaveBeenCalled();
		});

		it("a turn that calls another tool ends the interview", async () => {
			h = await createHarness();
			stubPrompt(h);
			await h.mode.handleGuidedLoopCommand("check CI");

			await endTurn(h, [toolCallTurn("read")]);

			expect(interviewFacts(h)).toEqual(ENDED);
		});

		it("question turns and turns that only call loop keep the interview", async () => {
			h = await createHarness();
			stubPrompt(h);
			await h.mode.handleGuidedLoopCommand("check CI");

			await endTurn(h, [assistantTurn([{ type: "text", text: "How often?" }])]);
			expect(interviewFacts(h)).toEqual(ACTIVE);
			await endTurn(h, [toolCallTurn("loop")]);
			expect(interviewFacts(h)).toEqual(ACTIVE);
		});

		it("a goal that starts during the interview keeps it", async () => {
			h = await createHarness();
			stubPrompt(h);
			await h.mode.handleGuidedLoopCommand("check CI");

			await h.mode.startGoalAtStartup("ship it");
			await settle();

			expect(h.mode.goalModeEnabled).toBe(true);
			expect(interviewFacts(h)).toEqual(ACTIVE);
		});

		it("a tool set saved during the interview does not bring the loop tool back", async () => {
			h = await createHarness();
			stubPrompt(h);
			await h.mode.handleGuidedLoopCommand("check CI");
			await h.mode.startGoalAtStartup("ship it");
			expect(await request(h, { op: "cancel" })).toBe("cancelled");
			stubConfirm(h, true);

			await h.mode.handleGoalModeCommand("drop");
			await settle();

			expect(h.mode.goalModeEnabled).toBe(false);
			expect(h.session.getEnabledToolNames()).not.toContain("loop");
		});

		it("a session switch ends the interview", async () => {
			h = await createHarness();
			vi.spyOn(h.session.modelRegistry, "getApiKey").mockResolvedValue("test-key");
			stubPrompt(h);
			await h.mode.handleGuidedLoopCommand("check CI");
			await h.session.sessionManager.ensureOnDisk();
			const sessionFile = h.session.sessionFile;
			if (!sessionFile) throw new Error("Expected persisted session file");

			expect(await h.session.switchSession(sessionFile)).toBe(true);
			await settle();

			expect(interviewFacts(h)).toEqual(ENDED);
		});

		it("a failed kickoff returns false and leaves no interview", async () => {
			h = await createHarness();
			vi.spyOn(h.session, "prompt").mockRejectedValue(new Error("provider down"));
			const error = vi.spyOn(h.mode, "showError").mockImplementation(() => {});

			expect(await h.mode.handleGuidedLoopCommand("check CI")).toBe(false);

			expect(error).toHaveBeenCalledWith("provider down");
			expect(interviewFacts(h)).toEqual(ENDED);
		});

		it("a typed /loop ends the interview and turns the loop on", async () => {
			h = await createHarness();
			stubPrompt(h);
			await h.mode.handleGuidedLoopCommand("check CI");

			expect(await h.mode.handleLoopCommand("every 2m hi")).toBe("hi");

			expect(interviewFacts(h)).toEqual(ENDED);
			expect(h.mode.loopModeEnabled).toBe(true);
			expect(h.mode.loopIntervalMs).toBe(120_000);
		});
	});

	describe("old loop", () => {
		it("pauses for the interview, ignores answers as loop prompts, and stays paused after cancel", async () => {
			h = await createHarness();
			stubPrompt(h);
			stubFollowUp(h);
			await startOldLoop(h);
			const limit = structuredClone(h.mode.loopLimit);
			const condition = h.mode.loopCondition;

			await h.mode.handleGuidedLoopCommand("check CI");
			expect(h.mode.loopModeEnabled).toBe(true);
			expect(h.mode.loopModePaused).toBe(true);
			expect(h.mode.loopPrompt).toBeUndefined();

			h.mode.setLoopPrompt("an answer");
			expect(h.mode.loopPrompt).toBeUndefined();
			expect(h.mode.loopModePaused).toBe(true);

			expect(await request(h, { op: "cancel" })).toBe("cancelled");
			expect(h.mode.loopModeEnabled).toBe(true);
			expect(h.mode.loopModePaused).toBe(true);
			expect(h.mode.loopPrompt).toBeUndefined();
			expect(h.mode.loopLimit).toEqual(limit);
			expect(h.mode.loopIntervalMs).toBe(120_000);
			expect(h.mode.loopCondition).toEqual(condition);
		});

		it("yes replaces the old setup with the new one", async () => {
			h = await createHarness();
			stubPrompt(h);
			const followUp = stubFollowUp(h);
			await startOldLoop(h);
			await h.mode.handleGuidedLoopCommand("check CI");
			stubConfirm(h, true);

			expect(await request(h, { op: "start", args: "every 30s new" })).toBe("started");

			expect(h.mode.loopModeEnabled).toBe(true);
			expect(h.mode.loopModePaused).toBe(false);
			expect(h.mode.loopPrompt).toBe("new");
			expect(h.mode.loopIntervalMs).toBe(30_000);
			expect(h.mode.loopLimit).toBeUndefined();
			expect(h.mode.loopCondition).toBeUndefined();
			expect(followUp.mock.calls.map(call => call[0])).toEqual(["new"]);
		});
	});

	describe("property: the four interview facts always agree with a simple model", () => {
		// mulberry32
		function prng(seed: number): () => number {
			let a = seed >>> 0;
			return () => {
				a = (a + 0x6d2b79f5) >>> 0;
				let t = a;
				t = Math.imul(t ^ (t >>> 15), t | 1);
				t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		}

		const SEED = 0x10_0b_5e_ed;
		const STEPS = 40;
		type Op = "begin" | "cancel" | "decline" | "agentEndRead" | "agentEndLoop" | "agentEndText" | "typedLoop";
		const OPS: Op[] = ["begin", "cancel", "decline", "agentEndRead", "agentEndLoop", "agentEndText", "typedLoop"];

		it(`holds for ${STEPS} random steps (seed ${SEED})`, async () => {
			h = await createHarness();
			stubPrompt(h);
			stubFollowUp(h);
			stubConfirm(h, false);
			const next = prng(SEED);
			const trace: Op[] = [];
			let active = false;

			for (let step = 0; step < STEPS; step++) {
				const op = OPS[Math.floor(next() * OPS.length)]!;
				trace.push(op);
				switch (op) {
					case "begin":
						expect(await h.mode.handleGuidedLoopCommand("check CI")).toBe(true);
						active = true;
						break;
					case "cancel":
						if (active) expect(await request(h, { op: "cancel" })).toBe("cancelled");
						active = false;
						break;
					case "decline":
						if (active) expect(await request(h, { op: "start", args: "every 1m check CI" })).toBe("declined");
						break;
					case "agentEndRead":
						await endTurn(h, [toolCallTurn("read")]);
						active = false;
						break;
					case "agentEndLoop":
						await endTurn(h, [toolCallTurn("loop")]);
						break;
					case "agentEndText":
						await endTurn(h, [assistantTurn([{ type: "text", text: "How often?" }])]);
						break;
					case "typedLoop":
						await h.mode.handleLoopCommand("every 2m hi");
						active = false;
						break;
				}
				expect(interviewFacts(h), `seed ${SEED}, step ${step}, trace ${trace.join(" > ")}`).toEqual(
					active ? ACTIVE : ENDED,
				);
			}
		});
	});
});
