/**
 * Regression: `SessionMaintenance#resolveCompactionModelCandidates` is the
 * shared candidate-construction seam behind manual `/compact`, auto-compaction,
 * speculative compaction, and the advisor's compaction fallback
 * (`session-advisors.ts`). Two of its sources bypassed cyber mode protection:
 * the supplied preferred/current model (added unconditionally) and the
 * largest-context catalog fallback (a raw scan over every available model).
 *
 * These tests exercise the seam directly with a minimal stub host -- the
 * method only ever reads `host.settings`, so no session, agent, or model
 * registry is needed. See `compaction-cyber-dispatch.test.ts` for the
 * full-session tests proving the fix also reaches the actual network request.
 *
 * Per T057 (specs/001-cyber-mode/tasks.md), FR-006, FR-013, FR-030, FR-031.
 */

import { describe, expect, it } from "bun:test";
import { type Api, type Model, type ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveCyberAllowlist } from "@oh-my-pi/pi-coding-agent/config/cyber-mode";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";

function makeModel(
	provider: string,
	id: string,
	contextWindow: number,
	extra: Partial<ModelSpec<Api>> = {},
): Model<Api> {
	const spec: ModelSpec<Api> = {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: `https://api.${provider}.example/v1`,
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow,
		maxTokens: 8_192,
		...extra,
	};
	return buildModel(spec);
}

/**
 * Installs protection under an owner name that is deliberately not "this
 * session" -- `resolveCompactionModelCandidates` has no notion of a session's
 * own cyber indicator at all, only the shared installed allowlist
 * (FR-030: protection is shared regardless of who installed it).
 */
function withProtection(cyberModels: Model<Api>[], catalogForResolution: Model<Api>[], owner = "protector"): Settings {
	const settings = Settings.isolated({ cyberModels: cyberModels.map(model => formatModelString(model)) });
	const allowlist = resolveCyberAllowlist(settings, catalogForResolution);
	if (!allowlist) throw new Error("expected the declared allowlist to resolve");
	settings.applyCyberRoles(owner, allowlist);
	return settings;
}

function maintenanceFor(settings: Settings): SessionMaintenance {
	return new SessionMaintenance({ settings } as unknown as SessionMaintenanceHost);
}

describe("resolveCompactionModelCandidates honors cyber mode protection", () => {
	it("drops an excluded preferred/current model and lands on the allowed catalog fallback", () => {
		const currentExcluded = makeModel("openai", "current-excluded", 50_000);
		const smallAllowed = makeModel("anthropic", "small-allowed", 100_000);
		const availableModels = [currentExcluded, smallAllowed];
		const settings = withProtection([smallAllowed], availableModels);
		const maintenance = maintenanceFor(settings);

		const candidates = maintenance.resolveCompactionModelCandidates(currentExcluded, availableModels);

		expect(candidates).toEqual([smallAllowed]);
	});

	for (const excludedCount of [1, 2, 3]) {
		it(`walks past ${excludedCount} excluded larger-context catalog entries to reach the allowed one`, () => {
			const excludedModels = Array.from({ length: excludedCount }, (_, index) =>
				makeModel("openai", `big-excluded-${index}`, 1_000_000 - index * 1_000),
			);
			const smallAllowed = makeModel("anthropic", "small-allowed", 10_000);
			const availableModels = [...excludedModels, smallAllowed];
			const settings = withProtection([smallAllowed], availableModels);
			const maintenance = maintenanceFor(settings);

			const candidates = maintenance.resolveCompactionModelCandidates(undefined, availableModels);

			expect(candidates).toEqual([smallAllowed]);
		});
	}

	it("gives the caller's filter exactly one shot at the first cyber-allowed catalog candidate, matching pre-existing filter semantics", () => {
		const bigExcluded = makeModel("openai", "big-excluded", 500_000);
		const midAllowedFilterRejected = makeModel("anthropic", "mid-allowed-filter-rejected", 400_000);
		const smallAllowedFilterAccepted = makeModel("google", "small-allowed-filter-accepted", 100_000);
		const availableModels = [bigExcluded, midAllowedFilterRejected, smallAllowedFilterAccepted];
		const settings = withProtection([midAllowedFilterRejected, smallAllowedFilterAccepted], availableModels);
		const maintenance = maintenanceFor(settings);

		const candidates = maintenance.resolveCompactionModelCandidates(
			undefined,
			availableModels,
			candidate => candidate.provider === "google",
		);

		// The walk skips the cyber-excluded top entry (big), then gives the
		// caller's filter exactly one shot at the next cyber-allowed entry
		// (mid). The filter's rejection ends the fallback there -- exactly as
		// it did before cyber filtering existed. It must not keep hunting for
		// a later entry (small) that would also satisfy the filter, or the
		// caller's "only the top remaining candidate" contract would change.
		expect(candidates).toEqual([]);
	});

	it("preserves the relative order of allowed candidates and drops an excluded role entry without leaving a gap", () => {
		const configuredTargetAllowed = makeModel("anthropic", "configured-target-allowed", 70_000);
		const currentAllowed = makeModel("anthropic", "current-allowed", 60_000, {
			compactionModel: `${configuredTargetAllowed.provider}/${configuredTargetAllowed.id}`,
		});
		const roleAllowed = makeModel("anthropic", "role-allowed", 80_000);
		const excludedFiller = makeModel("openai", "excluded-filler", 90_000);
		const availableModels = [configuredTargetAllowed, currentAllowed, roleAllowed, excludedFiller];
		const settings = withProtection([configuredTargetAllowed, currentAllowed, roleAllowed], availableModels);
		settings.setModelRole("smol", `${excludedFiller.provider}/${excludedFiller.id}`);
		settings.setModelRole("slow", `${roleAllowed.provider}/${roleAllowed.id}`);
		const maintenance = maintenanceFor(settings);

		const candidates = maintenance.resolveCompactionModelCandidates(currentAllowed, availableModels);

		expect(candidates).toEqual([configuredTargetAllowed, currentAllowed, roleAllowed]);
	});

	it("off: contributes every source unfiltered, matching behavior from before cyber mode existed", () => {
		const current = makeModel("openai", "current", 50_000);
		const catalogPick = makeModel("anthropic", "catalog-pick", 100_000);
		const availableModels = [current, catalogPick];
		const settings = Settings.isolated({});
		const maintenance = maintenanceFor(settings);

		const candidates = maintenance.resolveCompactionModelCandidates(current, availableModels);

		expect(candidates).toEqual([current, catalogPick]);
	});

	it("exhausts to no candidates when the allowlisted model is outside this call's available models", () => {
		const currentExcluded = makeModel("openai", "current-excluded-2", 50_000);
		const otherExcluded = makeModel("openai", "other-excluded-2", 60_000);
		const elsewhereAllowed = makeModel("anthropic", "elsewhere-allowed-2", 40_000);
		// Resolve the allowlist against a broader catalog that includes the
		// allowed model, but this call's available models omit it -- mirroring
		// a session whose registry legitimately doesn't expose it. Cyber mode
		// stays validly enabled (an unresolvable allowlist would refuse to
		// enable at all), yet this particular compaction call still finds
		// nothing it may use.
		const settings = withProtection([elsewhereAllowed], [currentExcluded, otherExcluded, elsewhereAllowed]);
		const maintenance = maintenanceFor(settings);

		const candidates = maintenance.resolveCompactionModelCandidates(currentExcluded, [
			currentExcluded,
			otherExcluded,
		]);

		expect(candidates).toEqual([]);
	});
});

describe("resolveContextPromotionTarget honors cyber mode protection", () => {
	function promotionMaintenance(settings: Settings, availableModels: Model<Api>[]): SessionMaintenance {
		return new SessionMaintenance({
			settings,
			modelRegistry: { getAvailable: () => availableModels, getApiKey: async () => "key" },
			sessionId: () => "cyber-promotion-session",
		} as unknown as SessionMaintenanceHost);
	}

	function promotingModel(id: string, contextWindow: number, target: string): Model<Api> {
		const model = makeModel("anthropic", id, contextWindow);
		(model as Model<Api> & { contextPromotionTarget?: string }).contextPromotionTarget = target;
		return model;
	}

	it("refuses a configured larger-context target the allowlist excludes", async () => {
		const target = makeModel("openai", "target-excluded", 200_000);
		const current = promotingModel("current-allowed", 100_000, "openai/target-excluded");
		const availableModels = [current, target];
		const settings = withProtection([current], availableModels);

		expect(
			await promotionMaintenance(settings, availableModels).resolveContextPromotionTarget(current, 100_000),
		).toBeUndefined();
	});

	it("promotes to a configured larger-context target the allowlist covers", async () => {
		const target = makeModel("openai", "target-allowed", 200_000);
		const current = promotingModel("current-allowed", 100_000, "openai/target-allowed");
		const availableModels = [current, target];
		const settings = withProtection([current, target], availableModels);

		expect(
			await promotionMaintenance(settings, availableModels).resolveContextPromotionTarget(current, 100_000),
		).toBe(target);
	});
});
