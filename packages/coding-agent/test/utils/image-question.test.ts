import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveCyberAllowlist } from "@oh-my-pi/pi-coding-agent/config/cyber-mode";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveImageQuestionModel } from "@oh-my-pi/pi-coding-agent/utils/image-question";

function makeProxyModel(id: string, compat?: ModelSpec["compat"]): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "myproxy",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		compat,
	} as ModelSpec);
}

function makeSession(active: Model<Api>, available: Model<Api>[], settings = Settings.isolated()): ToolSession {
	return {
		settings,
		modelRegistry: {
			getAvailable: () => available,
		} as unknown as NonNullable<ToolSession["modelRegistry"]>,
		getModelString: () => `${active.provider}/${active.id}`,
		getActiveModelString: () => `${active.provider}/${active.id}`,
	} as unknown as ToolSession;
}

describe("resolveImageQuestionModel wire truth (#9697)", () => {
	it("skips a wire-stripped model that declares image input", () => {
		const stripped = makeProxyModel("deepseek-v4-flash", { stripImageInput: true });
		const vision = makeProxyModel("qwen-vl", { stripImageInput: false });
		const resolved = resolveImageQuestionModel(makeSession(stripped, [stripped, vision]));
		expect(resolved.model.id).toBe("qwen-vl");
	});

	it("throws instead of returning the stripped model when nothing else can see", () => {
		const stripped = makeProxyModel("deepseek-v4-flash", { stripImageInput: true });
		expect(() => resolveImageQuestionModel(makeSession(stripped, [stripped]))).toThrow(
			"Resolved model myproxy/deepseek-v4-flash does not support image input.",
		);
	});
});

describe("resolveImageQuestionModel under cyber mode", () => {
	it("skips an excluded vision model and lands on the allowed one", () => {
		const excludedVision = makeProxyModel("excluded-vl");
		const allowedVision = makeProxyModel("allowed-vl");
		const textOnlyActive = buildModel({
			id: "text-only-active",
			name: "text-only-active",
			api: "openai-completions",
			provider: "myproxy",
			baseUrl: "https://proxy.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		} as ModelSpec);

		const settings = Settings.isolated({ cyberModels: ["myproxy/allowed-vl"] });
		const allowlist = resolveCyberAllowlist(settings, [textOnlyActive, excludedVision, allowedVision]);
		if (!allowlist) throw new Error("Expected the declared allowlist to resolve");
		settings.applyCyberRoles("test-owner", allowlist);

		const resolved = resolveImageQuestionModel(
			makeSession(textOnlyActive, [excludedVision, allowedVision], settings),
		);

		expect(resolved.model.id).toBe("allowed-vl");
	});

	it("reports the existing no-vision-model outcome when only excluded vision models remain", () => {
		const excludedVision = makeProxyModel("only-excluded-vl");
		const allowedText = makeProxyModel("allowed-text", { stripImageInput: true });
		const textOnlyActive = buildModel({
			id: "text-only-active-2",
			name: "text-only-active-2",
			api: "openai-completions",
			provider: "myproxy",
			baseUrl: "https://proxy.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		} as ModelSpec);

		const settings = Settings.isolated({ cyberModels: ["myproxy/allowed-text"] });
		const allowlist = resolveCyberAllowlist(settings, [textOnlyActive, excludedVision, allowedText]);
		if (!allowlist) throw new Error("Expected the declared allowlist to resolve");
		settings.applyCyberRoles("test-owner", allowlist);

		expect(() =>
			resolveImageQuestionModel(makeSession(textOnlyActive, [excludedVision, allowedText], settings)),
		).toThrow("Unable to resolve a model for image questions.");
	});
});
