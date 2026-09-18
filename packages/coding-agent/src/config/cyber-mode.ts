/**
 * Cyber mode: the operator's allowlist of models that upstream providers will
 * not block for security work, and the pure logic that keeps every role, and
 * every operator switch, inside it.
 *
 * Nothing here imports a session, so each function is callable from a test with
 * a plain model catalogue. The overlay that applies the filter to the merged
 * role view lives on `Settings`, which is why installation is a `Settings`
 * method call rather than a setter this module owns.
 */

import type { Api, Model } from "@oh-my-pi/pi-ai";
import {
	filterAvailableModelsByEnabledPatterns,
	formatModelSelectorValue,
	formatModelString,
	getModelMatchPreferences,
	type ModelMatchPreferences,
	type ModelRoleLookup,
	normalizeModelPatternList,
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
} from "./model-resolver";
import type { Settings } from "./settings";

/**
 * Owner recorded for protection installed from configuration rather than by a
 * session. A config-owned install survives an implicit clear, because a session
 * that did not install it MUST NOT drop it (FR-030).
 */
export const CYBER_CONFIG_OWNER = "config";

/** Findings from the configured allowlist. Every one is a warning, never a failure. */
export interface CyberModeFindings {
	/** The configured value was not a list of selector strings, so it is ignored. */
	notAList: boolean;
	/** Entries that repeat an earlier entry, in first-seen order. */
	duplicates: string[];
	/** Entries that match no available model. */
	unresolved: string[];
	/** Declared entries in configuration order, duplicates included. */
	declared: string[];
}

/**
 * The usable protection: the models an allowlisted chain entry may name, the
 * substitution target for a chain that survives filtering empty, and the
 * catalogue both resolve against.
 */
export interface ResolvedCyberAllowlist {
	/** Identity (`provider/id`) of every allowlisted model. The filter's membership set. */
	keys: ReadonlySet<string>;
	/** First declared entry that resolves to an available model, as a concrete selector. */
	primary: string;
	/** Catalogue the allowlist and every chain entry resolve against. */
	catalog: Model<Api>[];
	/** Preferences used to resolve ambiguous selectors when protection was installed. */
	matchPreferences?: ModelMatchPreferences;
}

/** Why enabling cyber mode was refused. */
export type CyberEnableRefusal = { reason: "empty" } | { reason: "unresolvable"; entries: string[] };

/** Outcome of preparing an enable: the protection to install, or the refusal to report. */
export type CyberEnableResult =
	| { ok: true; allowlist: ResolvedCyberAllowlist }
	| { ok: false; refusal: CyberEnableRefusal };

/** State of cyber mode after a bootstrap install. */
export type CyberStartupStatus = "off" | "on" | "degraded";

/** A cleared value (`null` tombstone) means no entries, not a malformed list. */
function isSelectorList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

/**
 * Inspect the configured allowlist against a model catalogue.
 *
 * Identity is the resolved model, not the spelling: an entry repeats an earlier
 * one when it resolves to the same model, so an alias and its target are one
 * member. A malformed value is reported and ignored rather than coerced, so the
 * operator is never told that a list is in force when it is not.
 */
export function inspectCyberModels(
	value: unknown,
	availableModels: Model<Api>[],
	settings?: Settings,
): CyberModeFindings {
	const empty: CyberModeFindings = { notAList: false, duplicates: [], unresolved: [], declared: [] };
	if (value === undefined || value === null) return empty;

	const notAList = !isSelectorList(value);
	if (notAList) return { ...empty, notAList: true };

	const declared = normalizeModelPatternList(value);
	const seen = new Set<string>();
	const duplicates: string[] = [];
	const unresolved: string[] = [];
	const roles = settings?.getRawModelRoles();
	const roleLookup = roles && { getModelRole: (role: string) => roles[role] };
	const matchPreferences = getModelMatchPreferences(settings);
	for (const entry of declared) {
		const { model } = resolveModelRoleValue(entry, availableModels, { roleLookup, matchPreferences });
		const identity = model ? formatModelString(model) : undefined;
		if (identity === undefined) {
			unresolved.push(entry);
			continue;
		}
		if (seen.has(identity)) {
			duplicates.push(entry);
			continue;
		}
		seen.add(identity);
	}

	return { notAList: false, duplicates, unresolved, declared };
}

function resolveAllowlistFrom(
	findings: CyberModeFindings,
	availableModels: Model<Api>[],
	settings: Settings,
): ResolvedCyberAllowlist | undefined {
	let primary: string | undefined;
	const keys = new Set<string>();
	const matchPreferences = getModelMatchPreferences(settings);
	const roles = settings.getRawModelRoles();
	const roleLookup = { getModelRole: (role: string) => roles[role] };
	for (const entry of findings.declared) {
		const resolved = resolveModelRoleValue(entry, availableModels, { roleLookup, matchPreferences });
		if (!resolved.model) continue;
		const identity = formatModelString(resolved.model);
		primary ??= formatModelSelectorValue(
			identity,
			resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined,
		);
		keys.add(identity);
		// A glob declares all matching identities. Other selectors, including
		// aliases, declare the same single model the role resolver would choose.
		if (entry.includes("*") || entry.includes("?") || entry.includes("[")) {
			for (const model of filterAvailableModelsByEnabledPatterns(availableModels, [entry], settings)) {
				keys.add(formatModelString(model));
			}
		}
	}
	if (primary === undefined) return undefined;
	return { keys, primary, catalog: availableModels, matchPreferences };
}

/**
 * Resolve the configured allowlist, or `undefined` when nothing in it resolves.
 *
 * The result is the value the overlay stores: the filter is derived from it on
 * every merge, so a role layer replaced later, by a model profile switch or a
 * config edit, is filtered against the same allowlist instead of a stale map.
 */
export function resolveCyberAllowlist(
	settings: Settings,
	availableModels: Model<Api>[],
): ResolvedCyberAllowlist | undefined {
	const findings = inspectCyberModels(settings.get("cyberModels"), availableModels, settings);
	if (findings.notAList || findings.declared.length === 0) return undefined;
	return resolveAllowlistFrom(findings, availableModels, settings);
}

/** Prepare an enable, naming the refusal when the configuration cannot support one. */
export function prepareCyberMode(settings: Settings, availableModels: Model<Api>[]): CyberEnableResult {
	const findings = inspectCyberModels(settings.get("cyberModels"), availableModels, settings);
	if (findings.declared.length === 0) return { ok: false, refusal: { reason: "empty" } };

	const allowlist = resolveAllowlistFrom(findings, availableModels, settings);
	if (!allowlist) {
		const entries = findings.unresolved.length > 0 ? findings.unresolved : findings.declared;
		return { ok: false, refusal: { reason: "unresolvable", entries } };
	}
	return { ok: true, allowlist };
}

/** One role whose selection cyber mode moved. */
export interface CyberRoleChange {
	role: string;
	/** Model the role lands on under the protection, as `provider/id`. */
	landed: string;
	/** `filtered` when an allowlisted survivor existed, `substituted` when the primary applied. */
	reason: "filtered" | "substituted";
}

/** Allowlisted survivors of one chain, in configured order. */
function chainSurvivors(
	value: string,
	allowlist: ResolvedCyberAllowlist,
	roleLookup?: ModelRoleLookup,
	matchPreferences = allowlist.matchPreferences,
): string[] {
	const chain = normalizeModelPatternList(value).flatMap(pattern =>
		resolveConfiguredModelPatterns(pattern, roleLookup),
	);
	const survivors: string[] = [];
	for (const pattern of chain) {
		const resolved = resolveModelRoleValue(pattern, allowlist.catalog, {
			roleLookup,
			matchPreferences,
		});
		if (!resolved.model || !allowlist.keys.has(formatModelString(resolved.model))) continue;
		// Store an identity, not an ambiguous selector that another provider order
		// or a smaller downstream catalogue could resolve outside the allowlist.
		survivors.push(
			formatModelSelectorValue(
				formatModelString(resolved.model),
				resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined,
			),
		);
	}
	return survivors;
}

/**
 * Filter one configured role value to its allowlisted entries.
 *
 * Survivors keep their configured relative order, because the filter walks the
 * chain in order and drops without reordering. A chain that keeps nothing
 * resolves to the primary cyber model (FR-007). An alias is expanded first, so
 * a chain naming another role is filtered after expansion (FR-015).
 */
export function filterCyberChain(
	value: string,
	allowlist: ResolvedCyberAllowlist,
	roleLookup?: ModelRoleLookup,
	matchPreferences = allowlist.matchPreferences,
): string {
	const survivors = chainSurvivors(value, allowlist, roleLookup, matchPreferences);
	return survivors.length > 0 ? survivors.join(",") : allowlist.primary;
}

/**
 * Shared membership rule for operator switches and background model calls.
 *
 * The parameter is the narrow shape this rule actually needs, mirroring
 * `getModelMatchPreferences`: callers hand in doubles as well as real settings,
 * and an object without the cyber overlay enforces no protection, which is the
 * unprotected path. A real `Settings` always carries the overlay.
 */
export function cyberAllowsModel(settings: Partial<Pick<Settings, "getCyberAllowlist">>, model: Model<Api>): boolean {
	return settings.getCyberAllowlist?.()?.keys.has(formatModelString(model)) ?? true;
}

/** One role's filtered chain, resolved to a concrete model. */
function resolveCyberRole(settings: Settings, role: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const value = settings.getModelRole(role);
	if (!value) return undefined;
	return resolveModelRoleValue(value, availableModels, {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	}).model;
}

/**
 * The model a role lands on under the protection: its own filtered chain, then
 * the `default` role's, then the primary cyber model (FR-007, FR-008, FR-024).
 *
 * A role whose chain the filter emptied resolves to the primary directly, so the
 * `default` step only adds a landing site when it resolves to something else.
 */
export function resolveCyberTarget(
	settings: Settings,
	role: string,
	availableModels: Model<Api>[],
	allowlist: ResolvedCyberAllowlist,
): Model<Api> | undefined {
	return (
		resolveCyberRole(settings, role, availableModels) ??
		(role === "default" ? undefined : resolveCyberRole(settings, "default", availableModels)) ??
		resolveModelRoleValue(allowlist.primary, availableModels, {
			settings,
			matchPreferences: getModelMatchPreferences(settings),
		}).model
	);
}

/**
 * Substitute a launch model the allowlist excludes (FR-010, FR-024).
 *
 * A session starts here rather than refusing, so an explicit launch model and a
 * persisted model the allowlist has since dropped both land inside it. Returns
 * `undefined` when the model is already cyber-capable, when nothing is
 * configured to replace it with, or when the replacement is the same model, so
 * the caller leaves the launch untouched.
 */
export function substituteLaunchModel(
	model: Model<Api>,
	role: string,
	settings: Settings,
	availableModels: Model<Api>[],
): { model: Model<Api> | undefined; message: string } | undefined {
	const allowlist = settings.getCyberAllowlist();
	if (!allowlist || allowlist.keys.has(formatModelString(model))) return undefined;
	const substitute = resolveCyberTarget(settings, role, availableModels, allowlist);
	if (!substitute) {
		return {
			model: undefined,
			message: `Cyber mode cannot use ${formatModelString(model)}. No cyber-capable model is available in the current selection.`,
		};
	}
	return {
		model: substitute,
		message: `Cyber mode is on: ${formatModelString(model)} is not cyber-capable, so the session starts on ${formatModelString(substitute)} instead.`,
	};
}

/**
 * One line naming the state and what it allows, for the operator surfaces that
 * report a switch: `/cyber`, the key binding, and the RPC path.
 *
 * `activeModel` is the model the session runs now, which a re-point may have
 * just moved, so the line names the session's model rather than the one the
 * caller passed in.
 */
export function cyberStateLine(
	result: { enabled: boolean; models: readonly string[] },
	activeModel?: { provider: string; id: string },
): string {
	if (!result.enabled) return "Cyber mode off — roles resolve from configuration.";
	const active = activeModel ? `, active: ${activeModel.provider}/${activeModel.id}` : "";
	return `Cyber mode on — ${result.models.length} models allowed: ${result.models.join(", ")}${active}`;
}

/**
 * Roles whose landed model the protection changes, with the model each lands on.
 *
 * A role is reported when the model it lands on moves, which is the landed model
 * rather than the shape of its chain: a chain whose first allowlisted entry is
 * still first lands where it always did and is not reported (FR-011, FR-017).
 * Call this against the configured view, before the filter is installed.
 */
export function planCyberChanges(
	roles: ReadOnlyDict<string>,
	allowlist: ResolvedCyberAllowlist,
	matchPreferences = allowlist.matchPreferences,
): CyberRoleChange[] {
	const roleLookup: ModelRoleLookup = { getModelRole: role => roles[role] };
	const changes: CyberRoleChange[] = [];
	for (const role in roles) {
		if (!Object.hasOwn(roles, role)) continue;
		const value = roles[role];
		if (!value) continue;

		const survivors = chainSurvivors(value, allowlist, roleLookup, matchPreferences);
		const landed = survivors[0] ?? allowlist.primary;
		const before = resolveModelRoleValue(value, allowlist.catalog, {
			roleLookup,
			matchPreferences,
		});
		const after = resolveModelRoleValue(landed, allowlist.catalog, { roleLookup });
		if (!after.model) continue;
		if (before.model && formatModelString(before.model) === formatModelString(after.model)) continue;

		changes.push({
			role,
			landed: formatModelString(after.model),
			reason: survivors.length > 0 ? "filtered" : "substituted",
		});
	}
	return changes;
}

/**
 * Report unusable `cyberModels` configuration at startup, and an on state that
 * current configuration cannot support (FR-026, FR-027).
 *
 * Unlike the profile check, selectors are resolved here: an entry that matches no
 * available model is exactly what the operator needs to hear, and the catalogue
 * is settled by the time a session is constructed.
 */
export function validateCyberMode(
	settings: Settings,
	availableModels: Model<Api>[],
	warn: (message: string) => void,
): void {
	const findings = inspectCyberModels(settings.get("cyberModels"), availableModels, settings);
	if (findings.notAList) warn("cyberModels must be a list of model selectors; ignoring it.");
	for (const entry of findings.duplicates) {
		warn(`cyberModels lists '${entry}' more than once; the repeat is ignored.`);
	}
	for (const entry of findings.unresolved) {
		warn(`cyberModels entry '${entry}' matches no available model; ignoring it.`);
	}
	if (settings.get("cyberMode") === true && !resolveCyberAllowlist(settings, availableModels)) {
		warn("cyberMode is on but no cyberModels entry resolves to an available model; starting with cyber mode off.");
	}
}

/**
 * Operator-facing reason an enable was refused (FR-016). One owner of the
 * wording, so the slash command, the key binding, and a degraded restore all
 * report the same reason.
 */
export function cyberRefusalMessage(refusal: CyberEnableRefusal): string {
	return refusal.reason === "empty"
		? "No cyber-capable models configured — add `cyberModels` to your config."
		: `Cyber mode unavailable: none of ${refusal.entries.join(", ")} resolves to an available model.`;
}

/**
 * Install the configured startup protection, before the first role is resolved.
 *
 * `off` means configuration does not ask for cyber mode, `degraded` means it does
 * but nothing in the allowlist resolves, and the session starts unprotected.
 * Either way the caller leaves the recorded state off.
 */
export function installStartupCyberMode(settings: Settings, availableModels: Model<Api>[]): CyberStartupStatus {
	if (settings.get("cyberMode") !== true) return "off";
	const prepared = prepareCyberMode(settings, availableModels);
	if (!prepared.ok) return "degraded";
	settings.applyCyberRoles(CYBER_CONFIG_OWNER, prepared.allowlist);
	return "on";
}
