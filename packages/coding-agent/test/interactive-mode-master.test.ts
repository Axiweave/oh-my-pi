/**
 * Contracts: /master toggle and `startMasterAtStartup` on InteractiveMode.
 * - Enter and exit never change the active tool set; the hidden message goes away on exit.
 * - The saved `master-mode` entry decides on resume, before the first turn.
 * - Master mode and vibe, plan (on and paused), and speckit-auto exclude each other. Goal and loop do not block it.
 * - Entry needs `async.enabled` and an async job manager.
 * - `--master` startup shows a reason and stays off when an entry check refuses.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgLoopMode, cfgSpeckitAutoDefaultOnStartup } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { SPECKIT_PHASE_COMMANDS } from "@oh-my-pi/pi-coding-agent/modes/speckit-auto";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { MASTER_MODE_CONTEXT_MESSAGE_TYPE, MASTER_MODE_ENTRY } from "@oh-my-pi/pi-coding-agent/session/master-mode";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const PHASE_COMMANDS = SPECKIT_PHASE_COMMANDS.map(phase => `speckit.${phase}`);
const ASYNC_OFF_TEXT = "Master mode needs background work. Enable async.enabled.";

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function hiddenMasterMessages(session: AgentSession): number {
	return session.agent.state.messages.filter(
		message => message.role === "custom" && message.customType === MASTER_MODE_CONTEXT_MESSAGE_TYPE,
	).length;
}

/** The saved flags, in order, of every `master-mode` entry on the session. */
function savedFlags(session: AgentSession): unknown[] {
	const flags: unknown[] = [];
	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== MASTER_MODE_ENTRY) continue;
		const data = entry.data;
		flags.push(typeof data === "object" && data !== null && "enabled" in data ? data.enabled : undefined);
	}
	return flags;
}

describe("InteractiveMode master mode", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let streamFn: StreamFn;
	let streamCalls: number;
	const opened: { session: AgentSession; mode: InteractiveMode; jobs?: AsyncJobManager }[] = [];

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-master-mode-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		VibeSessionRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		streamCalls = 0;
		streamFn = () => {
			streamCalls++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") }));
			return stream;
		};
	});

	afterEach(async () => {
		for (const { session, mode, jobs } of opened.splice(0)) {
			mode.stop();
			await session.dispose();
			await jobs?.dispose();
		}
		VibeSessionRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/** A session with `read`, `todo`, and `bash` and (unless `jobs: false`) an async job manager. */
	function open(options: { settings?: Record<string, unknown>; jobs?: boolean } = {}) {
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const names = ["read", "todo", "bash"];
		const jobs = options.jobs === false ? undefined : new AsyncJobManager({});
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: (...args) => streamFn(...args),
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(options.settings ?? {}),
			modelRegistry,
			toolRegistry: new Map(names.map(name => [name, stubTool(name)])),
			builtInToolNames: names,
			createVibeTools: () => VIBE_TOOL_NAMES.map(stubTool),
			asyncJobManager: jobs,
		});
		const mode = new InteractiveMode(session, "test", undefined, undefined, undefined, new EventBus());
		opened.push({ session, mode, jobs });
		return { session, mode };
	}

	/** Saves a session after `toggles` calls of /master and returns its file. */
	async function saveAfterToggles(toggles: number): Promise<string> {
		const { session, mode } = open();
		await mode.init({ suppressWelcomeIntro: true });
		for (let i = 0; i < toggles; i++) await mode.handleMasterModeCommand();
		await session.sessionManager.ensureOnDisk();
		const file = session.sessionFile;
		if (!file) throw new Error("Expected persisted session file");
		return file;
	}

	it("toggles with the contract messages, saves each change, and drives the status line", async () => {
		const { session, mode } = open();
		await mode.init({ suppressWelcomeIntro: true });
		const status = vi.spyOn(mode, "showStatus");
		const statusLine = vi.spyOn(mode.statusLine, "setMasterModeStatus");

		await mode.handleMasterModeCommand();
		expect(mode.masterModeEnabled).toBe(true);
		expect(session.getMasterModeState()).toEqual({ enabled: true });
		expect(status.mock.calls.at(-1)?.[0]).toStartWith("Master mode on:");
		expect(statusLine).toHaveBeenLastCalledWith({ enabled: true });

		await mode.handleMasterModeCommand();
		expect(mode.masterModeEnabled).toBe(false);
		expect(session.getMasterModeState()).toBeUndefined();
		expect(status).toHaveBeenLastCalledWith("Master mode off.");
		expect(statusLine).toHaveBeenLastCalledWith(null);

		expect(savedFlags(session)).toEqual([true, false]);
	});

	it("leaves the active tool names unchanged across enter and exit, and removes the hidden message", async () => {
		const { session, mode } = open();
		await mode.init({ suppressWelcomeIntro: true });
		await session.setActiveToolsByName(["read", "todo", "bash"]);
		const active = session.getActiveToolNames();
		const all = session.getAllToolNames();

		await mode.handleMasterModeCommand();
		expect(session.getActiveToolNames()).toEqual(active);
		expect(session.getAllToolNames()).toEqual(all);
		await session.prompt("one");
		expect(hiddenMasterMessages(session)).toBe(1);

		await mode.handleMasterModeCommand();
		expect(session.getActiveToolNames()).toEqual(active);
		expect(session.getAllToolNames()).toEqual(all);
		expect(hiddenMasterMessages(session)).toBe(0);
		await session.prompt("two");
		expect(hiddenMasterMessages(session)).toBe(0);
	});

	describe("resume", () => {
		// Each row: how often /master was typed in the saved session, and the mode after resume.
		const rows: [toggles: number, on: boolean][] = [
			[0, false],
			[1, true],
			[2, false],
			[3, true],
		];
		for (const [toggles, on] of rows) {
			it(`after ${toggles} toggle(s) in the saved session the mode is ${on ? "on" : "off"} before the first turn`, async () => {
				const file = await saveAfterToggles(toggles);
				const { session, mode } = open();
				await mode.init({ suppressWelcomeIntro: true });
				expect(await session.switchSession(file)).toBe(true);

				expect(mode.masterModeEnabled).toBe(on);
				expect(session.getMasterModeState()).toEqual(on ? { enabled: true } : undefined);
				expect(streamCalls).toBe(0);
			});
		}

		it("turns the mode off on /new", async () => {
			const { session, mode } = open();
			await mode.init({ suppressWelcomeIntro: true });
			await mode.handleMasterModeCommand();
			expect(mode.masterModeEnabled).toBe(true);

			await session.newSession();

			expect(mode.masterModeEnabled).toBe(false);
			expect(session.getMasterModeState()).toBeUndefined();
		});
	});

	describe("exclusion", () => {
		const blockers: [string, (mode: InteractiveMode) => Promise<void> | void, string][] = [
			[
				"speckit-auto",
				mode => void (mode.speckitAutoEnabled = true),
				"Turn off speckit-auto mode first (/speckit-auto-mode).",
			],
			["plan", mode => void (mode.planModeEnabled = true), "Exit plan mode first."],
			[
				"paused plan",
				mode => void (mode.planModePaused = true),
				"Plan mode is paused — run /plan again to fully exit.",
			],
			["vibe", async mode => void (await mode.handleVibeModeCommand()), "Exit vibe mode first."],
		];
		for (const [name, block, warning] of blockers) {
			it(`${name} blocks entry`, async () => {
				const { session, mode } = open();
				await mode.init({ suppressWelcomeIntro: true });
				await block(mode);
				const warn = vi.spyOn(mode, "showWarning");

				await mode.handleMasterModeCommand();

				expect(warn).toHaveBeenCalledWith(warning);
				expect(mode.masterModeEnabled).toBe(false);
				expect(session.getMasterModeState()).toBeUndefined();
				expect(savedFlags(session)).toEqual([]);
			});
		}

		it("master blocks vibe, plan, debate, and speckit-auto", async () => {
			const { session, mode } = open();
			await mode.init({ suppressWelcomeIntro: true });
			mode.fileSlashCommands = new Set(PHASE_COMMANDS);
			await mode.handleMasterModeCommand();
			const warn = vi.spyOn(mode, "showWarning");

			expect(await mode.handleVibeModeCommand()).toBe(false);
			expect(await mode.handlePlanModeCommand()).toBe(false);
			expect(await mode.handlePlanModeCommand(undefined, undefined, "debate")).toBe(false);
			expect(mode.setSpeckitAutoMode("full")).toBe(false);

			expect(warn.mock.calls).toEqual(Array.from({ length: 4 }, () => ["Exit master mode first."]));
			expect([mode.vibeModeEnabled, mode.planModeEnabled, mode.speckitAutoEnabled]).toEqual([false, false, false]);
			expect(session.getMasterModeState()).toEqual({ enabled: true });
		});

		it("goal mode and loop mode do not block entry", async () => {
			const { mode } = open();
			await mode.init({ suppressWelcomeIntro: true });
			mode.goalModeEnabled = true;
			mode.loopModeEnabled = true;
			try {
				await mode.handleMasterModeCommand();
				expect(mode.masterModeEnabled).toBe(true);
			} finally {
				mode.goalModeEnabled = false;
				mode.loopModeEnabled = false;
			}
		});
	});

	describe("entry needs background work", () => {
		const cases: [string, Parameters<typeof open>[0]][] = [
			["async.enabled is off", { settings: { "async.enabled": false } }],
			["the session has no async job manager", { jobs: false }],
		];
		for (const [name, options] of cases) {
			it(`is refused when ${name}`, async () => {
				const { session, mode } = open(options);
				await mode.init({ suppressWelcomeIntro: true });
				const warn = vi.spyOn(mode, "showWarning");

				await mode.handleMasterModeCommand();

				expect(warn).toHaveBeenCalledWith(ASYNC_OFF_TEXT);
				expect(mode.masterModeEnabled).toBe(false);
				expect(savedFlags(session)).toEqual([]);
			});
		}
	});

	it("refuses a reset loop under master mode and disables the loop", async () => {
		vi.useFakeTimers();
		try {
			const { mode } = open();
			await mode.init({ suppressWelcomeIntro: true });
			mode.ui.requestRender = vi.fn();
			vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
			vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
			cfgLoopMode.set(settings, "reset");
			await mode.handleMasterModeCommand();
			mode.loopModeEnabled = true;
			mode.loopPrompt = "do not resubmit";
			const showStatus = vi.spyOn(mode, "showStatus");
			const resolved: unknown[] = [];
			const pending = mode.getUserInput();
			void pending.then(input => resolved.push(input));

			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(resolved).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(false);
			expect(showStatus).toHaveBeenCalledWith("Exit master mode before using reset loops. Loop mode disabled.");
			mode.onInputCallback?.({ text: "", cancelled: true, started: false });
			await pending;
		} finally {
			vi.useRealTimers();
			cfgLoopMode.set(settings, "prompt");
		}
	});

	describe("startMasterAtStartup", () => {
		it("turns the mode on before the first prompt, and the first turn carries the message", async () => {
			const { session, mode } = open();
			await mode.init({ suppressWelcomeIntro: true });

			await mode.startMasterAtStartup(false);

			expect(mode.masterModeEnabled).toBe(true);
			expect(session.getMasterModeState()).toEqual({ enabled: true });
			expect(streamCalls).toBe(0);
			await session.prompt("first");
			expect(hiddenMasterMessages(session)).toBe(1);
		});

		it("does nothing on a resumed master session", async () => {
			const file = await saveAfterToggles(1);
			const { session, mode } = open();
			await mode.init({ suppressWelcomeIntro: true });
			expect(await session.switchSession(file)).toBe(true);
			const status = vi.spyOn(mode, "showStatus");
			const warn = vi.spyOn(mode, "showWarning");
			const saved = savedFlags(session);

			await mode.startMasterAtStartup(false);

			expect(mode.masterModeEnabled).toBe(true);
			expect(status).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
			expect(savedFlags(session)).toEqual(saved);
		});

		const refusals: [string, Parameters<typeof open>[0], (mode: InteractiveMode) => void, boolean, string][] = [
			["async.enabled is off", { settings: { "async.enabled": false } }, () => {}, false, ASYNC_OFF_TEXT],
			["plan mode is on", {}, mode => void (mode.planModeEnabled = true), false, "Exit plan mode first."],
			["--plan-yolo starts plan mode", {}, () => {}, true, "Master mode stays off: --plan-yolo starts plan mode."],
		];
		for (const [name, options, setup, planYolo, warning] of refusals) {
			it(`shows a reason and stays off when ${name}`, async () => {
				const { session, mode } = open(options);
				await mode.init({ suppressWelcomeIntro: true });
				setup(mode);
				const warn = vi.spyOn(mode, "showWarning");

				await mode.startMasterAtStartup(planYolo);

				expect(warn).toHaveBeenCalledWith(warning);
				expect(mode.masterModeEnabled).toBe(false);
				expect(session.getMasterModeState()).toBeUndefined();
				expect(savedFlags(session)).toEqual([]);
			});
		}

		it("wins over a speckit-auto startup default", async () => {
			const { session, mode } = open();
			cfgSpeckitAutoDefaultOnStartup.override(session.settings, "full");
			session.setSlashCommands(
				PHASE_COMMANDS.map(name => ({ name, description: name, content: "", source: "test" })),
			);

			await mode.init({ suppressWelcomeIntro: true, startupBlocker: "master" });
			expect(mode.speckitAutoEnabled).toBe(false);
			await mode.startMasterAtStartup(false);

			expect(mode.masterModeEnabled).toBe(true);
			expect(mode.speckitAutoEnabled).toBe(false);
		});
	});
});
