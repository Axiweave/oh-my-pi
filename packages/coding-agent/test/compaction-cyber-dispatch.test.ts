/**
 * Regression: cyber mode protection must reach the actual compaction network
 * request, not just candidate construction. `#compactWithFallbackModel` and
 * the auto-compaction dispatch loop both consume a `candidates` array that can
 * be built before protection existed (the manual `/compact` path threads it
 * through as `precomputedCandidates` across several awaited steps). A
 * candidate list computed while unprotected can outlive a protection change
 * that happens before dispatch, so dispatch itself must re-check membership.
 *
 * These tests drive `session.compact()` end-to-end with a mocked
 * `compact()` transport (no network) and assert on the actual model the
 * mock was invoked with. See `compaction-cyber-candidates.test.ts` for the
 * lighter, combinatorial candidate-construction coverage.
 *
 * Per T057 (specs/001-cyber-mode/tasks.md), FR-006, FR-013, FR-030, FR-031.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveCyberAllowlist } from "@oh-my-pi/pi-coding-agent/config/cyber-mode";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { assistantMsg, userMsg } from "./utilities";

/** Two rounds of history so `prepareCompaction` has something to summarize. */
function seedTranscript(session: AgentSession): void {
	for (const [userText, assistantText] of [
		["first question", "first answer"],
		["second question", "second answer"],
	] as const) {
		const user = userMsg(userText);
		const assistant = assistantMsg(assistantText);
		session.agent.appendMessage(user);
		session.sessionManager.appendMessage(user);
		session.agent.appendMessage(assistant);
		session.sessionManager.appendMessage(assistant);
	}
}

describe("compaction dispatch honors cyber mode protection", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-compact-cyber-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage?.close();
		tempDir.removeSync();
	});

	it("never requests the cyber-excluded current model, and reaches the allowed catalog fallback", async () => {
		const currentModel = getBundledModel("openai", "gpt-5");
		const allowedFallback = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!currentModel || !allowedFallback) throw new Error("Expected bundled test models to exist");

		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["soft"],
			cyberMode: true,
			cyberModels: [`${allowedFallback.provider}/${allowedFallback.id}`],
		});

		const agent = new Agent({
			initialState: { model: currentModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(currentModel.provider, "excluded-token");
		authStorage.setRuntimeApiKey(allowedFallback.provider, "allowed-token");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		const session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		sessions.push(session);
		session.subscribe(() => {});
		expect(session.cyberMode).toBe(true);
		seedTranscript(session);

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new Error(`compaction requested the cyber-excluded current model ${model.provider}/${model.id}`);
			}
			if (model.provider !== allowedFallback.provider || model.id !== allowedFallback.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "ok",
				shortSummary: "ok short",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 1,
				details: {},
			};
		});

		const result = await session.compact();

		expect(result.summary).toBe("ok");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const [, requestedModel] = compactSpy.mock.calls[0]!;
		expect(`${requestedModel.provider}/${requestedModel.id}`).toBe(
			`${allowedFallback.provider}/${allowedFallback.id}`,
		);
	});

	it("does not dispatch a precomputed candidate that protection excluded after the candidate list was built", async () => {
		const currentModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const allowedFallback = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!currentModel || !allowedFallback) throw new Error("Expected bundled test models to exist");

		// cyberModels is declared but cyberMode is left off: the manual
		// /compact path computes its candidate list unprotected (both models
		// pass), and this test installs protection inside the async gap
		// before dispatch -- the exact window `precomputedCandidates` crosses
		// between session-maintenance.ts's candidate build (~line 1130) and
		// its later `compact()` call (~line 1357).
		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["soft"],
			cyberModels: [`${allowedFallback.provider}/${allowedFallback.id}`],
		});
		settings.setModelRole("smol", `${allowedFallback.provider}/${allowedFallback.id}`);

		const agent = new Agent({
			initialState: { model: currentModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(currentModel.provider, "shared-token");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		const session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		sessions.push(session);
		session.subscribe(() => {});
		expect(session.cyberMode).toBe(false);
		seedTranscript(session);

		const realPrepareCompaction = compactionModule.prepareCompaction;
		let installed = false;
		vi.spyOn(compactionModule, "prepareCompaction").mockImplementation(
			(pathEntries, methodSettings, activeModel, tokenizer) => {
				if (!installed) {
					installed = true;
					const allowlist = resolveCyberAllowlist(settings, modelRegistry.getAvailable());
					if (!allowlist) throw new Error("expected the declared allowlist to resolve");
					settings.applyCyberRoles("late-protector", allowlist);
				}
				return realPrepareCompaction(pathEntries, methodSettings, activeModel, tokenizer);
			},
		);

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new Error(`compaction requested the cyber-excluded stale candidate ${model.provider}/${model.id}`);
			}
			if (model.provider !== allowedFallback.provider || model.id !== allowedFallback.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "recovered",
				shortSummary: "recovered short",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 1,
				details: {},
			};
		});

		const result = await session.compact();

		expect(installed).toBe(true);
		expect(result.summary).toBe("recovered");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const [, requestedModel] = compactSpy.mock.calls[0]!;
		expect(`${requestedModel.provider}/${requestedModel.id}`).toBe(
			`${allowedFallback.provider}/${allowedFallback.id}`,
		);
	});

	it("stays inside a sibling session's shared protection even though this session's own cyber indicator is off", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const allowedFallback = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!primaryModel || !allowedFallback) throw new Error("Expected bundled test models to exist");

		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["soft"],
			cyberModels: [`${allowedFallback.provider}/${allowedFallback.id}`],
		});
		settings.setModelRole("smol", `${allowedFallback.provider}/${allowedFallback.id}`);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(primaryModel.provider, "shared-token");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		const parentAgent = new Agent({
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const parent = new AgentSession({
			agent: parentAgent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		sessions.push(parent);
		parent.subscribe(() => {});

		const siblingAgent = new Agent({
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const sibling = new AgentSession({
			agent: siblingAgent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		sessions.push(sibling);
		sibling.subscribe(() => {});

		// The sibling installs protection on the settings the two sessions
		// share; the parent never toggles its own switch.
		await sibling.setCyberMode(true);
		expect(parent.cyberMode).toBe(false);

		seedTranscript(parent);

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
				throw new Error(`compaction requested the cyber-excluded model ${model.provider}/${model.id}`);
			}
			if (model.provider !== allowedFallback.provider || model.id !== allowedFallback.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "constrained",
				shortSummary: "constrained short",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 1,
				details: {},
			};
		});

		const result = await parent.compact();

		expect(result.summary).toBe("constrained");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const [, requestedModel] = compactSpy.mock.calls[0]!;
		expect(`${requestedModel.provider}/${requestedModel.id}`).toBe(
			`${allowedFallback.provider}/${allowedFallback.id}`,
		);
	});

	it("aborts a stale request inside a multi-request compact() call and lets the outer loop skip to a still-allowed candidate", async () => {
		const firstCandidate = getBundledModel("anthropic", "claude-sonnet-4-5");
		const allowedFallback = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!firstCandidate || !allowedFallback) throw new Error("Expected bundled test models to exist");

		// Declared but not installed: both candidates pass when the manual
		// /compact path builds its list. A single compact() call can issue
		// several internal requests through `completeImpl` (a summary oneshot,
		// then a short-summary oneshot); this installs protection in the gap
		// between two such requests for the SAME candidate.
		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["soft"],
			cyberModels: [`${allowedFallback.provider}/${allowedFallback.id}`],
		});
		settings.setModelRole("smol", `${allowedFallback.provider}/${allowedFallback.id}`);

		// A real, network-free side-stream transport so the actual
		// `completeImpl` closure in session-maintenance.ts runs for real
		// (only the top-level `compact()` engine call is mocked below).
		const sideStreamFn: StreamFn = requestModel => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					stopReason: "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const agent = new Agent({
			initialState: { model: firstCandidate, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(firstCandidate.provider, "shared-token");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			sideStreamFn,
		});
		sessions.push(session);
		session.subscribe(() => {});
		expect(session.cyberMode).toBe(false);
		seedTranscript(session);

		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockImplementation(async (preparation, model, _resolver, _customInstructions, _signal, options) => {
				if (model.provider === firstCandidate.provider && model.id === firstCandidate.id) {
					if (!options?.completeImpl) throw new Error("Expected completeImpl to be set");
					// First internal request: protection isn't installed yet.
					await options.completeImpl(model, { messages: [] }, {});
					const allowlist = resolveCyberAllowlist(settings, modelRegistry.getAvailable());
					if (!allowlist) throw new Error("expected the declared allowlist to resolve");
					settings.applyCyberRoles("late-protector", allowlist);
					// Second internal request for the SAME now-excluded model:
					// must refuse instead of silently completing.
					await options.completeImpl(model, { messages: [] }, {});
					throw new Error("unreachable: the second completeImpl call should have refused the excluded model");
				}
				if (model.provider !== allowedFallback.provider || model.id !== allowedFallback.id) {
					throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
				}
				return {
					summary: "recovered",
					shortSummary: "recovered short",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: 1,
					details: {},
				};
			});

		const result = await session.compact();

		expect(result.summary).toBe("recovered");
		expect(compactSpy).toHaveBeenCalledTimes(2);
		const [, secondRequestedModel] = compactSpy.mock.calls[1]!;
		expect(`${secondRequestedModel.provider}/${secondRequestedModel.id}`).toBe(
			`${allowedFallback.provider}/${allowedFallback.id}`,
		);
	});

	it("wraps auto-compaction's default transport with the same re-checked-per-request guard", async () => {
		const firstCandidate = getBundledModel("anthropic", "claude-sonnet-4-5");
		const allowedFallback = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!firstCandidate || !allowedFallback) throw new Error("Expected bundled test models to exist");

		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["soft"],
			cyberModels: [`${allowedFallback.provider}/${allowedFallback.id}`],
		});
		settings.setModelRole("smol", `${allowedFallback.provider}/${allowedFallback.id}`);

		const agent = new Agent({
			initialState: { model: firstCandidate, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(firstCandidate.provider, "shared-token");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		const session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		sessions.push(session);
		let committedSummary: string | undefined;
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") committedSummary = event.result?.summary;
		});
		expect(session.cyberMode).toBe(false);
		seedTranscript(session);

		// Auto-compaction has no side-stream transport override -- it goes
		// through the engine's default completeImpl (`completeSimple`). Stub
		// that shared transport primitive itself (network-free): everything
		// else below (the completeImpl wrapper, the cyber guard, the outer
		// candidate loop) still runs for real.
		vi.spyOn(ai, "completeSimple").mockImplementation(async requestModel => ({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: requestModel.api,
			provider: requestModel.provider,
			model: requestModel.id,
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		}));

		// A single compact() call can issue several internal requests through
		// `completeImpl` (a summary oneshot, then a short-summary oneshot).
		// This installs protection in the gap between two such requests for the
		// SAME candidate -- the same race the manual-path test above covers --
		// to prove the auto-compaction wrapper guards it too.
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockImplementation(async (preparation, model, _resolver, _customInstructions, _signal, options) => {
				if (model.provider === firstCandidate.provider && model.id === firstCandidate.id) {
					if (!options?.completeImpl) throw new Error("Expected completeImpl to be set");
					// First internal request: protection isn't installed yet.
					await options.completeImpl(model, { messages: [] }, {});
					const allowlist = resolveCyberAllowlist(settings, modelRegistry.getAvailable());
					if (!allowlist) throw new Error("expected the declared allowlist to resolve");
					settings.applyCyberRoles("late-protector", allowlist);
					// Second internal request for the SAME now-excluded model:
					// must refuse instead of silently completing.
					await options.completeImpl(model, { messages: [] }, {});
					throw new Error("unreachable: the second completeImpl call should have refused the excluded model");
				}
				if (model.provider !== allowedFallback.provider || model.id !== allowedFallback.id) {
					throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
				}
				return {
					summary: "auto-recovered",
					shortSummary: "auto-recovered short",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: 1,
					details: {},
				};
			});

		await session.runIdleCompaction();

		expect(compactSpy).toHaveBeenCalledTimes(2);
		const [, secondRequestedModel] = compactSpy.mock.calls[1]!;
		expect(`${secondRequestedModel.provider}/${secondRequestedModel.id}`).toBe(
			`${allowedFallback.provider}/${allowedFallback.id}`,
		);
		expect(committedSummary).toBe("auto-recovered");
	});
});
