import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

// The default status-line preset leads with the `pi` brand segment, which
// renders the running turn timer itself and only its icon between turns. The
// last turn's time must then stay on the idle working row.
describe("InteractiveMode idle turn timer under the pi brand preset", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-idle-turn-timer-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
	});

	afterAll(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("keeps the last turn's time on the idle row while pi owns the running timer", () => {
		expect(mode.statusLine.showsWorkingBrand()).toBe(true);
		const now = vi.spyOn(Date, "now");
		const idleRow = () => Bun.stripANSI((mode.renderIdleStatusHud(120) ?? []).join("\n"));

		now.mockReturnValue(1_000);
		mode.statusLine.markActivityStart();
		now.mockReturnValue(4_000);
		// Running: the pi segment shows the timer, so the row must not repeat it.
		expect(idleRow()).not.toContain("3s");

		now.mockReturnValue(13_000);
		mode.statusLine.markActivityEnd();
		now.mockReturnValue(60_000);
		// Idle: frozen at the finished turn's 12s, not the wall clock since.
		expect(idleRow()).toContain("12s");
		expect(JSON.stringify(mode.describeStatusHud([]))).toContain('"stopped":12000');

		// A new turn replaces the reading once it ends.
		mode.statusLine.markActivityStart();
		now.mockReturnValue(65_000);
		mode.statusLine.markActivityEnd();
		expect(idleRow()).toContain("5s");
		expect(idleRow()).not.toContain("12s");
	});
});
