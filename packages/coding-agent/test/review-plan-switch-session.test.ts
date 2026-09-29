import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveAgentModelSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgReviewUsesPlan } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// The switch is per session (FR-009): the saved `reviewUsesPlan` names only
// where a session starts. After that the transcript is the truth: a resume,
// `/new`, and `/clear` keep the state (FR-010), and a subagent starts from its
// parent's state (FR-012).
describe("review plan switch session state", () => {
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	const sonnet = getBundledModel("anthropic", "claude-sonnet-4-6");
	const opus = getBundledModel("anthropic", "claude-opus-4-6");
	if (!sonnet || !opus) throw new Error("Expected bundled Anthropic models to exist");
	const roles = { default: `${sonnet.provider}/${sonnet.id}`, plan: `${opus.provider}/${opus.id}` };

	beforeAll(async () => {
		dir = path.join(os.tmpdir(), `pi-review-plan-${Snowflake.next()}`);
		fs.mkdirSync(dir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(dir, "models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(dir)) removeSyncWithRetries(dir);
	});

	async function start(
		settings: Settings,
		options: { sessionManager?: SessionManager; reviewPlan?: boolean } = {},
	): Promise<AgentSession> {
		const created = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRegistry,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(dir),
			settings,
			model: sonnet,
			reviewPlan: options.reviewPlan,
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

	it("keeps each session's choice when two sessions share one settings object", async () => {
		const settings = Settings.isolated({ modelRoles: { ...roles, reviewer: roles.default } });
		const first = await start(settings);
		const second = await start(settings);
		/** A reviewer spawn from `session` through a `@reviewer` override, resolved the way the task tool resolves it. */
		const spawn = (session: AgentSession) =>
			resolveAgentModelSelection({
				settings,
				settingsOverride: "@reviewer",
				agentName: "reviewer",
				reviewPlan: session.reviewPlan,
			});

		for (const [target, other] of [
			[first, second],
			[second, first],
		] as const) {
			target.setReviewPlan(true);
			other.setReviewPlan(false);
			expect(target.reviewPlanActive).toBe(true);
			expect(other.reviewPlanActive).toBe(false);
			expect(spawn(target)).toEqual({ patterns: [roles.plan], role: "plan" });
			expect(spawn(other)).toEqual({ patterns: [roles.default], role: "reviewer" });
		}
		// Nothing leaks into the shared configuration.
		expect(cfgReviewUsesPlan.get(settings)).toBe(false);
		expect(settings.getModelRole("reviewer")).toBe(roles.default);
	});

	it("keeps a running subagent on its model after the parent turns the switch off", async () => {
		const settings = Settings.isolated({ modelRoles: roles });
		const parent = await start(settings);
		parent.setReviewPlan(true);
		const child = await start(settings, { reviewPlan: parent.reviewPlan });
		const childModel = child.model;

		parent.setReviewPlan(false);

		expect(child.reviewPlan).toBe(true);
		expect(child.reviewPlanActive).toBe(true);
		expect(child.model).toBe(childModel);
		expect(child.sessionManager.getLastReviewPlan()).toBe(true);
	});

	/** Collects every `source: "review-plan"` notice message emitted from now on. */
	function subscribeReviewPlanNotices(target: AgentSession): string[] {
		const notices: string[] = [];
		target.subscribe(event => {
			if (event.type === "notice" && event.source === "review-plan") notices.push(event.message);
		});
		return notices;
	}
	const INACTIVE = "no plan model resolves";

	it("warns at startup when a saved on-switch has no plan model", async () => {
		for (const configured of [false, true]) {
			const session = await start(
				Settings.isolated({ modelRoles: { default: roles.default }, reviewUsesPlan: configured }),
			);
			const warnings = session.configWarnings.filter(message => message.includes(INACTIVE));
			expect(warnings, `configured ${configured}`).toHaveLength(configured ? 1 : 0);
		}
		const withPlan = await start(Settings.isolated({ modelRoles: roles, reviewUsesPlan: true }));
		expect(withPlan.configWarnings.some(message => message.includes(INACTIVE))).toBe(false);
	});

	it("warns once per inactive stretch when a profile change drops the plan model", async () => {
		const settings = Settings.isolated({
			modelRoles: { default: roles.default },
			modelProfiles: {
				planned: { default: roles.default, plan: roles.plan },
				bare: { default: roles.default },
				alsoBare: { default: roles.default },
			},
		});
		const session = await start(settings);
		const notices = subscribeReviewPlanNotices(session);
		await session.applyModelProfile("planned");
		// The command reports an inactive switch itself, so the toggle adds no notice.
		session.setReviewPlan(true);
		expect(notices).toEqual([]);

		await session.applyModelProfile("bare");
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain(INACTIVE);
		await session.applyModelProfile("alsoBare");
		expect(notices).toHaveLength(1);

		await session.applyModelProfile("planned");
		expect(session.reviewPlanActive).toBe(true);
		await session.applyModelProfile("bare");
		expect(notices).toHaveLength(2);

		session.setReviewPlan(false);
		await session.applyModelProfile("alsoBare");
		expect(notices).toHaveLength(2);
	});

	it("starts from the saved default, the parent's state, then the transcript, in rising precedence", async () => {
		for (const configured of [false, true]) {
			for (const inherited of [undefined, false, true]) {
				const settings = Settings.isolated({ modelRoles: roles, reviewUsesPlan: configured });
				const session = await start(settings, { reviewPlan: inherited });
				const expected = inherited ?? configured;
				const label = `config ${configured}, inherited ${inherited}`;
				expect(session.reviewPlan, label).toBe(expected);
				expect(session.sessionManager.getLastReviewPlan(), label).toBe(expected);
			}
		}
	});

	it("reports the switch inactive while no plan role resolves", async () => {
		const session = await start(Settings.isolated({ modelRoles: { default: roles.default } }));
		session.setReviewPlan(true);
		expect(session.reviewPlan).toBe(true);
		expect(session.reviewPlanActive).toBe(false);
	});

	/** A transcript whose model entries record `reviewPlan` values in order; `undefined` records nothing. */
	async function writeRecordedSession(...values: Array<boolean | undefined>): Promise<string> {
		const file = path.join(dir, `recorded-${Snowflake.next()}.jsonl`);
		const timestamp = "2026-09-01T00:00:00.000Z";
		const entries: object[] = [{ type: "session", version: 3, id: `rp-${Snowflake.next()}`, timestamp, cwd: dir }];
		values.forEach((reviewPlan, index) => {
			entries.push({
				type: "model_change",
				id: `model-${index}`,
				parentId: index === 0 ? null : `model-${index - 1}`,
				timestamp,
				model: roles.default,
				role: "default",
				reviewPlan,
			});
		});
		await Bun.write(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		return file;
	}

	// The last defined record wins: a later entry that records nothing (a plain
	// model switch) must not reset the state to the saved default.
	for (const recorded of [false, true]) {
		for (const configured of [false, true]) {
			it(`resumes a recorded ${recorded} state under saved default ${configured}`, async () => {
				const file = await writeRecordedSession(!recorded, recorded, undefined);
				const sessionManager = await SessionManager.open(file, path.join(dir, "sessions"));
				const settings = Settings.isolated({ modelRoles: roles, reviewUsesPlan: configured });
				const resumed = await start(settings, { sessionManager, reviewPlan: !recorded });
				expect(resumed.reviewPlan).toBe(recorded);
			});
		}
	}

	it("falls back to the saved default for a transcript that predates the switch", async () => {
		for (const configured of [false, true]) {
			const sessionManager = await SessionManager.open(
				await writeRecordedSession(undefined),
				path.join(dir, "sessions"),
			);
			const resumed = await start(Settings.isolated({ modelRoles: roles, reviewUsesPlan: configured }), {
				sessionManager,
			});
			expect(resumed.reviewPlan, `config ${configured}`).toBe(configured);
		}
	});

	it("uses the parent's state before the saved default for a transcript that predates the switch", async () => {
		for (const inherited of [false, true]) {
			const sessionManager = await SessionManager.open(
				await writeRecordedSession(undefined),
				path.join(dir, "sessions"),
			);
			const resumed = await start(Settings.isolated({ modelRoles: roles, reviewUsesPlan: !inherited }), {
				sessionManager,
				reviewPlan: inherited,
			});
			expect(resumed.reviewPlan, `inherited ${inherited}`).toBe(inherited);
		}
	});

	it("restores each transcript's state when switching away and back", async () => {
		for (const recorded of [false, true]) {
			const original = await writeRecordedSession(recorded);
			const other = await writeRecordedSession(!recorded);
			const sessionManager = await SessionManager.open(original, path.join(dir, "sessions"));
			const session = await start(Settings.isolated({ modelRoles: roles }), { sessionManager });
			const label = `recorded ${recorded}`;
			expect(session.reviewPlan, label).toBe(recorded);
			expect(await session.switchSession(other, { preserveLocalCwd: true }), label).toBe(true);
			expect(session.reviewPlan, label).toBe(!recorded);
			expect(await session.switchSession(original, { preserveLocalCwd: true }), label).toBe(true);
			expect(session.reviewPlan, label).toBe(recorded);
		}
	});

	it("keeps the state through /clear", async () => {
		for (const enabled of [false, true]) {
			const session = await start(Settings.isolated({ modelRoles: roles, reviewUsesPlan: !enabled }));
			session.setReviewPlan(enabled);
			const user = { role: "user" as const, content: "question", timestamp: Date.now() };
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			await session.resetSessionContext();
			expect(session.reviewPlan, `enabled ${enabled}`).toBe(enabled);
			expect(session.sessionManager.getLastReviewPlan(), `enabled ${enabled}`).toBe(enabled);
		}
	});

	for (const enabled of [false, true]) {
		it(`carries a ${enabled ? "on" : "off"} state into /new and records it on the fresh transcript`, async () => {
			const session = await start(Settings.isolated({ modelRoles: roles, reviewUsesPlan: !enabled }));
			session.setReviewPlan(enabled);
			await session.newSession();
			expect(session.reviewPlan).toBe(enabled);
			expect(session.sessionManager.getLastReviewPlan()).toBe(enabled);
		});
	}
});
