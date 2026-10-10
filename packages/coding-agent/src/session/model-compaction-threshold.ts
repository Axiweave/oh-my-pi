import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelCompactionPoint } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	applyCompactionThresholdPair,
	type CompactionThresholdPair,
	formatCompactionPointInput,
	matchModelCompactionThreshold,
	parseCompactionPointInput,
	parseModelCompactionEntry,
} from "../config/compaction-threshold";
import type { ContextWindowTiers } from "../config/model-registry";
import type { ScopeLike } from "../config/registry";
import type { Settings } from "../config/settings";
import {
	type CompactionSettings,
	cfgCompaction,
	cfgCompactionModelOverrides,
	cfgCompactionModelThresholds,
	cfgCompactionModelThresholdsEnabled,
	cfgExtendedContext,
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
	const trigger = settings.enabled && contextWindow > 0 ? resolveTrigger(settings, contextWindow) : undefined;
	return {
		tokens: trigger?.tokens,
		basis: trigger && formatBasis(trigger),
		source:
			overrideKey !== undefined
				? `modelOverrides:${overrideKey}`
				: (match?.key ?? (settings.thresholdTokens > 0 || settings.thresholdPercent > 0 ? "global" : "default")),
		draft: match?.key === `${model.provider}/${model.id}` ? formatCompactionPointInput(match.threshold) : undefined,
	};
}

/** A window size as the hub's one-line notices show it: `272K`, `1.05M`. */
function formatWindow(tokens: number): string {
	return tokens.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

/**
 * Where a compaction policy triggers on a window, and why: at a `fixed` token
 * count (`cappedFrom` the configured count when it is at or past the window,
 * which then compacts at the window less its reserve), or `scaled` to `share`
 * percent of `scaledFrom` (the entry's base when `fromBase`, else the window).
 * `share` is the configured percentage when one applies, else the reserve
 * policy's exact share, so fractions survive.
 */
export type ModelCompactionTrigger =
	| { kind: "fixed"; tokens: number; cappedFrom?: number }
	| { kind: "scaled"; tokens: number; share: number; scaledFrom: number; fromBase: boolean };

function resolveTrigger(settings: CompactionSettings, window: number): ModelCompactionTrigger {
	const tokens = resolveThresholdTokens(window, settings);
	if (settings.thresholdTokens > 0) {
		// Capped exactly when `resolveThresholdTokens` lowered it, whatever its boundary.
		return tokens < settings.thresholdTokens
			? { kind: "fixed", tokens, cappedFrom: settings.thresholdTokens }
			: { kind: "fixed", tokens };
	}
	const base = settings.baseWindowTokens;
	const fromBase = base !== undefined && base > 0 && base < window;
	const scaledFrom = fromBase ? base : window;
	// Mirrors `resolveThresholdTokens`' clamp of a configured percentage.
	const share =
		settings.thresholdPercent > 0
			? Math.min(99, Math.max(1, settings.thresholdPercent))
			: (tokens / scaledFrom) * 100;
	return { kind: "scaled", tokens, share, scaledFrom, fromBase };
}

/** Why a trigger sits where it does, in a few words: `fixed`, `fixed 300K, capped by window`, `85% of 400K base`, `12.5% of window`. */
function formatBasis(trigger: ModelCompactionTrigger): string {
	if (trigger.kind === "fixed") {
		return trigger.cappedFrom === undefined ? "fixed" : `fixed ${formatWindow(trigger.cappedFrom)}, capped by window`;
	}
	const share = `${trigger.share.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
	return trigger.fromBase ? `${share} of ${formatWindow(trigger.scaledFrom)} base` : `${share} of window`;
}

/**
 * How a typed entry would apply to `model`: the policy it yields, the window it
 * runs on (the extended tier once the entry needs it), and why it is refused.
 */
interface ModelCompactionEntryPlan {
	settings: CompactionSettings;
	window: number | undefined;
	opensExtended: boolean;
	/** Set when a fork policy hides the entry, or it does not fit the largest window `model` can run with. */
	error?: string;
}

/**
 * Plan `entry` (as `parseCompactionPointInput` persists it) for `model`, decoded
 * and applied exactly as the runtime does ({@link parseModelCompactionEntry},
 * {@link applyCompactionThresholdPair}). With no entry, the model falls back to
 * whatever else matches it: a `compaction.modelOverrides` policy, a `…*` prefix
 * entry, else the configured policy. An entry is refused while a
 * `compaction.modelOverrides` policy or a task override hides `compaction.modelThresholds`.
 */
function planModelCompactionEntry(
	settings: Settings,
	model: Model,
	entry: number | string | undefined,
	tiers: ContextWindowTiers | undefined,
): ModelCompactionEntryPlan {
	const key = `${model.provider}/${model.id}`;
	const configured = cfgCompaction.get(settings);
	const perModelEnabled = cfgCompactionModelThresholdsEnabled.get(settings);
	const overrideKey = perModelEnabled
		? matchCompactionModelOverride(cfgCompactionModelOverrides.get(settings), model)
		: undefined;
	if (entry !== undefined && overrideKey !== undefined) {
		const error = `${key} uses compaction.modelOverrides.${overrideKey}. Edit that policy instead.`;
		return { settings: configured, window: undefined, opensExtended: false, error };
	}
	if (entry !== undefined && !perModelEnabled) {
		const error = "Per-model compaction policies are disabled for this session.";
		return { settings: configured, window: undefined, opensExtended: false, error };
	}
	let threshold: CompactionThresholdPair | undefined;
	if (entry !== undefined) {
		threshold = parseModelCompactionEntry(entry);
	} else if (perModelEnabled && overrideKey === undefined) {
		const { [key]: _removed, ...others } = cfgCompactionModelThresholds.get(settings);
		threshold = matchModelCompactionThreshold(others, model)?.threshold;
	}
	// A reset under a `modelOverrides` match falls back to that policy, not to `modelThresholds`.
	const fallback = overrideKey === undefined ? configured : resolveCompactionSettings(settings, model);
	const applied = threshold ? applyCompactionThresholdPair(configured, threshold) : fallback;
	const tokens = threshold && threshold.thresholdTokens > 0 ? threshold.thresholdTokens : undefined;
	const fixed = threshold?.fixed === true;
	// A base stands in for the window, so it needs a window at least that large;
	// a fixed trigger needs room above it.
	const opensExtended =
		tiers !== undefined && tokens !== undefined && (fixed ? tokens >= tiers.standard : tokens > tiers.standard);
	const window = tiers
		? opensExtended || cfgExtendedContext.get(settings)
			? tiers.extended
			: tiers.standard
		: (model.contextWindow ?? undefined);
	const ceiling = tiers?.extended ?? model.contextWindow;
	let error: string | undefined;
	if (entry !== undefined && tokens !== undefined && ceiling !== null && ceiling !== undefined) {
		const max = tiers ? "max " : "";
		if (fixed && tokens >= ceiling) error = `Must be below the ${formatWindow(ceiling)} ${max}window`;
		if (!fixed && tokens > ceiling) error = `Must not exceed the ${formatWindow(ceiling)} ${max}window`;
	}
	return { settings: applied, window, opensExtended: entry !== undefined && opensExtended, error };
}

/** A model entry in words, for the save message: `400,000-token base`, `fixed at 400,000 tokens`, `80% of the window`. */
function describeModelCompactionEntry(threshold: CompactionThresholdPair): string {
	if (threshold.thresholdTokens <= 0) return `${threshold.thresholdPercent}% of the window`;
	const tokens = threshold.thresholdTokens.toLocaleString("en-US");
	return threshold.fixed ? `fixed at ${tokens} tokens` : `${tokens}-token base`;
}

/** Where the plan compacts; undefined when auto-compaction is off or the window is unknown. */
function planTrigger(plan: ModelCompactionEntryPlan): ModelCompactionTrigger | undefined {
	if (!plan.settings.enabled || plan.window === undefined || plan.window <= 0) return undefined;
	return resolveTrigger(plan.settings, plan.window);
}

/** Where the plan compacts, as one short line: `compacts at 340K · 85% of 400K base`. */
function summarizePlan(plan: ModelCompactionEntryPlan): string | undefined {
	if (!plan.settings.enabled) return "auto-compaction is off";
	const trigger = planTrigger(plan);
	if (!trigger) return undefined;
	if (trigger.kind === "fixed" && trigger.cappedFrom === undefined) {
		return `compacts at exactly ${formatWindow(trigger.tokens)}`;
	}
	return `compacts at ${formatWindow(trigger.tokens)} · ${formatBasis(trigger)}`;
}

/** Parse and plan typed hub input; undefined when it does not parse or fit. */
function planInput(
	settings: Settings,
	model: Model,
	input: string,
	tiers: ContextWindowTiers | undefined,
): { reset: boolean; plan: ModelCompactionEntryPlan } | undefined {
	let entry: number | string | null;
	try {
		entry = parseCompactionPointInput(input);
	} catch {
		return undefined;
	}
	const plan = planModelCompactionEntry(settings, model, entry ?? undefined, tiers);
	return plan.error ? undefined : { reset: entry === null, plan };
}

/**
 * What a typed compaction limit would do to `model`: the window it runs on and
 * where it compacts (`trigger` undefined when auto-compaction is off), or with
 * no entry for empty input (`reset`). Undefined for input that does not parse
 * or fit, which {@link setModelCompactionPoint} reports on submit.
 */
export function planModelCompactionPoint(
	settings: Settings,
	model: Model,
	input: string,
	tiers: ContextWindowTiers | undefined,
): { reset: boolean; window: number | undefined; trigger: ModelCompactionTrigger | undefined } | undefined {
	const planned = planInput(settings, model, input, tiers);
	if (!planned) return undefined;
	return { reset: planned.reset, window: planned.plan.window, trigger: planTrigger(planned.plan) };
}

/**
 * Live preview line of a typed compaction limit for the hub field
 * ({@link planModelCompactionPoint} in words): `compacts at 340K · 85% of 400K
 * base`, prefixed `resets:` for empty input.
 */
export function previewModelCompactionPoint(
	settings: Settings,
	model: Model,
	input: string,
	tiers: ContextWindowTiers | undefined,
): string | undefined {
	const planned = planInput(settings, model, input, tiers);
	if (!planned) return undefined;
	const summary = summarizePlan(planned.plan);
	return planned.reset && summary ? `resets: ${summary}` : summary;
}

/**
 * Outcome of {@link setModelCompactionPoint}: the entry written (`undefined` =
 * removed), that entry in words (`400,000-token base`, `reset`), and where the
 * model now compacts (`trigger`, and `summary` in words); or, before writing an
 * entry that opens `extendedWindow`, a warning to acknowledge first, with
 * `premiumFrom` set when compaction would let input reach that long-context
 * price tier.
 */
export type ModelCompactionPointUpdate =
	| {
			kind: "saved";
			entry: number | string | undefined;
			described: string;
			trigger: ModelCompactionTrigger | undefined;
			summary: string | undefined;
	  }
	| { kind: "confirm"; message: string; extendedWindow: number; premiumFrom?: number };

/**
 * Persist `input` (see {@link parseCompactionPointInput}) as `model`'s own
 * `compaction.modelThresholds` entry in the global config; empty input removes it.
 * A token count is the base the compaction policy scales (it stands in for the window).
 * It may not exceed the largest window `model` can run with (`tiers.extended`, else its current window).
 * A fixed trigger (`f400k`) must stay below that window.
 * Throws on unparseable or too-large input.
 * Also throws when a fork `compaction.modelOverrides` policy, a task override,
 * a project entry, or a higher-priority layer would hide the global write.
 *
 * A base past `tiers.standard`, or a fixed trigger at or past it, opts the
 * model into its extended window (see `ModelRegistry.contextWindowTiers`).
 * Unless extended context is already on, it is written only once `confirmed`.
 * Otherwise the call returns the warning to show.
 */
export function setModelCompactionPoint(
	settings: Settings,
	model: Model,
	input: string,
	options: { tiers?: ContextWindowTiers; confirmed?: boolean } = {},
): ModelCompactionPointUpdate {
	const entry = parseCompactionPointInput(input) ?? undefined;
	const key = `${model.provider}/${model.id}`;
	const { tiers } = options;
	// A fork policy hides a project entry too, so the plan's refusals come before the project check.
	const plan = planModelCompactionEntry(settings, model, entry, tiers);
	if (plan.error) throw new Error(plan.error);
	const projectThresholds = settings.getProjectSettings().compaction;
	if (
		isRecord(projectThresholds) &&
		isRecord(projectThresholds.modelThresholds) &&
		Object.hasOwn(projectThresholds.modelThresholds, key)
	) {
		throw new Error(`${key} uses the project config. Edit compaction.modelThresholds there.`);
	}
	if (tiers && plan.opensExtended && !options.confirmed && !cfgExtendedContext.get(settings)) {
		// Pricing follows where compaction actually triggers: the fixed point, or the policy scaled from the base.
		const trigger = resolveThresholdTokens(tiers.extended, plan.settings);
		const threshold = model.cost.longContext?.inputThreshold;
		const premiumFrom = threshold !== undefined && trigger > threshold ? threshold : undefined;
		const pricing = premiumFrom !== undefined ? `; >${formatWindow(premiumFrom)} costs more` : "";
		// Kept short: the hub shows it on one line beside the input field.
		return {
			kind: "confirm",
			message: `Opens ${formatWindow(tiers.extended)} window${pricing}`,
			extendedWindow: tiers.extended,
			...(premiumFrom !== undefined ? { premiumFrom } : {}),
		};
	}
	cfgCompactionModelThresholds.setEntry(settings, key, entry);
	const effective = cfgCompactionModelThresholds.get(settings)[key] ?? undefined;
	if (effective !== entry) {
		throw new Error(`A higher-priority config layer controls ${key}. The saved global entry has no effect.`);
	}
	const threshold = entry === undefined ? undefined : parseModelCompactionEntry(entry);
	return {
		kind: "saved",
		entry,
		described: threshold ? describeModelCompactionEntry(threshold) : "reset",
		trigger: planTrigger(plan),
		summary: summarizePlan(plan),
	};
}
