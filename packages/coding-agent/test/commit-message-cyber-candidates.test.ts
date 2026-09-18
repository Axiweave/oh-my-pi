/**
 * Regression: `getSmolModelCandidates` (commit-message-generator.ts) built its
 * candidate list from the raw catalogue -- the configured `smol` role, then
 * every `MODEL_PRIO.smol` priority match, then every available model -- with no
 * cyber-mode membership check, and `generateCommitMessage` dispatched
 * `completeSimple` on the first candidate holding an API key. The generator
 * runs on live session settings (`makeIsolationCommitMessage` passes
 * `session.settings`), so isolated runs with `task.isolation.commits: "ai"`
 * dispatched a background completion to a model the operator's allowlist
 * excludes whenever the allowlisted candidate was unavailable or errored.
 *
 * These tests drive `generateCommitMessage` itself with a stubbed registry and
 * an intercepted `completeSimple`, so the assertion is on the model that would
 * actually receive the request -- not on the candidate list.
 *
 * Per T067 (specs/001-cyber-mode/tasks.md), FR-013, SC-010.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { type Api, type Model, type ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveCyberAllowlist } from "@oh-my-pi/pi-coding-agent/config/cyber-mode";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { generateCommitMessage } from "@oh-my-pi/pi-coding-agent/utils/commit-message-generator";

function makeModel(provider: string, id: string): Model<Api> {
	const spec: ModelSpec<Api> = {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: `https://api.${provider}.example/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	};
	return buildModel(spec);
}

function withProtection(cyberModels: Model<Api>[], catalog: Model<Api>[]): Settings {
	const settings = Settings.isolated({ cyberModels: cyberModels.map(model => formatModelString(model)) });
	const allowlist = resolveCyberAllowlist(settings, catalog);
	if (!allowlist) throw new Error("expected the declared allowlist to resolve");
	settings.applyCyberRoles("protector", allowlist);
	return settings;
}

function registryFor(catalog: Model<Api>[]): ModelRegistry {
	return {
		getAvailable: () => catalog,
		getApiKey: async () => "test-key",
		resolver: () => async () => "test-key",
	} as unknown as ModelRegistry;
}

/** Records the model each request lands on, and answers with `textFor(model)`. */
function interceptCompletions(textFor: (model: Model<Api>) => string | undefined): string[] {
	const dispatched: string[] = [];
	vi.spyOn(ai, "completeSimple").mockImplementation((async (model: Model<Api>) => {
		dispatched.push(formatModelString(model));
		const text = textFor(model);
		if (text === undefined) {
			return { stopReason: "error", errorMessage: "denied", content: [] };
		}
		return { stopReason: "end_turn", content: [{ type: "text", text }] };
	}) as unknown as typeof ai.completeSimple);
	return dispatched;
}

const DIFF = "diff --git a/x b/x\n+change\n";

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("generateCommitMessage honors cyber mode protection", () => {
	it("dispatches the allowlisted model, not the excluded one the priority scan would otherwise win with", async () => {
		// `claude-haiku-4-5` is the first `MODEL_PRIO.smol` needle this catalogue
		// satisfies, so it took the dispatch before the fix even though the
		// operator allowlisted only the second entry.
		const excludedPriorityMatch = makeModel("anthropic", "claude-haiku-4-5");
		const allowed = makeModel("openai", "gpt-5-mini");
		const catalog = [excludedPriorityMatch, allowed];
		const settings = withProtection([allowed], catalog);
		const dispatched = interceptCompletions(() => "feat: allowed");

		const message = await generateCommitMessage(DIFF, registryFor(catalog), settings);

		expect(dispatched).toEqual([formatModelString(allowed)]);
		expect(message).toBe("feat: allowed");
	});

	it("skips each excluded entry and keeps falling through to the next allowed candidate", async () => {
		// Excluded entries must be skipped, not terminal: the walk still has to
		// reach `allowed-b` after the first allowed candidate errors, exactly as
		// the fallback walk did before cyber filtering existed.
		const firstExcluded = makeModel("anthropic", "claude-haiku-4-5");
		const secondExcluded = makeModel("anthropic", "claude-haiku-4.5");
		const allowedA = makeModel("openai", "allowed-a");
		const allowedB = makeModel("google", "allowed-b");
		const catalog = [firstExcluded, allowedA, secondExcluded, allowedB];
		const settings = withProtection([allowedA, allowedB], catalog);
		const dispatched = interceptCompletions(model => (model.id === "allowed-a" ? undefined : "feat: allowed-b"));

		const message = await generateCommitMessage(DIFF, registryFor(catalog), settings);

		expect(dispatched).toEqual([formatModelString(allowedA), formatModelString(allowedB)]);
		expect(message).toBe("feat: allowed-b");
	});

	it("leaves the walk unfiltered when no protection is installed", async () => {
		// Same catalogue as the first case, protection off: the priority match
		// still wins, which is what makes the gating above the only difference.
		const priorityMatch = makeModel("anthropic", "claude-haiku-4-5");
		const other = makeModel("openai", "gpt-5-mini");
		const catalog = [priorityMatch, other];
		const settings = Settings.isolated({});
		const dispatched = interceptCompletions(() => "feat: unfiltered");

		const message = await generateCommitMessage(DIFF, registryFor(catalog), settings);

		expect(dispatched).toEqual([formatModelString(priorityMatch)]);
		expect(message).toBe("feat: unfiltered");
	});
});
