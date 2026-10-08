import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelCompactionPoint } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	formatCompactionPointInput,
	matchModelCompactionThreshold,
	parseCompactionPointInput,
} from "../config/compaction-threshold";
import type { ScopeLike } from "../config/registry";
import type { Settings } from "../config/settings";
import {
	cfgCompactionModelOverrides,
	cfgCompactionModelThresholds,
	cfgCompactionModelThresholdsEnabled,
	matchCompactionModelOverride,
	resolveCompactionSettings,
} from "./context-settings";

/** Where auto-compaction triggers for `model` and which setting decides it, for the model hub preview. */
export function describeModelCompactionPoint(scope: ScopeLike, model: Model): ModelCompactionPoint {
	const perModelEnabled = cfgCompactionModelThresholdsEnabled.get(scope);
	const overrideKey = perModelEnabled
		? matchCompactionModelOverride(cfgCompactionModelOverrides.get(scope), model)
		: undefined;
	const thresholds = perModelEnabled ? cfgCompactionModelThresholds.get(scope) : undefined;
	const match = matchModelCompactionThreshold(thresholds, model);
	const settings = resolveCompactionSettings(scope, model);
	const contextWindow = model.contextWindow ?? 0;
	return {
		tokens: settings.enabled && contextWindow > 0 ? resolveThresholdTokens(contextWindow, settings) : undefined,
		percent: settings.thresholdTokens > 0 || settings.thresholdPercent <= 0 ? undefined : settings.thresholdPercent,
		source:
			overrideKey !== undefined
				? `modelOverrides:${overrideKey}`
				: (match?.key ?? (settings.thresholdTokens > 0 || settings.thresholdPercent > 0 ? "global" : "default")),
		draft: match?.key === `${model.provider}/${model.id}` ? formatCompactionPointInput(match.threshold) : undefined,
	};
}

/**
 * Save the model hub's exact `compaction.modelThresholds` entry, or remove it for empty input.
 * Reject invalid input and edits that a fork policy or higher-priority layer would hide.
 * Returns the saved entry, or `undefined` after removal.
 */
export function setModelCompactionPoint(settings: Settings, model: Model, input: string): number | string | undefined {
	const entry = parseCompactionPointInput(input) ?? undefined;
	const key = `${model.provider}/${model.id}`;
	if (entry !== undefined) {
		if (!cfgCompactionModelThresholdsEnabled.get(settings)) {
			throw new Error("Per-model compaction policies are disabled for this session.");
		}
		const overrideKey = matchCompactionModelOverride(cfgCompactionModelOverrides.get(settings), model);
		if (overrideKey !== undefined) {
			throw new Error(`${key} uses compaction.modelOverrides.${overrideKey}. Edit that policy instead.`);
		}
	}
	const projectThresholds = settings.getProjectSettings().compaction;
	if (
		isRecord(projectThresholds) &&
		isRecord(projectThresholds.modelThresholds) &&
		Object.hasOwn(projectThresholds.modelThresholds, key)
	) {
		throw new Error(`${key} uses the project config. Edit compaction.modelThresholds there.`);
	}
	cfgCompactionModelThresholds.setEntry(settings, key, entry);
	const effective = cfgCompactionModelThresholds.get(settings)[key] ?? undefined;
	if (effective !== entry) {
		throw new Error(`A higher-priority config layer controls ${key}. The saved global entry has no effect.`);
	}
	return entry;
}
