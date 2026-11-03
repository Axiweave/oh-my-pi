/**
 * A pending CLI fork's first prompt sends the hidden fork reminder. The
 * interactive transcript shows its notice once while the turn runs (live
 * message_start → addMessageToChat), and a later replay of the saved session
 * does not add a second notice.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { FORK_START_REMINDER_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/fork-start-reminder";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Component } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { setAgentDir, TempDir, __resetDirsFromEnvForTests } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

let tempDir: TempDir;
let authStorage: AuthStorage;
let session: AgentSession | undefined;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

beforeEach(async () => {
	tempDir = TempDir.createSync("@pi-fork-reminder-notice-live-");
	setAgentDir(tempDir.join("agent"));
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.keys.setRuntime("openai", "openai-test-key");
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage.close();
	__resetDirsFromEnvForTests();
	tempDir.removeSync();
});

async function pendingFork(): Promise<SessionManager> {
	const sessionDir = tempDir.join("sessions");
	const source = SessionManager.create(tempDir.path(), sessionDir);
	source.appendMessage({ role: "user", content: "earlier question", timestamp: 1 });
	await source.ensureOnDisk();
	await source.flush();
	const sourceFile = source.getSessionFile()!;
	await source.close();
	return SessionManager.forkFrom(sourceFile, tempDir.path(), sessionDir, undefined, {
		repairInterruptedTail: true,
		startReminder: true,
	});
}

describe("fork start reminder notice in the live transcript", () => {
	it("shows once during the first turn and a later replay adds no second notice", async () => {
		const sessionManager = await pendingFork();
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses: [{ content: ["done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map(),
		});
		const ctx = createInteractiveModeContext({
			session,
			sessionManager,
			initialChatRendered: true,
		});
		const helpers = new UiHelpers(ctx);
		// Records the components each reminder or prompt paint adds, and whether the turn was running.
		const reminderPaints: Array<{ added: Component[]; streaming: boolean }> = [];
		const promptPaints: Component[][] = [];
		ctx.addMessageToChat = (message, options) => {
			const before = new Set(ctx.chatContainer.children);
			const result = helpers.addMessageToChat(message, options);
			const added = ctx.chatContainer.children.filter(child => !before.has(child));
			if (message.role === "custom" && message.customType === FORK_START_REMINDER_CUSTOM_TYPE) {
				reminderPaints.push({ added, streaming: session?.isStreaming === true });
			} else if (message.role === "user") {
				promptPaints.push(added);
			}
			return result;
		};
		ctx.renderSessionContext = helpers.renderSessionContext.bind(helpers);
		ctx.renderSessionContextIncrementally = helpers.renderSessionContextIncrementally.bind(helpers);
		ctx.renderInitialMessages = helpers.renderInitialMessages.bind(helpers);
		const controller = new EventController(ctx);
		ctx.eventController = controller;
		session.subscribe(event => controller.handleEvent(event));

		await session.prompt("first fork question");

		// One live paint, during the turn, adding exactly one component: the notice.
		expect(reminderPaints.map(paint => [paint.streaming, paint.added.length])).toEqual([[true, 1]]);
		const liveNotice = reminderPaints[0]!.added[0]!;
		const children = ctx.chatContainer.children;
		expect(children.filter(child => child === liveNotice)).toHaveLength(1);
		// The notice sits before the prompt it was sent with.
		const livePrompt = promptPaints.at(-1)?.[0];
		expect(livePrompt).toBeDefined();
		expect(children.indexOf(liveNotice)).toBeLessThan(children.indexOf(livePrompt!));
		const savedReminders = sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === FORK_START_REMINDER_CUSTOM_TYPE);
		expect(savedReminders).toHaveLength(1);

		const liveComponents = [...children];
		reminderPaints.length = 0;
		await ctx.renderInitialMessages();

		// The replay rebuilt the chat from the saved session and holds exactly one notice.
		const replayed = ctx.chatContainer.children;
		expect(replayed.some(child => liveComponents.includes(child))).toBe(false);
		const replayNotices = reminderPaints.flatMap(paint => paint.added).filter(child => replayed.includes(child));
		expect(replayNotices).toHaveLength(1);
	});
});
