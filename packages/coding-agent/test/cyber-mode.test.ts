import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Api, Effort, type Model, type ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type ResolvedCyberAllowlist,
	cyberStateLine,
	filterCyberChain,
	installStartupCyberMode,
	inspectCyberModels,
	planCyberChanges,
	prepareCyberMode,
	resolveCyberAllowlist,
	resolveCyberTarget,
	substituteLaunchModel,
	validateCyberMode,
} from "@oh-my-pi/pi-coding-agent/config/cyber-mode";
import {
	formatModelString,
	resolveModelFromSettings,
	resolveModelRoleValue,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgModelProviderOrder, cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

function makeModel(provider: string, id: string): Model<Api> {
	const spec: ModelSpec<Api> = {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: `https://api.${provider}.example/v1`,
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
	return buildModel(spec);
}

const MODELS: Model<Api>[] = [
	makeModel("anthropic", "claude-sonnet-5"),
	makeModel("anthropic", "claude-opus-5"),
	makeModel("openai", "gpt-6"),
	makeModel("google", "gemini-4"),
	makeModel("xai", "grok-5"),
	makeModel("deepseek", "deepseek-4"),
];

const SELECTORS = MODELS.map(formatModelString);
const UNKNOWN = "anthropic/does-not-exist";

/** Settings whose `modelRoles` are the given chains, with the given allowlist declared. */
function cyberSettings(options: {
	cyberModels?: unknown;
	modelRoles?: Record<string, string>;
	cyberMode?: boolean;
	enabledModels?: string[];
}): Settings {
	return Settings.isolated({
		cyberMode: options.cyberMode,
		cyberModels: options.cyberModels,
		modelRoles: options.modelRoles,
		enabledModels: options.enabledModels,
	});
}

function allowlistOf(settings: Settings): ResolvedCyberAllowlist {
	const allowlist = resolveCyberAllowlist(settings, MODELS);
	if (!allowlist) throw new Error("expected the declared allowlist to resolve");
	return allowlist;
}

/** A settings state whose allowlist is installed, the way a session installs it. */
function protectedSettings(options: Parameters<typeof cyberSettings>[0]): {
	settings: Settings;
	allowlist: ResolvedCyberAllowlist;
} {
	const settings = cyberSettings(options);
	const allowlist = allowlistOf(settings);
	settings.applyCyberRoles("test-owner", allowlist);
	return { settings, allowlist };
}

/** The models a chain names, in order, as the resolver sees them. */
function chainIdentities(chain: string, settings: Settings): (string | undefined)[] {
	return chain
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean)
		.map(entry => {
			const { model } = resolveModelRoleValue(entry, MODELS, { settings });
			return model ? formatModelString(model) : undefined;
		});
}

/** Fixed-seed generator, so a failure reproduces on the next run. */
function makeRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

const SEED = 0x5eed_1234;

describe("cyber chain filtering", () => {
	test("keeps the allowlisted entries of every generated chain, in order", () => {
		const random = makeRandom(SEED);
		let cases = 0;
		for (let iteration = 0; iteration < 250; iteration++) {
			// A random non-empty allowlist, declared in catalogue order.
			const allowed = SELECTORS.filter(() => random() < 0.5);
			const declared = allowed.length > 0 ? allowed : [SELECTORS[0]!];
			const settings = cyberSettings({ cyberModels: declared });
			const allowlist = allowlistOf(settings);

			// A random chain of 1-4 entries, unknown entries included.
			const pool = [...SELECTORS, UNKNOWN];
			const entries = Array.from({ length: 1 + Math.floor(random() * 4) }, () => {
				const index = Math.floor(random() * pool.length);
				return pool[index] ?? UNKNOWN;
			});
			const chain = entries.join(",");
			const filtered = filterCyberChain(chain, allowlist, { getModelRole: role => settings.getModelRole(role) });
			const landed = chainIdentities(filtered, settings).filter((entry): entry is string => entry !== undefined);

			// SC-010: whatever the chain was, the session lands inside the allowlist.
			for (const identity of landed) {
				if (!allowlist.keys.has(identity)) {
					throw new Error(
						`seed ${SEED}: chain ${chain} with allowlist ${declared.join("|")} landed outside it on ${identity}`,
					);
				}
			}

			const expected = chainIdentities(chain, settings).filter(
				(identity): identity is string => identity !== undefined && allowlist.keys.has(identity),
			);
			// Allowlisted entries survive in configured order; the rest are dropped.
			if (expected.length > 0) {
				if (landed.join("|") !== expected.join("|")) {
					throw new Error(
						`seed ${SEED}: chain ${chain} with allowlist ${declared.join("|")} resolved ${landed.join("|")}, expected ${expected.join("|")}`,
					);
				}
				cases++;
			} else if (filtered !== allowlist.primary) {
				// No survivor: the primary cyber model applies (FR-007).
				throw new Error(
					`seed ${SEED}: chain ${chain} with allowlist ${declared.join("|")} resolved ${filtered}, expected primary ${allowlist.primary}`,
				);
			}

			// Filtering an already filtered chain changes nothing.
			const again = filterCyberChain(filtered, allowlist, {
				getModelRole: role => settings.getModelRole(role),
			});
			if (again !== filtered) {
				throw new Error(
					`seed ${SEED}: filtering ${filtered} again gave ${again} with allowlist ${declared.join("|")}`,
				);
			}
		}
		// Guard against a generator that silently produces no filtering cases.
		expect(cases).toBeGreaterThan(50);
	});

	test("drops an entry that resolves outside the allowlist even when it is configured first", () => {
		const settings = cyberSettings({
			cyberModels: ["openai/gpt-6", "google/gemini-4"],
			modelRoles: { default: "xai/grok-5,openai/gpt-6,google/gemini-4" },
		});
		const allowlist = allowlistOf(settings);
		expect(filterCyberChain("xai/grok-5,openai/gpt-6,google/gemini-4", allowlist)).toBe(
			"openai/gpt-6,google/gemini-4",
		);
	});

	test("expands a role alias before filtering, so a chain naming another role still resolves", () => {
		const settings = cyberSettings({
			cyberModels: ["google/gemini-4"],
			modelRoles: { smol: "xai/grok-5,google/gemini-4", default: "@smol" },
		});
		const allowlist = allowlistOf(settings);
		const filtered = filterCyberChain("@smol", allowlist, { getModelRole: role => settings.getModelRole(role) });
		expect(filtered).toBe("google/gemini-4");
	});

	test("a chain whose entries are all unknown lands on the primary", () => {
		const settings = cyberSettings({ cyberModels: ["deepseek/deepseek-4"] });
		const allowlist = allowlistOf(settings);
		expect(filterCyberChain(`${UNKNOWN},${UNKNOWN}`, allowlist)).toBe("deepseek/deepseek-4");
	});

	test("a primary carrying a thinking suffix still resolves inside the allowlist", () => {
		const settings = cyberSettings({ cyberModels: ["anthropic/claude-sonnet-5:high"] });
		const allowlist = allowlistOf(settings);
		expect(allowlist.primary).toBe("anthropic/claude-sonnet-5:high");
		const filtered = filterCyberChain("openai/gpt-6", allowlist);
		expect(filtered).toBe("anthropic/claude-sonnet-5:high");
		const { model, thinkingLevel, explicitThinkingLevel } = resolveModelRoleValue(filtered, MODELS, { settings });
		expect(model ? formatModelString(model) : undefined).toBe("anthropic/claude-sonnet-5");
		expect(explicitThinkingLevel).toBe(true);
		expect(thinkingLevel).toBe(Effort.High);
	});
});

describe("cyber model identity boundaries", () => {
	test("keeps generated ambiguous selectors inside the declared identities across preferences and catalog subsets", () => {
		const random = makeRandom(SEED);
		const providers = ["anthropic", "openai", "google"];
		const models = providers.map(provider => makeModel(provider, "shared-model"));
		for (let mask = 0; mask < 1 << models.length; mask++) {
			const catalog = models.filter((_, index) => mask & (1 << index));
			for (let iteration = 0; iteration < 16; iteration++) {
				const offset = Math.floor(random() * providers.length);
				const providerOrder = [...providers.slice(offset), ...providers.slice(0, offset)];
				const declarations = ["shared-model", "@declared", "anthropic/shared-model", "*/shared-model"];
				const declaration = declarations[iteration % declarations.length]!;
				const settings = Settings.isolated({
					cyberModels: [declaration],
					modelProviderOrder: providerOrder,
					modelRoles: { declared: "shared-model", default: "@candidate", candidate: "shared-model:high" },
				});
				const allowlist = resolveCyberAllowlist(settings, catalog);
				const label = `seed ${SEED}, catalog ${mask}, declaration ${declaration}, preference ${providerOrder}`;
				if (!allowlist) {
					expect(resolveModelRoleValue(declaration, catalog, { settings }).model, label).toBeUndefined();
					continue;
				}
				const primary = resolveModelRoleValue(allowlist.primary, catalog, { settings }).model;
				expect(primary && allowlist.keys.has(formatModelString(primary)), label).toBe(true);
				settings.applyCyberRoles("identity-test", allowlist);
				for (const order of [providerOrder, [...providerOrder].reverse()]) {
					cfgModelProviderOrder.override(settings, order);
					const unfiltered = resolveModelRoleValue("shared-model:high", catalog, { settings });
					if (unfiltered.model && allowlist.keys.has(formatModelString(unfiltered.model))) {
						const filtered = resolveModelRoleValue(settings.getModelRole("candidate"), catalog, { settings });
						expect(filtered.model && formatModelString(filtered.model), label).toBe(
							formatModelString(unfiltered.model),
						);
						expect(filtered.thinkingLevel, label).toBe(Effort.High);
					}
					for (let subset = 1; subset < 1 << catalog.length; subset++) {
						const candidates = catalog.filter((_, index) => subset & (1 << index));
						for (const role of ["default", "candidate"]) {
							const resolved = resolveModelRoleValue(settings.getModelRole(role), candidates, { settings });
							if (resolved.model) {
								expect(allowlist.keys.has(formatModelString(resolved.model)), label).toBe(true);
							}
						}
					}
				}
			}
		}
	});

	test("does not retarget protected selectors to fuzzy siblings or strip literal thinking suffixes in smaller catalogs", () => {
		for (const [allowedId, excludedId] of [
			["shared-model", "shared-model-extra"],
			["router:max", "router"],
		]) {
			const allowed = makeModel("anthropic", allowedId!);
			const excluded = makeModel("anthropic", excludedId!);
			const fallback = makeModel("openai", "permitted-fallback");
			const catalog = [allowed, excluded, fallback];
			const allowedSelector = formatModelString(allowed);
			const fallbackSelector = formatModelString(fallback);
			for (const selector of [allowedSelector, `${allowedSelector}:high`, "@chosen"]) {
				const settings = Settings.isolated({
					cyberModels: [allowedSelector, fallbackSelector],
					modelRoles: { default: `${selector}, ${fallbackSelector}`, chosen: allowedSelector },
				});
				const allowlist = resolveCyberAllowlist(settings, catalog)!;
				settings.applyCyberRoles("narrowed-catalog", allowlist);
				for (const candidates of [[], [excluded], [excluded, fallback]]) {
					const expected = candidates.includes(fallback) ? fallbackSelector : undefined;
					const label = `selector ${selector}, candidates ${candidates.map(formatModelString)}`;
					const resolved = resolveModelRoleValue(settings.getModelRole("default"), candidates, { settings });
					expect(resolved.model && formatModelString(resolved.model), label).toBe(expected);
					const fromSettings = resolveModelFromSettings({
						settings,
						availableModels: candidates,
						roleOrder: ["default"],
					});
					expect(fromSettings && formatModelString(fromSettings), label).toBe(expected);
				}
				// Explicit excluded lookups still reach the operator switch guard and its cyber-specific refusal.
				expect(resolveModelRoleValue(formatModelString(excluded), [excluded], { settings }).model).toBe(excluded);
			}
		}
	});
});

describe("cyber allowlist inspection", () => {
	test("treats two spellings of one model as a duplicate and reports unresolved entries", () => {
		const findings = inspectCyberModels(
			["anthropic/claude-sonnet-5", "claude-sonnet-5", UNKNOWN],
			MODELS,
			Settings.isolated(),
		);
		expect(findings.notAList).toBe(false);
		expect(findings.duplicates).toEqual(["claude-sonnet-5"]);
		expect(findings.unresolved).toEqual([UNKNOWN]);
	});

	test("reports a malformed value instead of coercing it", async () => {
		expect(inspectCyberModels("anthropic/claude-sonnet-5", MODELS).notAList).toBe(true);

		// A non-array `cyberModels` can no longer reach a live `Settings` instance
		// through the typed registry (a constructor override or a handle write
		// both reject it) — only a hand-edited config.yml lands one, so that is
		// what this proves: the loader falls back to the default gracefully
		// (compute()'s warn-once path) instead of crashing or coercing, and
		// `resolveCyberAllowlist` reports nothing usable rather than the string.
		const tempDir = TempDir.createSync("@pi-cyber-malformed-");
		try {
			const agentDir = tempDir.join("agent");
			const cwd = tempDir.join("project");
			fs.mkdirSync(agentDir, { recursive: true });
			fs.mkdirSync(cwd, { recursive: true });
			await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ cyberModels: "not-a-list" }));
			const settings = await Settings.loadReadOnly({ cwd, agentDir });
			expect(resolveCyberAllowlist(settings, MODELS)).toBeUndefined();
		} finally {
			tempDir.removeSync();
		}
	});

	test("re-derives a chain whose alias target a later role layer repoints", () => {
		const settings = cyberSettings({
			cyberModels: SELECTORS,
			modelRoles: { default: "@strong", strong: "anthropic/claude-sonnet-5" },
		});
		settings.applyCyberRoles("test-owner", allowlistOf(settings));
		expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-5");

		// A bundle installs a new role layer under the same alias spelling, so the
		// filtered result computed for `@strong` from the previous layer is stale.
		settings.applyModelProfileRoles({ default: "@strong", strong: "openai/gpt-6" });

		expect(settings.getModelRole("default")).toBe("openai/gpt-6");
	});

	test("resolves a role alias in the allowlist to the model the role names", () => {
		const settings = cyberSettings({
			cyberModels: ["@strong"],
			modelRoles: { strong: "anthropic/claude-sonnet-5" },
		});

		expect([...allowlistOf(settings).keys]).toEqual(["anthropic/claude-sonnet-5"]);
	});

	test("revalidates an allowlist alias against the current raw role rather than its prior filtered value", () => {
		const settings = cyberSettings({
			cyberModels: ["@declared"],
			modelRoles: { declared: SELECTORS[0] },
		});
		settings.applyCyberRoles("test-owner", allowlistOf(settings));
		for (const target of [...SELECTORS.slice(1), UNKNOWN]) {
			settings.overrideModelRoles({ declared: target });
			const prepared = prepareCyberMode(settings, MODELS);
			if (target === UNKNOWN) {
				expect(prepared).toEqual({ ok: false, refusal: { reason: "unresolvable", entries: ["@declared"] } });
			} else {
				expect(prepared.ok).toBe(true);
				if (prepared.ok) {
					expect(prepared.allowlist.primary).toBe(target);
					expect(prepared.allowlist.keys.has(target)).toBe(true);
				}
			}
		}
	});

	test("expands globs into the models they match", () => {
		const allowlist = allowlistOf(cyberSettings({ cyberModels: ["anthropic/*"] }));
		expect([...allowlist.keys].sort()).toEqual(["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"]);
	});

	test("refuses an enable with no configured entries and with none that resolve", () => {
		const empty = prepareCyberMode(cyberSettings({ cyberModels: [] }), MODELS);
		expect(empty).toEqual({ ok: false, refusal: { reason: "empty" } });

		const unresolved = prepareCyberMode(cyberSettings({ cyberModels: [UNKNOWN] }), MODELS);
		expect(unresolved).toEqual({ ok: false, refusal: { reason: "unresolvable", entries: [UNKNOWN] } });
	});

	test("warns about unusable configuration and about an on state it cannot support", () => {
		const warnings: string[] = [];
		validateCyberMode(
			cyberSettings({
				cyberModels: ["anthropic/claude-sonnet-5", "claude-sonnet-5", UNKNOWN, UNKNOWN],
				cyberMode: true,
			}),
			MODELS,
			message => warnings.push(message),
		);
		expect(warnings.some(message => message.includes("more than once"))).toBe(true);
		expect(warnings.some(message => message.includes(UNKNOWN))).toBe(true);
	});

	test("warns when cyberMode is on but nothing resolves", () => {
		const warnings: string[] = [];
		validateCyberMode(cyberSettings({ cyberModels: [UNKNOWN], cyberMode: true }), MODELS, message =>
			warnings.push(message),
		);
		expect(warnings.some(message => message.includes("cyberMode is on"))).toBe(true);
	});
});

describe("cyber startup install", () => {
	test("installs from configuration, degrades when nothing resolves, and stays off when unasked", () => {
		const on = cyberSettings({
			cyberMode: true,
			cyberModels: ["google/gemini-4"],
			modelRoles: { default: "xai/grok-5", smol: "google/gemini-4" },
		});
		expect(installStartupCyberMode(on, MODELS)).toBe("on");
		expect(on.getModelRoles().default).toBe("google/gemini-4");
		expect(on.getModelRoles().smol).toBe("google/gemini-4");

		const degraded = cyberSettings({ cyberMode: true, cyberModels: [UNKNOWN] });
		expect(installStartupCyberMode(degraded, MODELS)).toBe("degraded");
		expect(degraded.getCyberAllowlist()).toBeUndefined();

		const off = cyberSettings({ cyberModels: ["google/gemini-4"] });
		expect(installStartupCyberMode(off, MODELS)).toBe("off");
		expect(off.getCyberAllowlist()).toBeUndefined();
	});
});

describe("cyber role overlay on Settings", () => {
	test("filters every configured role and restores the configuration exactly when switched off", () => {
		const settings = cyberSettings({
			modelRoles: {
				default: "xai/grok-5,google/gemini-4",
				smol: "deepseek/deepseek-4",
				slow: "anthropic/claude-opus-5",
			},
		});
		const before = structuredClone(settings.getModelRoles());

		const ownAllowlist = allowlistOf(cyberSettings({ cyberModels: ["google/gemini-4"] }));
		settings.applyCyberRoles("session-1", ownAllowlist);

		const filtered = settings.getModelRoles();
		expect(filtered.default).toBe("google/gemini-4");
		expect(filtered.smol).toBe("google/gemini-4");
		expect(filtered.slow).toBe("google/gemini-4");
		expect(settings.getCyberAllowlist()).toBe(ownAllowlist);

		settings.clearCyberRoles("session-1", { operator: true });
		expect(settings.getModelRoles()).toEqual(before);
		expect(settings.getCyberAllowlist()).toBeUndefined();
	});

	test("re-filters a role layer replaced under the protection", () => {
		const settings = cyberSettings({ modelRoles: { default: "xai/grok-5" } });
		settings.applyCyberRoles("session-1", allowlistOf(cyberSettings({ cyberModels: ["google/gemini-4"] })));

		cfgModelRoles.override(settings, { default: "openai/gpt-6,google/gemini-4" });
		expect(settings.getModelRoles().default).toBe("google/gemini-4");
	});

	test("keeps the protection when a session that did not install it clears", () => {
		const settings = cyberSettings({ modelRoles: { default: "xai/grok-5" } });
		settings.applyCyberRoles("session-1", allowlistOf(cyberSettings({ cyberModels: ["google/gemini-4"] })));

		settings.clearCyberRoles("session-2");
		expect(settings.getModelRoles().default).toBe("google/gemini-4");

		settings.clearCyberRoles("session-1", { operator: true });
		expect(settings.getModelRoles().default).toBe("xai/grok-5");
	});

	test("reports only the roles whose landed model the protection moved", () => {
		const settings = cyberSettings({
			cyberModels: ["google/gemini-4", "openai/gpt-6"],
			modelRoles: {
				default: "openai/gpt-6,xai/grok-5",
				smol: "xai/grok-5",
				slow: "google/gemini-4",
			},
		});
		const changes = planCyberChanges(settings.getModelRoles(), allowlistOf(settings));
		// `default` keeps its first allowlisted entry and `slow` is allowed as
		// configured, so neither role moved; only `smol` did (FR-011).
		expect(changes).toEqual([{ role: "smol", landed: "google/gemini-4", reason: "substituted" }]);
	});

	test("reports generated unresolved chains that substitute the primary", () => {
		for (let length = 1; length <= 4; length++) {
			const chain = Array.from({ length }, (_, index) => `missing/model-${index}`).join(",");
			const settings = cyberSettings({
				cyberModels: ["google/gemini-4"],
				modelRoles: { task: chain, default: "google/gemini-4" },
			});
			expect(
				planCyberChanges(settings.getModelRoles(), allowlistOf(settings)),
				`unresolved chain length ${length}`,
			).toEqual([{ role: "task", landed: "google/gemini-4", reason: "substituted" }]);
		}
	});
});

describe("cyber launch and re-point target", () => {
	test("keeps primary and launch targets inside every generated catalog subset", () => {
		const random = makeRandom(SEED);
		for (const id of ["shared-model", "router:max"]) {
			const primary = makeModel("anthropic", id);
			const sibling = makeModel("anthropic", `${id}-extra`);
			const excluded = makeModel("anthropic", "unrelated");
			const catalog = [primary, sibling, excluded];
			for (const suffix of ["", ":high"]) {
				for (let mask = 0; mask < 1 << catalog.length; mask++) {
					const available = catalog.filter((_, index) => mask & (1 << index));
					const role = random() < 0.5 ? "default" : "unconfigured";
					const selector = `${formatModelString(primary)}${suffix}`;
					const settings = cyberSettings({
						cyberModels: [selector],
						modelRoles: { default: selector },
					});
					const allowlist = resolveCyberAllowlist(settings, catalog)!;
					settings.applyCyberRoles("test", allowlist);
					const label = `seed ${SEED}, primary ${selector}, catalog ${mask}, role ${role}`;
					const target = resolveCyberTarget(settings, role, available, allowlist);
					expect(target, label).toBe(available.includes(primary) ? primary : undefined);
					const substitution = substituteLaunchModel(excluded, role, settings, available);
					// An unavailable approved target must not mean "keep the excluded launch model".
					expect(substitution, label).toBeDefined();
					expect(substitution?.model, label).toBe(target);
					expect(substitution?.message, label).toContain(formatModelString(excluded));
				}
			}
		}
	});

	test("never returns a model outside the allowlist, for generated roles and current models", () => {
		const random = makeRandom(SEED + 1);
		for (let iteration = 0; iteration < 200; iteration++) {
			const allowed = SELECTORS.filter(() => random() < 0.5);
			const declared = allowed.length > 0 ? allowed : [SELECTORS[0]!];
			const roleNames = ["default", "smol", "slow", "plan"];
			const modelRoles: Record<string, string> = {};
			for (const role of roleNames) {
				const count = 1 + Math.floor(random() * 3);
				const entries = Array.from({ length: count }, () => {
					const index = Math.floor(random() * SELECTORS.length);
					return SELECTORS[index]!;
				});
				modelRoles[role] = entries.join(",");
			}
			const { settings, allowlist } = protectedSettings({ cyberModels: declared, modelRoles });
			const current = MODELS[Math.floor(random() * MODELS.length)]!;
			const role = roleNames[Math.floor(random() * roleNames.length)]!;

			const substitution = substituteLaunchModel(current, role, settings, MODELS);
			const target = substitution?.model ?? current;
			if (!allowlist.keys.has(formatModelString(target))) {
				throw new Error(
					`seed ${SEED}: launching ${formatModelString(current)} as ${role} with allowlist ${declared.join("|")} landed outside it on ${formatModelString(target)}`,
				);
			}
			if (substitution) {
				// The report names both models, so the operator can see the move.
				expect(substitution.message).toContain(formatModelString(current));
				expect(substitution.message).toContain(formatModelString(target));
			}
		}
	});

	test("leaves a cyber-capable launch model alone and passes through an unconfigured one", () => {
		const { settings, allowlist } = protectedSettings({ cyberModels: ["google/gemini-4"] });
		expect(allowlist.keys.has("google/gemini-4")).toBe(true);
		expect(substituteLaunchModel(MODELS[3]!, "default", settings, MODELS)).toBeUndefined();
		expect(substituteLaunchModel(MODELS[2]!, "default", cyberSettings({}), MODELS)).toBeUndefined();
	});

	test("substitutes an excluded launch model and names both models in the report", () => {
		const { settings } = protectedSettings({
			cyberModels: ["google/gemini-4"],
			modelRoles: { default: "google/gemini-4" },
		});
		const substitution = substituteLaunchModel(MODELS[0]!, "default", settings, MODELS);
		expect(substitution).toBeDefined();
		expect(substitution?.model).toBe(MODELS[3]);
		expect(substitution?.message).toContain("anthropic/claude-sonnet-5");
		expect(substitution?.message).toContain("google/gemini-4");
	});

	test("follows the active role's filtered chain, then default, then the primary", () => {
		const { settings, allowlist } = protectedSettings({
			cyberModels: ["anthropic/claude-sonnet-5", "google/gemini-4"],
			modelRoles: {
				default: "anthropic/claude-sonnet-5",
				smol: "xai/grok-5,google/gemini-4",
				slow: "xai/grok-5",
			},
		});
		expect(formatModelString(resolveCyberTarget(settings, "smol", MODELS, allowlist)!)).toBe("google/gemini-4");
		expect(formatModelString(resolveCyberTarget(settings, "slow", MODELS, allowlist)!)).toBe(
			"anthropic/claude-sonnet-5",
		);
		expect(formatModelString(resolveCyberTarget(settings, "unconfigured", MODELS, allowlist)!)).toBe(
			"anthropic/claude-sonnet-5",
		);

		const noDefault = protectedSettings({ cyberModels: ["google/gemini-4"] });
		expect(formatModelString(resolveCyberTarget(noDefault.settings, "smol", MODELS, noDefault.allowlist)!)).toBe(
			"google/gemini-4",
		);
	});
});

describe("cyber state line", () => {
	test("identifies every allowed model and distinguishes enabled from disabled output", () => {
		for (let length = 0; length <= SELECTORS.length; length++) {
			const models = SELECTORS.slice(0, length);
			const active = MODELS[0]!;
			const on = cyberStateLine({ enabled: true, models }, active);
			expect(on, `allowlist length ${length}`).toMatch(/\bon\b/);
			for (const model of models) expect(on, `allowlist length ${length}`).toContain(model);
			const off = cyberStateLine({ enabled: false, models }, active);
			expect(off).toMatch(/\boff\b/);
			for (const model of models) expect(off).not.toContain(model);
		}
	});
});
