import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { FORK_API_KEY_REFUSAL } from "@oh-my-pi/pi-coding-agent/cli/fork-child";
import { cfgSpawnConfirm } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as siblingSpawn from "@oh-my-pi/pi-coding-agent/session/sibling-spawn";
import { createTools, type Tool } from "@oh-my-pi/pi-coding-agent/tools";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

type Harness = { mode: InteractiveMode; session: AgentSession; cleanup: () => Promise<void> };

async function createHarness(composer?: Composer): Promise<Harness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-spawn-command-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const settings = Settings.isolated({ "compaction.enabled": false });
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	const initialTools = await createTools(
		{ cwd: tempDir.path(), hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "*", settings },
		["read"],
	);
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: initialTools, messages: [] } }),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry: new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const)),
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, undefined, composer);
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
			mode.stop();
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
			resetSettingsForTest();
		},
	};
}

/** Emit `agent_start` and wait until the session delivered it to subscribers. */
async function startRun(h: Harness): Promise<void> {
	const delivered = Promise.withResolvers<void>();
	const unsubscribe = h.session.subscribe(event => {
		if (event.type === "agent_start") delivered.resolve();
	});
	try {
		h.session.agent.emitExternalEvent({ type: "agent_start" });
		await delivered.promise;
	} finally {
		unsubscribe();
	}
}

describe("spawn: one session per /spawn (SC-008) and the --api-key refusal (FR-020)", () => {
	let h: Harness | undefined;
	const env = { ZMX_SESSION: process.env.ZMX_SESSION, OMP_SPAWN_PARENT: process.env.OMP_SPAWN_PARENT };
	const argv = process.argv;
	const startFiles: string[] = [];

	beforeAll(() => {
		initTheme();
	});

	afterEach(async () => {
		await h?.cleanup();
		h = undefined;
		vi.restoreAllMocks();
		process.argv = argv;
		for (const file of startFiles.splice(0)) fs.rmSync(file, { force: true });
		for (const [name, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	async function spawnHarness(composer?: Composer) {
		process.env.ZMX_SESSION = "cci-omp-spawncmd-abc123";
		delete process.env.OMP_SPAWN_PARENT;
		h = await createHarness(composer);
		vi.spyOn(siblingSpawn, "zmxSessionExecutable").mockResolvedValue("omp");
		const announce = vi.spyOn(siblingSpawn, "writeSpawnAnnouncement").mockImplementation(() => {});
		const create = vi.spyOn(siblingSpawn, "createSibling").mockImplementation(async ({ startFile }) => {
			if (startFile) startFiles.push(startFile);
		});
		const handler = h.session.peekSpawnHandler();
		if (!handler) throw new Error("Expected the spawn handler after init");
		return { h, create, announce, handler };
	}

	it("parallel calls in one run create one session and refuse the rest", async () => {
		const { h, create, handler } = await spawnHarness();
		await startRun(h);

		const results = await Promise.allSettled([
			handler({ mode: "fresh", text: "first" }),
			handler({ mode: "fresh", text: "second" }),
		]);

		expect(create).toHaveBeenCalledTimes(1);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		const refused = results.find(result => result.status === "rejected");
		expect(String((refused as PromiseRejectedResult).reason)).toContain("already ran in this turn");
	});

	it("sends the start text only through the start file, and every failure shows once in A", async () => {
		const { h, create, handler } = await spawnHarness();
		const showError = vi.spyOn(h.mode, "showError").mockImplementation(() => {});
		const text = 'Run the checks.\n<file name="x">\n"quoted" text';
		await startRun(h);
		await handler({ mode: "fresh", text });
		const { argv, startFile } = create.mock.calls[0]![0];
		expect(argv.some(arg => arg.startsWith("@") || arg.includes("Run the checks"))).toBe(false);
		expect(fs.readFileSync(startFile!, "utf8")).toBe(text);

		create.mockImplementationOnce(async () => {
			throw new Error("zmx failed");
		});
		await startRun(h);
		await expect(handler({ mode: "fresh", text })).rejects.toThrow("zmx failed");
		const failedFile = create.mock.calls[1]![0].startFile!;
		expect(fs.existsSync(failedFile)).toBe(false);
		expect(showError.mock.calls).toEqual([["Spawn failed: zmx failed"]]);

		// A refusal before creation shows in A too, not only in the tool result.
		delete process.env.ZMX_SESSION;
		await startRun(h);
		await expect(handler({ mode: "fresh", text })).rejects.toThrow("spawn needs a zmx session");
		expect(showError.mock.calls.at(-1)).toEqual(["Spawn failed: spawn needs a zmx session"]);
		expect(showError).toHaveBeenCalledTimes(2);
		expect(create).toHaveBeenCalledTimes(2);
	});

	it("a /spawn queued into a run that already spawned still creates its one session", async () => {
		const { h, create, handler } = await spawnHarness();
		vi.spyOn(h.session, "prompt").mockResolvedValue(true);
		vi.spyOn(h.session, "followUp").mockResolvedValue();
		await startRun(h);
		await handler({ mode: "fresh", text: "first" });

		// No agent_start between: the second kickoff joins the same run, as a follow-up does.
		expect(await h.mode.handleSpawnCommand("another session")).toBe(true);
		await handler({ mode: "fresh", text: "second" });
		await expect(handler({ mode: "fresh", text: "third" })).rejects.toThrow("already ran in this turn");

		expect(create).toHaveBeenCalledTimes(2);
	});

	it("a /spawn while another /spawn window is open is refused, and the first still spawns once", async () => {
		const { h, create, handler } = await spawnHarness();
		const promptSpy = vi.spyOn(h.session, "prompt").mockResolvedValue(true);
		const followUp = vi.spyOn(h.session, "followUp").mockResolvedValue();
		const warning = vi.spyOn(h.mode, "showWarning");
		expect(await h.mode.handleSpawnCommand("first session")).toBe(true);

		expect(await h.mode.handleSpawnCommand("second session")).toBe(false);
		expect(warning).toHaveBeenCalledWith("A /spawn is already running. Wait for it to finish.");
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(followUp).not.toHaveBeenCalled();
		expect(h.session.isSpawnWindowOpen()).toBe(true);

		await startRun(h);
		await handler({ mode: "fresh", text: "first" });
		expect(create).toHaveBeenCalledTimes(1);
		expect(h.session.isSpawnWindowOpen()).toBe(false);
	});

	it("a parent started with --api-key spawns nothing and names the reason", async () => {
		const { h, create, handler } = await spawnHarness();
		const promptSpy = vi.spyOn(h.session, "prompt").mockResolvedValue(true);
		const error = vi.spyOn(h.mode, "showError");
		process.argv = [...argv.slice(0, 2), "--api-key", "sk-test-secret"];

		expect(await h.mode.handleSpawnCommand("start a session")).toBe(false);
		expect(error).toHaveBeenCalledWith(FORK_API_KEY_REFUSAL);
		expect(promptSpy).not.toHaveBeenCalled();
		await startRun(h);
		await expect(handler({ mode: "fresh", text: "work" })).rejects.toThrow(FORK_API_KEY_REFUSAL);
		expect(create).not.toHaveBeenCalled();
	});

	describe("/fork spawn", () => {
		/** A spawn harness whose A has a saved session file, so fork mode has something to copy. */
		async function forkHarness(composer?: Composer) {
			const spawn = await spawnHarness(composer);
			const manager = spawn.h.session.sessionManager;
			manager.appendMessage({ role: "user", content: "keep this context", timestamp: Date.now() });
			await manager.ensureOnDisk();
			await manager.flush();
			const file = manager.getSessionFile();
			// Without a file every case below would only test the "no saved conversation" refusal.
			expect(file !== undefined && fs.existsSync(file)).toBe(true);
			const prompt = vi.spyOn(spawn.h.session, "prompt").mockResolvedValue(true);
			const followUp = vi.spyOn(spawn.h.session, "followUp").mockResolvedValue();
			const showError = vi.spyOn(spawn.h.mode, "showError").mockImplementation(() => {});
			const showStatus = vi.spyOn(spawn.h.mode, "showStatus").mockImplementation(() => {});
			return { ...spawn, file: file!, prompt, followUp, showError, showStatus };
		}

		it("creates one pure fork of A with no model turn and no new message", async () => {
			const { h, create, announce, file, prompt, followUp, showError, showStatus } = await forkHarness();
			const transcript = fs.readFileSync(file, "utf8");
			const messages = h.session.messages.length;

			await h.mode.handleForkSpawnCommand();

			expect(showError).not.toHaveBeenCalled();
			expect(create).toHaveBeenCalledTimes(1);
			const { name, argv, labels, startFile } = create.mock.calls[0]![0];
			expect(argv.slice(-2)).toEqual(["--fork", path.resolve(file)]);
			expect(startFile).toBeUndefined();
			expect(labels).toEqual({ "cci-parent": "cci-omp-spawncmd-abc123" });
			expect(announce.mock.calls).toEqual([[name]]);
			expect(showStatus.mock.calls).toEqual([[`Spawned ${name}`]]);
			expect(prompt).not.toHaveBeenCalled();
			expect(followUp).not.toHaveBeenCalled();
			expect(h.session.messages.length).toBe(messages);
			expect(fs.readFileSync(file, "utf8")).toBe(transcript);
			expect(h.session.isSpawnWindowOpen()).toBe(false);
		});

		it("ignores spawn.confirm", async () => {
			const { h, create } = await forkHarness();
			cfgSpawnConfirm.set(h.session.settings, true);
			const confirm = vi.spyOn(h.mode, "showHookConfirm");
			await h.mode.handleForkSpawnCommand();
			expect(confirm).not.toHaveBeenCalled();
			expect(create).toHaveBeenCalledTimes(1);
		});

		it("outside zmx creates nothing and names the reason", async () => {
			const { h, create, showError } = await forkHarness();
			delete process.env.ZMX_SESSION;
			await h.mode.handleForkSpawnCommand();
			expect(create).not.toHaveBeenCalled();
			expect(showError.mock.calls).toEqual([["Spawn failed: spawn needs a zmx session"]]);
		});

		it("leaves an open /spawn window and its spawn slot alone", async () => {
			const { h, create, handler } = await forkHarness();
			expect(await h.mode.handleSpawnCommand("x")).toBe(true);
			await h.mode.handleForkSpawnCommand();
			expect(create).toHaveBeenCalledTimes(1);
			expect(h.session.isSpawnWindowOpen()).toBe(true);
			await handler({ mode: "fresh", text: "the /spawn session" });
			expect(create).toHaveBeenCalledTimes(2);
		});

		it.each([
			[false, 0],
			[true, 1],
		])("during a turn asks first; answer %p creates %p sessions", async (answer, sessions) => {
			const { h, create } = await forkHarness();
			Object.defineProperty(h.session, "isStreaming", { configurable: true, get: () => true });
			const confirm = vi.spyOn(h.mode, "showHookConfirm").mockResolvedValue(answer);
			await h.mode.handleForkSpawnCommand();
			expect(confirm).toHaveBeenCalledTimes(1);
			expect(confirm.mock.calls[0]![0]).toBe("Fork while a response is running?");
			expect(create).toHaveBeenCalledTimes(sessions);
			Reflect.deleteProperty(h.session, "isStreaming");
		});

		describe("IDE fork request", () => {
			const packet = "\x1b_pi:action;fork-spawn\x1b\\";

			/**
			 * The packet path starts the fork without awaiting it. Spy on the call so a
			 * test awaits the fork itself; a dialog refusal runs synchronously.
			 */
			function watchForks(h: Harness) {
				const run = vi.spyOn(h.mode, "handleForkSpawnCommand");
				return { run, settled: () => Promise.all(run.mock.results.map(result => result.value)) };
			}

			it("forks during a turn without the busy-turn question", async () => {
				const { h, create } = await forkHarness();
				Object.defineProperty(h.session, "isStreaming", { configurable: true, get: () => true });
				const confirm = vi.spyOn(h.mode, "showHookConfirm");
				const forks = watchForks(h);
				h.mode.ui.injectDebugInput(packet);
				expect(forks.run.mock.calls).toEqual([[false]]);
				await forks.settled();
				expect(create).toHaveBeenCalledTimes(1);
				expect(confirm).not.toHaveBeenCalled();
				Reflect.deleteProperty(h.session, "isStreaming");
			});

			it("leaves the draft text and cursor unchanged", async () => {
				const { h, create } = await forkHarness();
				h.mode.editor.setText("draft text");
				const cursor = h.mode.editor.getCursor();
				const forks = watchForks(h);
				h.mode.ui.injectDebugInput(packet);
				await forks.settled();
				expect(create).toHaveBeenCalledTimes(1);
				expect(h.mode.editor.getText()).toBe("draft text");
				expect(h.mode.editor.getCursor()).toEqual(cursor);
			});

			it("an open dialog blocks the request with a warning", async () => {
				const { h, create } = await forkHarness();
				vi.spyOn(h.mode.ui, "hasOverlay").mockReturnValue(true);
				const warning = vi.spyOn(h.mode, "showWarning").mockImplementation(() => {});
				const forks = watchForks(h);
				h.mode.ui.injectDebugInput(packet);
				expect(warning.mock.calls).toEqual([["Fork request ignored: close the open dialog first."]]);
				expect(forks.run).not.toHaveBeenCalled();
				expect(create).not.toHaveBeenCalled();
			});

			it("an open /spawn window does not block the request", async () => {
				const { h, create } = await forkHarness();
				expect(await h.mode.handleSpawnCommand("x")).toBe(true);
				const forks = watchForks(h);
				h.mode.ui.injectDebugInput(packet);
				await forks.settled();
				expect(create).toHaveBeenCalledTimes(1);
				expect(h.session.isSpawnWindowOpen()).toBe(true);
			});

			it("two packets back to back create two sessions with different names", async () => {
				const { h, create } = await forkHarness();
				const forks = watchForks(h);
				h.mode.ui.injectDebugInput(packet);
				h.mode.ui.injectDebugInput(packet);
				await forks.settled();
				expect(create).toHaveBeenCalledTimes(2);
				const [first, second] = create.mock.calls.map(([args]) => args.name);
				expect(first).not.toBe(second);
			});

			it("works through a Composer that was started before InteractiveMode adopted it", async () => {
				const composer = new Composer({
					terminal: new VirtualTerminal(80, 24),
					preferences: { ...COMPOSER_DEFAULTS, quiet: true },
				});
				composer.start();
				const { h, create } = await forkHarness(composer);
				const forks = watchForks(h);
				composer.ui.injectDebugInput(packet);
				await forks.settled();
				expect(create).toHaveBeenCalledTimes(1);
			});
		});
	});
});
