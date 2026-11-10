import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import * as loopCondition from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import { createLoopLimitRuntime } from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import type { LoopConditionVerdict } from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgLoopMode } from "@oh-my-pi/pi-coding-agent/modes/settings";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("InteractiveMode loop auto-submit", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let pendingInput: Promise<SubmittedUserInput> | undefined;

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-loop-auto-submit-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	beforeEach(() => {
		cfgLoopMode.set(settings, "prompt");
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode.disableLoopMode("Loop mode disabled.");
		mode.cancelPendingSubmission();
		if (mode.onInputCallback) {
			mode.onInputCallback({ text: "", cancelled: true, started: false });
		}
		await pendingInput;
		pendingInput = undefined;
		mode.vibeModeEnabled = false;
		session.setVibeModeState(undefined);
		Reflect.deleteProperty(session, "isCompacting");
		Reflect.deleteProperty(session, "isStreaming");
		Reflect.deleteProperty(session, "hasPostPromptWork");
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode.stop();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("does not resolve the next loop prompt while compaction is running", async () => {
		vi.useFakeTimers();
		let compacting = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => compacting });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat this";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		compacting = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat this");
	});

	it("does not recompact when a compact loop turn starts another prompt before resubmitting", async () => {
		vi.useFakeTimers();
		cfgLoopMode.set(settings, "compact");
		let streaming = false;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		const compact = vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
			streaming = true;
			return "ok";
		});

		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat after compact";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(compact).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(0);

		streaming = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(compact).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat after compact");
	});

	it("does not resolve the next loop prompt while post-prompt background work is pending", async () => {
		vi.useFakeTimers();
		let hasPendingWork = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => hasPendingWork });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "deliver this";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		// Loop timer fires while an idle-flush / delivery turn is still pending.
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		// Background delivery completes; loop may now fire.
		hasPendingWork = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("deliver this");
	});

	it("disables reset loops when vibe blocks the session transition", async () => {
		vi.useFakeTimers();
		cfgLoopMode.set(settings, "reset");
		mode.vibeModeEnabled = true;
		mode.loopModeEnabled = true;
		mode.loopPrompt = "do not resubmit";
		const showStatus = vi.spyOn(mode, "showStatus");
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(0);
		expect(mode.loopModeEnabled).toBe(false);
		expect(mode.loopPrompt).toBeUndefined();
		expect(showStatus).toHaveBeenCalledWith("Exit vibe mode before using reset loops. Loop mode disabled.");
	});

	it("reports waiting, running, paused, resumed, and disabled loop states", async () => {
		const setLoopModeStatus = vi.spyOn(mode.statusLine, "setLoopModeStatus");

		await mode.handleLoopCommand("3");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "waiting",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.setLoopPrompt("repeat this");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "running",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.pauseLoop();
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "paused",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.setLoopPrompt("resume this");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "running",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.disableLoopMode();
		expect(setLoopModeStatus).toHaveBeenLastCalledWith(undefined);
	});

	describe("continue condition", () => {
		function idleSession(): void {
			Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
			Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => false });
		}

		function armLoop(prompt: string): SubmittedUserInput[] {
			const resolved: SubmittedUserInput[] = [];
			mode.loopModeEnabled = true;
			mode.loopPrompt = prompt;
			pendingInput = mode.getUserInput();
			void pendingInput.then(input => resolved.push(input));
			return resolved;
		}

		it("submits the next iteration when the condition says continue", async () => {
			vi.useFakeTimers();
			idleSession();
			const evaluate = vi.spyOn(loopCondition, "evaluateLoopCondition").mockResolvedValue({ kind: "continue" });
			mode.loopCondition = { command: "test -f GO", until: false };

			const resolved = armLoop("keep going");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(evaluate).toHaveBeenCalledTimes(1);
			expect(evaluate.mock.calls[0][0]).toEqual({ command: "test -f GO", until: false });
			expect(resolved).toHaveLength(1);
			expect(resolved[0].text).toBe("keep going");
			expect(mode.loopModeEnabled).toBe(true);
		});

		it("disables the loop and submits nothing when the condition says halt", async () => {
			vi.useFakeTimers();
			idleSession();
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockResolvedValue({
				kind: "halt",
				message: "Loop condition `bun test` is now satisfied. Loop mode disabled.",
			});
			const showStatus = vi.spyOn(mode, "showStatus");
			mode.loopCondition = { command: "bun test", until: true };

			const resolved = armLoop("fix the tests");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(resolved).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(false);
			expect(showStatus).toHaveBeenCalledWith("Loop condition `bun test` is now satisfied. Loop mode disabled.");
		});

		// A halted iteration never ran, so it must not spend the user's budget:
		// `/loop 3 --until ...` that stops early should still report 3 remaining.
		it("does not consume the iteration budget when the condition halts", async () => {
			vi.useFakeTimers();
			idleSession();
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockResolvedValue({ kind: "halt", message: "stop" });
			mode.loopCondition = { command: "bun test", until: true };
			const limit = { kind: "iterations", initial: 3, remaining: 3 } as const;
			mode.loopLimit = { ...limit };
			const observed = mode.loopLimit;

			armLoop("fix the tests");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(observed).toEqual(limit);
		});

		// Esc between iterations must kill the child process and skip the
		// iteration without tearing down loop mode, and the late verdict that
		// arrives afterwards must not resurrect the cancelled iteration.
		it("aborts an in-flight condition on pause and ignores its late verdict", async () => {
			vi.useFakeTimers();
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			let captured: AbortSignal | undefined;
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async (_condition, options) => {
				captured = options.signal;
				return await pending.promise;
			});
			mode.loopCondition = { command: "sleep 30", until: false };

			const resolved = armLoop("keep going");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(captured?.aborted).toBe(false);

			mode.pauseLoop();
			expect(captured?.aborted).toBe(true);
			expect(mode.loopModeEnabled).toBe(true);
			expect(mode.loopModePaused).toBe(true);

			pending.resolve({ kind: "continue" });
			await flushMicrotasks();

			expect(resolved).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(true);
		});

		// A manual submit while the gate is still running supersedes it: the
		// stale-verdict guard alone would let a `sleep 30`-style condition (or a
		// mutating command) keep running concurrently with the replacement turn
		// for up to the configured timeout instead of being killed immediately.
		it("aborts an in-flight condition as soon as a manual prompt supersedes it", async () => {
			vi.useFakeTimers();
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			let captured: AbortSignal | undefined;
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async (_condition, options) => {
				captured = options.signal;
				return await pending.promise;
			});
			mode.loopCondition = { command: "sleep 30", until: false };

			armLoop("keep going");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(captured?.aborted).toBe(false);

			mode.setLoopPrompt("a different manual prompt");
			expect(captured?.aborted).toBe(true);
		});

		// A manual submit that happens to repeat the current loop prompt still
		// supersedes the pending gate: an equality check on the prompt text alone
		// would leave a `sleep 30`-style condition running concurrently with the
		// resubmitted turn instead of aborting it immediately.
		it("aborts an in-flight condition when the manual submission repeats the loop prompt", async () => {
			vi.useFakeTimers();
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			let captured: AbortSignal | undefined;
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async (_condition, options) => {
				captured = options.signal;
				return await pending.promise;
			});
			mode.loopCondition = { command: "sleep 30", until: false };

			armLoop("keep going");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(captured?.aborted).toBe(false);

			mode.setLoopPrompt("keep going");
			expect(captured?.aborted).toBe(true);
		});

		// /vibe enabled while the gate is awaiting must kill a reset loop: the
		// pre-gate guard is stale by then, and handleClearCommand would only
		// warn while the iteration still submitted without resetting. Goes
		// through the real /vibe command so the vibeModeEnabled transition is
		// exercised instead of assigned directly.
		it("disables a reset loop when vibe is enabled while the condition is in flight", async () => {
			vi.useFakeTimers();
			cfgLoopMode.set(settings, "reset");
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async () => await pending.promise);
			const clear = vi.spyOn(mode, "handleClearCommand");
			const showStatus = vi.spyOn(mode, "showStatus");
			vi.spyOn(session, "activateVibeTools").mockResolvedValue();
			mode.loopCondition = { command: "sleep 30", until: false };

			const resolved = armLoop("reset me");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			await mode.handleVibeModeCommand();
			expect(mode.vibeModeEnabled).toBe(true);
			pending.resolve({ kind: "continue" });
			await flushMicrotasks();

			expect(clear).not.toHaveBeenCalled();
			expect(resolved).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(false);
			expect(mode.loopPrompt).toBeUndefined();
			expect(showStatus).toHaveBeenCalledWith("Exit vibe mode before using reset loops. Loop mode disabled.");
		});

		// The condition can resolve while /vibe tool activation is still in
		// flight: vibeModeEnabled is still false, but the reset must not run
		// concurrently with the toolset switch. The loop must disable on the
		// entering transition, not just the settled flag.
		it("disables a reset loop when the condition resolves during vibe activation", async () => {
			vi.useFakeTimers();
			cfgLoopMode.set(settings, "reset");
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async () => await pending.promise);
			const clear = vi.spyOn(mode, "handleClearCommand");
			const showStatus = vi.spyOn(mode, "showStatus");
			const vibeGate = Promise.withResolvers<void>();
			vi.spyOn(session, "activateVibeTools").mockImplementation(() => vibeGate.promise);
			mode.loopCondition = { command: "sleep 30", until: false };

			const resolved = armLoop("reset me");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			const vibeEnter = mode.handleVibeModeCommand();
			await flushMicrotasks();
			expect(mode.vibeModeEnabled).toBe(false);

			pending.resolve({ kind: "continue" });
			await flushMicrotasks();

			expect(clear).not.toHaveBeenCalled();
			expect(resolved).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(false);
			expect(mode.loopPrompt).toBeUndefined();
			expect(showStatus).toHaveBeenCalledWith("Exit vibe mode before using reset loops. Loop mode disabled.");

			vibeGate.resolve();
			await vibeEnter;
			expect(mode.vibeModeEnabled).toBe(true);
		});
	});

	it("resubmits a /skill: prompt dispatched inline by the submit handler", async () => {
		vi.useFakeTimers();
		const skillPath = path.join(tempDir.path(), "recap.md");
		await Bun.write(skillPath, "---\nname: recap\n---\nSummarize recent changes.\n");
		mode.skillCommands.set("skill:recap", {
			name: "recap",
			description: "",
			filePath: skillPath,
			baseDir: tempDir.path(),
			source: "test",
		});
		new InputController(mode).setupEditorSubmitHandler();
		const promptCustomMessage = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(true);
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });

		mode.disableLoopMode();
		mode.loopModeEnabled = true;
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		await mode.editor.onSubmit?.("/skill:recap go");

		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		expect(mode.loopPrompt).toBe("/skill:recap go");
		expect(resolved).toHaveLength(0);

		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("/skill:recap go");
		mode.skillCommands.delete("skill:recap");
	});

	it("paints no optimistic user row for a resubmitted /skill: loop prompt", async () => {
		vi.useFakeTimers();
		const skillPath = path.join(tempDir.path(), "recap.md");
		await Bun.write(skillPath, "---\nname: recap\n---\nSummarize recent changes.\n");
		mode.skillCommands.set("skill:recap", {
			name: "recap",
			description: "",
			filePath: skillPath,
			baseDir: tempDir.path(),
			source: "test",
		});
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "/skill:recap go";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("/skill:recap go");
		// A plain loop prompt paints one; the skill row comes from the dispatched
		// custom message instead.
		expect(mode.addMessageToChat).not.toHaveBeenCalled();
		mode.skillCommands.delete("skill:recap");
	});

	it("paints an optimistic user row for a resubmitted plain loop prompt", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat this";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(mode.addMessageToChat).toHaveBeenCalledTimes(1);
	});

	describe("every interval", () => {
		const MINUTE = 60_000;
		let streaming = false;
		let runs: { text: string; at: number }[] = [];

		beforeEach(() => {
			vi.useFakeTimers();
			streaming = false;
			runs = [];
			Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
			Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => false });
		});

		afterEach(() => {
			setSystemTime();
			mode.editor.setText("");
			mode.editor.pendingImages = [];
		});

		// The run loop calls getUserInput once each turn ends; record when each run is submitted.
		function waitForRun(): void {
			pendingInput = mode.getUserInput();
			void pendingInput.then(input => runs.push({ text: input.text, at: Date.now() }));
		}

		async function advance(ms: number): Promise<void> {
			vi.advanceTimersByTime(ms);
			await flushMicrotasks();
		}

		function startIntervalLoop(intervalMs: number, prompt = "tick"): number {
			mode.loopModeEnabled = true;
			mode.loopIntervalMs = intervalMs;
			mode.setLoopPrompt(prompt);
			return Date.now();
		}

		const GAP_SEED = 0x6a9;
		it(`starts each run exactly one interval after the previous run started (seed ${GAP_SEED})`, async () => {
			let state = GAP_SEED;
			let lastStart = startIntervalLoop(MINUTE);
			for (let i = 0; i < 5; i++) {
				state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
				const turnMs = state % 59_000;
				streaming = true;
				await advance(turnMs);
				streaming = false;
				waitForRun();
				await advance(lastStart + MINUTE - Date.now() - 1);
				expect({ turnMs, runs: runs.length }).toEqual({ turnMs, runs: i });
				await advance(1);
				expect({ turnMs, runs: runs.length, gap: runs[i]?.at - lastStart }).toEqual({
					turnMs,
					runs: i + 1,
					gap: MINUTE,
				});
				lastStart = runs[i].at;
			}
		});

		it("runs once, 800 ms after idle, when a turn outlasts the interval, and never while busy", async () => {
			startIntervalLoop(MINUTE);
			streaming = true;
			await advance(90_000);
			streaming = false;
			waitForRun();
			await advance(799);
			expect(runs).toHaveLength(0);
			await advance(1);
			expect(runs).toHaveLength(1);

			// Armed while the next turn still runs: due passes ten times over, nothing runs.
			streaming = true;
			waitForRun();
			await advance(10 * MINUTE);
			expect(runs).toHaveLength(1);
			streaming = false;
			await advance(800);
			expect(runs).toHaveLength(2);
			await advance(10 * MINUTE);
			expect(runs).toHaveLength(2);
		});

		it("runs once right after a wall-clock jump past the due time (system sleep)", async () => {
			startIntervalLoop(15 * MINUTE);
			waitForRun();
			setSystemTime(new Date(Date.now() + 20 * MINUTE));
			await advance(1_000);
			expect(runs).toHaveLength(1);
		});

		it.each([
			["with", MINUTE],
			["without", undefined],
		])("keeps the draft text and images when a loop run starts %s an interval", async (_label, intervalMs) => {
			const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
			mode.editor.setText("draft");
			mode.editor.pendingImages = [image];
			startIntervalLoop(intervalMs as number);
			waitForRun();
			await advance(MINUTE);
			expect(runs).toHaveLength(1);
			expect(mode.editor.getText()).toBe("draft");
			expect(mode.editor.pendingImages).toEqual([image]);
		});

		it("keeps the 800 ms resubmit without an interval", async () => {
			mode.loopModeEnabled = true;
			mode.setLoopPrompt("tick");
			waitForRun();
			await advance(799);
			expect(runs).toHaveLength(0);
			await advance(1);
			expect(runs).toHaveLength(1);
		});

		it("stops after the count limit, with every run on schedule and no extra wait", async () => {
			const showStatus = vi.spyOn(mode, "showStatus");
			mode.loopLimit = createLoopLimitRuntime({ kind: "iterations", iterations: 2 });
			const start = startIntervalLoop(MINUTE);
			for (let i = 0; i < 2; i++) {
				waitForRun();
				await advance(MINUTE);
			}
			expect(runs.map(run => run.at - start)).toEqual([MINUTE, 2 * MINUTE]);
			// The budget is spent: the loop ends on the next tick, not one interval later.
			waitForRun();
			await advance(800);
			expect(runs).toHaveLength(2);
			expect(mode.loopModeEnabled).toBe(false);
			expect(showStatus).toHaveBeenCalledWith("Loop limit reached. Loop mode disabled.");
		});

		it("stops at the time limit, with every run on schedule", async () => {
			mode.loopLimit = createLoopLimitRuntime({ kind: "duration", durationMs: 60 * MINUTE });
			const start = startIntervalLoop(15 * MINUTE);
			for (let i = 0; i < 4; i++) {
				waitForRun();
				await advance(15 * MINUTE);
			}
			expect(runs.map(run => run.at - start)).toEqual([15 * MINUTE, 30 * MINUTE, 45 * MINUTE]);
			expect(mode.loopModeEnabled).toBe(false);
		});

		it("checks the condition at each due time, not when the wait starts", async () => {
			const checkedAt: number[] = [];
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async () => {
				checkedAt.push(Date.now());
				return { kind: "continue" };
			});
			mode.loopCondition = { command: "true", until: false };
			const start = startIntervalLoop(MINUTE);
			for (let i = 0; i < 3; i++) {
				waitForRun();
				await advance(MINUTE);
			}
			expect(checkedAt.map(at => at - start)).toEqual([MINUTE, 2 * MINUTE, 3 * MINUTE]);
			expect(runs).toHaveLength(3);
		});

		it("compacts once for each due run and never during the wait", async () => {
			cfgLoopMode.set(settings, "compact");
			const compact = vi.spyOn(mode, "handleCompactCommand").mockResolvedValue("ok");
			startIntervalLoop(MINUTE);
			waitForRun();
			await advance(MINUTE - 1);
			expect(compact).not.toHaveBeenCalled();
			await advance(1);
			expect(compact).toHaveBeenCalledTimes(1);
			expect(runs).toHaveLength(1);
		});

		describe("replace and status", () => {
			it("keeps the prompt and moves the due time", async () => {
				const start = startIntervalLoop(MINUTE);
				waitForRun();
				await advance(10_000);
				expect(await mode.handleLoopCommand("every 120s")).toBeUndefined();
				expect(mode.loopPrompt).toBe("tick");
				await advance(start + 2 * MINUTE - Date.now() - 1);
				expect(runs).toHaveLength(0);
				await advance(1);
				expect(runs).toEqual([{ text: "tick", at: start + 2 * MINUTE }]);
			});

			it("hands a new prompt back to the dispatcher", async () => {
				startIntervalLoop(MINUTE);
				expect(await mode.handleLoopCommand("every 30s other")).toBe("other");
				expect(mode.loopIntervalMs).toBe(30_000);
			});

			it("every +<duration> runs nothing now and the first run one interval later", async () => {
				const start = Date.now();
				waitForRun();
				expect(await mode.handleLoopCommand("every +60s tick")).toBeUndefined();
				expect(mode.loopPrompt).toBe("tick");
				await advance(MINUTE - 1);
				expect(runs).toHaveLength(0);
				await advance(1);
				expect(runs).toEqual([{ text: "tick", at: start + MINUTE }]);
			});

			it("changes nothing on an invalid replace", async () => {
				vi.spyOn(mode, "showError").mockImplementation(() => {});
				mode.loopLimit = createLoopLimitRuntime({ kind: "iterations", iterations: 5 });
				const start = startIntervalLoop(MINUTE);
				const limit = mode.loopLimit;
				waitForRun();
				expect(await mode.handleLoopCommand("every 1.5h")).toBeUndefined();
				expect(mode.showError).toHaveBeenCalledTimes(1);
				expect({ on: mode.loopModeEnabled, prompt: mode.loopPrompt, interval: mode.loopIntervalMs }).toEqual({
					on: true,
					prompt: "tick",
					interval: MINUTE,
				});
				expect(mode.loopLimit).toBe(limit);
				await advance(MINUTE);
				expect(runs).toEqual([{ text: "tick", at: start + MINUTE }]);
			});

			it("clears the parts that the replace leaves out", async () => {
				await mode.handleLoopCommand("3 every 60s --until 'x'");
				expect(await mode.handleLoopCommand("every 60s")).toBeUndefined();
				expect(mode.loopLimit).toBeUndefined();
				expect(mode.loopCondition).toBeUndefined();
				expect(mode.loopIntervalMs).toBe(MINUTE);
			});

			it("turns the loop off on a bare /loop", async () => {
				startIntervalLoop(MINUTE);
				await mode.handleLoopCommand("");
				expect(mode.loopModeEnabled).toBe(false);
				expect(mode.loopIntervalMs).toBeUndefined();
			});

			it("arms nothing for a replace during a turn; the turn end arms the new interval", async () => {
				const setLoopModeStatus = vi.spyOn(mode.statusLine, "setLoopModeStatus");
				const start = startIntervalLoop(MINUTE);
				streaming = true;
				await mode.handleLoopCommand("every 120s");
				expect(setLoopModeStatus.mock.lastCall?.[0]?.nextRunAt).toBeUndefined();
				await advance(30_000);
				streaming = false;
				waitForRun();
				await advance(start + 2 * MINUTE - Date.now());
				expect(runs).toEqual([{ text: "tick", at: start + 2 * MINUTE }]);
			});

			it("does not run after Esc pauses the wait", async () => {
				startIntervalLoop(MINUTE);
				waitForRun();
				await advance(10_000);
				mode.pauseLoop();
				await advance(5 * MINUTE);
				expect(runs).toHaveLength(0);
			});

			it("restarts the schedule from a new /loop prompt sent during the wait", async () => {
				const start = startIntervalLoop(MINUTE);
				waitForRun();
				await advance(20_000);
				mode.setLoopPrompt("new");
				mode.onInputCallback?.({ text: "new", cancelled: false, started: false });
				waitForRun();
				await advance(MINUTE - 1);
				expect(runs).toHaveLength(1);
				await advance(1);
				expect(runs[1]).toEqual({ text: "new", at: start + 20_000 + MINUTE });
			});

			it("runs a prompt typed during the wait once and keeps the loop prompt", async () => {
				new InputController(mode).setupEditorSubmitHandler();
				const start = startIntervalLoop(MINUTE);
				waitForRun();
				await advance(20_000);
				await mode.editor.onSubmit?.("side question");
				expect(mode.loopPrompt).toBe("tick");
				waitForRun();
				await advance(start + MINUTE - Date.now());
				expect(runs.map(run => run.text)).toEqual(["side question", "tick"]);
			});

			it("keeps the loop prompt through Esc; a typed prompt does not resume it, /loop with args does", async () => {
				new InputController(mode).setupEditorSubmitHandler();
				startIntervalLoop(MINUTE);
				waitForRun();
				mode.pauseLoop();
				await mode.editor.onSubmit?.("hello");
				expect({ prompt: mode.loopPrompt, paused: mode.loopModePaused }).toEqual({ prompt: "tick", paused: true });
				waitForRun();
				await advance(5 * MINUTE);
				expect(runs.map(run => run.text)).toEqual(["hello"]);
				expect(await mode.handleLoopCommand("every 60s")).toBeUndefined();
				await advance(800);
				expect(runs.map(run => run.text)).toEqual(["hello", "tick"]);
			});

			it("keeps a reset loop running across the new session of its own reset", async () => {
				cfgLoopMode.set(settings, "reset");
				const clear = vi.spyOn(mode, "handleClearCommand").mockImplementation(async () => {
					await session.newSession();
				});
				const sessionId = session.sessionManager.getSessionId();
				mode.loopModeEnabled = true;
				mode.setLoopPrompt("tick");
				waitForRun();
				await advance(800);
				expect(clear).toHaveBeenCalledTimes(1);
				await clear.mock.results[0]?.value;
				await advance(0);
				expect(session.sessionManager.getSessionId()).not.toBe(sessionId);
				expect(mode.loopModeEnabled).toBe(true);
				expect(runs.map(run => run.text)).toEqual(["tick"]);
			});

			it("pauses a reset loop and runs nothing when a hook cancels the reset", async () => {
				cfgLoopMode.set(settings, "reset");
				// A cancelled newSession keeps the session id.
				const clear = vi.spyOn(mode, "handleClearCommand").mockResolvedValue();
				const showStatus = vi.spyOn(mode, "showStatus");
				mode.loopModeEnabled = true;
				mode.setLoopPrompt("tick");
				waitForRun();
				await advance(800);
				await advance(0);
				expect(clear).toHaveBeenCalledTimes(1);
				expect(runs).toEqual([]);
				expect(mode.loopModePaused).toBe(true);
				expect(mode.loopPrompt).toBe("tick");
				expect(showStatus).toHaveBeenCalledWith(
					"Loop paused: the session reset was cancelled. /loop with arguments resumes it.",
				);
				await advance(5 * MINUTE);
				expect(runs).toEqual([]);
			});

			it("starts no run while a session switch is pending", async () => {
				// Hold a real newSession open after its transition starts.
				const held = Promise.withResolvers<void>();
				vi.spyOn(session, "abort").mockImplementation(() => held.promise);
				mode.loopModeEnabled = true;
				mode.setLoopPrompt("tick");
				waitForRun();
				const switching = session.newSession();
				expect(session.isSessionTransitioning).toBe(true);
				await advance(5_000);
				expect(runs).toEqual([]);
				expect(mode.loopModeEnabled).toBe(true);
				held.resolve();
				await switching;
				await advance(5_000);
				expect(mode.loopModeEnabled).toBe(false);
				expect(runs).toEqual([]);
			});

			// Model check over generated command sequences. Invariants after every step:
			// the loop prompt changes only on enable, disable, the first prompt while the
			// loop waits, or `/loop … <prompt>`; a disabled loop has no prompt; Esc keeps
			// the prompt; a scheduled run sends exactly the loop prompt, and only when the
			// loop is on, not paused, and has a prompt.
			const MODEL_SEED = 0x10091;
			const OP_KINDS = [
				"typed",
				"skill",
				"steer",
				"esc",
				"loopPrompt",
				"loopArgs",
				"bareLoop",
				"switch",
				"cancelledSwitch",
				"tick",
			] as const;
			type Op = { kind: (typeof OP_KINDS)[number]; text: string };

			async function resetLoop(): Promise<void> {
				mode.disableLoopMode();
				mode.onInputCallback?.({ text: "", cancelled: true, started: false });
				await pendingInput;
				vi.clearAllTimers();
				streaming = false;
				runs = [];
			}

			/** Runs `ops` from a disabled loop; returns the first broken invariant, if any. */
			async function checkOps(ops: Op[]): Promise<string | undefined> {
				await resetLoop();
				const model = { enabled: false, prompt: undefined as string | undefined, paused: false };
				for (const [step, op] of ops.entries()) {
					if (!mode.onInputCallback) waitForRun();
					const before = runs.length;
					switch (op.kind) {
						case "typed":
						case "skill":
							await mode.editor.onSubmit?.(op.text);
							if (model.enabled && model.prompt === undefined && !model.paused) model.prompt = op.text;
							break;
						case "steer":
							streaming = true;
							await mode.editor.onSubmit?.(op.text);
							streaming = false;
							break;
						case "esc":
							if (mode.loopModeEnabled) mode.pauseLoop();
							if (model.enabled) model.paused = true;
							break;
						case "loopPrompt":
							await mode.editor.onSubmit?.(`/loop every 60s ${op.text}`);
							Object.assign(model, { enabled: true, prompt: op.text, paused: false });
							break;
						case "loopArgs":
							await mode.editor.onSubmit?.("/loop every 60s");
							if (!model.enabled) model.prompt = undefined;
							Object.assign(model, { enabled: true, paused: false });
							break;
						case "bareLoop":
							await mode.editor.onSubmit?.("/loop");
							Object.assign(model, { enabled: !model.enabled, prompt: undefined, paused: false });
							break;
						case "switch":
							await session.newSession();
							Object.assign(model, { enabled: false, prompt: undefined, paused: false });
							break;
						case "cancelledSwitch":
							await mode.prepareSessionSwitch();
							break;
						case "tick": {
							await advance(MINUTE + 1_000);
							const sent = runs.slice(before).map(run => run.text);
							const due = model.enabled && !model.paused && model.prompt !== undefined ? [model.prompt] : [];
							if (!Bun.deepEquals(sent, due)) {
								return `step ${step} tick sent ${JSON.stringify(sent)}, expected ${JSON.stringify(due)}`;
							}
							break;
						}
					}
					await flushMicrotasks();
					const actual = {
						enabled: mode.loopModeEnabled,
						prompt: mode.loopPrompt,
						paused: mode.loopModeEnabled && mode.loopModePaused,
					};
					const expected = { ...model, paused: model.enabled && model.paused };
					if (!Bun.deepEquals(actual, expected)) {
						return `step ${step} ${op.kind}: state ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
					}
				}
				return undefined;
			}

			it(`keeps the loop prompt model over generated command sequences (seed ${MODEL_SEED})`, async () => {
				const skillPath = path.join(tempDir.path(), "recap.md");
				await Bun.write(skillPath, "---\nname: recap\n---\nSummarize recent changes.\n");
				mode.skillCommands.set("skill:recap", {
					name: "recap",
					description: "",
					filePath: skillPath,
					baseDir: tempDir.path(),
					source: "test",
				});
				vi.spyOn(session, "promptCustomMessage").mockResolvedValue(true);
				vi.spyOn(session, "prompt").mockResolvedValue(true);
				new InputController(mode).setupEditorSubmitHandler();

				let state = MODEL_SEED;
				const next = (limit: number) => {
					state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
					return state % limit;
				};
				try {
					for (let sequence = 0; sequence < 40; sequence++) {
						const ops = Array.from({ length: 16 }, (_, index): Op => {
							const kind = OP_KINDS[next(OP_KINDS.length)];
							return { kind, text: kind === "skill" ? `/skill:recap ${index}` : `${kind} ${index}` };
						});
						if (!(await checkOps(ops))) continue;
						// Shrink: drop each op that the failure does not need.
						let smallest = ops;
						for (let index = smallest.length - 1; index >= 0; index--) {
							const candidate = smallest.toSpliced(index, 1);
							if (await checkOps(candidate)) smallest = candidate;
						}
						const failure = await checkOps(smallest);
						throw new Error(
							`seed ${MODEL_SEED} sequence ${sequence}: ${failure}\nops: ${JSON.stringify(smallest.map(op => op.kind))}`,
						);
					}
				} finally {
					mode.skillCommands.delete("skill:recap");
				}
			});

			it("shows the next run time only while the loop waits", async () => {
				const setLoopModeStatus = vi.spyOn(mode.statusLine, "setLoopModeStatus");
				const lastNextRunAt = () => setLoopModeStatus.mock.lastCall?.[0]?.nextRunAt;
				const start = startIntervalLoop(MINUTE);
				waitForRun();
				expect(lastNextRunAt()).toBe(start + MINUTE);
				await advance(MINUTE);
				expect(runs).toHaveLength(1);
				expect(lastNextRunAt()).toBeUndefined();

				// Armed during a turn (as after a compaction-queued prompt): shown once idle.
				streaming = true;
				waitForRun();
				expect(lastNextRunAt()).toBeUndefined();
				streaming = false;
				await advance(1_000);
				expect(lastNextRunAt()).toBe(start + 2 * MINUTE);

				mode.pauseLoop();
				expect(lastNextRunAt()).toBeUndefined();
			});
		});
	});
});
