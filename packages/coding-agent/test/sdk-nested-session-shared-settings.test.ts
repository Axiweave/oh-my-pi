import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Regression for a nested createAgentSession() call sharing the same live
// Settings as an already-running parent (mirrors agents-hub.ts's architect
// session, which passes `settings: this.#settings` straight through), and
// for the companion /new-style explicit session switch that must still fall
// back to the configured startup profile.
describe("createAgentSession() with a Settings instance shared by a live parent session", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	const sonnet45 = getBundledModel("anthropic", "claude-sonnet-4-5");
	const sonnet46 = getBundledModel("anthropic", "claude-sonnet-4-6");
	const haiku = getBundledModel("anthropic", "claude-haiku-4-5");
	if (!sonnet45 || !sonnet46 || !haiku) throw new Error("Expected bundled Anthropic models to exist");

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-nested-session-settings-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(registryDir, "models.yml"));
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose();
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	function selector(model: { provider: string; id: string }): string {
		return `${model.provider}/${model.id}`;
	}

	async function newSession(settings: Settings, sessionManager?: SessionManager) {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: sessionManager ?? SessionManager.inMemory(registryDir),
			settings,
			model: sonnet45,
			disableExtensionDiscovery: true,
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["__none__"],
			customTools: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		sessions.push(session);
		return session;
	}

	it("does not let a nested session reinstalling the startup profile revert the parent's explicit switch", async () => {
		const settings = Settings.isolated({
			modelProfile: "startup",
			modelProfiles: {
				startup: { default: selector(sonnet45), plan: selector(sonnet45) },
				strong: { default: selector(sonnet46), plan: selector(sonnet46) },
			},
		});

		const parent = await newSession(settings);
		expect(parent.activeModelProfile).toBe("startup");
		expect(parent.settings.getModelRole("plan")).toBe(selector(sonnet45));

		await parent.applyModelProfile("strong");
		expect(parent.activeModelProfile).toBe("strong");
		expect(parent.settings.getModelRole("plan")).toBe(selector(sonnet46));

		// Nested creation on the exact same live Settings instance, as
		// agents-hub.ts's architect session does.
		const nested = await newSession(settings);

		expect(parent.activeModelProfile).toBe("strong");
		expect(parent.settings.getModelRole("plan")).toBe(selector(sonnet46));
		expect(settings.getModelRole("plan")).toBe(selector(sonnet46));

		// Must not misreport "startup" either — its role layer is whatever the
		// parent already installed, under a name it never itself applied.
		expect(nested.activeModelProfile).toBeUndefined();
	});

	it("still installs the startup profile for a freshly created Settings instance", async () => {
		const settings = Settings.isolated({
			modelProfile: "fast",
			modelProfiles: { fast: { default: selector(haiku) } },
		});

		const session = await newSession(settings);
		expect(session.activeModelProfile).toBe("fast");
		expect(session.settings.getModelRole("default")).toBe(selector(haiku));
	});

	it("falls back to the configured startup profile when switching to an untagged session, preserving CLI overrides", async () => {
		const settings = Settings.isolated({
			modelProfile: "startup",
			modelProfiles: {
				startup: { default: selector(sonnet45), plan: selector(sonnet45) },
				strong: { default: selector(sonnet46), plan: selector(sonnet46) },
			},
		});
		// Mirrors `--smol`: a CLI override installed before any profile switch.
		settings.overrideModelRoles({ smol: selector(haiku) });

		const sessionManager = SessionManager.create(registryDir, path.join(registryDir, "switch-source"));
		const session = await newSession(settings, sessionManager);
		expect(session.activeModelProfile).toBe("startup");

		await session.applyModelProfile("strong");
		expect(session.activeModelProfile).toBe("strong");
		expect(session.settings.getModelRole("plan")).toBe(selector(sonnet46));

		// An empty, untagged session follows startup settings rather than the outgoing profile.
		const targetManager = SessionManager.create(registryDir, path.join(registryDir, "switch-target"));
		await targetManager.flush();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file to be created");

		expect(await session.switchSession(targetFile)).toBe(true);

		expect(session.activeModelProfile).toBe("startup");
		expect(session.settings.getModelRole("plan")).toBe(selector(sonnet45));
		expect(session.settings.getModelRole("smol")).toBe(selector(haiku));
	});
});
