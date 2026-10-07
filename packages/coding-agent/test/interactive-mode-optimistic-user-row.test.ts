/**
 * The optimistic user row painted at submit must be swapped for the canonical
 * row, never left behind next to it, even when a frame retires settled blocks
 * into native scrollback before the canonical `message_start` arrives.
 *
 * Speckit-auto submits `/speckit.plan` through `startPendingSubmission`; the
 * canonical message is the expanded template, so EventController replaces the
 * raw row. A committed row cannot be removed, which left a plain
 * `/speckit.plan` row above the collapsed command card.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const REPLY = "PLAN_REPLY";

describe("InteractiveMode optimistic user row", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-optimistic-user-row-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		const mock = createMockModel({ responses: [{ content: [REPLY] }] });
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "k",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (m, c, o) => mock.stream(m, c, o),
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			// Every frame retires settled blocks into native scrollback, so the
			// optimistic row commits at its first paint, before `message_start`.
			settings: Settings.isolated({ "display.streamingScrollback": true }),
			modelRegistry,
			slashCommands: [
				{
					name: "speckit.plan",
					description: "plan",
					content: Array.from({ length: 40 }, (_, i) => `Template line ${i}`).join("\n"),
					source: "test",
				},
			],
		});
		term = new VirtualTerminal(100, 24);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: term }),
		);
		await mode.init({ suppressWelcomeIntro: true });
		mode.fileSlashCommands = new Set(["speckit.plan"]);
	});

	afterEach(async () => {
		mode.stop();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	const rows = () => term.getScrollBuffer().map(row => Bun.stripANSI(row).trim());

	for (const [name, text] of [
		["an expanded file command (speckit-auto /speckit.plan)", "/speckit.plan"],
		["a same-text prompt", "Say hello"],
	] as const) {
		it(`shows one user row for ${name} after the canonical message_start`, async () => {
			// The speckit-auto submit: `onInput(startPendingSubmission({ text }))`.
			await submitInteractiveInput(mode, session, mode.startPendingSubmission({ text }));
			await term.waitForRender(() => rows().includes(REPLY));

			expect(rows().filter(row => row === text)).toHaveLength(1);
		});
	}
});
