import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { assistantMsg } from "./utilities";

// Cyber mode at the session boundary: the launch substitution, the re-point of a
// resumed session whose persisted model the allowlist has since dropped, and the
// state a new transcript inherits.
describe("cyber mode across session startup", () => {
	let dir: TempDir;
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5");
	const haiku = getBundledModel("anthropic", "claude-haiku-4-5");
	if (!sonnet || !haiku) throw new Error("Expected bundled Anthropic models to exist");
	const cyberModels = [`${haiku.provider}/${haiku.id}`];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-cyber-session-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
	});

	beforeEach(() => {
		dir = TempDir.createSync("@pi-cyber-session-");
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		dir.removeSync();
	});

	async function start(options: {
		settings: Settings;
		model?: typeof sonnet;
		sessionManager?: SessionManager;
		cyber?: boolean;
	}): Promise<{ session: AgentSession; modelFallbackMessage: string | undefined }> {
		const created = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			modelRegistry,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(dir.path()),
			settings: options.settings,
			model: options.model,
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
		session = created.session;
		return { session: created.session, modelFallbackMessage: created.modelFallbackMessage };
	}

	/** A transcript whose last model entry records the cyber state beside it. */
	async function writeRecordedSession(cyber: boolean | undefined): Promise<string> {
		const file = path.join(dir.path(), `recorded-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-09-01T00:00:00.000Z";
		const entries = [
			{ type: "session", version: 3, id: "cyber-recorded", timestamp, cwd: dir.path() },
			{
				type: "model_change",
				id: "first-model",
				parentId: null,
				timestamp,
				model: `${sonnet.provider}/${sonnet.id}`,
				role: "default",
				cyber,
			},
		];
		await Bun.write(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		return file;
	}

	/** Collects every `source: "cyber"` notice message emitted from now on. */
	function subscribeCyberNotices(target: AgentSession): string[] {
		const notices: string[] = [];
		target.subscribe(event => {
			if (event.type === "notice" && event.source === "cyber") notices.push(event.message);
		});
		return notices;
	}

	/**
	 * A model_change entry recording `cyber`, with a user message appended as its
	 * child: branch() targets a user message and lands on its parent, while
	 * navigateTree() can target any entry directly, so each reaches this
	 * checkpoint through the id it needs.
	 */
	function appendCyberCheckpoint(
		sessionManager: SessionManager,
		cyber: boolean,
	): { modelChangeId: string; childMessageId: string } {
		const modelChangeId = sessionManager.appendModelChange(
			`${haiku.provider}/${haiku.id}`,
			"default",
			false,
			undefined,
			cyber,
		);
		const childMessageId = sessionManager.appendMessage({
			role: "user",
			content: "checkpoint",
			timestamp: Date.now(),
		});
		return { modelChangeId, childMessageId };
	}

	/** A persisted, file-backed history branchable to an earlier recorded cyber state. */
	async function writeCyberTreeSession(
		firstCyber: boolean,
		secondCyber: boolean,
	): Promise<{ file: string; secondUserMessageId: string }> {
		const file = path.join(dir.path(), `tree-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-09-01T00:00:00.000Z";
		const entries = [
			{ type: "session", version: 3, id: "cyber-tree", timestamp, cwd: dir.path() },
			{
				type: "message",
				id: "first-user",
				parentId: null,
				timestamp,
				message: { role: "user", content: "first", timestamp: Date.parse(timestamp) },
			},
			{
				type: "model_change",
				id: "first-model",
				parentId: "first-user",
				timestamp,
				model: `${haiku.provider}/${haiku.id}`,
				role: "default",
				cyber: firstCyber,
			},
			{
				type: "message",
				id: "second-user",
				parentId: "first-model",
				timestamp,
				message: { role: "user", content: "second", timestamp: Date.parse(timestamp) },
			},
			{
				type: "model_change",
				id: "second-model",
				parentId: "second-user",
				timestamp,
				model: `${haiku.provider}/${haiku.id}`,
				role: "default",
				cyber: secondCyber,
			},
		];
		await Bun.write(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		return { file, secondUserMessageId: "second-user" };
	}

	for (const candidates of [[], [sonnet]]) {
		it(`does not reinstate an excluded SDK default after a blocked launch with ${candidates.length} scoped candidates`, async () => {
			const catalog = spyOn(modelRegistry, "getAvailable").mockReturnValue([sonnet, haiku]);
			const scopedCatalog = spyOn(modelRegistry, "getAvailableForProviders").mockReturnValue(candidates);
			try {
				const settings = Settings.isolated({
					cyberMode: true,
					cyberModels,
					modelRoles: { default: `${haiku.provider}/${haiku.id}` },
				});
				const created = await start({ settings, model: sonnet });
				expect(created.session.cyberMode).toBe(true);
				expect(created.session.model).toBeUndefined();
				expect(created.modelFallbackMessage).toContain("Cyber mode");
				expect(created.modelFallbackMessage).toContain(sonnet.id);
			} finally {
				scopedCatalog.mockRestore();
				catalog.mockRestore();
			}
		});
	}

	it("starts on the cyber-capable model when the launch model is outside the allowlist", async () => {
		const settings = Settings.isolated({
			cyberMode: true,
			cyberModels,
			modelRoles: { default: `${haiku.provider}/${haiku.id}` },
		});
		const created = await start({ settings, model: sonnet });

		expect(created.session.model?.id).toBe(haiku.id);
		expect(created.session.cyberMode).toBe(true);
		expect(created.modelFallbackMessage).toContain(`${sonnet.provider}/${sonnet.id}`);
		expect(created.modelFallbackMessage).toContain(`${haiku.provider}/${haiku.id}`);
		expect(created.session.sessionManager.getLastCyberMode()).toBe(true);
	});

	it("starts on the launch model when it is already cyber-capable", async () => {
		const settings = Settings.isolated({
			cyberMode: true,
			cyberModels,
			modelRoles: { default: `${haiku.provider}/${haiku.id}` },
		});
		const created = await start({ settings, model: haiku });

		expect(created.session.model?.id).toBe(haiku.id);
		expect(created.modelFallbackMessage).toBeUndefined();
	});

	it("re-points a resumed session whose recorded model the allowlist dropped", async () => {
		// The protection is recorded on the transcript, not configured: a session
		// that turned it on last time resumes protected (FR-021, FR-024).
		const sessionFile = await writeRecordedSession(true);
		const sessionManager = await SessionManager.open(sessionFile, path.join(dir.path(), "sessions"));
		const settings = Settings.isolated({ cyberModels });

		const created = await start({ settings, sessionManager });

		expect(created.session.model?.id).toBe(haiku.id);
		expect(created.session.cyberMode).toBe(true);
		expect(created.session.sessionManager.getLastCyberMode()).toBe(true);
	});

	for (const configured of [false, true]) {
		it(`reports the resumed active-model substitution once at startup with configuration ${configured}`, async () => {
			const sessionFile = await writeRecordedSession(true);
			const sessionManager = await SessionManager.open(sessionFile, path.join(dir.path(), "sessions"));
			const settings = Settings.isolated({
				cyberMode: configured,
				cyberModels,
				modelRoles: { default: `${haiku.provider}/${haiku.id}` },
			});
			const created = await start({ settings, sessionManager });
			const warnings = [...created.session.configWarnings, created.modelFallbackMessage].filter(
				message => message?.includes(sonnet.id) && message.includes(haiku.id),
			);
			expect(created.session.model?.id).toBe(haiku.id);
			expect(warnings).toHaveLength(1);
			const startupWarnings = [...created.session.configWarnings];
			await created.session.setCyberMode(false);
			await created.session.setModelTemporary(sonnet);
			const notices = subscribeCyberNotices(created.session);
			await created.session.setCyberMode(true);
			expect(notices.filter(message => message.includes(sonnet.id) && message.includes(haiku.id))).toHaveLength(1);
			expect(created.session.configWarnings).toEqual(startupWarnings);
		});
	}

	it("leaves a resumed session unprotected when its transcript recorded the state off", async () => {
		const sessionFile = await writeRecordedSession(false);
		const sessionManager = await SessionManager.open(sessionFile, path.join(dir.path(), "sessions"));
		const settings = Settings.isolated({ cyberModels });

		const created = await start({ settings, sessionManager });

		expect(created.session.model?.id).toBe(sonnet.id);
		expect(created.session.cyberMode).toBe(false);
	});

	it("uses the configured startup value only where the transcript recorded no state", async () => {
		// The record is `undefined` here, not `false`: absent means the session has no
		// predecessor state, so the configured value decides (FR-025). The role chain
		// is filtered onto the allowlist in the same operation.
		const sessionFile = await writeRecordedSession(undefined);
		const sessionManager = await SessionManager.open(sessionFile, path.join(dir.path(), "sessions"));
		const settings = Settings.isolated({
			cyberMode: true,
			cyberModels,
			modelRoles: { default: `${sonnet.provider}/${sonnet.id}` },
		});

		const created = await start({ settings, sessionManager });

		expect(created.session.cyberMode).toBe(true);
		expect(created.session.model?.id).toBe(haiku.id);
	});

	it("releases the claim this session installed on a shared configuration state when it is disposed", async () => {
		// A session that no longer exists must not keep filtering the roles of the
		// sessions sharing its settings, and the release must be this session's own
		// claim only.
		const settings = Settings.isolated({
			cyberModels,
			modelRoles: { default: `${sonnet.provider}/${sonnet.id}` },
		});
		const created = await start({ settings, model: sonnet });
		expect((await created.session.setCyberMode(true)).enabled).toBe(true);
		expect(settings.getModelRole("default")).toBe(`${haiku.provider}/${haiku.id}`);
		expect(settings.getCyberAllowlist()).toBeDefined();

		await created.session.dispose();
		session = undefined;

		expect(settings.getCyberAllowlist()).toBeUndefined();
		expect(settings.getModelRole("default")).toBe(`${sonnet.provider}/${sonnet.id}`);
	});

	it("keeps the configured claim when a session that did not install it is disposed", async () => {
		const settings = Settings.isolated({
			cyberMode: true,
			cyberModels,
			modelRoles: { default: `${sonnet.provider}/${sonnet.id}` },
		});
		const created = await start({ settings, model: sonnet });
		expect(created.session.cyberMode).toBe(true);

		await created.session.dispose();
		session = undefined;

		expect(settings.getCyberAllowlist()).toBeDefined();
		expect(settings.getModelRole("default")).toBe(`${haiku.provider}/${haiku.id}`);
	});

	for (const declaration of [[], ["anthropic/does-not-exist"]]) {
		it(`warns when a recorded on state starts with an ${declaration.length === 0 ? "empty" : "unresolvable"} declaration`, async () => {
			const sessionFile = await writeRecordedSession(true);
			const sessionManager = await SessionManager.open(sessionFile, path.join(dir.path(), "sessions"));
			// The recorded state carries no list of its own, so an allowlist that no
			// longer resolves degrades the state instead of reporting protection the
			// session does not have (FR-026).
			const settings = Settings.isolated({ cyberModels: declaration });

			const created = await start({ settings, sessionManager });

			expect(created.session.cyberMode).toBe(false);
			expect(created.session.model?.id).toBe(sonnet.id);
			expect(created.session.configWarnings.some(message => /cyber mode|cyber-capable/i.test(message))).toBe(true);
		});
	}

	it("keeps config-driven protection in force when the transcript recorded the session state off", async () => {
		const sessionFile = await writeRecordedSession(false);
		const sessionManager = await SessionManager.open(sessionFile, path.join(dir.path(), "sessions"));
		const settings = Settings.isolated({
			cyberMode: true,
			cyberModels,
			modelRoles: { default: `${sonnet.provider}/${sonnet.id},${haiku.provider}/${haiku.id}` },
		});

		const created = await start({ settings, sessionManager });

		// The record governs what the session reports (FR-021), while protection
		// installed from configuration is additive and survives the session's own
		// adoption of an off state (FR-030): the roles stay filtered.
		expect(created.session.cyberMode).toBe(false);
		expect(created.session.settings.getModelRole("default")).toBe(`${haiku.provider}/${haiku.id}`);
		expect(
			created.session.configWarnings.some(message => message.includes("default") && message.includes(haiku.id)),
		).toBe(true);
		const notices = subscribeCyberNotices(created.session);
		settings.setModelRole("task", `${sonnet.provider}/${sonnet.id}`);
		expect(notices.some(message => message.includes("task") && message.includes(haiku.id))).toBe(true);
		expect(created.session.cyberMode).toBe(false);
	});

	it("releases the protection this session installed when it switches to a session recorded off", async () => {
		// The owner is the session object, not the transcript id it happens to be
		// showing: an owner that followed the switch would leave this session's own
		// protection installed for the rest of the process.
		const settings = Settings.isolated({
			cyberModels,
			modelRoles: { default: `${sonnet.provider}/${sonnet.id}` },
		});
		const sessionDir = path.join(dir.path(), "sessions");
		const created = await start({
			settings,
			model: sonnet,
			sessionManager: SessionManager.create(dir.path(), sessionDir),
		});
		const result = await created.session.setCyberMode(true);
		expect(result.enabled).toBe(true);
		expect(settings.getModelRole("default")).toBe(`${haiku.provider}/${haiku.id}`);

		const targetFile = await writeRecordedSession(false);

		// The switch loads a transcript that recorded its own state, and the cwd is
		// not what this test is about.
		expect(await created.session.switchSession(targetFile, { preserveLocalCwd: true })).toBe(true);

		expect(created.session.cyberMode).toBe(false);
		expect(settings.getCyberAllowlist()).toBeUndefined();
		expect(settings.getModelRole("default")).toBe(`${sonnet.provider}/${sonnet.id}`);
	});

	it("carries the cyber state onto the transcript a new session inherits", async () => {
		const settings = Settings.isolated({
			cyberMode: true,
			cyberModels,
			modelRoles: { default: `${haiku.provider}/${haiku.id}` },
		});
		const created = await start({ settings, model: sonnet });
		expect(created.session.cyberMode).toBe(true);

		await created.session.newSession();

		expect(created.session.cyberMode).toBe(true);
		expect(created.session.sessionManager.getLastCyberMode()).toBe(true);
		expect(created.session.model?.id).toBe(haiku.id);
	});

	it("reports a startup role substitution through configWarnings, not a notice listener", async () => {
		// The constructor runs before any notice listener can attach, so this
		// report has to reach configWarnings instead of emitNotice (FR-011).
		const settings = Settings.isolated({
			cyberMode: true,
			cyberModels,
			modelRoles: { default: `${haiku.provider}/${haiku.id}`, task: "missing/model" },
		});
		const created = await start({ settings, model: haiku });

		expect(created.session.configWarnings.some(w => w.includes("task") && w.includes(haiku.id))).toBe(true);
	});

	it.each(["configuration", "profile"] as const)(
		"reports excluded and unresolved roles after a live %s edit",
		async source => {
			const settings = Settings.isolated({
				cyberModels,
				modelRoles: { default: `${haiku.provider}/${haiku.id}`, task: `${haiku.provider}/${haiku.id}` },
			});
			const created = await start({ settings, model: haiku });
			const notices = subscribeCyberNotices(created.session);
			await created.session.setCyberMode(true);
			expect(notices).toHaveLength(0);

			for (const [role, target] of [
				["task", `${sonnet.provider}/${sonnet.id}`],
				["reviewer", "missing/model"],
			] as const) {
				if (source === "configuration") settings.setModelRole(role, target);
				else settings.applyModelProfileRoles({ [role]: target });
				expect(settings.getModelRole(role)).toBe(`${haiku.provider}/${haiku.id}`);
				expect(notices.some(message => message.includes(role) && message.includes(haiku.id))).toBe(true);
			}
			expect(notices).toHaveLength(2);
		},
	);

	it("reports a provider preference change even when the filtered role remains unchanged", async () => {
		const available = spyOn(modelRegistry, "getAvailable").mockReturnValue([haiku, { ...haiku, provider: "openai" }]);
		try {
			const settings = Settings.isolated({
				cyberMode: true,
				cyberModels,
				modelProviderOrder: ["anthropic", "openai"],
				modelRoles: { default: `${haiku.provider}/${haiku.id}`, task: haiku.id },
			});
			const created = await start({ settings, model: haiku });
			const notices = subscribeCyberNotices(created.session);

			settings.override("modelProviderOrder", ["openai", "anthropic"]);

			expect(settings.getModelRole("task")).toBe(`${haiku.provider}/${haiku.id}`);
			expect(notices.some(message => message.includes("task") && message.includes(haiku.id))).toBe(true);
		} finally {
			available.mockRestore();
		}
	});

	it("scopes the no-model role report to the transcript", async () => {
		// A surface that only sees its role resolution fail reports the role and the
		// excluded model it could not use (FR-011). The session owns the dedup, so a
		// repeated block in one transcript stays silent while a new transcript
		// reports it again (FR-012).
		const settings = Settings.isolated({ cyberMode: true, cyberModels });
		const created = await start({ settings, model: haiku });
		const notices = subscribeCyberNotices(created.session);
		const excluded = `${sonnet.provider}/${sonnet.id}`;

		created.session.reportCyberRoleWithoutModel("tiny", excluded);
		created.session.reportCyberRoleWithoutModel("tiny", excluded);

		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain('"tiny"');
		expect(notices[0]).toContain(excluded);

		await created.session.newSession();
		created.session.reportCyberRoleWithoutModel("tiny", excluded);

		expect(notices).toHaveLength(2);
	});

	it("does not repeat a role/model pair within one transcript", async () => {
		const settings = Settings.isolated({
			cyberModels,
			modelRoles: { default: `${haiku.provider}/${haiku.id}`, task: `${sonnet.provider}/${sonnet.id}` },
		});
		const created = await start({ settings, model: haiku });
		const notices = subscribeCyberNotices(created.session);

		expect((await created.session.setCyberMode(true)).enabled).toBe(true);
		expect(notices).toHaveLength(1);

		expect((await created.session.setCyberMode(false)).enabled).toBe(false);
		expect((await created.session.setCyberMode(true)).enabled).toBe(true);

		expect(notices).toHaveLength(1);
		const { modelChangeId } = appendCyberCheckpoint(created.session.sessionManager, true);
		await created.session.navigateTree(modelChangeId);
		expect(notices).toHaveLength(1);
	});

	it("reports an active-model repoint when enabling cyber mode moves a model no role names", async () => {
		// The active model can diverge from every role's own value (an explicit
		// switch sets it directly), so the role-table diff alone would miss it;
		// the repoint has its own report (T044).
		const settings = Settings.isolated({
			cyberModels,
			modelRoles: { default: `${haiku.provider}/${haiku.id}` },
		});
		const created = await start({ settings, model: haiku });
		await created.session.setModelTemporary(sonnet);
		expect(created.session.model?.id).toBe(sonnet.id);

		const notices = subscribeCyberNotices(created.session);
		const result = await created.session.setCyberMode(true);

		expect(result.enabled).toBe(true);
		expect(result.changes).toHaveLength(0);
		expect(created.session.model?.id).toBe(haiku.id);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain(sonnet.id);
		expect(notices[0]).toContain(haiku.id);
	});

	it("reports a substitution again on a new transcript after the startup substitution already reported it", async () => {
		const settings = Settings.isolated({
			cyberMode: true,
			cyberModels,
			modelRoles: { default: `${haiku.provider}/${haiku.id}`, task: `${sonnet.provider}/${sonnet.id}` },
		});
		const created = await start({ settings, model: haiku });
		expect(created.session.configWarnings.some(w => w.includes("task"))).toBe(true);

		const notices = subscribeCyberNotices(created.session);
		await created.session.newSession();

		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("task");
	});

	it("reports a substitution again after switching sessions, even though it was already reported", async () => {
		const settings = Settings.isolated({
			cyberMode: true,
			cyberModels,
			modelRoles: { default: `${haiku.provider}/${haiku.id}`, task: `${sonnet.provider}/${sonnet.id}` },
		});
		const sessionDir = path.join(dir.path(), "sessions");
		const created = await start({
			settings,
			model: haiku,
			sessionManager: SessionManager.create(dir.path(), sessionDir),
		});
		expect(created.session.configWarnings.some(w => w.includes("task"))).toBe(true);

		const targetFile = await writeRecordedSession(true);
		const notices = subscribeCyberNotices(created.session);

		expect(await created.session.switchSession(targetFile, { preserveLocalCwd: true })).toBe(true);

		expect(notices.some(n => n.includes("task"))).toBe(true);
	});

	for (const enabled of [false, true]) {
		for (const foreignOwner of [false, true]) {
			it(`restores cyber state after a failed switch from ${enabled} with foreign ownership ${foreignOwner}`, async () => {
				const originalFile = await writeRecordedSession(enabled);
				const incomingFile = await writeRecordedSession(!enabled);
				const sessionManager = await SessionManager.open(originalFile, path.join(dir.path(), "sessions"));
				const settings = Settings.isolated({
					cyberModels,
					modelRoles: { default: `${haiku.provider}/${haiku.id}`, task: `${sonnet.provider}/${sonnet.id}` },
				});
				if (foreignOwner) {
					const siblingManager = SessionManager.inMemory(dir.path());
					siblingManager.appendModelChange(`${haiku.provider}/${haiku.id}`, "default", false, undefined, true);
					const sibling = await start({ settings, sessionManager: siblingManager });
					// Preserve a foreign claim without retaining a second live session fixture.
					settings.applyCyberRoles("foreign", settings.getCyberAllowlist()!);
					await sibling.session.dispose();
				}
				const created = await start({ settings, sessionManager });
				const beforeModel = created.session.model;
				const notices = subscribeCyberNotices(created.session);
				const failSwitch = spyOn(created.session.agent, "setModel").mockImplementationOnce(() => {
					throw new Error("injected target model failure");
				});
				try {
					await expect(created.session.switchSession(incomingFile)).rejects.toThrow(
						"injected target model failure",
					);
				} finally {
					failSwitch.mockRestore();
				}
				expect(created.session.sessionFile).toBe(originalFile);
				expect(created.session.model).toBe(beforeModel);
				expect(created.session.cyberMode).toBe(enabled);
				expect(settings.getCyberAllowlist() !== undefined).toBe(enabled || foreignOwner);
				expect(notices).toEqual([]);
				if (foreignOwner) {
					settings.clearCyberRoles("foreign");
					expect(settings.getCyberAllowlist() !== undefined).toBe(enabled);
				}
				if (enabled) {
					await created.session.setCyberMode(false);
					await created.session.setCyberMode(true);
					expect(notices.filter(message => message.includes("task"))).toEqual([]);
				}
			});
		}
	}

	for (const declaration of [[], ["anthropic/does-not-exist"]]) {
		it(`degrades inherited cyber mode when the declaration is ${declaration.length === 0 ? "empty" : "unresolvable"}`, async () => {
			const settings = Settings.isolated({
				cyberMode: true,
				cyberModels,
				modelRoles: { default: `${haiku.provider}/${haiku.id}` },
			});
			const created = await start({ settings, model: haiku });
			expect(created.session.cyberMode).toBe(true);

			settings.override("cyberModels", declaration);
			const notices = subscribeCyberNotices(created.session);

			await created.session.newSession();

			expect(created.session.cyberMode).toBe(false);
			expect(created.session.sessionManager.getLastCyberMode()).toBe(false);
			expect(notices.some(message => message.includes(declaration[0] ?? "cyberModels"))).toBe(true);
			// The session's degradation must not clear the configuration owner's protection.
			await expect(created.session.setModelTemporary(sonnet)).rejects.toThrow("Cyber mode");
		});
	}

	it("keeps cyber mode on and re-points across a new session when the declaration changes but still resolves", async () => {
		const settings = Settings.isolated({
			cyberMode: true,
			cyberModels,
			modelRoles: { default: `${haiku.provider}/${haiku.id}` },
		});
		const created = await start({ settings, model: haiku });
		expect(created.session.cyberMode).toBe(true);
		expect(created.session.model?.id).toBe(haiku.id);

		// The declaration now allows only Sonnet: the previous allowlist member is excluded.
		settings.override("cyberModels", [`${sonnet.provider}/${sonnet.id}`]);
		const notices = subscribeCyberNotices(created.session);

		await created.session.newSession();

		expect(created.session.cyberMode).toBe(true);
		expect(created.session.model?.id).toBe(sonnet.id);
		expect(created.session.sessionManager.getLastCyberMode()).toBe(true);
		expect(notices.some(n => n.includes(haiku.id) && n.includes(sonnet.id))).toBe(true);
	});

	it.each(["branch", "navigateTree"] as const)(
		"restores an off session to the on state a %s target recorded",
		async method => {
			const settings = Settings.isolated({ cyberModels, modelRoles: { default: `${haiku.provider}/${haiku.id}` } });
			const created = await start({ settings, model: haiku });
			const { modelChangeId, childMessageId } = appendCyberCheckpoint(created.session.sessionManager, true);
			expect(created.session.cyberMode).toBe(false);

			if (method === "branch") await created.session.branch(childMessageId);
			else await created.session.navigateTree(modelChangeId);

			expect(created.session.cyberMode).toBe(true);
			expect(created.session.sessionManager.getLastCyberMode()).toBe(true);
		},
	);

	it.each(["branch", "navigateTree"] as const)(
		"turns an on session off at the state a %s target recorded",
		async method => {
			const settings = Settings.isolated({
				cyberMode: true,
				cyberModels,
				modelRoles: { default: `${haiku.provider}/${haiku.id}` },
			});
			const created = await start({ settings, model: haiku });
			expect(created.session.cyberMode).toBe(true);
			const { modelChangeId, childMessageId } = appendCyberCheckpoint(created.session.sessionManager, false);

			if (method === "branch") await created.session.branch(childMessageId);
			else await created.session.navigateTree(modelChangeId);

			expect(created.session.cyberMode).toBe(false);
			expect(created.session.sessionManager.getLastCyberMode()).toBe(false);
		},
	);

	it.each(["branch", "navigateTree"] as const)(
		"re-points an excluded active model when a %s lands on a branch recorded on",
		async method => {
			const settings = Settings.isolated({ cyberModels, modelRoles: { default: `${haiku.provider}/${haiku.id}` } });
			const created = await start({ settings, model: haiku });
			const { modelChangeId, childMessageId } = appendCyberCheckpoint(created.session.sessionManager, true);
			await created.session.setModelTemporary(sonnet);
			expect(created.session.model?.id).toBe(sonnet.id);

			if (method === "branch") await created.session.branch(childMessageId);
			else await created.session.navigateTree(modelChangeId);

			expect(created.session.cyberMode).toBe(true);
			expect(created.session.model?.id).toBe(haiku.id);
		},
	);

	it("keeps config-driven protection installed when this session branches to a recorded off state", async () => {
		// cyberMode: true installs a config-owned claim before the session object
		// exists (installStartupCyberMode); this session's own claim is a second,
		// independent owner layered on top, and releasing only its own claim must
		// not disturb the config-owned one (FR-030).
		const settings = Settings.isolated({
			cyberMode: true,
			cyberModels,
			modelRoles: { default: `${sonnet.provider}/${sonnet.id}` },
		});
		const created = await start({ settings, model: haiku });
		expect(created.session.cyberMode).toBe(true);

		const { childMessageId } = appendCyberCheckpoint(created.session.sessionManager, false);
		await created.session.branch(childMessageId);

		expect(created.session.cyberMode).toBe(false);
		expect(settings.getCyberAllowlist()).toBeDefined();
		expect(settings.getModelRole("default")).toBe(`${haiku.provider}/${haiku.id}`);
	});

	for (const method of ["branch", "navigateTree"] as const) {
		for (const configuredOwner of [false, true]) {
			it(`records degraded ${method} state with ${configuredOwner ? "configuration" : "session"} ownership`, async () => {
				const settings = Settings.isolated({
					cyberMode: configuredOwner,
					cyberModels,
					modelRoles: { default: `${haiku.provider}/${haiku.id}` },
				});
				const sessionDir = path.join(dir.path(), "sessions");
				const { file: sourceFile } = await writeCyberTreeSession(true, true);
				const created = await start({
					settings,
					model: haiku,
					sessionManager: await SessionManager.open(sourceFile, sessionDir),
				});
				await created.session.setCyberMode(true);
				const { modelChangeId, childMessageId } = appendCyberCheckpoint(created.session.sessionManager, true);
				const declaration = configuredOwner ? ["anthropic/does-not-exist"] : [];
				settings.override("cyberModels", declaration);
				const notices = subscribeCyberNotices(created.session);

				if (method === "branch") await created.session.branch(childMessageId);
				else await created.session.navigateTree(modelChangeId);

				expect(created.session.cyberMode).toBe(false);
				expect(created.session.sessionManager.getLastCyberMode()).toBe(false);
				expect(settings.getCyberAllowlist() !== undefined).toBe(configuredOwner);
				expect(notices.some(message => message.includes(declaration[0] ?? "cyberModels"))).toBe(true);

				const file = created.session.sessionManager.getSessionFile();
				if (!file) throw new Error("Expected the adopted branch to have a session file");
				await created.session.dispose();
				session = undefined;
				settings.override("cyberModels", cyberModels);
				const reopened = await SessionManager.open(file, sessionDir);
				expect(reopened.getLastCyberMode()).toBe(false);
				const resumed = await start({ settings, sessionManager: reopened });
				// Repairing configuration must not revive the state that degraded to off.
				expect(resumed.session.cyberMode).toBe(false);
			});
		}
	}

	it("restores the on state a persisted branch recorded, after resuming on a later off leaf", async () => {
		const { file, secondUserMessageId } = await writeCyberTreeSession(true, false);
		const sessionManager = await SessionManager.open(file, path.join(dir.path(), "sessions"));
		const settings = Settings.isolated({ cyberModels });
		const created = await start({ settings, sessionManager });
		expect(created.session.cyberMode).toBe(false);

		await created.session.branch(secondUserMessageId);

		expect(created.session.cyberMode).toBe(true);
		expect(created.session.sessionManager.getLastCyberMode()).toBe(true);

		const branchFile = created.session.sessionManager.getSessionFile();
		if (!branchFile) throw new Error("Expected the branch to have a session file");
		await created.session.dispose();
		session = undefined;
		const resumedManager = await SessionManager.open(branchFile, path.join(dir.path(), "sessions"));
		const resumed = await start({ settings, sessionManager: resumedManager });
		expect(resumed.session.cyberMode).toBe(true);
		expect(resumed.session.model?.id).toBe(haiku.id);
	});

	it("keeps report history across repeated same-transcript reloads", async () => {
		const file = await writeRecordedSession(true);
		const sessionManager = await SessionManager.open(file, path.join(dir.path(), "sessions"));
		const settings = Settings.isolated({
			cyberModels,
			modelRoles: { default: `${haiku.provider}/${haiku.id}`, task: `${sonnet.provider}/${sonnet.id}` },
		});
		const created = await start({ settings, sessionManager });
		expect(created.session.configWarnings.some(message => message.includes("task"))).toBe(true);
		const notices = subscribeCyberNotices(created.session);
		for (let reload = 0; reload < 3; reload++) {
			await created.session.reload();
			expect(created.session.sessionFile).toBe(file);
			expect(created.session.cyberMode).toBe(true);
			expect(notices.filter(message => message.includes("task"))).toEqual([]);
		}
	});

	async function adoptTranscript(target: AgentSession, method: "fork" | "btw"): Promise<void> {
		if (method === "fork") {
			await target.fork();
			return;
		}
		await target.branchFromBtw(
			"side question",
			{
				role: "assistant",
				content: [{ type: "text", text: "side answer" }],
				api: haiku.api,
				provider: haiku.provider,
				model: haiku.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
			target.sessionManager.getLeafId()!,
			target.sessionManager.getSessionId(),
		);
	}

	for (const method of ["fork", "btw"] as const) {
		for (const declaration of [
			{ name: "empty", models: [], enabled: false, model: haiku },
			{ name: "unresolved", models: ["anthropic/unknown-model"], enabled: false, model: haiku },
			{ name: "changed", models: [`${sonnet.provider}/${sonnet.id}`], enabled: true, model: sonnet },
		]) {
			for (const configuredOwner of [false, true]) {
				it(`revalidates ${method} with ${declaration.name} declaration and config ownership ${configuredOwner}`, async () => {
					const file = await writeRecordedSession(true);
					const sessionManager = await SessionManager.open(file, path.join(dir.path(), "sessions"));
					const settings = Settings.isolated({
						cyberMode: configuredOwner,
						cyberModels,
						modelRoles: { default: `${haiku.provider}/${haiku.id}` },
					});
					const created = await start({ settings, sessionManager });
					const previousId = sessionManager.getSessionId();
					const notices = subscribeCyberNotices(created.session);
					settings.override("cyberModels", declaration.models);
					await adoptTranscript(created.session, method);
					expect(sessionManager.getSessionId()).not.toBe(previousId);
					expect(created.session.cyberMode).toBe(declaration.enabled);
					expect(created.session.model?.id).toBe(declaration.model.id);
					expect(settings.getCyberAllowlist() !== undefined).toBe(declaration.enabled || configuredOwner);
					expect(notices.some(message => /cyber mode|cyber-capable/i.test(message))).toBe(true);
					await sessionManager.flush();
					const reopened = await SessionManager.open(
						sessionManager.getSessionFile()!,
						path.join(dir.path(), "reopen"),
					);
					try {
						expect(reopened.getLastCyberMode()).toBe(declaration.enabled);
					} finally {
						await reopened.close();
					}
				});
			}
		}
		it(`reports substitutions once on the new ${method} transcript`, async () => {
			const file = await writeRecordedSession(true);
			const sessionManager = await SessionManager.open(file, path.join(dir.path(), "sessions"));
			const settings = Settings.isolated({
				cyberModels,
				modelRoles: { default: `${haiku.provider}/${haiku.id}`, task: `${sonnet.provider}/${sonnet.id}` },
			});
			const created = await start({ settings, sessionManager });
			expect(created.session.configWarnings.some(message => message.includes("task"))).toBe(true);
			const notices = subscribeCyberNotices(created.session);
			await adoptTranscript(created.session, method);
			expect(notices.filter(message => message.includes("task"))).toHaveLength(1);
			await created.session.setCyberMode(false);
			await created.session.setCyberMode(true);
			expect(notices.filter(message => message.includes("task"))).toHaveLength(1);
		});
	}

	// `/clear` drops the conversation but keeps the session, so the state, the
	// installed allowlist, and the protection itself all continue (FR-022,
	// US4/AC2). The reset never touches cyber state by design; this pins that
	// design so a later change to `resetSessionContext` cannot silently drop
	// protection on a continuing session.
	it("keeps cyber mode, its allowlist, and the recorded state across /clear", async () => {
		const settings = Settings.isolated({
			cyberMode: true,
			cyberModels,
			modelRoles: { default: `${haiku.provider}/${haiku.id}` },
		});
		const sessionManager = SessionManager.create(dir.path(), dir.path());
		const created = await start({ settings, model: sonnet, sessionManager });
		expect(created.session.cyberMode).toBe(true);
		expect(created.session.model?.id).toBe(haiku.id);
		expect(sessionManager.getLastCyberMode()).toBe(true);

		// A real `/clear` runs on a conversation, and the transcript has to exist
		// on disk for the resume below to read anything back.
		const user = { role: "user" as const, content: "first question", timestamp: Date.now() };
		const assistant = assistantMsg("first answer");
		created.session.agent.appendMessage(user);
		sessionManager.appendMessage(user);
		created.session.agent.appendMessage(assistant);
		sessionManager.appendMessage(assistant);

		const reset = await created.session.resetSessionContext();
		expect(reset).toBeDefined();

		expect(created.session.cyberMode).toBe(true);
		expect(created.session.model?.id).toBe(haiku.id);
		expect(settings.getCyberAllowlist()?.keys.has(`${haiku.provider}/${haiku.id}`)).toBe(true);
		// Still in force, not merely a flag: the excluded switch is refused.
		await expect(created.session.setModel(sonnet)).rejects.toThrow(/not cyber-capable/);

		// A resume of the continuing transcript still reads the state back.
		await sessionManager.flush();
		expect(sessionManager.getLastCyberMode()).toBe(true);
		const reopened = await SessionManager.open(sessionManager.getSessionFile()!, path.join(dir.path(), "reopen"));
		try {
			expect(reopened.getLastCyberMode()).toBe(true);
		} finally {
			await reopened.close();
		}
	});
});
