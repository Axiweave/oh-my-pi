import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

describe("AgentSession file mentions", () => {
	it("attaches only the selected lines before the first provider request without tools", async () => {
		using tempDir = TempDir.createSync("@pi-agent-session-file-mentions-");
		const authStorage = await AuthStorage.create(":memory:");
		let session: AgentSession | undefined;
		try {
			const lines = [
				"RANGE_SOURCE_OUTSIDE_ONE_7f413b",
				"RANGE_SOURCE_SELECTED_TWO_d064ac",
				"RANGE_SOURCE_SELECTED_THREE_982e5d",
				"RANGE_SOURCE_OUTSIDE_FOUR_106ec9",
				"RANGE_SOURCE_OUTSIDE_FIVE_15e9bb",
			];
			fs.writeFileSync(path.join(tempDir.path(), "range-source.txt"), lines.join("\n"));
			authStorage.keys.setRuntime("anthropic", "test-key");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
			const requests: Context[] = [];
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: (_model, context) => {
					requests.push(structuredClone(context));
					const response: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "Done" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 0,
					};
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: response });
						stream.push({ type: "done", reason: "stop", message: response });
					});
					return stream;
				},
			});
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings: Settings.isolated({
					"compaction.enabled": false,
					"task.eager": "default",
					"todo.enabled": false,
					"todo.eager": "default",
					"todo.reminders": false,
				}),
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			});
			let toolExecutions = 0;
			session.subscribe(event => {
				if (event.type === "tool_execution_start") toolExecutions++;
			});

			const prompt = "Review @range-source.txt:2-3";
			await session.prompt(prompt);

			expect(requests).toHaveLength(1);
			const firstRequest = requests[0]!;
			const text = firstRequest.messages
				.flatMap(message =>
					typeof message.content === "string"
						? [message.content]
						: message.content.flatMap(block => (block.type === "text" && "text" in block ? [block.text] : [])),
				)
				.join("\n");
			expect(text).toContain(lines[1]!);
			expect(text).toContain(lines[2]!);
			for (const outside of [lines[0]!, lines[3]!, lines[4]!]) expect(text).not.toContain(outside);
			expect(text).toContain(prompt);
			expect(firstRequest.tools ?? []).toEqual([]);
			expect(toolExecutions).toBe(0);
			expect(firstRequest.messages.filter(message => message.role === "toolResult")).toEqual([]);
			expect(session.messages.filter(message => message.role === "toolResult")).toEqual([]);
		} finally {
			try {
				await session?.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
});
