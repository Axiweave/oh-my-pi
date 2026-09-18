/**
 * Regression: the advisor runtime resolved its model from the `advisor` role
 * chain and assigned the result unconditionally
 * (`session-advisors.ts`, `#resolveAdvisorRuntimeDescriptors`). The explicit
 * `config.model` override was gated, but the role path was not.
 *
 * `@advisor` is what makes that reachable: with `modelRoles.advisor` and
 * `modelRoles.slow` unset, the alias falls through to the role's static
 * priority defaults (`src/priority.json` slow chain), and the cyber filter
 * rewrites configured role values only. A protected session therefore ran its
 * advisor -- which streams provider requests on that model and injects advice
 * into the turn -- on a model the operator's allowlist excludes.
 *
 * The tests assert on the model the built advisor agent actually carries, which
 * is the model its stream is issued with.
 *
 * Per T071 (specs/001-cyber-mode/tasks.md), FR-007, FR-013, SC-010.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveCyberAllowlist } from "@oh-my-pi/pi-coding-agent/config/cyber-mode";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const slowChainHit = getBundledModel("anthropic", "claude-opus-5");
const allowlisted = getBundledModel("openai", "gpt-4o-mini");
if (!slowChainHit || !allowlisted) throw new Error("Expected bundled models to exist");

/** `slowChainHit` wins the static slow chain, so it is the resolution under test. */
const catalog: Model<Api>[] = [slowChainHit, allowlisted];

describe("advisor runtime model under cyber mode protection", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: TempDir;
	let session: AgentSession;
	/** Notices the session emitted, captured per case. */
	let notices: { level: string; message: string; source?: string }[];

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey(slowChainHit.provider, "test-key");
		authStorage.setRuntimeApiKey(allowlisted.provider, "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-advisor-cyber-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		tempDir.removeSync();
	});

	/**
	 * Start a session whose entire catalog is `catalog`, with protection
	 * installed when `protect` is set. The `advisor` and `slow` roles stay unset
	 * on purpose: their fall-through to the static slow chain is the path under
	 * test.
	 */
	function startSession(protect: boolean): void {
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(catalog);
		notices = [];

		const settings = Settings.isolated({
			"compaction.enabled": false,
			cyberModels: [formatModelString(allowlisted)],
		});
		if (protect) {
			const allowlist = resolveCyberAllowlist(settings, catalog);
			if (!allowlist) throw new Error("expected the declared allowlist to resolve");
			settings.applyCyberRoles("protector", allowlist);
		}

		const agent = new Agent({
			initialState: { model: allowlisted, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
			advisorTools: [],
		});
		session.subscribe(event => {
			if (event.type === "notice")
				notices.push({ level: event.level, message: event.message, source: event.source });
		});
		session.toggleAdvisorEnabled();
	}

	/** Cyber notices only: the channel the fallback report uses. */
	function cyberNotices(): string[] {
		return notices.filter(notice => notice.source === "cyber").map(notice => notice.message);
	}

	function advisorModelString(): string | undefined {
		const model = session.getAdvisorAgent()?.state.model;
		return model ? formatModelString(model) : undefined;
	}

	it("runs the advisor on the protected target, not the excluded slow-chain model", () => {
		startSession(true);

		expect(advisorModelString()).toBe(formatModelString(allowlisted));
	});

	it("leaves the advisor on the slow-chain model when no protection is installed", () => {
		// Same catalog, protection off: the chain still lands on the excluded model,
		// which is what makes the gating above its only cause.
		startSession(false);

		expect(advisorModelString()).toBe(formatModelString(slowChainHit));
	});

	it("names the advisor and its landed model in one cyber notice", () => {
		// FR-011: the substitution is a role change, and `planCyberChanges` sees
		// configured role values only, so an unset `advisor` chain would otherwise
		// change silently. FR-012: the pair is reported once.
		startSession(true);

		expect(cyberNotices()).toEqual([
			`Cyber mode changed 1 role(s): advisor → ${formatModelString(allowlisted)} (substituted: no cyber-capable entry)`,
		]);

		session.toggleAdvisorEnabled();
		session.toggleAdvisorEnabled();

		expect(cyberNotices()).toHaveLength(1);
	});

	it("carries a configured-startup substitution into the startup warnings", () => {
		// With `advisor.enabled` in configuration the advisor builds from the
		// SessionAdvisors constructor, before any mode subscribes: a warning
		// emitted as an event there reaches no listener, so it has to land in the
		// startup channels every mode flushes (FR-011).
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(catalog);
		notices = [];
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"advisor.enabled": true,
			cyberModels: [formatModelString(allowlisted)],
		});
		const allowlist = resolveCyberAllowlist(settings, catalog);
		if (!allowlist) throw new Error("expected the declared allowlist to resolve");
		settings.applyCyberRoles("protector", allowlist);
		session = new AgentSession({
			agent: new Agent({ initialState: { model: allowlisted, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
			advisorTools: [],
		});
		// Subscribe only now, the way every mode does.
		session.subscribe(event => {
			if (event.type === "notice")
				notices.push({ level: event.level, message: event.message, source: event.source });
		});

		const report = `Cyber mode changed 1 role(s): advisor → ${formatModelString(allowlisted)} (substituted: no cyber-capable entry)`;
		expect(advisorModelString()).toBe(formatModelString(allowlisted));
		expect(session.configWarnings).toContain(report);
		expect([...session.startupCyberWarnings]).toContain(report);
		expect(cyberNotices()).toEqual([]);
	});

	it("stays silent when the advisor's own chain is already cyber-capable", () => {
		// The control: a role the filter does not change produces no report.
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(catalog);
		notices = [];
		const settings = Settings.isolated({
			"compaction.enabled": false,
			cyberModels: [formatModelString(allowlisted)],
			modelRoles: { advisor: formatModelString(allowlisted) },
		});
		const allowlist = resolveCyberAllowlist(settings, catalog);
		if (!allowlist) throw new Error("expected the declared allowlist to resolve");
		settings.applyCyberRoles("protector", allowlist);
		session = new AgentSession({
			agent: new Agent({ initialState: { model: allowlisted, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
			advisorTools: [],
		});
		session.subscribe(event => {
			if (event.type === "notice")
				notices.push({ level: event.level, message: event.message, source: event.source });
		});
		session.toggleAdvisorEnabled();

		expect(advisorModelString()).toBe(formatModelString(allowlisted));
		expect(cyberNotices()).toEqual([]);
	});
});
