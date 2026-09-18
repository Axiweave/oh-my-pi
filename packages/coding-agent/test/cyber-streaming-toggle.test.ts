/**
 * Regression: FR-008 -- enabling cyber mode while a turn is streaming re-points
 * the active model through `setModelTemporary`, which calls
 * `setModelWithProviderSessionReset` (model-controls.ts). That teardown runs
 * while the provider is mid-response, so the contract the spec states --
 * "It MUST take effect for the next model call, because a streaming turn cannot
 * change its model mid-flight" -- has two halves that only this test pins:
 * the open turn finishes on the model it started with, and the following call
 * uses the allowlisted model.
 *
 * The stream is held open by a gate so the toggle provably happens mid-flight,
 * and the assertion is on the model each real request was issued with.
 *
 * Per T068 (specs/001-cyber-mode/tasks.md), FR-008, Edge Cases.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Gate {
	promise: Promise<void>;
	release: () => void;
}

function gate(): Gate {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, release: resolve };
}

const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5");
const haiku = getBundledModel("anthropic", "claude-haiku-4-5");
if (!sonnet || !haiku) throw new Error("Expected bundled Anthropic models to exist");

function completion(
	model: { api: AssistantMessage["api"]; provider: string; id: string },
	text: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("cyber mode toggled during a streaming turn", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-cyber-streaming-toggle-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	it("leaves the open turn on its own model and re-points the next call", async () => {
		// cyberModels is declared but cyberMode is left off, so the session starts
		// on a model the allowlist excludes and the toggle below has real work.
		const settings = Settings.isolated({ cyberModels: [`${haiku?.provider}/${haiku?.id}`] });

		const requestedModels: string[] = [];
		const gates: Gate[] = [];
		const streamFn: StreamFn = model => {
			requestedModels.push(`${model.provider}/${model.id}`);
			const current = gate();
			gates.push(current);
			const stream = new AssistantMessageEventStream();
			const message = completion(model, `answer ${requestedModels.length}`);
			void current.promise.then(() => {
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: sonnet!, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		const completedModels: string[] = [];
		session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				completedModels.push(`${event.message.provider}/${event.message.model}`);
			}
		});
		expect(session.cyberMode).toBe(false);

		// First turn: start it, then wait for the request to actually be in flight.
		const firstTurn = session.prompt("first question");
		for (let i = 0; i < 500 && gates.length === 0; i++) await Bun.sleep(1);
		expect(gates.length).toBe(1);
		expect(session.isStreaming).toBe(true);
		expect(`${session.model?.provider}/${session.model?.id}`).toBe(`${sonnet?.provider}/${sonnet?.id}`);

		// Toggle mid-flight. The re-point must not disturb the open response.
		const result = await session.setCyberMode(true);

		expect(result.enabled).toBe(true);
		expect(`${session.model?.provider}/${session.model?.id}`).toBe(`${haiku?.provider}/${haiku?.id}`);

		gates[0]!.release();
		await firstTurn;

		// The turn that was already streaming completed on the model it started
		// with -- not aborted, not moved onto the new model mid-response.
		expect(requestedModels).toEqual([`${sonnet?.provider}/${sonnet?.id}`]);
		expect(completedModels).toEqual([`${sonnet?.provider}/${sonnet?.id}`]);

		// The next call is where FR-008 says the re-point takes effect.
		const secondTurn = session.prompt("second question");
		for (let i = 0; i < 500 && gates.length < 2; i++) await Bun.sleep(1);
		expect(gates.length).toBe(2);
		gates[1]!.release();
		await secondTurn;

		expect(requestedModels).toEqual([`${sonnet?.provider}/${sonnet?.id}`, `${haiku?.provider}/${haiku?.id}`]);
		expect(completedModels.at(-1)).toBe(`${haiku?.provider}/${haiku?.id}`);
	});
});
