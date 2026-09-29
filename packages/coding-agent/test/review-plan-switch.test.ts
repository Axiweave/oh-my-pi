import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	type ModelRoleLookup,
	resolveAgentModelSelection,
	reviewPlanLookup,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "./helpers/session-defaults";

// The review plan switch sends every review onto the `plan` role. Properties:
// - off, or on with no `plan` role, resolves exactly as before (SC-004, FR-011);
// - on, no resolved review pattern reaches the reviewer model (SC-001);
// - on, a review agent or a selector naming `@reviewer` lands on `plan` and
//   retries through the `plan` chain, whatever the saved override says (FR-002);
// - on, only a request selector outranks the switch (Q1), and everything else
//   resolves as before.

const PLAN = "anthropic/claude-opus-4-6";
const REVIEWER = "openai-codex/gpt-5.5";
const SLOW = "anthropic/claude-sonnet-4-6";
const SMOL = "anthropic/claude-haiku-4-5";
const DEFAULT = "google/gemini-2.5-pro";
const FIXED = "openrouter/deepseek-v3";

const AGENTS = ["reviewer", "plan-reviewer", "impl-reviewer", "task", "scout", "custom-auditor", undefined];
const OVERRIDES: Array<string | string[] | undefined> = [
	undefined,
	FIXED,
	"@reviewer",
	"@slow",
	"@task",
	["@smol", "@reviewer"],
];
const AGENT_MODELS: Array<string | string[] | undefined> = [
	undefined,
	"@slow",
	["@reviewer", "@slow"],
	"@task",
	FIXED,
	"@reviewer",
];
const REQUESTS: Array<string | undefined> = [undefined, undefined, FIXED, "@reviewer", "@smol"];
const REVIEW_AGENTS = new Set(["reviewer", "plan-reviewer", "impl-reviewer"]);

/** mulberry32: small seeded generator so every failure replays from the printed seed. */
function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(next: () => number, values: readonly T[]): T {
	return values[Math.floor(next() * values.length)] as T;
}

/** Whether the selector's first role alias is `@reviewer`: that alias names the spawn's role. */
function leadsWithReviewer(value: string | string[] | undefined): boolean {
	return [value].flat().find(pattern => pattern?.startsWith("@")) === "@reviewer";
}

describe("review plan switch model resolution", () => {
	const seed = 0x5eed05;
	const withPlan = Settings.isolated({
		modelRoles: { default: DEFAULT, plan: PLAN, reviewer: REVIEWER, slow: SLOW, smol: SMOL },
	});
	const withoutPlan = Settings.isolated({
		modelRoles: { default: DEFAULT, reviewer: REVIEWER, slow: SLOW, smol: SMOL },
	});

	it(`holds every property over generated spawns (seed ${seed})`, () => {
		console.log(`review-plan-switch seed: ${seed}`);
		const next = rng(seed);
		for (let run = 0; run < 400; run++) {
			const agentName = pick(next, AGENTS);
			const base = {
				requestModel: pick(next, REQUESTS),
				settingsOverride: pick(next, OVERRIDES),
				agentModel: pick(next, AGENT_MODELS),
				activeModelPattern: next() < 0.5 ? DEFAULT : undefined,
				agentName,
			};
			const label = `seed ${seed} run ${run}: ${JSON.stringify(base)}`;
			for (const settings of [withPlan, withoutPlan]) {
				const legacy = resolveAgentModelSelection({ ...base, agentName: undefined, settings });
				expect(resolveAgentModelSelection({ ...base, settings, reviewPlan: false }), label).toEqual(legacy);
			}
			// No `plan` role: the switch is on but inactive, so nothing moves.
			expect(resolveAgentModelSelection({ ...base, settings: withoutPlan, reviewPlan: true }), label).toEqual(
				resolveAgentModelSelection({ ...base, settings: withoutPlan }),
			);

			const off = resolveAgentModelSelection({ ...base, settings: withPlan });
			const on = resolveAgentModelSelection({ ...base, settings: withPlan, reviewPlan: true });
			expect(
				on.patterns.some(pattern => pattern.startsWith(REVIEWER)),
				label,
			).toBe(false);
			if (base.requestModel !== undefined) {
				const expected = base.requestModel === "@reviewer" ? PLAN : base.requestModel === "@smol" ? SMOL : FIXED;
				expect(on.patterns, label).toEqual([expected]);
			} else if (
				(agentName !== undefined && REVIEW_AGENTS.has(agentName)) ||
				leadsWithReviewer(base.settingsOverride) ||
				leadsWithReviewer(base.agentModel)
			) {
				expect(on.patterns, label).toContain(PLAN);
				expect(on.role, label).toBe("plan");
			} else {
				// Everything else resolves as before, with any `@reviewer` entry read as `plan`.
				const moved = off.patterns.map(pattern => (pattern === REVIEWER ? PLAN : pattern));
				expect(on, label).toEqual({ patterns: moved, role: off.role });
			}
		}
	});

	it("moves a review agent off a saved fixed-model override", () => {
		const base = { settings: withPlan, settingsOverride: FIXED, agentModel: "@slow", agentName: "reviewer" };
		expect(resolveAgentModelSelection(base).patterns).toEqual([FIXED]);
		expect(resolveAgentModelSelection({ ...base, reviewPlan: true })).toEqual({ patterns: [PLAN], role: "plan" });
	});

	it("keeps the fallback entries a review selector lists after `@reviewer`", () => {
		const selection = resolveAgentModelSelection({
			settings: withPlan,
			agentModel: ["@reviewer", "@slow"],
			agentName: "plan-reviewer",
			reviewPlan: true,
		});
		expect(selection).toEqual({ patterns: [PLAN, SLOW], role: "plan" });
	});
});

describe("review plan role lookup", () => {
	const seed = 0x7e1e5;
	const ROLES = ["default", "plan", "reviewer", "slow", "smol", "task", "advisor", "commit"];
	const VALUES = [undefined, PLAN, REVIEWER, SLOW, SMOL, DEFAULT, FIXED];

	it(`moves only the reviewer role, and nothing while off (seed ${seed})`, () => {
		console.log(`review-plan-lookup seed: ${seed}`);
		const next = rng(seed);
		for (let run = 0; run < 300; run++) {
			// Generated role maps, including an empty map and maps with no plan or reviewer.
			const map: Record<string, string | undefined> = {};
			for (const role of ROLES) if (next() < 0.6) map[role] = pick(next, VALUES);
			const base: ModelRoleLookup = { getModelRole: role => map[role] };
			const on = reviewPlanLookup(base, true);
			const off = reviewPlanLookup(base, false);
			const label = `seed ${seed} run ${run}: ${JSON.stringify(map)}`;
			for (const role of [...ROLES, "unknown-role"]) {
				expect(off.getModelRole(role), `${label} off ${role}`).toBe(map[role]);
				expect(on.getModelRole(role), `${label} on ${role}`).toBe(role === "reviewer" ? map.plan : map[role]);
			}
		}
	});
});

describe("review plan retry chain", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const models = [PLAN, REVIEWER].map(selector => {
		const [provider, id] = selector.split("/") as [string, string];
		return buildModel({
			provider,
			id,
			name: id,
			api: "openai-completions",
			baseUrl: `https://${provider}.example.test`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		});
	});

	/** A child session that yields at once, so the spawn finishes without a model call. */
	function yieldingChild(): AgentSession {
		const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
		return {
			...createSessionDefaults(),
			agent: { state: { systemPrompt: ["test"] } },
			state: { messages: [] },
			model: models[0],
			extensionRunner: undefined,
			sessionManager: { appendSessionInit: () => {} },
			getActiveToolNames: () => ["yield"],
			getEnabledToolNames: () => ["yield"],
			subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
				listeners.push(listener);
				return () => {};
			},
			prompt: async () => {
				for (const listener of listeners) {
					listener({
						type: "tool_execution_end",
						toolCallId: "tool-yield",
						toolName: "yield",
						result: { content: [{ type: "text", text: "done" }], details: { status: "success" } },
						isError: false,
					});
				}
			},
		} as unknown as AgentSession;
	}

	// A chain's key order is the user's YAML order, so both orders must give the same answer.
	for (const chains of [
		{ reviewer: ["openai/gpt-4o-mini"], plan: ["openai/gpt-4o"] },
		{ plan: ["openai/gpt-4o"], reviewer: ["openai/gpt-4o-mini"] },
	]) {
		const order = Object.keys(chains).join(" before ");
		it(`gives a reviewer spawn the chain of the role the switch picks, and the switch itself (${order})`, async () => {
			for (const reviewPlan of [false, true]) {
				let child: CreateAgentSessionOptions | undefined;
				vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
					child = options;
					return { session: yieldingChild(), extensionsResult: {}, setToolUIContext: () => {} } as never;
				});
				const settings = Settings.isolated({
					modelRoles: { default: DEFAULT, plan: PLAN, reviewer: REVIEWER },
					"retry.fallbackChains": chains,
				});
				const selection = resolveAgentModelSelection({
					settings,
					agentModel: "@reviewer",
					agentName: "reviewer",
					reviewPlan,
				});
				const role = reviewPlan ? "plan" : "reviewer";
				await runSubprocess({
					cwd: "/tmp",
					agent: { name: "reviewer", description: "test", systemPrompt: "test", source: "bundled" },
					task: "review",
					index: 0,
					id: "rp-chain",
					modelOverride: selection.patterns,
					modelRole: selection.role,
					reviewPlan,
					settings,
					modelRegistry: {
						refresh: async () => {},
						getAvailable: () => models,
						getApiKey: async () => "test-key",
					} as never,
					enableLsp: false,
				});
				const label = `reviewPlan ${reviewPlan}`;
				const childChains = child?.settings ? cfgRetryFallbackChains.get(child.settings) : undefined;
				expect(childChains?.["subagent:rp-chain"], label).toEqual(chains[role]);
				expect(child?.reviewPlan, label).toBe(reviewPlan);
				vi.restoreAllMocks();
			}
		});
	}
});

describe("review plan main-session retry chain", () => {
	const sonnet = getBundledModel("anthropic", "claude-sonnet-4-6");
	const opus = getBundledModel("anthropic", "claude-opus-4-6");
	const haiku = getBundledModel("anthropic", "claude-haiku-4-5");
	if (!sonnet || !opus || !haiku) throw new Error("Expected bundled Anthropic models to exist");
	const selector = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-review-plan-chain-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings: Settings.isolated() });
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/** Recovery for a session running `model`; only the parts chain resolution reads are real. */
	function recovery(model: typeof opus, active: boolean, chains: Record<string, string[]>): TurnRecovery {
		const settings = Settings.isolated({
			modelRoles: { default: selector(sonnet), plan: selector(opus), reviewer: selector(haiku) },
			"retry.fallbackChains": chains,
		});
		return new TurnRecovery({
			model: () => model,
			sessionManager: { getLastModelChangeRole: () => undefined },
			settings,
			modelRegistry,
			reviewPlanActive: () => active,
		} as unknown as TurnRecoveryHost);
	}

	// A chain's key order is the user's YAML order, so both orders must give the same answer.
	for (const chains of [
		{ reviewer: ["openai/gpt-4o-mini"], plan: ["openai/gpt-4o"] },
		{ plan: ["openai/gpt-4o"], reviewer: ["openai/gpt-4o-mini"] },
	]) {
		const order = Object.keys(chains).join(" before ");
		it(`never lets the reviewer chain claim a plan-model session (${order})`, () => {
			for (const active of [false, true]) {
				const label = `active ${active}`;
				expect(recovery(opus, active, chains).resolveRetryFallbackRole(selector(opus)), label).toBe("plan");
			}
		});

		it(`reads a reviewer reference as the plan chain only while the switch is on (${order})`, () => {
			for (const active of [false, true]) {
				const label = `active ${active}`;
				const role = recovery(opus, active, chains).resolveRetryFallbackRole(selector(opus), opus, "reviewer");
				expect(role, label).toBe(active ? "plan" : "reviewer");
			}
			expect(recovery(haiku, false, chains).resolveRetryFallbackRole(selector(haiku))).toBe("reviewer");
		});
	}
});
