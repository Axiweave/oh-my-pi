import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { FORK_API_KEY_REFUSAL } from "@oh-my-pi/pi-coding-agent/cli/fork-child";
import { cfgSpawnConfirm } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sessionWorktree from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import * as siblingSpawn from "@oh-my-pi/pi-coding-agent/session/sibling-spawn";
import { createTools, type Tool } from "@oh-my-pi/pi-coding-agent/tools";
import { SpawnSessionTool } from "@oh-my-pi/pi-coding-agent/tools/spawn-session";
import { isSpawnKickoff } from "@oh-my-pi/pi-coding-agent/modes/speckit-auto";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { $ } from "bun";

const realGit = vcs.git;

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

/** Emit one agent event and wait until the session delivered it to subscribers. */
async function emit(h: Harness, event: Parameters<Agent["emitExternalEvent"]>[0]): Promise<void> {
	const delivered = Promise.withResolvers<void>();
	const unsubscribe = h.session.subscribe(e => {
		if (e.type === event.type) delivered.resolve();
	});
	try {
		h.session.agent.emitExternalEvent(event);
		await delivered.promise;
	} finally {
		unsubscribe();
	}
}

/** The hidden developer message that `/spawn` sends, as `isSpawnKickoff` sees it. */
const kickoffMessage = (request: string): AgentMessage =>
	({
		role: "developer",
		content: [{ type: "text", text: "kickoff" }],
		displayText: `/spawn ${request}`,
		userInitiated: true,
		synthetic: true,
		timestamp: Date.now(),
	}) as unknown as AgentMessage;

const assistantCalls = (...names: string[]): AgentMessage =>
	({
		role: "assistant",
		content: names.map((name, i) => ({ type: "toolCall", id: `call-${i}`, name, arguments: {} })),
	}) as unknown as AgentMessage;

const askResult = (isError: boolean): AgentMessage =>
	({
		role: "toolResult",
		toolCallId: "call-0",
		toolName: "ask",
		content: [],
		isError,
		timestamp: Date.now(),
	}) as unknown as AgentMessage;
const assistantText = { role: "assistant", content: [{ type: "text", text: "ok" }] } as unknown as AgentMessage;

describe("spawn: sessions per /spawn (FR-001) and the --api-key refusal (FR-020)", () => {
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

	it("parallel calls in one run each create a session", async () => {
		const { h, create, handler } = await spawnHarness();
		await startRun(h);

		await Promise.all([handler({ mode: "fresh", text: "first" }), handler({ mode: "fresh", text: "second" })]);

		const texts = create.mock.calls.map(([args]) => fs.readFileSync(args.startFile!, "utf8"));
		expect(texts.sort()).toEqual(["first", "second"]);
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

	it("a /spawn window stays open for its whole run and frees the next /spawn at agent_end (SC-006)", async () => {
		const { h, create, handler } = await spawnHarness();
		vi.spyOn(h.session, "prompt").mockResolvedValue(true);
		expect(await h.mode.handleSpawnCommand("two sessions")).toBe(true);
		const kickoff = kickoffMessage("two sessions");
		await startRun(h);
		await emit(h, { type: "message_start", message: kickoff });
		await handler({ mode: "fresh", text: "first" });
		await handler({ mode: "fresh", text: "second" });

		expect(create).toHaveBeenCalledTimes(2);
		expect(h.session.isSpawnWindowOpen()).toBe(true);
		expect(await h.mode.handleSpawnCommand("another")).toBe(false);

		await emit(h, { type: "agent_end", messages: [kickoff, assistantCalls("spawn_session", "spawn_session")] });
		expect(h.session.isSpawnWindowOpen()).toBe(false);
		expect(await h.mode.handleSpawnCommand("another")).toBe(true);
	});

	it("a /spawn while another /spawn window is open is refused, and the first window stays open", async () => {
		const { h, create, handler } = await spawnHarness();
		const promptSpy = vi.spyOn(h.session, "prompt").mockResolvedValue(true);
		const followUp = vi.spyOn(h.session, "followUp").mockResolvedValue();
		const warning = vi.spyOn(h.mode, "showWarning");
		expect(await h.mode.handleSpawnCommand("first session")).toBe(true);

		expect(await h.mode.handleSpawnCommand("second session")).toBe(false);
		expect(warning).toHaveBeenCalledWith("A /spawn is already running. Wait for it to finish.");
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(followUp).not.toHaveBeenCalled();

		await startRun(h);
		await handler({ mode: "fresh", text: "first" });
		expect(create).toHaveBeenCalledTimes(1);
		expect(h.session.isSpawnWindowOpen()).toBe(true);
	});

	it("only calls after the kickoff decide the close: an earlier ask does not keep the window open (FR-015)", async () => {
		const { h } = await spawnHarness();
		vi.spyOn(h.session, "prompt").mockResolvedValue(true);
		const kickoff = kickoffMessage("x");

		expect(await h.mode.handleSpawnCommand("x")).toBe(true);
		await emit(h, { type: "message_start", message: kickoff });
		await emit(h, { type: "agent_end", messages: [assistantCalls("ask"), kickoff, assistantCalls("read")] });
		expect(h.session.isSpawnWindowOpen()).toBe(false);

		// A cancelled ask after the kickoff keeps the window for the reply run.
		expect(await h.mode.handleSpawnCommand("x")).toBe(true);
		await emit(h, { type: "message_start", message: kickoff });
		await emit(h, {
			type: "agent_end",
			messages: [assistantCalls("spawn_session"), kickoff, assistantCalls("ask"), askResult(true)],
		});
		expect(h.session.isSpawnWindowOpen()).toBe(true);
		await emit(h, { type: "agent_end", messages: [] });
		expect(h.session.isSpawnWindowOpen()).toBe(false);

		// An answered ask followed by a text-only reply ends the /spawn: the next one is accepted.
		expect(await h.mode.handleSpawnCommand("x")).toBe(true);
		await emit(h, { type: "message_start", message: kickoff });
		await emit(h, { type: "agent_end", messages: [kickoff, assistantCalls("ask"), askResult(false), assistantText] });
		expect(h.session.isSpawnWindowOpen()).toBe(false);
		expect(await h.mode.handleSpawnCommand("x")).toBe(true);
	});

	it("a queued kickoff keeps the window open until it runs; a dropped one frees it", async () => {
		const { h } = await spawnHarness();
		Object.defineProperty(h.session, "isStreaming", { configurable: true, get: () => true });
		expect(await h.mode.handleSpawnCommand("queued")).toBe(true);
		expect(h.session.agent.peekFollowUpQueue().some(isSpawnKickoff)).toBe(true);

		// The run that was in progress ends without the kickoff; it had spawned before.
		await emit(h, { type: "agent_end", messages: [assistantCalls("spawn_session")] });
		expect(h.session.isSpawnWindowOpen()).toBe(true);

		h.session.agent.clearFollowUpQueue();
		await emit(h, { type: "agent_end", messages: [] });
		expect(h.session.isSpawnWindowOpen()).toBe(false);
		Reflect.deleteProperty(h.session, "isStreaming");
		vi.spyOn(h.session, "prompt").mockResolvedValue(true);
		expect(await h.mode.handleSpawnCommand("again")).toBe(true);
	});

	it("an agent_end while the kickoff is still being sent keeps the window open", async () => {
		const { h } = await spawnHarness();
		const sent = Promise.withResolvers<void>();
		Object.defineProperty(h.session, "isStreaming", { configurable: true, get: () => true });
		const sending = Promise.withResolvers<void>();
		vi.spyOn(h.session, "followUp").mockImplementation(() => {
			sending.resolve();
			return sent.promise;
		});
		const started = h.mode.handleSpawnCommand("slow");
		await sending.promise;

		await emit(h, { type: "agent_end", messages: [] });
		expect(h.session.isSpawnWindowOpen()).toBe(true);
		sent.resolve();
		expect(await started).toBe(true);
		expect(h.session.isSpawnWindowOpen()).toBe(true);
		Reflect.deleteProperty(h.session, "isStreaming");
	});

	describe("overview (mode plan)", () => {
		it("an approved overview covers its tasks; a call beyond them asks again", async () => {
			const { h, create, handler } = await spawnHarness();
			cfgSpawnConfirm.set(h.session.settings, true);
			const confirm = vi.spyOn(h.mode, "showHookConfirm").mockResolvedValue(true);
			await startRun(h);

			expect(await handler({ mode: "plan", tasks: ["A: fresh", "B: fresh"] })).toBe("Approved: spawn the 2 tasks.");
			await expect(handler({ mode: "plan", tasks: ["A", "B"] })).rejects.toThrow("already showed");
			for (const text of ["a", "b", "c"]) await handler({ mode: "fresh", text });

			expect(confirm.mock.calls.map(([title]) => title)).toEqual(["Spawn these 2 sessions?", "Spawn this session?"]);
			expect(create).toHaveBeenCalledTimes(3);
		});

		it("a declined overview spawns nothing", async () => {
			const { h, create, handler } = await spawnHarness();
			cfgSpawnConfirm.set(h.session.settings, true);
			vi.spyOn(h.mode, "showHookConfirm").mockResolvedValue(false);
			await startRun(h);

			expect(await handler({ mode: "plan", tasks: ["A", "B"] })).toBe("Overview declined: spawn nothing.");
			await expect(handler({ mode: "fresh", text: "a" })).rejects.toThrow("declined");
			expect(create).not.toHaveBeenCalled();
		});

		it("with spawn.confirm off, shows no dialog", async () => {
			const { h, create, handler } = await spawnHarness();
			cfgSpawnConfirm.set(h.session.settings, false);
			const confirm = vi.spyOn(h.mode, "showHookConfirm");
			await startRun(h);

			expect(await handler({ mode: "plan", tasks: ["A", "B"] })).toContain("spawn.confirm is off");
			await handler({ mode: "fresh", text: "a" });
			expect(confirm).not.toHaveBeenCalled();
			expect(create).toHaveBeenCalledTimes(1);
		});

		it.each([
			[{ mode: "plan", tasks: ["only one"] }],
			[{ mode: "plan", tasks: ["A", " "] }],
			[{ mode: "plan", tasks: ["A", "B"], text: "x" }],
			[{ mode: "plan", tasks: ["A", "B"], new_worktree: true }],
			[{ mode: "fresh", text: "x", new_worktree: true }],
			[{ mode: "fresh", text: "x", new_worktree: true, branch: " " }],
			[{ mode: "fresh", text: "x", tasks: ["A", "B"] }],
		] as const)("the tool refuses %j", async params => {
			const { h, handler } = await spawnHarness();
			const tool = new SpawnSessionTool({ peekSpawnHandler: () => handler } as never);
			await expect(tool.execute("call", params as never)).rejects.toThrow();
			expect(h.session.isSpawnWindowOpen()).toBe(false);
		});
	});

	it("a taken spawn branch gets the next free -N suffix", async () => {
		const { h, handler } = await spawnHarness();
		using repo = TempDir.createSync("@pi-spawn-branch-");
		await $`git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git branch feat/eng-1-x && git branch feat/eng-1-x-2`
			.cwd(repo.path())
			.quiet();
		vi.spyOn(vcs, "git").mockImplementation(realGit);
		vi.spyOn(h.session.sessionManager, "getCwd").mockReturnValue(repo.path());
		const branches: string[] = [];
		vi.spyOn(sessionWorktree, "createSessionWorktree").mockImplementation(async (cwd, _settings, branch) => {
			branches.push(branch);
			return { path: cwd, branch, sourceCwd: cwd, baseCommit: "0", keptChanges: true };
		});
		await startRun(h);
		await handler({ mode: "fresh", text: "a", new_worktree: true, branch: "feat/eng-1-x" });
		await handler({ mode: "fresh", text: "b", new_worktree: true, branch: "feat/eng-1-y" });
		expect(branches).toEqual(["feat/eng-1-x-3", "feat/eng-1-y"]);
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
