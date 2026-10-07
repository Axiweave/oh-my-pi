import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, UserMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgCompletionNotify, cfgErrorNotify } from "@oh-my-pi/pi-coding-agent/modes/settings";
import * as speckitAuto from "@oh-my-pi/pi-coding-agent/modes/speckit-auto";
import type { SpeckitVerdict } from "@oh-my-pi/pi-coding-agent/modes/speckit-auto";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ASYNC_RESULT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type CustomMessage,
	SKILL_PROMPT_MESSAGE_TYPE,
	USER_INTERRUPT_LABEL,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const PHASE_COMMANDS = speckitAuto.SPECKIT_PHASE_COMMANDS.map(phase => `speckit.${phase}`);
const CLEAN: SpeckitVerdict = { completed: true, waits: false, routine: false };
const IMAGE: ImageContent = { type: "image", data: "", mimeType: "image/png" };
const ORIGINAL_WARP_PROTOCOL = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;

async function flush(): Promise<void> {
	for (let index = 0; index < 20; index++) await Promise.resolve();
}

describe("InteractiveMode speckit-auto mode", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let mode: InteractiveMode;
	let classify: Mock<typeof speckitAuto.classifySpeckitTurn>;
	let notify: Mock<typeof TERMINAL.sendNotification>;
	let reply: AssistantMessage | undefined;
	let clock: number;
	let submitted: SubmittedUserInput[];

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-speckit-auto-mode-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
		cfgCompletionNotify.override(settings, "on");
		cfgErrorNotify.override(settings, "on");
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
		classify = vi.spyOn(speckitAuto, "classifySpeckitTurn").mockResolvedValue(CLEAN);
		notify = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		reply = undefined;
		clock = 1_000;
		submitted = [];
	});

	afterEach(async () => {
		vi.useRealTimers();
		mode.cancelPendingSubmission();
		mode.onInputCallback?.({ text: "", cancelled: true, started: false });
		mode.stop();
		await session.dispose();
		vi.restoreAllMocks();
		resetSettingsForTest();
		if (ORIGINAL_WARP_PROTOCOL === undefined) delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
		else process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = ORIGINAL_WARP_PROTOCOL;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/** Starts the mode UI with every phase command installed; fake timers from here on. */
	async function start(): Promise<void> {
		await mode.init({ suppressWelcomeIntro: true });
		mode.fileSlashCommands = new Set(PHASE_COMMANDS);
		mode.ui.requestRender = vi.fn();
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		vi.spyOn(session, "getLastAssistantMessage").mockImplementation(() => reply);
		vi.useFakeTimers();
	}

	/** The main loop waits for the next input, which arms the tick. */
	function waitForInput(): void {
		void mode.getUserInput().then(input => submitted.push(input));
	}

	async function turnStarts(text: string): Promise<void> {
		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: ++clock,
			...(text.startsWith("/") ? { promptTemplateInput: text } : {}),
		};
		session.agent.emitExternalEvent({ type: "message_start", message });
		await flush();
	}

	/** The running turn settles with a new reply that the check reads as `verdict`. */
	function turnSettles(verdict: SpeckitVerdict = CLEAN, stopReason: AssistantMessage["stopReason"] = "stop"): void {
		classify.mockResolvedValue(verdict);
		reply = { ...createAssistantMessage("done"), stopReason, timestamp: ++clock };
		waitForInput();
	}

	/** The main loop runs a submission the mode made: its turn starts, then the submit finishes. */
	async function ownTurnRuns(input: SubmittedUserInput): Promise<void> {
		mode.markPendingSubmissionStarted(input);
		await turnStarts(input.text);
		mode.finishPendingSubmission(input);
	}

	async function tick(count = 1): Promise<void> {
		for (let index = 0; index < count; index++) {
			vi.advanceTimersByTime(800);
			await flush();
		}
	}

	async function startRun(command: string): Promise<void> {
		mode.toggleSpeckitAutoMode();
		await turnStarts(command);
	}

	const texts = (): string[] => submitted.map(input => input.text);

	function saved(): speckitAuto.SpeckitAutoState | undefined {
		const entry = session.sessionManager
			.getBranch()
			.findLast(candidate => candidate.type === "custom" && candidate.customType === speckitAuto.SPECKIT_AUTO_ENTRY);
		return speckitAuto.parseSpeckitAutoState(entry?.type === "custom" ? entry.data : undefined);
	}

	function setStreaming(value: () => boolean): void {
		Object.defineProperty(session, "isStreaming", { configurable: true, get: value });
	}

	/** omp opens a turn with its own custom message; the check reads only that turn's reply as `verdict`. */
	async function ompTurnRuns(customType: string, verdict: SpeckitVerdict): Promise<AssistantMessage> {
		session.agent.emitExternalEvent({ type: "agent_start" });
		const opener: CustomMessage = {
			role: "custom",
			customType,
			content: "Note for the agent.",
			display: true,
			attribution: "agent",
			timestamp: ++clock,
		};
		session.agent.emitExternalEvent({ type: "message_start", message: opener });
		await flush();
		const sideReply: AssistantMessage = {
			...createAssistantMessage("noted"),
			stopReason: "stop",
			timestamp: ++clock,
		};
		classify.mockImplementation(async (_phase, message) => (message === sideReply ? verdict : CLEAN));
		reply = sideReply;
		return sideReply;
	}

	describe("start timing and the guard", () => {
		it("submits the successor one tick after the decision, not before", async () => {
			await start();
			await startRun("/speckit.plan");
			turnSettles();

			await tick();
			expect(classify).toHaveBeenCalledTimes(1);
			expect(submitted).toHaveLength(0);

			await tick();
			expect(texts()).toEqual(["/speckit.tasks"]);
		});

		const guards: [string, () => () => void][] = [
			["streaming", () => flag("isStreaming")],
			["compacting", () => flag("isCompacting")],
			["retrying", () => flag("isRetrying")],
			[
				"queued message",
				() => {
					Object.defineProperty(session, "queuedMessageCount", { configurable: true, get: () => 1 });
					return () => Reflect.deleteProperty(session, "queuedMessageCount");
				},
			],
			[
				"pending async work",
				() => {
					const spy = vi.spyOn(session, "hasPendingAsyncWork").mockReturnValue(true);
					return () => spy.mockReturnValue(false);
				},
			],
			[
				"pending submission",
				() => {
					const input = mode.startPendingSubmission({ text: "typed by the user" });
					return () => mode.finishPendingSubmission(input);
				},
			],
			[
				"submit in flight",
				() => {
					mode.speckitSubmitInFlight = 1;
					return () => {
						mode.speckitSubmitInFlight = 0;
					};
				},
			],
			[
				"draft text",
				() => {
					mode.editor.setText("draft");
					return () => mode.editor.setText("");
				},
			],
			[
				"pending image",
				() => {
					mode.editor.pendingImages = [IMAGE];
					return () => {
						mode.editor.pendingImages = [];
					};
				},
			],
			[
				"open overlay",
				() => {
					const spy = vi.spyOn(mode.ui, "hasOverlay").mockReturnValue(true);
					return () => spy.mockReturnValue(false);
				},
			],
		];

		function flag(name: "isStreaming" | "isCompacting" | "isRetrying"): () => void {
			Object.defineProperty(session, name, { configurable: true, get: () => true });
			return () => Reflect.deleteProperty(session, name);
		}

		for (const [name, block] of guards) {
			it(`holds a parked start while ${name} blocks, then submits it without a new check`, async () => {
				await start();
				await startRun("/speckit.plan");
				turnSettles();
				await tick();

				const clear = block();
				await tick(3);
				expect(submitted).toHaveLength(0);

				clear();
				await tick();
				expect(texts()).toEqual(["/speckit.tasks"]);
				expect(classify).toHaveBeenCalledTimes(1);
			});
		}

		it("drops a parked start when a user turn starts and decides again after that turn settles", async () => {
			await start();
			await startRun("/speckit.plan");
			turnSettles();
			await tick();

			await turnStarts("Also cover the CLI flags.");
			await tick(3);
			expect(submitted).toHaveLength(0);

			turnSettles();
			await tick(2);
			expect(texts()).toEqual(["/speckit.tasks"]);
			expect(classify).toHaveBeenCalledTimes(2);
		});

		it("holds for the user when clarify waits for an answer", async () => {
			await start();
			await startRun("/speckit.clarify");
			turnSettles({ completed: true, waits: true, routine: false, ready: false });
			await tick(3);

			expect(submitted).toHaveLength(0);
			expect(saved()?.run?.hold?.kind).toBe("user");
		});

		it("forgets the own-turn marker after a failed own submit, so the same text from the user is a user turn", async () => {
			await start();
			await startRun("/speckit.implement");
			turnSettles({ completed: false, waits: true, routine: true });
			await tick(2);
			const [answer] = submitted;
			expect(answer.text).toBe(speckitAuto.SPECKIT_ANSWER_TEXT);

			// The submit fails before its turn starts; the main loop waits for input again.
			mode.finishPendingSubmission(answer);
			waitForInput();
			await tick();

			await turnStarts(answer.text);
			expect(saved()?.run?.autoAnswered).toBe(false);
		});

		it("drops a parked start when a user-invoked skill turn starts", async () => {
			await start();
			await startRun("/speckit.plan");
			turnSettles();
			await tick();

			const skill: CustomMessage = {
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "Run the review skill.",
				display: true,
				attribution: "user",
				timestamp: ++clock,
			};
			session.agent.emitExternalEvent({ type: "message_start", message: skill });
			await flush();
			await tick(3);
			expect(submitted).toHaveLength(0);

			turnSettles();
			await tick(2);
			expect(texts()).toEqual(["/speckit.tasks"]);
			expect(classify).toHaveBeenCalledTimes(2);
		});

		it("keeps a hold through a turn that omp starts on its own", async () => {
			await start();
			await startRun("/speckit.clarify");
			turnSettles({ completed: true, waits: true, routine: false, ready: false });
			await tick();
			expect(saved()?.run?.hold?.kind).toBe("user");

			const redirect: UserMessage = {
				role: "user",
				content: [{ type: "text", text: "Advisor: check the spec again." }],
				attribution: "agent",
				timestamp: ++clock,
			};
			session.agent.emitExternalEvent({ type: "message_start", message: redirect });
			await flush();

			expect(saved()?.run?.hold?.kind).toBe("user");
		});

		it("checks a newer reply instead of submitting a start parked before it", async () => {
			await start();
			await startRun("/speckit.plan");
			turnSettles();
			await tick();

			// A turn that continues the phase with no opener message (for example a retry) ends with an error report.
			turnSettles({ completed: false, waits: false, routine: false });
			await tick(2);

			expect(submitted).toHaveLength(0);
			expect(classify).toHaveBeenCalledTimes(2);
			expect(saved()?.run?.hold).toBeDefined();
		});

		const HELD: SpeckitVerdict = { completed: false, waits: false, routine: false };

		it("checks the phase reply, not the reply to an advisor turn that follows it", async () => {
			await start();
			await startRun("/speckit.plan");
			turnSettles();
			const phaseReply = reply;
			if (!phaseReply) throw new Error("Expected the phase reply");
			await ompTurnRuns("advisor", HELD);
			await tick(2);

			expect(classify).toHaveBeenCalledTimes(1);
			expect(classify.mock.calls[0][1]).toBe(phaseReply);
			expect(texts()).toEqual(["/speckit.tasks"]);
		});

		it("keeps a parked start through an advisor turn", async () => {
			await start();
			await startRun("/speckit.plan");
			turnSettles();
			await tick();
			await ompTurnRuns("advisor", HELD);
			await tick(2);

			expect(classify).toHaveBeenCalledTimes(1);
			expect(texts()).toEqual(["/speckit.tasks"]);
		});

		it("checks the reply of a background job wake, which finishes the phase work", async () => {
			await start();
			await startRun("/speckit.plan");
			turnSettles();
			const wakeReply = await ompTurnRuns(ASYNC_RESULT_MESSAGE_TYPE, HELD);
			await tick(2);

			expect(classify.mock.calls.at(-1)?.[1]).toBe(wakeReply);
			expect(submitted).toHaveLength(0);
			expect(saved()?.run?.hold).toBeDefined();
		});

		it("counts a settled turn that waits for its check as acting, so a pause stops the check", async () => {
			await start();
			await startRun("/speckit.plan");
			turnSettles();
			expect(mode.speckitAutoActing).toBe(true);

			mode.pauseSpeckitAuto();
			await tick(5);

			expect(classify).not.toHaveBeenCalled();
			expect(submitted).toHaveLength(0);
		});

		it("counts a remediation round only when its turn starts", async () => {
			const critical: SpeckitVerdict = { ...CLEAN, analyze: { critical: 1, high: 0 } };
			await start();
			await startRun("/speckit.analyze");
			turnSettles(critical);
			await tick();

			await turnStarts("Keep the CSV column order.");
			expect(saved()?.run?.remediationRounds).toBe(0);

			turnSettles(critical);
			await tick(2);
			expect(texts()).toEqual([speckitAuto.SPECKIT_REMEDIATION_TEXT]);
			await ownTurnRuns(submitted[0]);
			expect(saved()?.run?.remediationRounds).toBe(1);
		});

		it("re-runs analyze after a user-requested fix and counts it as a remediation round when that turn starts", async () => {
			const unreadable: SpeckitVerdict = { ...CLEAN, analyze: "unreadable" };
			await start();
			await startRun("/speckit.analyze");
			turnSettles(unreadable);
			await tick();
			// The mode's own phase command is not a user request.
			expect(classify.mock.calls.at(-1)?.[3]).toBeUndefined();

			await turnStarts("Fix the analyze findings.");
			turnSettles({ ...unreadable, fixed: true });
			await tick(2);
			expect(classify.mock.calls.at(-1)?.[3]).toBe("Fix the analyze findings.");
			expect(texts()).toEqual(["/speckit.analyze"]);
			expect(saved()?.run?.remediationRounds).toBe(0);

			await ownTurnRuns(submitted[0]);
			expect(saved()?.run?.remediationRounds).toBe(1);
			turnSettles(unreadable);
			await tick();
			expect(classify.mock.calls.at(-1)?.[3]).toBeUndefined();
		});
	});

	describe("pause, resume, next, and session state", () => {
		it("submits nothing while paused during a parked start", async () => {
			await start();
			await startRun("/speckit.plan");
			turnSettles();
			await tick();
			expect(mode.speckitAutoActing).toBe(true);

			mode.pauseSpeckitAuto();
			await tick(10);

			expect(mode.speckitAutoActing).toBe(false);
			expect(submitted).toHaveLength(0);
		});

		it("resumes an interrupted turn with the continue message and keeps the phase", async () => {
			await start();
			await startRun("/speckit.plan");
			mode.pauseSpeckitAuto();
			waitForInput();

			await mode.handleSpeckitAutoCommand("resume");
			await tick();

			expect(texts()).toEqual([speckitAuto.renderSpeckitContinue("plan")]);
			expect(classify).not.toHaveBeenCalled();
			await ownTurnRuns(submitted[0]);
			expect(saved()?.run).toMatchObject({ phase: "plan", history: ["plan"], turnOpen: true, paused: false });
		});

		it("resumes a settled turn by checking it again", async () => {
			await start();
			await startRun("/speckit.plan");
			turnSettles();
			await tick();
			mode.pauseSpeckitAuto();

			await mode.handleSpeckitAutoCommand("resume");
			await tick(2);

			expect(classify).toHaveBeenCalledTimes(2);
			expect(texts()).toEqual(["/speckit.tasks"]);
		});

		it("next stops the streaming turn and submits the successor in the same call", async () => {
			await start();
			await startRun("/speckit.plan");
			let streaming = true;
			setStreaming(() => streaming);
			const abort = vi.spyOn(session, "abort").mockImplementation(async () => {
				streaming = false;
			});
			waitForInput();

			await mode.handleSpeckitAutoCommand("next");
			await flush();

			expect(abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
			expect(texts()).toEqual(["/speckit.tasks"]);
			expect(classify).not.toHaveBeenCalled();
		});

		it("next typed in the editor submits the successor while its own submit is in flight", async () => {
			await start();
			await startRun("/speckit.plan");
			waitForInput();

			await mode.editor.onSubmit?.("/speckit-auto next");
			await flush();

			expect(texts()).toEqual(["/speckit.tasks"]);
		});

		it("next submits nothing when a user turn starts during the abort", async () => {
			await start();
			await startRun("/speckit.plan");
			let streaming = true;
			setStreaming(() => streaming);
			vi.spyOn(session, "abort").mockImplementation(async () => {
				streaming = false;
				await turnStarts("Stop, use SQLite instead.");
			});
			waitForInput();

			await mode.handleSpeckitAutoCommand("next");
			await tick(3);

			expect(submitted).toHaveLength(0);
		});

		it("restores a saved run paused and submits nothing until resume", async () => {
			session.sessionManager.appendCustomEntry(speckitAuto.SPECKIT_AUTO_ENTRY, {
				enabled: true,
				run: { ...speckitAuto.newSpeckitRun("plan", 3), turnOpen: false },
			});
			await start();
			turnSettles();
			await tick(3);

			expect(mode.speckitAutoEnabled).toBe(true);
			expect(mode.speckitAutoRunActive).toBe(false);
			expect(classify).not.toHaveBeenCalled();
			expect(submitted).toHaveLength(0);

			await mode.handleSpeckitAutoCommand("resume");
			await tick(2);
			expect(texts()).toEqual(["/speckit.tasks"]);
		});

		it("resume of a restored held run checks the latest turn again", async () => {
			session.sessionManager.appendCustomEntry(speckitAuto.SPECKIT_AUTO_ENTRY, {
				enabled: true,
				run: {
					...speckitAuto.newSpeckitRun("plan", 3),
					turnOpen: false,
					hold: { kind: "needs-you", reason: "the phase reported an error or stopped early" },
				},
			});
			await start();
			turnSettles();

			await mode.handleSpeckitAutoCommand("resume");
			await tick(2);

			expect(classify).toHaveBeenCalledTimes(1);
			expect(texts()).toEqual(["/speckit.tasks"]);
		});

		it("stops the in-memory mode on a session switch without a new entry", async () => {
			await start();
			await startRun("/speckit.plan");
			const before = session.sessionManager.getEntries().length;

			await mode.prepareSessionSwitch();
			turnSettles();
			await tick(3);

			expect(mode.speckitAutoEnabled).toBe(false);
			expect(session.sessionManager.getEntries()).toHaveLength(before);
			expect(submitted).toHaveLength(0);
		});

		it("keeps the mode on through /new, and /resume of the old session brings back its run paused", async () => {
			await start();
			await startRun("/speckit.plan");
			session.sessionManager.appendMessage({
				...createAssistantMessage("planned"),
				model: "claude-sonnet-4-5",
				timestamp: ++clock,
			});
			await session.sessionManager.flush();
			authStorage.keys.setRuntime("anthropic", "test-key");
			const oldFile = session.sessionFile;
			if (!oldFile) throw new Error("Expected a session file");

			await mode.handleClearCommand();

			expect(session.sessionFile).not.toBe(oldFile);
			expect(mode.speckitAutoEnabled).toBe(true);
			expect(saved()).toMatchObject({ enabled: true });
			expect(saved()?.run).toBeUndefined();

			await session.switchSession(oldFile);

			expect(mode.speckitAutoEnabled).toBe(true);
			expect(mode.speckitAutoRunActive).toBe(false);
			expect(saved()?.run).toMatchObject({ phase: "plan" });
		});

		it("keeps the mode on through /delete, and keeps it off through /new when it was off", async () => {
			await start();
			mode.toggleSpeckitAutoMode();
			session.sessionManager.appendMessage({ ...createAssistantMessage("hi"), timestamp: ++clock });
			await session.sessionManager.flush();

			await mode.handleDeleteCommand();
			expect(mode.speckitAutoEnabled).toBe(true);
			expect(saved()).toMatchObject({ enabled: true });

			mode.toggleSpeckitAutoMode();
			await mode.handleClearCommand();
			expect(mode.speckitAutoEnabled).toBe(false);
			expect(saved()).toBeUndefined();
		});

		it("brings back the old session's run, paused, when /new fails", async () => {
			await start();
			await startRun("/speckit.plan");
			vi.spyOn(session, "newSession").mockRejectedValue(new Error("disk full"));

			await expect(mode.handleClearCommand()).rejects.toThrow("disk full");

			expect(mode.speckitAutoEnabled).toBe(true);
			expect(mode.speckitAutoRunActive).toBe(false);
			expect(saved()?.run).toMatchObject({ phase: "plan" });
		});

		it("refuses every other mode while on", async () => {
			await start();
			mode.toggleSpeckitAutoMode();
			const warn = vi.spyOn(mode, "showWarning");

			expect(await mode.handleLoopCommand("")).toBeUndefined();
			expect(await mode.handlePlanModeCommand()).toBe(false);
			expect(await mode.handlePlanModeCommand(undefined, undefined, "debate")).toBe(false);
			expect(await mode.handleGoalModeCommand()).toBe(false);
			expect(await mode.handleGuidedGoalCommand()).toBe(false);
			expect(await mode.handleVibeModeCommand()).toBe(false);

			expect(warn).toHaveBeenCalledTimes(6);
			expect([mode.loopModeEnabled, mode.planModeEnabled, mode.goalModeEnabled, mode.vibeModeEnabled]).toEqual([
				false,
				false,
				false,
				false,
			]);
		});

		const blockers: [string, () => void][] = [
			["loop", () => (mode.loopModeEnabled = true)],
			["paused plan", () => (mode.planModePaused = true)],
			["goal", () => (mode.goalModeEnabled = true)],
			["vibe", () => (mode.vibeModeEnabled = true)],
		];
		for (const [name, block] of blockers) {
			it(`refuses to turn on while ${name} mode is on`, async () => {
				await start();
				block();
				const warn = vi.spyOn(mode, "showWarning");

				mode.toggleSpeckitAutoMode();

				expect(mode.speckitAutoEnabled).toBe(false);
				expect(warn).toHaveBeenCalledTimes(1);
			});
		}

		it("keeps the phase when the user steers a running implement turn", async () => {
			await start();
			await startRun("/speckit.implement");
			setStreaming(() => true);

			await turnStarts("Also handle Windows paths.");

			expect(saved()?.run).toMatchObject({ phase: "implement", history: ["implement"] });
		});

		it("moves to a queued phase command only when its turn starts", async () => {
			await start();
			await startRun("/speckit.plan");
			// `/speckit.tasks` typed during the plan turn waits in the queue: no turn start yet.
			Object.defineProperty(session, "queuedMessageCount", { configurable: true, get: () => 1 });
			expect(saved()?.run?.phase).toBe("plan");

			await turnStarts("/speckit.tasks");
			expect(saved()?.run).toMatchObject({ phase: "tasks", history: ["plan", "tasks"] });
		});

		it("refuses to turn on and lists only the missing phase commands", async () => {
			await start();
			mode.fileSlashCommands = new Set(PHASE_COMMANDS.filter(name => name !== "speckit.converge"));
			const warn = vi.spyOn(mode, "showWarning");

			mode.toggleSpeckitAutoMode();

			expect(mode.speckitAutoEnabled).toBe(false);
			const message = String(warn.mock.calls[0]?.[0]);
			expect(message).toContain("/speckit.converge");
			expect(message).not.toContain("/speckit.plan");
		});

		it("does nothing after a phase command while the mode is off", async () => {
			await start();
			await turnStarts("/speckit.plan");
			turnSettles();
			await tick(3);

			expect(classify).not.toHaveBeenCalled();
			expect(submitted).toHaveLength(0);
		});

		it("runs every phase to a complete end and reports the rounds", async () => {
			const summary = vi.spyOn(speckitAuto, "formatSpeckitSummary");
			await start();
			await startRun("/speckit.specify Build a CLI");
			const steps: SpeckitVerdict[] = [
				CLEAN,
				{ ...CLEAN, ready: true },
				CLEAN,
				CLEAN,
				{ ...CLEAN, analyze: { critical: 1, high: 0 } },
				CLEAN,
				{ ...CLEAN, analyze: { critical: 0, high: 2 } },
				CLEAN,
				{ ...CLEAN, converge: "added" },
				CLEAN,
			];
			for (const verdict of steps) {
				turnSettles(verdict);
				await tick(2);
				await ownTurnRuns(submitted[submitted.length - 1]);
			}
			turnSettles({ ...CLEAN, converge: "complete" });
			await tick(3);

			expect(texts()).toEqual([
				"/speckit.clarify",
				"/speckit.plan",
				"/speckit.tasks",
				"/speckit.analyze",
				speckitAuto.SPECKIT_REMEDIATION_TEXT,
				"/speckit.analyze",
				"/speckit.implement",
				"/speckit.converge",
				"/speckit.implement",
				"/speckit.converge",
			]);
			expect(summary).toHaveBeenCalledTimes(1);
			const [run, result] = summary.mock.calls[0];
			expect(result).toBe("complete");
			expect(run).toMatchObject({
				history: [
					"specify",
					"clarify",
					"plan",
					"tasks",
					"analyze",
					"remediation",
					"analyze",
					"implement",
					"converge",
					"implement",
					"converge",
				],
				remediationRounds: 1,
				convergeRounds: 1,
				convergeLimit: 3,
			});
			// One notification for the run end, none for the automatic phases.
			expect(notify).toHaveBeenCalledTimes(1);
			expect(mode.speckitAutoEnabled).toBe(true);
			expect(saved()?.run).toBeUndefined();
		});
	});

	describe("notifications", () => {
		const agentEnd = (message: AssistantMessage): Extract<AgentSessionEvent, { type: "agent_end" }> => ({
			type: "agent_end",
			messages: [message],
		});

		it("suppresses the per-turn notifications while a run is active", async () => {
			await start();
			await startRun("/speckit.plan");

			mode.eventController.sendCompletionNotification(agentEnd(createAssistantMessage("done")));
			mode.eventController.sendErrorNotification(
				agentEnd({ ...createAssistantMessage(""), stopReason: "error", errorMessage: "boom" }),
			);
			expect(notify).not.toHaveBeenCalled();

			mode.pauseSpeckitAuto();
			mode.eventController.sendCompletionNotification(agentEnd(createAssistantMessage("done")));
			expect(notify).toHaveBeenCalledTimes(1);
		});

		it("sends one notification for a hold", async () => {
			await start();
			await startRun("/speckit.clarify");
			turnSettles({ completed: true, waits: true, routine: false });
			await tick(5);

			expect(notify).toHaveBeenCalledTimes(1);
		});

		it("sends none for a hold when completion.notify is off", async () => {
			cfgCompletionNotify.override(settings, "off");
			await start();
			await startRun("/speckit.clarify");
			turnSettles({ completed: true, waits: true, routine: false });
			await tick(5);

			expect(saved()?.run?.hold?.kind).toBe("user");
			expect(notify).not.toHaveBeenCalled();
		});

		it("sends one notification for an output-limit hold", async () => {
			classify.mockRestore();
			await start();
			await startRun("/speckit.plan");
			reply = { ...createAssistantMessage("partial plan"), stopReason: "length", timestamp: ++clock };
			waitForInput();
			await tick(5);

			expect(saved()?.run?.hold?.kind).toBe("needs-you");
			expect(notify).toHaveBeenCalledTimes(1);
		});
	});
});
