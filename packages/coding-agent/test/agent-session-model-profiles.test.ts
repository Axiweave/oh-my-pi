import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type ModelProfilesSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession model profiles", () => {
	let tempDir: TempDir;
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let sessionSettings: Settings;

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-model-profiles-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-model-profiles-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		tempDir.removeSync();
	});

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	function anthropicModel(id: string) {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	const sonnet45 = () => anthropicModel("claude-sonnet-4-5");
	const sonnet46 = () => anthropicModel("claude-sonnet-4-6");
	const haiku = () => anthropicModel("claude-haiku-4-5");

	function selector(model: { provider: string; id: string }): string {
		return `${model.provider}/${model.id}`;
	}

	function createSession(options: {
		initialModelId: string;
		modelRoles?: Record<string, string>;
		modelProfile?: string;
		runtimeModelRoles?: Record<string, string>;
		modelProfiles: unknown;
		sessionManager?: SessionManager;
		/** Seed a transcript, as sdk/session-switch do before restoring a profile. */
		resumedConversation?: boolean;
	}) {
		const agent = new Agent({
			initialState: {
				model: anthropicModel(options.initialModelId),
				systemPrompt: ["Test"],
				tools: [],
				messages: options.resumedConversation ? [{ role: "user", content: "hi", timestamp: Date.now() }] : [],
				thinkingLevel: Effort.Medium,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		for (const [role, value] of Object.entries(options.modelRoles ?? {})) {
			sessionSettings.setModelRole(role, value);
		}
		// Deliberately malformed fixtures: the validator's whole job is bad input.
		sessionSettings.override("modelProfiles", options.modelProfiles as ModelProfilesSettings);
		if (options.modelProfile !== undefined) sessionSettings.override("modelProfile", options.modelProfile);
		// Mirrors `--smol` and friends: installed before the session exists, so
		// the startup-profile layer has to land underneath it.
		if (options.runtimeModelRoles) sessionSettings.overrideModelRoles(options.runtimeModelRoles);
		session = new AgentSession({
			agent,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});
	}

	it("warns about profile mistakes that would otherwise fail silently", () => {
		createSession({
			initialModelId: sonnet45().id,
			modelRoles: { default: selector(sonnet45()) },
			modelProfiles: {
				// Documented escape hatch back to config — not a mistake.
				base: null,
				// A typo'd role is applied to nothing at all.
				fast: { pan: selector(haiku()) },
				// A bundle that is not a mapping is dropped whole.
				broken: selector(haiku()),
				// A role pointing at a non-selector never resolves.
				odd: { plan: 42 },
			},
		});

		expect(session.configWarnings).toEqual([
			"modelProfiles.fast sets unknown role 'pan'; nothing reads it. Add it to modelRoles first.",
			"modelProfiles.broken must be a mapping of role names to model selectors; ignoring it.",
			"modelProfiles.odd.plan must be a model selector string.",
		]);
	});

	it("accepts a hidden built-in role that the selector UI omits", () => {
		createSession({
			initialModelId: sonnet45().id,
			modelProfiles: { fast: { advisor: selector(haiku()) } },
		});

		expect(session.configWarnings).toEqual([]);
	});

	it("cycles profiles in configured order and wraps around", async () => {
		createSession({
			initialModelId: sonnet45().id,
			modelProfiles: {
				fast: { default: selector(haiku()) },
				strong: { default: selector(sonnet46()) },
			},
		});

		const first = await session.cycleModelProfile("forward");
		expect(first?.profile).toBe("fast");
		expect(first?.model?.id).toBe(haiku().id);
		expect(session.model?.id).toBe(haiku().id);

		const second = await session.cycleModelProfile("forward");
		expect(second?.profile).toBe("strong");
		expect(session.model?.id).toBe(sonnet46().id);

		const wrapped = await session.cycleModelProfile("forward");
		expect(wrapped?.profile).toBe("fast");
		expect(session.model?.id).toBe(haiku().id);

		const backward = await session.cycleModelProfile("backward");
		expect(backward?.profile).toBe("strong");
		expect(session.activeModelProfile).toBe("strong");
	});

	it("starts at the last profile when cycling backward from no active profile", async () => {
		createSession({
			initialModelId: sonnet45().id,
			modelProfiles: {
				fast: { default: selector(haiku()) },
				strong: { default: selector(sonnet46()) },
			},
		});

		const first = await session.cycleModelProfile("backward");

		expect(first?.profile).toBe("strong");
		expect(session.model?.id).toBe(sonnet46().id);
	});

	it("switches the plan role with the profile so plan mode follows the active profile", async () => {
		createSession({
			initialModelId: sonnet45().id,
			modelProfiles: {
				fast: { default: selector(haiku()), plan: selector(sonnet45()) },
				strong: { default: selector(sonnet46()), plan: selector(sonnet46()) },
			},
		});

		await session.applyModelProfile("fast");
		// Plan mode resolves `modelRoles.plan` on entry; it must see the profile's
		// plan model, not the one the previous profile (or global config) named.
		expect(session.resolveRoleModel("plan")?.id).toBe(sonnet45().id);

		await session.applyModelProfile("strong");
		expect(session.resolveRoleModel("plan")?.id).toBe(sonnet46().id);
	});

	it("does not leak a role from the outgoing profile into the next one", async () => {
		createSession({
			initialModelId: sonnet45().id,
			modelRoles: { plan: selector(sonnet45()) },
			modelProfiles: {
				pinned: { default: selector(haiku()), plan: selector(sonnet46()) },
				inherit: { default: selector(haiku()) },
			},
		});

		await session.applyModelProfile("pinned");
		expect(session.resolveRoleModel("plan")?.id).toBe(sonnet46().id);

		// `inherit` names no plan role, so plan must fall back to the config layer
		// rather than keeping `pinned`'s plan model.
		await session.applyModelProfile("inherit");
		expect(session.resolveRoleModel("plan")?.id).toBe(sonnet45().id);
	});

	it("activates the requested role within the incoming profile", async () => {
		createSession({
			initialModelId: sonnet45().id,
			modelProfiles: {
				strong: { default: selector(haiku()), plan: selector(sonnet46()) },
			},
		});

		const result = await session.cycleModelProfile("forward", "plan");

		expect(result?.role).toBe("plan");
		expect(session.model?.id).toBe(sonnet46().id);
	});

	it("falls back to the default role when the profile leaves the requested role unset", async () => {
		createSession({
			initialModelId: sonnet45().id,
			modelProfiles: {
				fast: { default: selector(haiku()) },
			},
		});

		const result = await session.cycleModelProfile("forward", "plan");

		expect(result?.role).toBe("default");
		expect(session.model?.id).toBe(haiku().id);
	});

	it("returns every role to config when cycling onto an empty profile", async () => {
		createSession({
			initialModelId: sonnet45().id,
			modelRoles: { default: selector(sonnet45()), plan: selector(sonnet46()) },
			modelProfiles: {
				fast: { default: selector(haiku()), plan: selector(haiku()) },
				// `base:` in YAML parses to null; an empty bundle is the escape
				// hatch back to the config roles, so it must stay in the cycle.
				base: null as unknown as Record<string, string>,
			},
		});

		await session.applyModelProfile("fast");
		expect(session.resolveRoleModelWithThinking("plan").model?.id).toBe(haiku().id);

		const back = await session.cycleModelProfile("forward");

		expect(back?.profile).toBe("base");
		expect(session.model?.id).toBe(sonnet45().id);
		expect(session.resolveRoleModelWithThinking("plan").model?.id).toBe(sonnet46().id);
	});

	it("reports no profile when none are configured", async () => {
		createSession({ initialModelId: sonnet45().id, modelProfiles: {} });

		expect(await session.cycleModelProfile("forward")).toBeUndefined();
		expect(session.activeModelProfile).toBeUndefined();
		expect(session.model?.id).toBe(sonnet45().id);
	});

	it("keeps CLI runtime role overrides across profile switches", async () => {
		createSession({
			initialModelId: sonnet45().id,
			modelProfiles: {
				fast: { default: selector(haiku()) },
				strong: { default: selector(sonnet46()) },
			},
		});
		// Mirrors `--smol`: a runtime override installed before any profile switch.
		sessionSettings.overrideModelRoles({ smol: selector(haiku()) });

		await session.applyModelProfile("fast");
		await session.applyModelProfile("strong");

		expect(sessionSettings.getModelRole("smol")).toBe(selector(haiku()));
		expect(sessionSettings.getModelRole("default")).toBe(selector(sonnet46()));
	});

	it("reinstalls the active profile and its role layer when the session is resumed", async () => {
		const roles = { default: selector(sonnet45()), plan: selector(sonnet45()) };
		const profiles = { fast: { default: selector(haiku()), plan: selector(haiku()) } };
		createSession({ initialModelId: sonnet45().id, modelRoles: roles, modelProfiles: profiles });
		const written = session;
		const sessionManager = written.sessionManager;

		await written.applyModelProfile("fast");
		// A plain role cycle after the profile switch records an untagged model
		// change; the profile must still be recovered from the earlier entry.
		await written.cycleRoleModels(["default", "plan"]);

		// Resume: same transcript, fresh settings — a new process re-reads config,
		// so the runtime role layer only comes back from the persisted entry.
		createSession({
			initialModelId: sonnet45().id,
			modelRoles: roles,
			modelProfiles: profiles,
			sessionManager,
		});

		expect(session.activeModelProfile).toBe("fast");
		expect(session.resolveRoleModelWithThinking("plan").model?.id).toBe(haiku().id);
		await written.dispose();
	});

	it("boots on the configured startup profile before any switch", () => {
		createSession({
			initialModelId: sonnet45().id,
			modelRoles: { default: selector(sonnet45()), plan: selector(sonnet45()) },
			modelProfiles: { fast: { default: selector(haiku()), plan: selector(haiku()) } },
			modelProfile: "fast",
		});

		expect(session.activeModelProfile).toBe("fast");
		expect(session.resolveRoleModelWithThinking("plan").model?.id).toBe(haiku().id);
	});

	it("does not claim the startup profile for a session that already has a transcript", () => {
		createSession({
			initialModelId: sonnet45().id,
			modelRoles: { default: selector(sonnet45()) },
			modelProfiles: { fast: { default: selector(haiku()) } },
			modelProfile: "fast",
			resumedConversation: true,
		});

		// The resumed session's own model outranks the config field, so reporting
		// `fast` would name a bundle whose default is not the running model.
		expect(session.activeModelProfile).toBeUndefined();
	});

	it("lets a CLI role override beat the startup profile it names", () => {
		createSession({
			initialModelId: sonnet45().id,
			modelProfiles: { fast: { default: selector(haiku()), smol: selector(haiku()) } },
			modelProfile: "fast",
			runtimeModelRoles: { smol: selector(sonnet46()) },
		});

		// The flag wins on the role it names; the profile still owns the rest.
		expect(sessionSettings.getModelRole("smol")).toBe(selector(sonnet46()));
		expect(sessionSettings.getModelRole("default")).toBe(selector(haiku()));
	});

	it("prefers a resumed session's pinned profile over the configured one", async () => {
		const profiles = {
			fast: { default: selector(haiku()) },
			strong: { default: selector(sonnet46()) },
		};
		createSession({ initialModelId: sonnet45().id, modelProfiles: profiles, modelProfile: "fast" });
		const written = session;
		await written.applyModelProfile("strong");

		createSession({
			initialModelId: sonnet45().id,
			modelProfiles: profiles,
			modelProfile: "fast",
			sessionManager: written.sessionManager,
		});

		expect(session.activeModelProfile).toBe("strong");
		expect(sessionSettings.getModelRole("default")).toBe(selector(sonnet46()));
		await written.dispose();
	});

	it("warns when the startup profile names no bundle", () => {
		createSession({
			initialModelId: sonnet45().id,
			modelProfiles: { fast: { default: selector(haiku()) } },
			modelProfile: "nope",
		});

		expect(session.configWarnings).toContain("modelProfile 'nope' names no bundle in modelProfiles; ignoring it.");
		expect(session.activeModelProfile).toBeUndefined();
	});
});
