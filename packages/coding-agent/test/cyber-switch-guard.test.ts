import { describe, expect, it } from "bun:test";
import { type Api, type Model, type ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveCyberAllowlist } from "@oh-my-pi/pi-coding-agent/config/cyber-mode";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelControls, type ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";

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
];

/** A host stub: the guard paths are decided before any of this is needed. */
function createControls(options: {
	allowlist: string[];
	cyber: boolean;
	current: Model<Api>;
	scopedModels?: Model<Api>[];
}): { controls: ModelControls; recorded: string[] } {
	const settings = Settings.isolated({ cyberModels: options.allowlist });
	const allowlist = resolveCyberAllowlist(settings, MODELS);
	if (!allowlist) throw new Error("expected the declared allowlist to resolve");
	// The state a session lands in on resume: recorded on, so the constructor
	// installs the protection from configuration.
	settings.applyCyberRoles("test-session", allowlist);

	let current = options.current;
	const recorded: string[] = [];
	const host = {
		agent: { state: { messages: [] }, setThinkingLevel: () => {}, setDisableReasoning: () => {} },
		settings,
		modelRegistry: {
			getAvailable: () => MODELS,
			hasConfiguredAuth: () => true,
			refreshSelectedModelMetadata: async (model: Model<Api>) => model,
			clearSuppressedSelector: () => {},
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
		},
		sessionManager: {
			sessionId: () => "test-session",
			getLastModelProfile: () => undefined,
			getLastCyberMode: () => options.cyber,
			appendModelChange: (model: string) => {
				recorded.push(model);
				return "entry";
			},
			appendThinkingLevelChange: () => "entry",
		},
		providerSessionState: new Map(),
		model: () => current,
		sessionId: () => "test-session",
		promptGeneration: () => 0,
		resolveActiveEditMode: () => "accept",
		syncAfterModelChange: async () => {},
		setModelWithProviderSessionReset: async (model: Model<Api>) => {
			current = model;
		},
		clearActiveRetryFallback: () => {},
		clearInheritedProviderPromptCacheKey: () => {},
		magicKeywordEnabled: () => false,
		emit: () => {},
		emitSessionEvent: async () => {},
		emitNotice: () => {},
	} as unknown as ModelControlsHost;

	const scopedModels = options.scopedModels?.map(model => ({ model }));
	return { controls: new ModelControls(host, { scopedModels }), recorded };
}

const allowed = formatModelString(MODELS[0]!);
const excluded = MODELS[2]!;

describe("cyber switch guard", () => {
	it("refuses a direct switch to a model outside the allowlist and leaves the session on its model", async () => {
		const { controls, recorded } = createControls({ allowlist: [allowed], cyber: true, current: MODELS[0]! });

		await expect(controls.setModel(excluded)).rejects.toThrow(/not cyber-capable/);
		expect(recorded).toEqual([]);
	});

	it("refuses a temporary switch to a model outside the allowlist", async () => {
		const { controls } = createControls({ allowlist: [allowed], cyber: true, current: MODELS[0]! });

		await expect(controls.setModelTemporary(excluded)).rejects.toThrow(/not cyber-capable/);
	});

	it("allows a switch to a model the allowlist covers, and records the state beside it", async () => {
		const { controls, recorded } = createControls({ allowlist: [allowed], cyber: true, current: MODELS[0]! });

		await expect(controls.setModel(MODELS[0]!, "default")).resolves.toEqual({ switched: true });
		expect(recorded).toEqual([allowed]);
	});

	it("refuses a cycle that would land outside the allowlist", async () => {
		const { controls } = createControls({
			allowlist: [allowed],
			cyber: true,
			current: MODELS[0]!,
			scopedModels: [MODELS[0]!, excluded],
		});

		await expect(controls.cycleModel("forward")).rejects.toThrow(/not cyber-capable/);
	});

	it("cycles among allowed models and lands inside the allowlist", async () => {
		const { controls } = createControls({
			allowlist: [allowed, formatModelString(MODELS[1]!)],
			cyber: true,
			current: MODELS[0]!,
			scopedModels: [MODELS[0]!, MODELS[1]!],
		});

		const cycled = await controls.cycleModel("forward");
		expect(cycled?.model.id).toBe(MODELS[1]!.id);
	});

	it("refuses a cycle through the available catalogue that would land outside the allowlist", async () => {
		const { controls } = createControls({ allowlist: [allowed], cyber: true, current: MODELS[0]! });

		// The next available model is excluded, so the cycle refuses rather than
		// moving: every refusal names cyber mode as the reason (FR-009, SC-010).
		await expect(controls.cycleModel("forward")).rejects.toThrow(/Cyber mode is on and .* is not cyber-capable/);
	});

	it("does not guard switches while cyber mode is off", async () => {
		const { controls } = createControls({ allowlist: [allowed], cyber: false, current: MODELS[0]! });

		await expect(controls.setModelTemporary(excluded)).resolves.toBeUndefined();
	});
});
