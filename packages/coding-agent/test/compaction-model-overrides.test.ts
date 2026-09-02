import { describe, expect, it } from "bun:test";
import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveCompactionSettings } from "@oh-my-pi/pi-coding-agent/session/compaction-methods";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";

const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5");
const gpt = getBundledModel("openai", "gpt-4o");
if (!sonnet || !gpt) throw new Error("Expected bundled anthropic and openai models to exist");

describe("resolveCompactionSettings", () => {
	it("returns the global group when no overrides are configured", () => {
		const settings = Settings.isolated({ "compaction.thresholdTokens": 200_000 });
		expect(resolveCompactionSettings(settings, sonnet)).toEqual(settings.getGroup("compaction"));
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

	it("replaces the whole threshold policy on match", () => {
		const settings = Settings.isolated({
			"compaction.thresholdTokens": 200_000,
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
		expect(resolveCompactionSettings(settings, sonnet)).toEqual(settings.getGroup("compaction"));
	});

	it("is inherited by subagent settings", () => {
		const overrides = { "openai/*": { thresholdTokens: 250_000 } };
		const child = createSubagentSettings(Settings.isolated({ "compaction.modelOverrides": overrides }));
		expect(child.get("compaction.modelOverrides")).toEqual(overrides);
	});
});
