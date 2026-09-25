import { describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { resolveCyberAllowlist } from "../../src/config/cyber-mode";
import type { ModelRegistry } from "../../src/config/model-registry";
import { cfgCyberMode, cfgCyberModels } from "../../src/config/model-settings";
import { Settings } from "../../src/config/settings";
import { resolveJudge, type JudgeDeps } from "../../src/judgment";

function makeModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 4096,
	} as Model<Api>;
}

function installCyberAllowlist(settings: Settings, allowedSelectors: string[], catalog: Model<Api>[]): void {
	cfgCyberModels.set(settings, allowedSelectors);
	const allowlist = resolveCyberAllowlist(settings, catalog);
	if (!allowlist) throw new Error("test setup: cyberModels did not resolve to an allowlist");
	// Installed the way a sibling session or shared configuration would; this
	// settings object's own `cyberMode` flag is never switched on, matching
	// FR-029/FR-030 shared-protection-independent-of-own-state semantics.
	settings.applyCyberRoles("shared", allowlist);
}

describe("resolveJudge online fallback under cyber mode protection", () => {
	it("does not fall back to an excluded session model when the shared allowlist blocks it", async () => {
		const excludedSession = makeModel("p", "session-excluded");
		const allowedOther = makeModel("p", "allowed-other");
		const settings = Settings.isolated();
		installCyberAllowlist(settings, ["p/allowed-other"], [excludedSession, allowedOther]);
		expect(cfgCyberMode.get(settings)).not.toBe(true);
		const apiKeySpy = vi.fn(async () => undefined);
		const deps: JudgeDeps = {
			settings,
			registry: { getAvailable: () => [], getApiKey: apiKeySpy } as unknown as ModelRegistry,
			sessionModel: excludedSession,
		};

		const judge = resolveJudge(deps);

		await expect(
			judge.judge({ state: "s", questions: { ok: { type: "noul", instructions: "ok?" } } }),
		).rejects.toThrow();
		expect(apiKeySpy).not.toHaveBeenCalled();
	});

	it("still falls back to an allowed session model when nothing else resolves", async () => {
		const allowedSession = makeModel("p", "session-allowed");
		const settings = Settings.isolated();
		installCyberAllowlist(settings, ["p/session-allowed"], [allowedSession]);
		const apiKeySpy = vi.fn(async () => undefined);
		const deps: JudgeDeps = {
			settings,
			registry: { getAvailable: () => [], getApiKey: apiKeySpy } as unknown as ModelRegistry,
			sessionModel: allowedSession,
		};

		const judge = resolveJudge(deps);

		await expect(
			judge.judge({ state: "s", questions: { ok: { type: "noul", instructions: "ok?" } } }),
		).rejects.toThrow(/every judge candidate failed/);
		expect(apiKeySpy).toHaveBeenCalledTimes(1);
		expect(apiKeySpy).toHaveBeenCalledWith(allowedSession, undefined, expect.objectContaining({}));
	});

	it("still blocks a session model that only becomes excluded after candidates were already collected", async () => {
		const midFlight = makeModel("p", "mid-flight");
		const siblingChoice = makeModel("p", "someone-else");
		const settings = Settings.isolated();
		// No protection installed yet: the session model is still unprotected
		// when ChainJudge collects its candidates.
		const backendSpy = vi.spyOn(ai, "chatTextBackend").mockImplementation(() => {
			throw new Error("must not construct a backend for an excluded model");
		});
		const apiKeySpy = vi.fn(async () => {
			// A sibling session installs protection while this judge call is
			// already in flight, after candidates were already collected.
			// The catalog includes a model the new pattern actually matches, so
			// the allowlist genuinely resolves and excludes mid-flight, rather
			// than failing installation outright.
			installCyberAllowlist(settings, ["p/someone-else"], [midFlight, siblingChoice]);
			return "test-key";
		});
		const deps: JudgeDeps = {
			settings,
			registry: {
				getAvailable: () => [],
				getApiKey: apiKeySpy,
				resolver: () => undefined,
			} as unknown as ModelRegistry,
			sessionModel: midFlight,
		};

		const judge = resolveJudge(deps);

		await expect(
			judge.judge({ state: "s", questions: { ok: { type: "noul", instructions: "ok?" } } }),
		).rejects.toThrow();
		expect(backendSpy).not.toHaveBeenCalled();
		backendSpy.mockRestore();
	});
});
