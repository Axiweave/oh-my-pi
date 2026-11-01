import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { FORK_API_KEY_REFUSAL } from "@oh-my-pi/pi-coding-agent/cli/fork-child";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as siblingSpawn from "@oh-my-pi/pi-coding-agent/session/sibling-spawn";
import { createTools, type Tool } from "@oh-my-pi/pi-coding-agent/tools";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

type Harness = { mode: InteractiveMode; session: AgentSession; cleanup: () => Promise<void> };

async function createHarness(): Promise<Harness> {
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

	async function spawnHarness() {
		process.env.ZMX_SESSION = "cci-omp-spawncmd-abc123";
		delete process.env.OMP_SPAWN_PARENT;
		h = await createHarness();
		vi.spyOn(siblingSpawn, "zmxSessionExecutable").mockResolvedValue("omp");
		vi.spyOn(siblingSpawn, "writeSpawnAnnouncement").mockImplementation(() => {});
		const create = vi.spyOn(siblingSpawn, "createSibling").mockImplementation(async ({ argv }) => {
			for (const arg of argv) if (arg.startsWith("@")) startFiles.push(arg.slice(1));
		});
		const handler = h.session.peekSpawnHandler();
		if (!handler) throw new Error("Expected the spawn handler after init");
		return { h, create, handler };
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
});
