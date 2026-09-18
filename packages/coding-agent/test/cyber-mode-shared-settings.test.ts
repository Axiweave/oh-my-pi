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
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// FR-029 and FR-030: cyber protection belongs to the configuration state a
// session runs against, as the active model profile does. Sessions sharing that
// state share one protection, adding is additive for every owner, an implicit
// clear only removes protection the caller itself installed, and an explicit
// operator switch-off always clears.
describe("cyber protection on configuration state shared by several sessions", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	const haiku = getBundledModel("anthropic", "claude-haiku-4-5");
	const sonnet = getBundledModel("anthropic", "claude-sonnet-4-6");
	if (!haiku || !sonnet) throw new Error("Expected bundled Anthropic models to exist");

	const allowed = `${haiku.provider}/${haiku.id}`;
	const excluded = `${sonnet.provider}/${sonnet.id}`;

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-cyber-shared-settings-${Snowflake.next()}`);
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

	/** The two non-cyber roles resolve to the excluded model, so the filter has work to do. */
	function sharedSettings(overrides: Record<string, unknown> = {}): Settings {
		return Settings.isolated({
			cyberModels: [allowed],
			modelRoles: { default: excluded, smol: excluded, slow: excluded },
			...overrides,
		});
	}

	async function startSession(settings: Settings): Promise<AgentSession> {
		const created = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(registryDir),
			settings,
			model: sonnet,
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
		sessions.push(created.session);
		return created.session;
	}

	it("protects every session on the shared state once one of them enables it", async () => {
		const settings = sharedSettings();
		const parent = await startSession(settings);
		expect(parent.cyberMode).toBe(false);

		const result = await parent.setCyberMode(true);
		expect(result.enabled).toBe(true);
		expect(parent.cyberMode).toBe(true);
		expect(settings.getModelRole("default")).toBe(allowed);

		// The sibling starts after the install. Its own recorded state is nothing,
		// so its indicator stays hidden, but the shared state still constrains it:
		// the excluded launch model is substituted for the allowlisted primary.
		const sibling = await startSession(settings);
		expect(sibling.cyberMode).toBe(false);
		expect(`${sibling.model?.provider}/${sibling.model?.id}`).toBe(allowed);
		expect(settings.getModelRole("smol")).toBe(allowed);
	});

	it("keeps protection through every implicit clear but the owner's own", async () => {
		const settings = sharedSettings();
		const session = await startSession(settings);
		await session.setCyberMode(true);

		// Another session adopting an off state names itself as the owner, and owns
		// nothing here. The inversion the feature must never allow is a nested
		// session dropping its parent's protection while sharing the state.
		for (const foreign of ["", "sibling-session", `${session.sessionId}-nested`]) {
			settings.clearCyberRoles(foreign);
			expect(settings.getCyberAllowlist()).toBeDefined();
			expect(settings.getModelRole("default")).toBe(allowed);
		}

		// The owner's own implicit clear removes it, which is what clearing the mode
		// on the session that installed it does.
		settings.clearCyberRoles(session.sessionId);
		expect(settings.getCyberAllowlist()).toBeUndefined();
		expect(settings.getModelRole("default")).toBe(excluded);
		expect(settings.getModelRole("slow")).toBe(excluded);
	});

	it("keeps config-driven protection that no session installed, until an operator switch-off", async () => {
		const settings = sharedSettings({ cyberMode: true });
		const session = await startSession(settings);
		expect(session.cyberMode).toBe(true);

		// The install belongs to the configuration, not to this session, so the
		// session's implicit clear cannot drop it.
		settings.clearCyberRoles(session.sessionId);
		expect(settings.getCyberAllowlist()).toBeDefined();
		expect(session.cyberMode).toBe(true);

		// An explicit switch-off always clears, whatever installed the protection.
		await session.setCyberMode(false);
		expect(settings.getCyberAllowlist()).toBeUndefined();
		expect(session.cyberMode).toBe(false);
		expect(settings.getModelRole("default")).toBe(excluded);
	});

	it("constrains a session whose own state is off while a sibling holds protection", async () => {
		const settings = sharedSettings();
		const parent = await startSession(settings);
		const sibling = await startSession(settings);

		await sibling.setCyberMode(true);

		// Over-restriction is the accepted direction: the parent keeps reporting its
		// own state, so no indicator, while role resolution follows the filter the
		// shared configuration now carries.
		expect(parent.cyberMode).toBe(false);
		expect(settings.getModelRole("default")).toBe(allowed);
		expect(settings.getModelRole("smol")).toBe(allowed);

		// The protection governs the operator surfaces too, not only role
		// resolution: the parent's own flag being off is not a way past the filter
		// a sibling installed on the state they share (FR-029, SC-010). It can
		// still move inside the allowlist, so the protection filters rather than
		// freezing the session.
		await parent.setModel(haiku);
		expect(`${parent.model?.provider}/${parent.model?.id}`).toBe(allowed);
		await expect(parent.setModel(sonnet)).rejects.toThrow("is not cyber-capable");
		await expect(parent.setModelTemporary(sonnet)).rejects.toThrow("is not cyber-capable");
		expect(`${parent.model?.provider}/${parent.model?.id}`).toBe(allowed);

		// An explicit switch-off always clears what another session installed
		// (FR-030), which is what makes the refusal message's remedy real.
		await parent.setCyberMode(false);
		expect(settings.getCyberAllowlist()).toBeUndefined();
		await parent.setModel(sonnet);
		expect(`${parent.model?.provider}/${parent.model?.id}`).toBe(excluded);
	});

	it("restores the configured role chains when a subagent snapshot releases protection", async () => {
		const settings = sharedSettings();
		const parent = await startSession(settings);
		await parent.setCyberMode(true);

		const child = createSubagentSettings(settings);
		// The snapshot carries the parent's live protection and substitutes the
		// excluded chains it was configured with.
		expect(child.getCyberAllowlist()).toBeDefined();
		expect(child.getModelRole("smol")).toBe(allowed);

		// Releasing it must reveal the configured chain again, not the filtered one.
		child.clearCyberRoles("parent", { operator: true });
		expect(child.getRawModelRoles().smol).toBe(excluded);
		expect(child.getModelRole("smol")).toBe(excluded);
	});

	it("retains runtime protection through nested settings snapshots without changing unprotected selection", async () => {
		// Invariant: descendants inherit protection, even though the startup setting remains off.
		for (const enabled of [false, true]) {
			const settings = sharedSettings();
			const parent = await startSession(settings);
			if (enabled) await parent.setCyberMode(true);
			let inherited = settings;
			for (let depth = 1; depth <= 2; depth++) {
				inherited = createSubagentSettings(inherited, {
					modelRoles: { default: excluded, smol: excluded },
				});
				const child = await startSession(inherited);
				const label = `protection=${enabled}, depth=${depth}`;
				expect(`${child.model?.provider}/${child.model?.id}`, label).toBe(enabled ? allowed : excluded);
				expect(child.cyberMode, label).toBe(false);
				if (enabled) {
					await expect(child.setModel(sonnet)).rejects.toThrow("is not cyber-capable");
					await expect(child.setModelTemporary(sonnet)).rejects.toThrow("is not cyber-capable");
				}
			}
		}
	});
});
