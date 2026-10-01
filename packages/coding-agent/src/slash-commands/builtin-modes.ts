import { clearSubmittedText, restoreDetachedDraft } from "./helpers/draft";
import * as path from "node:path";
import { cyberRefusalMessage, cyberStateLine } from "../config/cyber-mode";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import {
	formatModelString,
	getModelMatchPreferences,
	parsePrewalkKeepModel,
	resolveCliModel,
	type ResolveCliModelResult,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { describeLoopCondition } from "../modes/loop-condition";
import { describeLoopLimitRuntime } from "../modes/loop-limit";
import type { InteractiveModeContext } from "../modes/types";
import type { AgentSession } from "../session/agent-session";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { handleSecurityCommand } from "./helpers/security";
import type { ParsedSlashCommand, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";

import { cfgComputerDisplay, cfgComputerEnabled, cfgComputerMaxHeight, cfgComputerMaxWidth } from "../tools/settings";
import { cfgPrewalkInto, cfgSkillful } from "../session/settings";
import { formatSlowModeResetClock } from "../session/anthropic-slow-mode";
import { cfgExtendedContext } from "../session/context-settings";
import { cfgGoalEnabled } from "../goals/settings";
import { cfgPlanEnabled } from "../plan-mode/settings";
import { cfgCyberMode, cfgModelProfile, cfgReviewUsesPlan } from "../config/model-settings";

export function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

/**
 * Resolve a `/model` / `/switch` selector the way `omp bench` and `--model`
 * do: exact `provider/id`, fuzzy ids (`opus`), role aliases (`@smol`, `smol`),
 * and `:level` thinking suffixes. Unqualified selectors prefer the session's
 * `--models` scope, else the authenticated set, before the full catalog.
 */
function resolveSessionModelSelector(
	selector: string,
	session: AgentSession,
	settings: Settings,
): ResolveCliModelResult {
	const scoped = session.scopedModels.map(entry => entry.model);
	return resolveCliModel({
		cliModel: selector,
		modelRegistry: session.modelRegistry,
		availableModels: scoped.length > 0 ? scoped : undefined,
		settings,
		preferences: getModelMatchPreferences(settings),
	});
}

async function runWithDetachedModeDraft(
	command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
	run: () => Promise<boolean>,
): Promise<void> {
	const { editor } = runtime.ctx;
	if (!runtime.draftDetached) editor.clearDraft();
	try {
		const submitted = await run();
		const hasAttachments = (runtime.input?.images?.length ?? 0) > 0 || (runtime.input?.imageLinks?.length ?? 0) > 0;
		if (!submitted && hasAttachments) {
			if (runtime.draftDetached) {
				// Newer typing may already sit in the editor: merge the submission
				// back beside it so each draft's image markers keep their images.
				restoreDetachedDraft(editor, command.text, runtime.input?.images, runtime.input?.imageLinks);
				return;
			}
			editor.pendingImages = [...(runtime.input?.images ?? []), ...editor.pendingImages];
			editor.pendingImageLinks = [
				...(runtime.input?.imageLinks ?? runtime.input?.images?.map(() => undefined) ?? []),
				...editor.pendingImageLinks,
			];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
	} catch (error) {
		if (runtime.draftDetached) {
			// The caller already took this draft out of the editor before
			// dispatch (Ctrl+Enter's `handleFollowUp`, or `onSubmit` for these
			// mode commands); it owns restoring the submission and reporting
			// the error so a submission that failed after newer text was typed
			// merges with it once, instead of being silently dropped here.
			throw error;
		}
		if (!editor.getText() && editor.pendingImages.length === 0) {
			editor.setText(command.text);
			editor.pendingImages = runtime.input?.images ? [...runtime.input.images] : [];
			editor.pendingImageLinks = runtime.input?.imageLinks ? [...runtime.input.imageLinks] : [];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
		runtime.ctx.showError(error instanceof Error ? error.message : String(error));
	}
}

/** `/fast status` label for the active model: "ultra" for the Ultrafast tier, "on" for priority, else "off". */
function formatFastModeStatus(session: AgentSession): string {
	if (session.isUltrafastModeEnabled()) return "ultra";
	return session.isFastModeEnabled() ? "on" : "off";
}

const FAST_USAGE = "Usage: /fast [on|ultra|off|status]";

/**
 * `/fast [on|ultra|off|status]` for the active model: `on` selects the
 * family's `priority` tier, `ultra` the OpenAI `ultrafast` tier, `off` clears
 * either. Bare invocation toggles between off and priority. Returns the
 * user-facing reply, or `undefined` for an unknown argument.
 */
function runFastCommand(arg: string, session: AgentSession): string | undefined {
	switch (arg) {
		case "":
		case "toggle":
			return `Fast mode ${session.toggleFastMode() ? "enabled" : "disabled"}.`;
		case "on":
			return session.setFastMode(true) ? "Fast mode enabled." : "Fast mode is unavailable for the current model.";
		case "ultra":
		case "ultrafast":
			return session.setUltrafastMode(true)
				? "Ultrafast mode enabled."
				: "Ultrafast is unavailable for the current model.";
		case "off":
			session.setFastMode(false);
			return "Fast mode disabled.";
		case "status":
			return `Fast mode is ${formatFastModeStatus(session)}.`;
		default:
			return undefined;
	}
}

const SLOW_UNSUPPORTED =
	"The current model has no slow mode: /slow uses the flex tier on OpenAI/Google models and low priority on Anthropic subscriptions.";

/**
 * `/slow [on|off|status]` for the active model: the `flex` service tier on
 * OpenAI/Google, subscription low priority (`providers.anthropic.slowMode`
 * `auto`/`off`) on Anthropic. Bare invocation toggles. Returns the user-facing
 * reply, or `undefined` for an unknown argument.
 */
function runSlowCommand(arg: string, session: AgentSession): string | undefined {
	if (arg !== "" && arg !== "toggle" && arg !== "on" && arg !== "off" && arg !== "status") return undefined;
	const anthropic = session.model?.provider === "anthropic";
	if (arg === "status") {
		const label = anthropic ? session.getAnthropicSlowModeLabel() : undefined;
		if (!session.isSlowModeEnabled()) return label ? `Slow mode is off (${label}).` : "Slow mode is off.";
		if (!anthropic) return "Slow mode is on (flex tier).";
		return label ? `Slow mode is on (${label}).` : "Slow mode is on (low priority at the Claude session limit).";
	}
	const enabled = arg === "on" || (arg !== "off" && !session.isSlowModeEnabled());
	if (!session.setSlowMode(enabled)) return SLOW_UNSUPPORTED;
	if (!session.isSlowModeEnabled()) {
		return anthropic
			? "Slow mode off: at your Claude usage limit, requests may get a short wrap-up allowance, then wait for the limit to reset."
			: "Slow mode off.";
	}
	if (!anthropic) return "Slow mode on: requests use the flex tier (lower cost, higher latency).";
	const resetsAtSec = session.getAnthropicSlowModeLane()?.activeResetsAtSec();
	return resetsAtSec !== undefined
		? `Slow mode on: continuing at low priority until your limit resets at ${formatSlowModeResetClock(resetsAtSec)}. Your weekly limit still applies, and responses may pause while waiting for spare capacity.`
		: "Slow mode on: when your Claude subscription hits its session limit and Anthropic offers low priority, requests switch to it after any wrap-up allowance.";
}

/** `/extended-context status` label for the premium long-context window setting. */
function formatExtendedContextStatus(settings: Settings): string {
	return cfgExtendedContext.get(settings) ? "on" : "off";
}

type ModelProfileScope = "global" | "project";

/** Resolves the /model-profile argument tokens against configured bundles. */
function resolveModelProfileArg(
	settings: Settings,
	args: string,
):
	| { kind: "none-configured" }
	| { kind: "status"; names: string[] }
	| { kind: "usage" }
	| { kind: "unknown"; name: string; names: string[] }
	| { kind: "apply"; name: string; names: string[]; scope?: ModelProfileScope } {
	const names = Object.keys(settings.getModelProfiles());
	if (names.length === 0) return { kind: "none-configured" };
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "status", names };
	if (tokens.length > 2) return { kind: "usage" };
	const [name, scope] = tokens;
	if (scope !== undefined && scope !== "global" && scope !== "project") return { kind: "usage" };
	if (!names.includes(name)) return { kind: "unknown", name, names };
	return { kind: "apply", name, names, scope };
}

/** Persists the startup modelProfile field to the requested config scope. */
function persistModelProfile(settings: Settings, name: string, scope: ModelProfileScope): string {
	if (scope === "global") {
		cfgModelProfile.set(settings, name);
		return "saved as startup profile (global config)";
	}
	settings.setProjectModelProfile(name);
	return "saved as startup profile (.omp/config.yml)";
}

/**
 * Resolves a `/cyber` argument to the switch it names, or `undefined` for a form
 * the command does not take (contracts/slash-command.md).
 *
 * A scope persists the startup field, and only enabling has a persisted form, so
 * `off global` and `status project` are usage errors rather than silent no-ops.
 */
function resolveCyberArg(
	args: string,
):
	| { kind: "toggle" }
	| { kind: "status" }
	| { kind: "set"; enabled: boolean; scope?: "global" | "project" }
	| undefined {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "toggle" };
	if (tokens.length > 2) return undefined;
	const [verb, scope] = tokens;
	if (scope !== undefined && scope !== "global" && scope !== "project") return undefined;
	if (verb === "on") return scope ? { kind: "set", enabled: true, scope } : { kind: "set", enabled: true };
	if (verb === "off") return scope === undefined ? { kind: "set", enabled: false } : undefined;
	if (verb === "status") return scope === undefined ? { kind: "status" } : undefined;
	return undefined;
}

/** Persists `cyberMode: true` to the named scope, returning the feedback line. */
function persistCyberMode(settings: Settings, scope: "global" | "project"): string {
	if (scope === "global") {
		cfgCyberMode.set(settings, true);
		return "saved as the startup default (global config)";
	}
	settings.setProjectCyberMode(true);
	return "saved as the startup default (.omp/config.yml)";
}

/**
 * The state `/cyber status` reports without changing anything: the session's
 * effective state, which is what every enforcement path reads.
 */
function cyberState(session: AgentSession): { enabled: boolean; models: readonly string[] } {
	return {
		enabled: session.cyberMode,
		models: [...(session.settings.getCyberAllowlist()?.keys ?? [])],
	};
}

type ReviewPlanArg =
	| { kind: "toggle" }
	| { kind: "status" }
	| { kind: "set"; enabled: boolean; scope?: "global" | "project" };

/** Parses `/review-plan` arguments; `undefined` means the usage line. */
function resolveReviewPlanArg(args: string): ReviewPlanArg | undefined {
	const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "toggle" };
	if (tokens.length > 2) return undefined;
	const [verb, scope] = tokens;
	if (verb === "status") return scope === undefined ? { kind: "status" } : undefined;
	if (verb !== "on" && verb !== "off") return undefined;
	if (scope !== undefined && scope !== "global" && scope !== "project") return undefined;
	return { kind: "set", enabled: verb === "on", scope };
}

/** Saves `reviewUsesPlan` to the named scope, returning the feedback line. */
function persistReviewPlan(settings: Settings, scope: "global" | "project", enabled: boolean): string {
	if (scope === "global") {
		cfgReviewUsesPlan.set(settings, enabled);
		return "Saved to global config";
	}
	settings.setProjectReviewUsesPlan(enabled);
	return "Saved to project config";
}

/** The `/review-plan` state line: the switch, and which role's model reviews use now. */
function reviewPlanStateLine(session: AgentSession): string {
	const reviewer = session.settings.getModelRole("reviewer") ?? "the agent's own model";
	if (!session.reviewPlan)
		return `Review plan mode off: reviews use the reviewer model ${reviewer}, not the plan model`;
	if (!session.reviewPlanActive) {
		return `Review plan mode on, but no plan model resolves. Reviews keep the reviewer model ${reviewer}.`;
	}
	return `Review plan mode on: reviews use the plan model ${session.settings.getModelRole("plan")}, not the reviewer model`;
}

/** Applies a parsed `/review-plan` argument and returns the operator feedback. */
function applyReviewPlanCommand(session: AgentSession, settings: Settings, resolved: ReviewPlanArg): string {
	if (resolved.kind === "status") return reviewPlanStateLine(session);
	const enabled = resolved.kind === "toggle" ? !session.reviewPlan : resolved.enabled;
	session.setReviewPlan(enabled);
	const line = reviewPlanStateLine(session);
	if (resolved.kind !== "set" || !resolved.scope) return line;
	const saved = persistReviewPlan(settings, resolved.scope, enabled);
	return `${line.endsWith(".") ? line : `${line}.`} ${saved}.`;
}

/** Applies an `/extended-context` argument and returns its operator feedback. */
function applyExtendedContextCommand(settings: Settings, args: string): string | undefined {
	const arg = args.trim().toLowerCase();
	const current = cfgExtendedContext.get(settings);
	if (!arg || arg === "toggle") {
		const enabled = !current;
		cfgExtendedContext.set(settings, enabled);
		return `Extended context ${enabled ? "enabled" : "disabled"}.`;
	}
	if (arg === "on") {
		cfgExtendedContext.set(settings, true);
		return "Extended context enabled.";
	}
	if (arg === "off") {
		cfgExtendedContext.set(settings, false);
		return "Extended context disabled.";
	}
	if (arg === "status") return `Extended context is ${formatExtendedContextStatus(settings)}.`;
	return undefined;
}

/** Detailed, session-effective `/computer status` diagnostics. */
function formatComputerUseStatus(session: AgentSession): string {
	const enabled = cfgComputerEnabled.get(session.settings);
	const active = session.getEvalPreludes().some(definition => definition.name === "computer");
	const configured = {
		display: cfgComputerDisplay.get(session.settings),
		maxWidth: cfgComputerMaxWidth.get(session.settings),
		maxHeight: cfgComputerMaxHeight.get(session.settings),
	};
	return [
		`Computer use: ${enabled ? "enabled" : "disabled"}`,
		`prelude: ${active ? "active" : "inactive"}`,
		`configured: display=${configured.display}, maxWidth=${configured.maxWidth}, maxHeight=${configured.maxHeight}`,
	].join(" · ");
}

/**
 * Apply a session-scoped computer-use toggle; the session's setting listener
 * reconciles the prompt without a mid-session cache-busting rebuild.
 * The override is never persisted to settings.json.
 */
function applyComputerUseToggle(session: AgentSession, enable: boolean): string {
	const previous = cfgComputerEnabled.get(session.settings);
	cfgComputerEnabled.override(session.settings, enable);
	if (enable && !session.getEvalPreludes().some(definition => definition.name === "computer")) {
		cfgComputerEnabled.override(session.settings, previous);
		return "Computer use is unavailable in this session.";
	}
	return enable
		? `Computer use enabled for this session. ${formatComputerUseStatus(session)}`
		: "Computer use disabled for this session.";
}

const AUTOCOMPLETE_DETAIL_LIMIT = 48;

function shortDetail(value: string, limit = AUTOCOMPLETE_DETAIL_LIMIT): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit - 1)}…`;
}

export function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

export const BUILTIN_MODE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "security",
		icon: "shield",
		description: "Plan, run, inspect, import, and compare OMP-native security scans",
		allowArgs: true,
		acpInputHint: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
		subcommands: [
			{ name: "plan", description: "Create an immutable security scan plan" },
			{ name: "scan", description: "Start a planned or newly planned native scan" },
			{ name: "status", description: "Show native scan operation status" },
			{ name: "cancel", description: "Cancel a running native scan" },
			{ name: "scans", description: "List stored project security scans" },
			{ name: "show", description: "Render a scan or security:// resource" },
			{ name: "import", description: "Import SARIF or a Codex Security bundle" },
			{ name: "export", description: "Export a canonical bundle, SARIF, or report" },
			{ name: "validate", description: "Validate one finding with OMP-native tools" },
			{ name: "compare", description: "Compare finding lineage across two scans" },
			{ name: "disposition", description: "Set a finding disposition with rationale" },
		],
		handle: handleSecurityCommand,
	},
	{
		name: "settings",
		icon: "settings",
		description: "Open settings menu",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "reload-config",
		icon: "restart",
		description: "Reload config.yml, project settings, and --config overlays from disk",
		handle: async (_command, runtime) => {
			try {
				await runtime.settings.reloadFromDisk();
				await runtime.output("Config reloaded.");
			} catch (error) {
				await runtime.output(`Config reload failed: ${errorMessage(error)}`);
			}
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			try {
				await runtime.ctx.settings.reloadFromDisk();
				runtime.ctx.showStatus("Config reloaded.");
			} catch (error) {
				runtime.ctx.showError(`Config reload failed: ${errorMessage(error)}`);
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "setup",
		aliases: ["providers"],
		icon: "gear",
		description: "Open provider setup",
		allowArgs: true,
		subcommands: [{ name: "providers", description: "Configure sign-in and web search providers" }],
		handleTui: async (command, runtime) => {
			const args = command.args.trim().toLowerCase();
			const opensProviders = args === "" || args === "providers";
			if (opensProviders) {
				await runtime.ctx.showProviderSetup();
			} else {
				runtime.ctx.showWarning(`Usage: /${command.name} [providers]`);
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "debate",
		icon: "plan",
		description: "Toggle plan mode with independent review",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!cfgPlanEnabled.get(runtime.ctx.settings)) return "Debate: disabled in settings";
			if (runtime.ctx.planModeEnabled) {
				const workflow = runtime.ctx.session.getPlanModeState()?.workflow;
				const planFile = runtime.ctx.planModePlanFilePath;
				return workflow === "debate"
					? `Debate: on${planFile ? ` (${path.basename(planFile)})` : ""}`
					: "Debate: blocked by active plan mode";
			}
			if (runtime.ctx.goalModeEnabled) return "Debate: blocked by goal mode";
			return "Debate: off";
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handlePlanModeCommand(command.args || undefined, runtime.input, "debate"),
			);
		},
	},
	{
		name: "plan",
		icon: "plan",
		description: "Toggle plan mode (agent plans before executing)",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!cfgPlanEnabled.get(runtime.ctx.settings)) return "Plan: disabled in settings";
			if (runtime.ctx.planModeEnabled) {
				const planFile = runtime.ctx.planModePlanFilePath;
				return `Plan: on${planFile ? ` (${path.basename(planFile)})` : ""}`;
			}
			if (runtime.ctx.goalModeEnabled) return "Plan: blocked by goal mode";
			return "Plan: off";
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handlePlanModeCommand(command.args || undefined, runtime.input, "parallel"),
			);
		},
	},
	{
		name: "plan-review",
		icon: "plan",
		description: "Re-open the plan review for the latest plan (plan mode only)",
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.planModeEnabled ? "Plan review: available" : "Plan review: plan mode inactive",
		handleTui: async (_command, runtime) => {
			await runtime.ctx.openPlanReview();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "vibe",
		icon: "wave",
		description: "Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.vibeModeEnabled) return "Vibe: on";
			if (runtime.ctx.planModeEnabled) return "Vibe: blocked by plan mode";
			if (runtime.ctx.goalModeEnabled) return "Vibe: blocked by goal mode";
			return "Vibe: off";
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleVibeModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "goal",
		icon: "goal",
		description: "Toggle goal mode (persistent autonomous objective for this session)",
		subcommands: [
			{ name: "set", description: "Set or replace the goal", usage: "<objective>" },
			{ name: "show", description: "Show current goal details" },
			{ name: "pause", description: "Pause the current goal" },
			{ name: "resume", description: "Resume a paused goal" },
			{ name: "drop", description: "Drop the current goal" },
			{ name: "budget", description: "Adjust the token budget", usage: "<N|off>" },
		],
		inlineHint: "[objective]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!cfgGoalEnabled.get(runtime.ctx.settings)) return "Goal: disabled in settings";
			if (runtime.ctx.planModeEnabled) return "Goal: blocked by plan mode";
			const state = runtime.ctx.session.getGoalModeState();
			return state ? `Goal: ${state.goal.status} (${shortDetail(state.goal.objective)})` : "Goal: off";
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleGoalModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "guided-goal",
		icon: "compass",
		description: "Have the agent interview you in chat, then set up goal mode",
		inlineHint: "[rough objective]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleGuidedGoalCommand(command.args || undefined, runtime.input, command.text),
			);
		},
	},
	{
		name: "loop",
		icon: "loop",
		get description() {
			return `Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Bound it with a count/duration, or gate it with \`--until '<cmd>'\` / \`--while '<cmd>'\` — the command's exit status decides whether the next iteration runs. ${formatKeyHint("escape")} suspends the ongoing loop; /loop again to disable.`;
		},
		inlineHint: "[count|duration] [--while|--until '<cmd>'] [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.loopModeEnabled) return "Loop: off";
			if (runtime.ctx.loopModePaused) return "Loop: paused";
			const bounds = [
				runtime.ctx.loopLimit ? describeLoopLimitRuntime(runtime.ctx.loopLimit) : undefined,
				runtime.ctx.loopCondition ? describeLoopCondition(runtime.ctx.loopCondition) : undefined,
			].filter((part): part is string => part !== undefined);
			if (bounds.length > 0) return `Loop: on (${bounds.join(", ")})`;
			if (runtime.ctx.loopPrompt) return "Loop: on (repeating prompt)";
			return "Loop: on (waiting for next prompt)";
		},
		handleTui: async (command, runtime) => {
			const prompt = await runtime.ctx.handleLoopCommand(command.args);
			clearSubmittedText(runtime);
			// Surface any inline prompt so the dispatcher returns it and the normal
			// submit flow runs the first loop iteration (recording it as the loop prompt).
			if (prompt) return { prompt };
		},
	},
	{
		name: "queue",
		icon: "inbox",
		description: "Queue a message for after the agent yields",
		inlineHint: "<message>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleQueueCommand(
				command.args,
				runtime.draftDetached ? { ...runtime.input, text: command.text } : undefined,
			);
		},
	},
	{
		name: "model",
		aliases: ["models"],
		icon: "model",
		description: "Switch model for this session",
		acpDescription: "Show current model selection",
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `Model: ${model.provider}/${model.id}` : "Model: none selected";
		},
		handle: async (command, runtime) => {
			if (command.args) {
				const selector = command.args.trim();
				const resolved = resolveSessionModelSelector(selector, runtime.session, runtime.settings);
				const match = resolved.model;
				if (!match) {
					return usage(
						`Unknown model: ${selector}. Use ACP \`session/setModel\` for picker-driven selection or list available models with /model.`,
						runtime,
					);
				}
				try {
					await runtime.session.setModel(match);
					if (resolved.thinkingLevel !== undefined) runtime.session.setThinkingLevel(resolved.thinkingLevel);
					await runtime.output(`Model set to ${match.provider}/${match.id}.`);
					await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(`Failed to set model: ${errorMessage(err)}`, runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
			);
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "switch",
		icon: "swap",
		get description() {
			return `Switch model for this session (same as ${formatKeyHint("alt+p")}); accepts fuzzy ids, provider/id, @role, :level`;
		},
		acpDescription: "Switch model for this session only",
		acpInputHint: "[model]",
		inlineHint: "[model]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `Model: ${model.provider}/${model.id}` : "Model: none selected";
		},
		handle: async (command, runtime) => {
			const selector = command.args.trim();
			if (!selector) {
				const model = runtime.session.model;
				await runtime.output(
					model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
				);
				return commandConsumed();
			}
			const resolved = resolveSessionModelSelector(selector, runtime.session, runtime.settings);
			if (!resolved.model) return usage(`Unknown model: ${selector}`, runtime);
			try {
				await runtime.session.setModelTemporary(resolved.model, resolved.thinkingLevel);
				await runtime.output(`Session-only model: ${formatModelString(resolved.model)}.`);
				await runtime.notifyTitleChanged?.();
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to switch model: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const selector = command.args.trim();
			if (!selector) {
				runtime.ctx.showModelSelector({ temporaryOnly: true });
				return;
			}
			const resolved = resolveSessionModelSelector(selector, runtime.ctx.session, runtime.ctx.settings);
			if (!resolved.model) {
				runtime.ctx.showError(`Unknown model: ${selector}`);
				return;
			}
			if (resolved.warning) runtime.ctx.showStatus(resolved.warning);
			await runtime.ctx.switchSessionModel(resolved.model, resolved.thinkingLevel);
		},
	},
	{
		name: "model-profile",
		icon: "package",
		description: "Switch to a named modelProfiles bundle, optionally saving it as the startup profile",
		acpDescription: "Switch to a named modelProfiles bundle, optionally saving it as the startup profile",
		acpInputHint: "[name] [global|project]",
		inlineHint: "[name] [global|project]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => `Profile: ${runtime.ctx.session.activeModelProfile ?? "none"}`,
		handle: async (command, runtime) => {
			const resolved = resolveModelProfileArg(runtime.settings, command.args);
			if (resolved.kind === "none-configured") {
				await runtime.output("No model profiles configured — add `modelProfiles` to your config.");
				return commandConsumed();
			}
			if (resolved.kind === "status") {
				await runtime.output(
					`Model profile: ${runtime.session.activeModelProfile ?? "none (config roles)"}. Available: ${resolved.names.join(", ")}`,
				);
				return commandConsumed();
			}
			if (resolved.kind === "usage") {
				return usage("Usage: /model-profile [name] [global|project]", runtime);
			}
			if (resolved.kind === "unknown") {
				return usage(`Unknown model profile: ${resolved.name}. Available: ${resolved.names.join(", ")}`, runtime);
			}
			try {
				const role = runtime.session.getPlanModeState()?.enabled ? "plan" : "default";
				const result = await runtime.session.applyModelProfile(resolved.name, role);
				// Persist regardless of result.model: the bundle is installed either way,
				// and the startup field names a bundle, not a model.
				const saved = resolved.scope
					? persistModelProfile(runtime.settings, resolved.name, resolved.scope)
					: undefined;
				await runtime.output(
					(result?.model
						? `Model profile ${resolved.name}: now on ${result.model.provider}/${result.model.id}.`
						: `Model profile ${resolved.name} installed, but no configured role resolved to an available model.`) +
						(saved ? ` ${saved[0].toUpperCase()}${saved.slice(1)}.` : ""),
				);
				await runtime.notifyTitleChanged?.();
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to set model profile: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			if (runtime.ctx.focusedAgentId) {
				runtime.ctx.showStatus("Model/thinking apply to the main session — press ←← to return first");
				return;
			}
			const resolved = resolveModelProfileArg(runtime.ctx.settings, command.args);
			if (resolved.kind === "none-configured") {
				runtime.ctx.showStatus("No model profiles configured — add `modelProfiles` to your config");
				return;
			}
			if (resolved.kind === "status") {
				runtime.ctx.showStatus(
					`Model profile: ${runtime.ctx.session.activeModelProfile ?? "none (config roles)"} — available: ${resolved.names.join(", ")}`,
				);
				return;
			}
			if (resolved.kind === "usage") {
				runtime.ctx.showStatus("Usage: /model-profile [name] [global|project]");
				return;
			}
			if (resolved.kind === "unknown") {
				runtime.ctx.showStatus(`Unknown model profile: ${resolved.name}. Available: ${resolved.names.join(", ")}`);
				return;
			}
			try {
				const role = runtime.ctx.session.getPlanModeState()?.enabled ? "plan" : "default";
				const result = await runtime.ctx.session.applyModelProfile(resolved.name, role);
				if (!result) {
					// Unreachable after the key check above, but keep the guard.
					runtime.ctx.showStatus(
						`Unknown model profile: ${resolved.name}. Available: ${resolved.names.join(", ")}`,
					);
					return;
				}
				// Persist regardless of result.model: the bundle is installed either way,
				// and the startup field names a bundle, not a model.
				const saved = resolved.scope
					? persistModelProfile(runtime.ctx.settings, resolved.name, resolved.scope)
					: undefined;
				runtime.ctx.statusLine.invalidate();
				runtime.ctx.updateEditorBorderColor();
				if (!result.model) {
					runtime.ctx.showStatus(
						`Model profile ${result.profile}: no configured role resolved to an available model${saved ? ` — ${saved}` : ""}`,
					);
					return;
				}
				if (saved) {
					// Scope-save shows a status naming the file instead of the segment track.
					runtime.ctx.showStatus(
						`Model profile ${resolved.name}: now on ${result.model.provider}/${result.model.id} — ${saved}`,
					);
					return;
				}
				runtime.ctx.showModelCycleTrack(
					resolved.names.map(label => ({ label })),
					resolved.names.indexOf(result.profile),
				);
			} catch (error) {
				runtime.ctx.showError(error instanceof Error ? error.message : String(error));
			}
		},
	},
	{
		name: "cyber",
		icon: "cyber",
		description: "Toggle cyber mode: every role resolves among the cyber-capable models only",
		acpDescription: "Toggle cyber mode",
		acpInputHint: "[on|off|status] [global|project]",
		allowArgs: true,
		inlineHint: "[on|off|status] [global|project]",
		getTuiAutocompleteDescription: runtime => `Cyber: ${runtime.ctx.session.cyberMode ? "on" : "off"}`,
		handle: async (command, runtime) => {
			const resolved = resolveCyberArg(command.args);
			if (!resolved) return usage("Usage: /cyber [on|off|status] [global|project]", runtime);
			const session = runtime.session;
			if (resolved.kind === "status") {
				await runtime.output(cyberStateLine(cyberState(session), session.model));
				return commandConsumed();
			}
			const enabled = resolved.kind === "toggle" ? !session.cyberMode : resolved.enabled;
			const result = await session.setCyberMode(enabled);
			if (result.refusal) {
				await runtime.output(cyberRefusalMessage(result.refusal));
				return commandConsumed();
			}
			const scope = resolved.kind === "set" ? resolved.scope : undefined;
			const saved = scope ? persistCyberMode(runtime.settings, scope) : undefined;
			await runtime.output(`${cyberStateLine(result, session.model)}${saved ? ` ${saved}.` : ""}`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const resolved = resolveCyberArg(command.args);
			if (!resolved) {
				runtime.ctx.showStatus("Usage: /cyber [on|off|status] [global|project]");
				return;
			}
			const session = runtime.ctx.session;
			if (resolved.kind === "status") {
				runtime.ctx.showStatus(cyberStateLine(cyberState(session), session.model));
				return;
			}
			try {
				const enabled = resolved.kind === "toggle" ? !session.cyberMode : resolved.enabled;
				const result = await session.setCyberMode(enabled);
				if (result.refusal) {
					runtime.ctx.showStatus(cyberRefusalMessage(result.refusal));
					return;
				}
				const scope = resolved.kind === "set" ? resolved.scope : undefined;
				const saved = scope ? persistCyberMode(runtime.ctx.settings, scope) : undefined;
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`${cyberStateLine(result, session.model)}${saved ? ` — ${saved}` : ""}`);
			} catch (error) {
				runtime.ctx.showError(error instanceof Error ? error.message : String(error));
			}
		},
	},
	{
		name: "review-plan",
		icon: "reviewPlan",
		description: "Run reviews on the profile's plan model instead of its reviewer model",
		acpDescription: "Run reviews on the plan model instead of the reviewer model",
		acpInputHint: "[on|off|status] [global|project]",
		allowArgs: true,
		inlineHint: "[on|off|status] [global|project]",
		getTuiAutocompleteDescription: runtime => reviewPlanStateLine(runtime.ctx.session),
		handle: async (command, runtime) => {
			const resolved = resolveReviewPlanArg(command.args);
			if (!resolved) return usage("Usage: /review-plan [on|off|status] [global|project]", runtime);
			await runtime.output(applyReviewPlanCommand(runtime.session, runtime.settings, resolved));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const resolved = resolveReviewPlanArg(command.args);
			if (!resolved) {
				runtime.ctx.showStatus("Usage: /review-plan [on|off|status] [global|project]");
				return;
			}
			try {
				const line = applyReviewPlanCommand(runtime.ctx.session, runtime.ctx.settings, resolved);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(line);
			} catch (error) {
				runtime.ctx.showError(error instanceof Error ? error.message : String(error));
			}
		},
	},
	{
		name: "fast",
		icon: "fast",
		description:
			"Toggle fast service (OpenAI service_tier=priority or ultrafast, Anthropic speed=fast, Google priority)",
		acpDescription: "Toggle fast mode",
		acpInputHint: "[on|ultra|off|status]",
		subcommands: [
			{ name: "on", description: "Enable fast mode (priority tier)" },
			{ name: "ultra", description: "Enable Ultrafast (OpenAI API, or Codex models that offer it)" },
			{ name: "off", description: "Disable fast mode" },
			{ name: "status", description: "Show fast mode status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => `Fast: ${formatFastModeStatus(runtime.ctx.session)}`,
		handle: async (command, runtime) => {
			const message = runFastCommand(command.args.trim().toLowerCase(), runtime.session);
			if (message === undefined) return usage(FAST_USAGE, runtime);
			await runtime.output(message);
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const message = runFastCommand(command.args.trim().toLowerCase(), runtime.ctx.session);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(message ?? FAST_USAGE);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "slow",
		icon: "fast",
		description:
			"Toggle slow mode: flex tier on OpenAI/Google; on Anthropic, continue at low priority after the Claude session limit",
		acpDescription: "Toggle slow mode",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Flex tier, or Anthropic low priority at the session limit (auto)" },
			{ name: "off", description: "Standard service; stop Anthropic low priority" },
			{ name: "status", description: "Show slow mode status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isSlowModeEnabled() ? "Slow mode: on" : "Slow mode: off",
		handle: async (command, runtime) => {
			const message = runSlowCommand(command.args.trim().toLowerCase(), runtime.session);
			if (message === undefined) return usage("Usage: /slow [on|off|status]", runtime);
			await runtime.output(message);
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const message = runSlowCommand(command.args.trim().toLowerCase(), runtime.ctx.session);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(message ?? "Usage: /slow [on|off|status]");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "skillful",
		icon: "compass",
		description: "Toggle listing available skills in the system prompt (session only)",
		acpDescription: "Toggle skill listing",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "List skills in the prompt for this session" },
			{ name: "off", description: "Omit the skills listing for this session" },
			{ name: "status", description: "Show skill listing status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`Skill listing: ${cfgSkillful.get(runtime.ctx.session.settings) ? "on" : "off"}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(
					`Skill listing: ${cfgSkillful.get(runtime.session.settings) ? "on" : "off"} (session override; default from the skillful setting).`,
				);
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enabled =
					arg === "on"
						? await runtime.session.setSkillful(true)
						: arg === "off"
							? await runtime.session.setSkillful(false)
							: await runtime.session.toggleSkillful();
				await runtime.output(`Skill listing ${enabled ? "enabled" : "disabled"} for this session.`);
				return commandConsumed();
			}
			return usage("Usage: /skillful [on|off|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(`Skill listing: ${cfgSkillful.get(runtime.ctx.session.settings) ? "on" : "off"}.`);
				clearSubmittedText(runtime);
				return;
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enabled =
					arg === "on"
						? await runtime.ctx.session.setSkillful(true)
						: arg === "off"
							? await runtime.ctx.session.setSkillful(false)
							: await runtime.ctx.session.toggleSkillful();
				runtime.ctx.showStatus(`Skill listing ${enabled ? "enabled" : "disabled"} for this session.`);
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus("Usage: /skillful [on|off|status]");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "extended-context",
		icon: "expand",
		description: "Toggle extended context windows",
		acpDescription: "Toggle extended context",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable larger context windows" },
			{ name: "off", description: "Use default or standard-pricing context windows" },
			{ name: "status", description: "Show extended context status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`Extended context: ${formatExtendedContextStatus(runtime.ctx.settings)}`,
		handle: async (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.settings, command.args);
			if (!output) return usage("Usage: /extended-context [on|off|status]", runtime);
			await runtime.output(output);
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.ctx.settings, command.args);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(output ?? "Usage: /extended-context [on|off|status]");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "computer",
		icon: "computer",
		description: "Toggle the native computer-use eval prelude for this session",
		acpDescription: "Toggle computer use",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable computer use for this session" },
			{ name: "off", description: "Disable computer use for this session" },
			{ name: "status", description: "Show computer use status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`Computer: ${cfgComputerEnabled.get(runtime.ctx.session.settings) ? "on" : "off"}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(formatComputerUseStatus(runtime.session));
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable = arg === "off" ? false : arg === "on" || !cfgComputerEnabled.get(runtime.session.settings);
				await runtime.output(applyComputerUseToggle(runtime.session, enable));
				return commandConsumed();
			}
			return usage("Usage: /computer [on|off|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(formatComputerUseStatus(runtime.ctx.session));
				clearSubmittedText(runtime);
				return;
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable =
					arg === "off" ? false : arg === "on" || !cfgComputerEnabled.get(runtime.ctx.session.settings);
				runtime.ctx.showStatus(applyComputerUseToggle(runtime.ctx.session, enable));
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus("Usage: /computer [on|off|status]");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "prewalk",
		icon: "prewalk",
		description: "Arm, restart, or drop a one-shot model handoff",
		allowArgs: true,
		acpDescription: "Arm, restart, or drop prewalk",
		acpInputHint: "[restart|off]",
		subcommands: [
			{ name: "restart", description: "Return to @default and re-arm the handoff to the prewalk.into target" },
			{ name: "off", description: "Drop the pending handoff and stay on the active model" },
		],
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg && arg !== "restart" && arg !== "off") return usage("Usage: /prewalk [restart|off]", runtime);
			if (arg === "off") {
				// The coordinator announces a real disarm; only the nothing-armed case needs output here.
				if (!runtime.session.disarmPrewalk()) await runtime.output("Prewalk: nothing armed.");
				return commandConsumed();
			}
			const selector = cfgPrewalkInto.get(runtime.settings);
			// `@@` keeps the model that is active when the handoff runs; no catalog lookup.
			const keep = parsePrewalkKeepModel(selector);
			const resolvedTarget = keep
				? undefined
				: resolveSessionModelSelector(selector, runtime.session, runtime.settings);
			if (resolvedTarget) {
				if (resolvedTarget.error || !resolvedTarget.model) {
					return usage(resolvedTarget.error ?? `Model "${selector}" not found`, runtime);
				}
				if (!runtime.session.modelRegistry.hasConfiguredAuth(resolvedTarget.model)) {
					return usage(`No API key for ${resolvedTarget.model.provider}/${resolvedTarget.model.id}`, runtime);
				}
			}
			const targetThinkingLevel = keep ? keep.thinkingLevel : resolvedTarget?.thinkingLevel;
			if (arg === "restart") {
				const source = resolveSessionModelSelector("@default", runtime.session, runtime.settings);
				if (source.error || !source.model) {
					return usage(source.error ?? 'Model "@default" not found', runtime);
				}
				if (!runtime.session.modelRegistry.hasConfiguredAuth(source.model)) {
					return usage(`No API key for ${source.model.provider}/${source.model.id}`, runtime);
				}
				const targetModel = resolvedTarget?.model ?? source.model;
				const result = await runtime.session.restartPrewalk(
					source.model,
					source.thinkingLevel,
					targetModel,
					targetThinkingLevel,
					keep !== undefined,
				);
				if (result === "rejected") return commandConsumed();
				const restartSource = `${source.model.provider}/${source.model.id}`;
				await runtime.output(
					result === "armed"
						? `Prewalk restarted: using @default (${restartSource}) for planning, then ${keep ? "staying on" : `switching to ${selector}`} (${targetModel.provider}/${targetModel.id}) at the next edit/write (todo-gated).`
						: `Prewalk reset: using @default (${restartSource}); ${selector} resolves to the same model and thinking level, so no handoff was armed. Set prewalk.into to @@ to plan first on the same model.`,
				);
				return commandConsumed();
			}
			const targetModel = resolvedTarget?.model ?? runtime.session.model;
			if (!targetModel) return usage("No active model to keep for prewalk", runtime);
			const armed = runtime.session.armPrewalk(targetModel, targetThinkingLevel, keep !== undefined);
			if (armed) {
				await runtime.output(
					`Prewalk on: ${keep ? "staying on" : "switching to"} ${targetModel.provider}/${targetModel.id} at the next edit/write (todo-gated).`,
				);
			}
			return commandConsumed();
		},
	},
];
