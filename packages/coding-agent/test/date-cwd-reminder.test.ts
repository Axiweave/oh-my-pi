import { afterEach, describe, expect, it } from "bun:test";
import type { Api, Context, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { DateCwdReminderInjector, renderDateCwdReminder } from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { formatLocalCalendarDate } from "@oh-my-pi/pi-coding-agent/utils/local-date";
import { normalizePromptPath } from "@oh-my-pi/pi-coding-agent/utils/prompt-path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("date-cwd-reminder", () => {
	afterEach(() => {
		clearCustomApis();
	});

	describe("renderDateCwdReminder", () => {
		it("renders a system-reminder block carrying the date and cwd with a do-not-repeat instruction", () => {
			const reminder = renderDateCwdReminder("2026-08-14", "C:/work/omp");

			expect(reminder.startsWith("<system-reminder>")).toBe(true);
			expect(reminder.endsWith("</system-reminder>")).toBe(true);
			expect(reminder).toContain("2026-08-14");
			expect(reminder).toContain("C:/work/omp");
			expect(reminder).toContain("Do not repeat");
		});
	});

	describe("DateCwdReminderInjector", () => {
		const reminder = (date: string, cwd: string) => renderDateCwdReminder(date, cwd);
		const context = (messages: Message[]): Context => ({ systemPrompt: ["SYS"], messages });

		it("prepends the reminder to the first user message with string content without mutating the input", () => {
			const messages: Message[] = [{ role: "user", content: "hello", timestamp: 1 }, createAssistantMessage("hi")];
			const original = [...messages];

			const out = new DateCwdReminderInjector().transform(context(messages), "2026-08-14", "/cwd");

			expect(out.messages).not.toBe(messages);
			expect(out.messages[0]).toEqual({
				role: "user",
				content: `${reminder("2026-08-14", "/cwd")}\n\nhello`,
				timestamp: 1,
			});
			expect(out.messages[1]).toBe(messages[1]);
			expect(messages).toEqual(original);
		});

		it("prepends a text part before image parts when the first user message has array content", () => {
			const messages: Message[] = [
				{ role: "user", content: [{ type: "image", data: "img", mimeType: "image/png" }], timestamp: 1 },
			];

			const out = new DateCwdReminderInjector().transform(context(messages), "2026-08-14", "/cwd");

			expect(out.messages[0]?.content).toEqual([
				{ type: "text", text: reminder("2026-08-14", "/cwd") },
				{ type: "image", data: "img", mimeType: "image/png" },
			]);
		});

		it("returns the input unchanged when there is no user message or the system prompt is empty", () => {
			const noUser = context([createAssistantMessage("hi")]);
			expect(new DateCwdReminderInjector().transform(noUser, "2026-08-14", "/cwd")).toBe(noUser);

			const nullPrompt: Context = { systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: 1 }] };
			expect(new DateCwdReminderInjector().transform(nullPrompt, "2026-08-14", "/cwd")).toBe(nullPrompt);
		});

		it("reuses the same injected message object across requests for an unchanged reminder", () => {
			// The append-only context path reuses message objects across requests;
			// the injected first-turn message must keep its identity so the stable
			// prefix is preserved (and the provider prompt cache is not churned).
			const pristine: Message = { role: "user", content: "first", timestamp: 1 };
			const injector = new DateCwdReminderInjector();

			const first = injector.transform(context([pristine]), "2026-08-14", "/cwd").messages[0]!;
			const second = injector.transform(context([pristine]), "2026-08-14", "/cwd").messages[0]!;
			expect(second).toBe(first);
		});

		it("keeps earlier injected bytes and attaches a changed reminder to the next new user turn", () => {
			const firstTurn: Message = { role: "user", content: "first", timestamp: 1 };
			const reply = createAssistantMessage("ok");
			const injector = new DateCwdReminderInjector();

			const day1 = injector.transform(context([firstTurn, reply]), "2026-08-14", "/cwd").messages[0]!;

			const secondTurn: Message = { role: "user", content: "second", timestamp: 2 };
			const out = injector.transform(context([firstTurn, reply, secondTurn]), "2026-08-15", "/cwd").messages;
			expect(out[0]).toBe(day1);
			expect(out[2]).toEqual({
				role: "user",
				content: `${reminder("2026-08-15", "/cwd")}\n\nsecond`,
				timestamp: 2,
			});
		});

		it("appends a synthetic developer message when the reminder changes with no new user turn", () => {
			const firstTurn: Message = { role: "user", content: "first", timestamp: 1 };
			const injector = new DateCwdReminderInjector();
			const day1 = injector.transform(context([firstTurn]), "2026-08-14", "/cwd").messages[0]!;

			const out = injector.transform(context([firstTurn]), "2026-08-15", "/cwd").messages;
			expect(out[0]).toBe(day1);
			expect(out[1]).toMatchObject({
				role: "developer",
				content: reminder("2026-08-15", "/cwd"),
				synthetic: true,
			});
		});

		it("does not double-wrap when the first user message already carries the reminder", () => {
			const carried = `${reminder("2026-08-14", "/cwd")}\n\nfirst`;
			const ctx = context([{ role: "user", content: carried, timestamp: 1 }]);
			expect(new DateCwdReminderInjector().transform(ctx, "2026-08-14", "/cwd")).toBe(ctx);
		});
	});
});

describe("date-cwd reminder on the provider wire", () => {
	const sessions: Array<{ dispose(): Promise<void> }> = [];

	afterEach(async () => {
		clearCustomApis();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("keeps the date/cwd out of the system prompt and pins the reminder to the first user turn across requests", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-");
		const api = "test-date-cwd-reminder";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "date-cwd-reminder",
			name: "Date cwd reminder",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		sessions.push(session);

		try {
			await session.sendUserMessage("first");

			expect(contexts).toHaveLength(1);
			// The volatile line must no longer live in the system prompt: open-weight
			// chat templates render tool schemas after the system content, so any
			// per-request byte there invalidates the whole tool-schema cache (#7404).
			const systemPrompt = contexts[0]!.systemPrompt?.join("\n") ?? "";
			expect(systemPrompt).not.toContain("Today");
			expect(systemPrompt).not.toContain("current working directory");
			expect(systemPrompt).not.toContain(formatLocalCalendarDate());

			const firstUser = contexts[0]!.messages[0]!;
			expect(firstUser.role).toBe("user");
			const firstText =
				typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content);
			expect(firstText).toContain("<system-reminder>");
			expect(firstText).toContain(formatLocalCalendarDate());
			expect(firstText).toContain(normalizePromptPath(tempDir.path()));

			// A second request must re-emit byte-identical reminder bytes so the
			// conversation prefix (system + tools + first turn) stays cached.
			await session.sendUserMessage("second");
			expect(contexts).toHaveLength(2);
			const secondFirst = contexts[1]!.messages[0]!;
			expect(secondFirst.role).toBe("user");
			expect(typeof secondFirst.content).toBe(typeof firstUser.content);
			expect(secondFirst.content).toEqual(firstUser.content);
		} finally {
			authStorage.close();
		}
	});
});
