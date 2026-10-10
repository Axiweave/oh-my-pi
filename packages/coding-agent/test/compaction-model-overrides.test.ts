import { describe, expect, it } from "bun:test";
import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { compactionThresholdSettings, createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	cfgCompaction,
	cfgCompactionModelOverrides,
	cfgCompactionModelThresholds,
	resolveCompactionSettings,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { getSessionCompactionBoundaries } from "@oh-my-pi/pi-coding-agent/session/context-usage-runtime";
import {
	describeModelCompactionPoint,
	planModelCompactionPoint,
	previewModelCompactionPoint,
	setModelCompactionPoint,
} from "@oh-my-pi/pi-coding-agent/session/model-compaction-threshold";

const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5");
const gpt = getBundledModel("openai", "gpt-4o");
if (!sonnet || !gpt) throw new Error("Expected bundled anthropic and openai models to exist");

describe("resolveCompactionSettings", () => {
	it("returns the global group when no overrides are configured", () => {
		const settings = Settings.isolated({ "compaction.thresholdTokens": 200_000 });
		expect(resolveCompactionSettings(settings, sonnet)).toEqual(cfgCompaction.get(settings));
	});

	it("applies a provider wildcard only to matching models", () => {
		const settings = Settings.isolated({
			"compaction.thresholdTokens": 200_000,
			"compaction.modelOverrides": { "anthropic/*": { thresholdTokens: 250_000 } },
		});
		expect(resolveCompactionSettings(settings, sonnet).thresholdTokens).toBe(250_000);
		expect(resolveCompactionSettings(settings, gpt).thresholdTokens).toBe(200_000);
	});

	it("prefers an exact key over a wildcard regardless of order", () => {
		const settings = Settings.isolated({
			"compaction.modelOverrides": {
				"anthropic/*": { thresholdTokens: 1 },
				"anthropic/claude-sonnet-4-5": { thresholdTokens: 2 },
			},
		});
		expect(resolveCompactionSettings(settings, sonnet).thresholdTokens).toBe(2);
	});

	it("uses the first wildcard, not the longest matching prefix", () => {
		const settings = Settings.isolated({
			"compaction.modelOverrides": {
				"anthropic/*": { thresholdTokens: 70_000 },
				"anthropic/claude-*": { thresholdTokens: 80_000 },
			},
		});
		expect(resolveCompactionSettings(settings, sonnet).thresholdTokens).toBe(70_000);
	});

	it("matches exact keys without regard to case", () => {
		const settings = Settings.isolated({
			"compaction.modelOverrides": {
				"anthropic/*": { thresholdTokens: 70_000 },
				"ANTHROPIC/CLAUDE-SONNET-4-5": { thresholdTokens: 80_000 },
			},
		});
		expect(resolveCompactionSettings(settings, sonnet).thresholdTokens).toBe(80_000);
	});

	it("replaces the whole threshold policy on match", () => {
		const settings = Settings.isolated({
			"compaction.thresholdTokens": 200_000,
			"compaction.reserveTokens": 42_000,
			"compaction.modelOverrides": { "anthropic/*": { thresholdPercent: 60 } },
		});
		const resolved = resolveCompactionSettings(settings, sonnet);
		expect(resolved.thresholdTokens).toBe(-1);
		expect(resolved.thresholdPercent).toBe(60);
		expect(resolved.reserveTokens).toBeUndefined();
		expect(resolveThresholdTokens(200_000, resolved)).toBe(120_000);
	});

	it("ignores malformed override entries", () => {
		const settings = Settings.isolated({
			"compaction.thresholdTokens": 200_000,
			"compaction.modelOverrides": { "anthropic/*": "nope" },
		});
		expect(resolveCompactionSettings(settings, sonnet)).toEqual(cfgCompaction.get(settings));
	});

	it("is inherited by subagent settings", () => {
		const overrides = { "openai/*": { thresholdTokens: 250_000 } };
		const child = createSubagentSettings(Settings.isolated({ "compaction.modelOverrides": overrides }));
		expect(cfgCompactionModelOverrides.get(child)).toEqual(overrides);
	});

	it("uses model hub thresholds only when no fork policy matches", () => {
		const settings = Settings.isolated({
			"compaction.thresholdTokens": 200_000,
			"compaction.reserveTokens": 42_000,
			"compaction.modelOverrides": { "anthropic/*": { thresholdPercent: 60 } },
			"compaction.modelThresholds": {
				"anthropic/claude-sonnet-4-5": 50_000,
				"openai/*": 90_000,
			},
		});
		expect(resolveCompactionSettings(settings, sonnet)).toMatchObject({
			thresholdTokens: -1,
			thresholdPercent: 60,
			reserveTokens: undefined,
		});
		expect(resolveCompactionSettings(settings, gpt)).toMatchObject({
			thresholdTokens: -1,
			baseWindowTokens: 90_000,
			reserveTokens: 42_000,
		});
	});

	it("keeps the fork policy in the model hub preview and context gauge", () => {
		const model = { ...sonnet, contextWindow: 200_000 };
		const settings = Settings.isolated({
			"compaction.asyncEnabled": false,
			"compaction.modelOverrides": { "anthropic/*": { thresholdPercent: 60 } },
			"compaction.modelThresholds": { "anthropic/claude-sonnet-4-5": 50_000 },
		});
		expect(describeModelCompactionPoint(settings, model)).toMatchObject({
			tokens: 120_000,
			source: "modelOverrides:anthropic/*",
		});
		expect(getSessionCompactionBoundaries(settings, model.contextWindow, model)).toEqual({
			thresholdPercent: 60,
			speculationPercent: null,
		});
		cfgCompactionModelOverrides.override(settings, { "anthropic/*": { thresholdTokens: 70_000 } });
		expect(describeModelCompactionPoint(settings, model).tokens).toBe(70_000);
		expect(getSessionCompactionBoundaries(settings, model.contextWindow, model)?.thresholdPercent).toBe(35);
	});

	it("lets task overrides win over live edits to both model maps for that agent only", () => {
		const root = Settings.isolated({
			"compaction.modelOverrides": { "anthropic/*": { thresholdTokens: 70_000 } },
			"compaction.modelThresholds": { "anthropic/claude-sonnet-4-5": 50_000 },
		});
		const agent = createSubagentSettings(
			root,
			compactionThresholdSettings({ thresholdPercent: 50, thresholdTokens: -1 }),
		);
		expect(resolveCompactionSettings(agent, sonnet)).toMatchObject({
			thresholdPercent: 50,
			thresholdTokens: -1,
		});
		cfgCompactionModelOverrides.override(root, { "anthropic/*": { thresholdTokens: 80_000 } });
		cfgCompactionModelThresholds.override(root, { "anthropic/claude-sonnet-4-5": 60_000 });
		expect(resolveCompactionSettings(agent, sonnet)).toMatchObject({
			thresholdPercent: 50,
			thresholdTokens: -1,
		});
		const grandchild = createSubagentSettings(agent);
		expect(resolveCompactionSettings(grandchild, sonnet).thresholdTokens).toBe(80_000);
		cfgCompactionModelOverrides.override(root, {});
		expect(resolveCompactionSettings(grandchild, sonnet).baseWindowTokens).toBe(60_000);
	});
});

describe("model hub compaction edits", () => {
	it("refuses a fork-shadowed edit before changing the model hub map", () => {
		const settings = Settings.isolated({
			"compaction.modelOverrides": { "anthropic/*": { thresholdTokens: 70_000 } },
		});
		cfgCompactionModelThresholds.set(settings, { "anthropic/claude-sonnet-4-5": 50_000 });
		expect(() => setModelCompactionPoint(settings, sonnet, "90k")).toThrow("compaction.modelOverrides.anthropic/*");
		expect(cfgCompactionModelThresholds.get(settings)).toEqual({ "anthropic/claude-sonnet-4-5": 50_000 });
		expect(setModelCompactionPoint(settings, sonnet, "")).toMatchObject({ kind: "saved", entry: undefined });
		expect(cfgCompactionModelThresholds.get(settings)).toEqual({});
		expect(resolveCompactionSettings(settings, sonnet).thresholdTokens).toBe(70_000);
	});

	it("previews only what a save would apply under a fork policy", () => {
		const model = { ...sonnet, contextWindow: 200_000 };
		const settings = Settings.isolated({
			extendedContext: false,
			"compaction.modelOverrides": { "anthropic/*": { thresholdTokens: 70_000 } },
			"compaction.modelThresholds": { "anthropic/claude-sonnet-4-5": 50_000 },
		});
		const tiers = { standard: 200_000, extended: 1_000_000 };
		expect(planModelCompactionPoint(settings, model, "400k", tiers)).toBeUndefined();
		expect(previewModelCompactionPoint(settings, model, "400k", tiers)).toBeUndefined();
		expect(planModelCompactionPoint(settings, model, "", tiers)).toMatchObject({
			reset: true,
			window: 200_000,
			trigger: { kind: "fixed", tokens: 70_000 },
		});
	});

	it("keeps model hub edits and reset behavior when no fork policy matches", () => {
		const settings = Settings.isolated({
			"compaction.thresholdTokens": 200_000,
			"compaction.modelOverrides": { "openai/*": { thresholdTokens: 70_000 } },
		});
		expect(setModelCompactionPoint(settings, sonnet, "60%")).toMatchObject({ kind: "saved", entry: "60%" });
		expect(resolveCompactionSettings(settings, sonnet)).toMatchObject({
			thresholdTokens: -1,
			thresholdPercent: 60,
		});
		expect(describeModelCompactionPoint(settings, sonnet)).toMatchObject({
			source: "anthropic/claude-sonnet-4-5",
			draft: "60%",
		});
		expect(setModelCompactionPoint(settings, sonnet, "")).toMatchObject({ kind: "saved", entry: undefined });
		expect(resolveCompactionSettings(settings, sonnet).thresholdTokens).toBe(200_000);
	});

	it("refuses a model hub edit when a task override disables both model maps", () => {
		const settings = createSubagentSettings(
			Settings.isolated(),
			compactionThresholdSettings({ thresholdPercent: 50, thresholdTokens: -1 }),
		);
		expect(() => setModelCompactionPoint(settings, sonnet, "90k")).toThrow(
			"Per-model compaction policies are disabled",
		);
		expect(cfgCompactionModelThresholds.get(settings)).toEqual({});
	});
});
