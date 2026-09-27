import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { shouldUseProviderNativeCompaction } from "@oh-my-pi/pi-agent-core/compaction";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { discoverModelsByProviderType } from "@oh-my-pi/pi-coding-agent/config/model-discovery";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

// A shared model id must not mix credentials, limits, or cached rows across servers.
test("CLIProxyAPI isolates discovery and cached metadata by configured provider", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cliproxyapi-"));
	const auth = await AuthStorage.create(path.join(dir, "auth.db"));
	try {
		const modelsPath = path.join(dir, "models.yml");
		await Bun.write(
			modelsPath,
			`providers:
  proxy-home:
    baseUrl: https://home.invalid
    api: openai-responses
    apiKey: home-test-key
    authHeader: true
    discovery:
      type: cliproxyapi
  proxy-work:
    baseUrl: https://work.invalid/gateway/v1/
    api: openai-responses
    apiKey: work-test-key
    authHeader: true
    discovery:
      type: cliproxyapi
`,
		);
		let homePayload: unknown = {
			models: [
				{
					slug: "shared-model",
					context_window: 64000,
					max_tokens: 8000,
					supported_reasoning_levels: [{ effort: "high" }],
					default_reasoning_level: "high",
				},
			],
		};
		const calls: string[] = [];
		const fetch: FetchImpl = async (input, init) => {
			const url = String(input);
			const authorization = new Headers(init?.headers).get("Authorization");
			calls.push(url);
			if (url === "https://home.invalid/v1/models?client_version=pi") {
				expect(authorization).toBe("Bearer home-test-key");
				return Response.json(homePayload);
			}
			if (url === "https://work.invalid/gateway/v1/models?client_version=pi") {
				expect(authorization).toBe("Bearer work-test-key");
				return Response.json({
					models: [
						{
							slug: "shared-model",
							context_window: 96000,
							max_tokens: 12000,
							supported_reasoning_levels: ["none", "low"],
							default_reasoning_level: "low",
						},
					],
				});
			}
			throw new Error(`Unexpected discovery URL: ${url}`);
		};
		const registry = new ModelRegistry(auth, modelsPath, { fetch });
		expect(registry.getError()).toBeUndefined();
		await registry.refreshProvider("proxy-home");
		await registry.refreshProvider("proxy-work");
		expect(calls).toEqual([
			"https://home.invalid/v1/models?client_version=pi",
			"https://work.invalid/gateway/v1/models?client_version=pi",
		]);
		expect(registry.find("proxy-home", "shared-model")).toMatchObject({
			baseUrl: "https://home.invalid/v1",
			contextWindow: 64000,
			thinking: { efforts: [Effort.High], requiresEffort: true },
		});
		expect(registry.find("proxy-work", "shared-model")).toMatchObject({
			baseUrl: "https://work.invalid/gateway/v1",
			contextWindow: 96000,
			thinking: { efforts: [Effort.Low], requiresEffort: false },
		});

		const offline = new ModelRegistry(auth, modelsPath, {
			fetch: async () => {
				throw new Error("Offline catalog must not request the network");
			},
		});
		await offline.refreshProvider("proxy-home", "offline");
		await offline.refreshProvider("proxy-work", "offline");
		expect(offline.find("proxy-home", "shared-model")?.contextWindow).toBe(64000);
		expect(offline.find("proxy-work", "shared-model")?.contextWindow).toBe(96000);

		// A wrong response shape is a failed refresh, not an authoritative empty catalog.
		homePayload = { data: [{ id: "shared-model" }] };
		await registry.refreshProvider("proxy-home");
		expect(registry.getProviderDiscoveryState("proxy-home")?.status).toBe("cached");
		expect(registry.find("proxy-home", "shared-model")?.contextWindow).toBe(64000);
		homePayload = { models: [] };
		await registry.refreshProvider("proxy-home");
		expect(registry.find("proxy-home", "shared-model")).toBeUndefined();
		expect(registry.find("proxy-work", "shared-model")?.contextWindow).toBe(96000);
	} finally {
		auth.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// GPT models retain the proxy's advertised effort vocabulary.
test("CLIProxyAPI maps reported effort levels and ignores hidden or malformed entries", async () => {
	const models = await discoverModelsByProviderType(
		{
			provider: "proxy-lab",
			api: "openai-responses",
			baseUrl: "https://lab.invalid/v1",
			discovery: { type: "cliproxyapi" },
		},
		{
			getBearerApiKeyResolver: async () => undefined,
			fetch: async () =>
				Response.json({
					models: [
						{
							slug: "gpt-5.4",
							display_name: "GPT 5.4",
							context_window: 1000000,
							max_tokens: 128000,
							input_modalities: ["text", "image"],
							default_reasoning_level: "medium",
							supported_reasoning_levels: [
								"max",
								{ effort: "medium" },
								"low",
								"high",
								"xhigh",
								"max",
								"ultra",
								null,
							],
						},
						{ slug: "gpt-5-mini", supported_reasoning_levels: ["none"] },
						{
							slug: "future-model",
							max_context_window: 2000,
							max_output_tokens: 4000,
							supported_reasoning_levels: ["ultra"],
						},
						{ slug: "hidden-model", visibility: "hide" },
						null,
						{ slug: 42 },
						{ slug: " " },
					],
				}),
		},
	);
	expect(models.map(model => model.id)).toEqual(["gpt-5.4", "gpt-5-mini", "future-model"]);
	expect(models[0]).toMatchObject({
		contextWindow: 1000000,
		maxTokens: 128000,
		input: ["text", "image"],
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			defaultLevel: Effort.Medium,
			requiresEffort: true,
			effortMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		},
	});
	expect(models[1]?.thinking).toBeUndefined();
	expect(models[1]?.reasoning).toBe(false);
	expect(models[2]?.thinking).toBeUndefined();
	expect(models[2]?.maxTokens).toBe(2000);
});

// Authentication failures must reach the registry as auth errors, not an empty catalog.
test("CLIProxyAPI preserves authentication rejection status", async () => {
	await expect(
		discoverModelsByProviderType(
			{
				provider: "proxy-denied",
				api: "openai-responses",
				baseUrl: "https://denied.invalid/v1",
				discovery: { type: "cliproxyapi" },
			},
			{
				getBearerApiKeyResolver: async () => undefined,
				fetch: async () => new Response(null, { status: 403 }),
			},
		),
	).rejects.toMatchObject({ status: 403 });
});

test("CLIProxyAPI selects compaction and thinking by model family", async () => {
	const models = await discoverModelsByProviderType(
		{
			provider: "proxy-families",
			api: "openai-completions",
			baseUrl: "https://families.invalid",
			discovery: { type: "cliproxyapi" },
		},
		{
			getBearerApiKeyResolver: async () => undefined,
			fetch: async () =>
				Response.json({
					models: [
						{ slug: "openai/gpt-5.4" },
						{ slug: "[proxy] claude-sonnet-4-6", supported_reasoning_levels: ["low", "high"] },
						{ slug: "gemini-3-pro" },
						{ slug: "unknown-model" },
					],
				}),
		},
	);
	expect(models[0]).toMatchObject({
		api: "openai-completions",
		remoteCompaction: { api: "openai-responses", v2StreamingEnabled: true },
	});
	expect(models[1]).toMatchObject({
		api: "anthropic-messages",
		remoteCompaction: { enabled: true },
		thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high"] },
	});
	expect(models[2]?.remoteCompaction).toBeUndefined();
	expect(models[3]?.remoteCompaction).toBeUndefined();
});

test("CLIProxyAPI reapplies current provider and model opt-outs to raw cached models", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cliproxyapi-settings-"));
	const auth = await AuthStorage.create(path.join(dir, "auth.db"));
	try {
		const modelsPath = path.join(dir, "models.yml");
		const configure = (settings = "") =>
			Bun.write(
				modelsPath,
				`providers:
  proxy-settings:
    baseUrl: https://settings.invalid
    api: openai-responses
    apiKey: test-key
    authHeader: true
    discovery:
      type: cliproxyapi
${settings}`,
			);
		const providerOptOut = `    remoteCompaction:
      enabled: false
`;
		const modelOptOut = `    modelOverrides:
      gpt-5.4:
        remoteCompaction:
          v2StreamingEnabled: false
          api: openai-completions
    models:
      - id: claude-sonnet-4-6
        api: openai-responses
        remoteCompaction:
          enabled: false
`;
		const fetch: FetchImpl = async () =>
			Response.json({
				models: [{ slug: "gpt-5.4" }, { slug: "claude-sonnet-4-6" }],
			});
		const offlineFetch: FetchImpl = async () => {
			throw new Error("Unexpected network request");
		};
		await configure(providerOptOut);
		const initial = new ModelRegistry(auth, modelsPath, { fetch });
		await initial.refreshProvider("proxy-settings");
		expect(initial.getError()).toBeUndefined();
		for (const id of ["gpt-5.4", "claude-sonnet-4-6"]) {
			const model = initial.find("proxy-settings", id)!;
			expect(model.remoteCompaction?.enabled).toBe(false);
			expect(shouldUseProviderNativeCompaction(model, { remoteEnabled: true })).toBe(false);
		}
		await configure(modelOptOut);
		const overridden = new ModelRegistry(auth, modelsPath, { fetch: offlineFetch });
		await overridden.refreshProvider("proxy-settings", "offline");
		expect(overridden.find("proxy-settings", "gpt-5.4")?.remoteCompaction).toMatchObject({
			api: "openai-completions",
			v2StreamingEnabled: false,
		});
		expect(
			shouldUseProviderNativeCompaction(overridden.find("proxy-settings", "gpt-5.4")!, {
				remoteEnabled: true,
			}),
		).toBe(false);
		expect(overridden.find("proxy-settings", "claude-sonnet-4-6")).toMatchObject({
			api: "openai-responses",
			remoteCompaction: { enabled: false },
		});
		// Fresh discovery must not write model opt-outs into the reusable cache.
		const onlineOverride = new ModelRegistry(auth, modelsPath, { fetch });
		await onlineOverride.refreshProvider("proxy-settings");
		expect(onlineOverride.find("proxy-settings", "claude-sonnet-4-6")?.api).toBe("openai-responses");
		await configure();
		const restored = new ModelRegistry(auth, modelsPath, { fetch: offlineFetch });
		await restored.refreshProvider("proxy-settings", "offline");
		expect(restored.find("proxy-settings", "gpt-5.4")?.remoteCompaction).toMatchObject({
			api: "openai-responses",
			v2StreamingEnabled: true,
		});
		expect(restored.find("proxy-settings", "claude-sonnet-4-6")).toMatchObject({
			api: "anthropic-messages",
			remoteCompaction: { enabled: true },
		});
		for (const id of ["gpt-5.4", "claude-sonnet-4-6"]) {
			expect(
				shouldUseProviderNativeCompaction(restored.find("proxy-settings", id)!, {
					remoteEnabled: true,
				}),
			).toBe(true);
		}
		await configure(`    modelOverrides:
      gpt-5.4:
        remoteCompaction:
          enabled: false
      claude-sonnet-4-6:
        remoteCompaction:
          enabled: false
`);
		const modelDisabled = new ModelRegistry(auth, modelsPath, { fetch: offlineFetch });
		for (const id of ["gpt-5.4", "claude-sonnet-4-6"]) {
			expect(
				shouldUseProviderNativeCompaction(modelDisabled.find("proxy-settings", id)!, {
					remoteEnabled: true,
				}),
			).toBe(false);
		}
		await configure(`    remoteCompaction:
      v2StreamingEnabled: false
`);
		const streamingDisabled = new ModelRegistry(auth, modelsPath, { fetch: offlineFetch });
		expect(
			shouldUseProviderNativeCompaction(streamingDisabled.find("proxy-settings", "gpt-5.4")!, {
				remoteEnabled: true,
			}),
		).toBe(false);
		await configure(providerOptOut);
		const disabled = new ModelRegistry(auth, modelsPath, { fetch: offlineFetch });
		expect(
			shouldUseProviderNativeCompaction(disabled.find("proxy-settings", "gpt-5.4")!, {
				remoteEnabled: true,
			}),
		).toBe(false);
		expect(disabled.find("proxy-settings", "claude-sonnet-4-6")?.remoteCompaction?.enabled).toBe(false);
	} finally {
		auth.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
