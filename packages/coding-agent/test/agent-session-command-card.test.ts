import { afterEach, describe, expect, it } from "bun:test";
import { type Api, clearCustomApis, type Model, type ModelSpec, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function lastUserMessage(session: AgentSession): { text: string; promptTemplate: string | undefined } {
	const message = session.state.messages.findLast(m => m.role === "user");
	if (!message || message.role !== "user") throw new Error("Expected a user message");
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter(part => part.type === "text")
					.map(part => part.text)
					.join("");
	return { text, promptTemplate: message.promptTemplate };
}

describe("AgentSession command cards", () => {
	afterEach(() => {
		clearCustomApis();
	});

	it("stamps file slash commands and prompt templates as promptTemplate", async () => {
		using tempDir = TempDir.createSync("@pi-command-card-");
		const api = "test-command-card";
		registerCustomApi(api, () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "command-card",
			name: "Command card",
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
			promptTemplates: [{ name: "plan", description: "plan", content: "Plan for $ARGUMENTS", source: "test" }],
			slashCommands: [{ name: "greet", description: "greet", content: "Say hello to $ARGUMENTS", source: "test" }],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		try {
			await session.prompt("/greet world");
			await session.waitForIdle();
			expect(lastUserMessage(session)).toEqual({ text: "Say hello to world", promptTemplate: "greet" });

			await session.prompt("/plan release");
			await session.waitForIdle();
			expect(lastUserMessage(session)).toEqual({ text: "Plan for release", promptTemplate: "plan" });

			await session.prompt("hello there");
			await session.waitForIdle();
			expect(lastUserMessage(session)).toEqual({ text: "hello there", promptTemplate: undefined });
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
