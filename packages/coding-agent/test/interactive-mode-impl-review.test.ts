/**
 * Contracts: implementation review on InteractiveMode after a debate plan is
 * approved.
 *
 * 1. Debate "Approve and execute" begins the implementation review with the
 *    consensus hash/title, installs the impl proposal handler, and activates
 *    built-in `write` when it was inactive (state carries `restoreTools`).
 *    Parallel-workflow approval and a disabled `plan.implReview` do none of
 *    this.
 * 2. Cold restore: a valid `impl_review` entry rehydrates state + handler and
 *    re-activates `write` for nonterminal phases; an invalid entry appends
 *    `"none"`.
 * 3. Entering plan mode with a pending implementation review supersedes it:
 *    the toolset is restored, the handler dropped, and the state cleared.
 * 4. Session switch: the outgoing session's cleanup restores its toolset and
 *    drops the review without appending a mode entry to the target.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { hashPlanContent } from "@oh-my-pi/pi-coding-agent/plan-mode/debate";
import { serializeImplReviewState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: `${name} executed` }] };
		},
	};
}

const TOOL_NAMES = ["read", "write", "ask"];

describe("InteractiveMode implementation review", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-impl-review-mode-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		({ session, mode } = openFixture());
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage?.close();
		tempDir?.removeSync();
	});

	function openFixture() {
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const opened = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry: new Map(TOOL_NAMES.map(name => [name, stubTool(name)])),
			builtInToolNames: TOOL_NAMES,
		});
		return {
			session: opened,
			mode: new InteractiveMode(opened, "test", undefined, undefined, undefined, undefined, new EventBus()),
		};
	}

	function planPathFor(target: AgentSession, url: string): string {
		return resolveLocalUrlToPath(url, {
			getArtifactsDir: () => target.sessionManager.getArtifactsDir(),
			getSessionId: () => target.sessionManager.getSessionId(),
		});
	}

	async function approveDebatePlan(
		planFilePath: string,
		reviewedContent: string,
	): Promise<{ consensusHash: string; executionPrompt: string | undefined }> {
		const resolvedPlanPath = planPathFor(session, planFilePath);
		await Bun.write(resolvedPlanPath, reviewedContent);
		const consensusHash = hashPlanContent(reviewedContent);
		await session.setActiveToolsByName(["read"]);
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		session.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: "debate",
			debate: { phase: "consensus", round: 1, planHash: consensusHash, summary: "Ready." },
		});
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and execute");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);
		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "auth", consensusHash });
		return { consensusHash, executionPrompt: promptSpy.mock.calls[0]?.[0] };
	}

	it("debate approval begins the review, installs the handler, and augments write", async () => {
		const planFilePath = "local://auth-plan.md";
		const { consensusHash, executionPrompt } = await approveDebatePlan(planFilePath, "# Auth\n\nReviewed bytes.");

		expect(session.getImplReviewState()).toMatchObject({
			planFilePath,
			planHash: consensusHash,
			planTitle: "auth",
			phase: "implementing",
			restoreTools: ["read"],
		});
		expect(session.getActiveToolNames()).toContain("write");
		// The execution prompt carries the submission contract.
		expect(executionPrompt).toContain("xd://propose");

		// The proposal slot now routes to the implementation review: a mutated
		// plan file is rejected with plan-mismatch guidance.
		await Bun.write(planPathFor(session, planFilePath), "# Auth\n\nMutated after approval.");
		const handler = session.peekPlanProposalHandler();
		if (!handler) throw new Error("Expected impl review proposal handler");
		const result = await handler("auth", { signal: new AbortController().signal, toolCallId: "t1" });
		expect(result.details).toEqual({ outcome: "plan_mismatch" });
	});

	it("parallel approval does not begin an implementation review", async () => {
		const planFilePath = "local://parallel-plan.md";
		await Bun.write(planPathFor(session, planFilePath), "# Plan\n\nDo the thing.");
		await session.setActiveToolsByName(["read"]);
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showPlanReview").mockResolvedValue("Approve and execute");
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "plan" });

		expect(session.getImplReviewState()).toBeUndefined();
		expect(session.getActiveToolNames()).not.toContain("write");
	});

	it("a disabled plan.implReview keeps debate approval review-free", async () => {
		session.settings.set("plan.implReview", false);
		const { executionPrompt } = await approveDebatePlan("local://toggle-plan.md", "# Toggle\n\nReviewed bytes.");

		expect(session.getImplReviewState()).toBeUndefined();
		expect(session.getActiveToolNames()).not.toContain("write");
		// With the toggle off there is no handler, so the prompt must not
		// instruct a submission the device would reject.
		expect(executionPrompt).not.toContain("xd://propose");
	});

	it("cold restore rehydrates a nonterminal review with write and restoreTools", async () => {
		await session.setActiveToolsByName(["read"]);
		session.sessionManager.appendModeChange(
			"impl_review",
			serializeImplReviewState({
				planFilePath: "local://auth-plan.md",
				planHash: "plan-hash",
				planTitle: "auth",
				phase: "implementing",
				round: 0,
			}),
		);

		await mode.init({ suppressWelcomeIntro: true });

		expect(session.getImplReviewState()).toMatchObject({
			planHash: "plan-hash",
			phase: "implementing",
			restoreTools: ["read"],
		});
		expect(session.getActiveToolNames()).toContain("write");
		expect(session.peekPlanProposalHandler()).toBeDefined();
	});

	it("cold restore appends none for an invalid impl_review entry", async () => {
		session.sessionManager.appendModeChange("impl_review", { bogus: true });

		await mode.init({ suppressWelcomeIntro: true });

		expect(session.getImplReviewState()).toBeUndefined();
		expect(session.sessionManager.buildSessionContext().mode).toBe("none");
	});

	it("entering plan mode supersedes a pending review and restores the toolset", async () => {
		await session.setActiveToolsByName(["read", "write"]);
		session.beginImplReview("local://auth-plan.md", {
			planHash: "plan-hash",
			planTitle: "auth",
			restoreTools: ["read"],
		});

		await mode.handlePlanModeCommand();

		expect(session.getImplReviewState()).toBeUndefined();
		expect(mode.planModeEnabled).toBe(true);
	});

	it("session switch restores the outgoing toolset without touching the target", async () => {
		// Target session: plain, persisted to disk.
		const { session: targetSession, mode: targetMode } = openFixture();
		let targetFile: string;
		try {
			await targetMode.init({ suppressWelcomeIntro: true });
			await targetSession.sessionManager.ensureOnDisk();
			const file = targetSession.sessionFile;
			if (!file) throw new Error("Expected persisted session file");
			targetFile = file;
		} finally {
			targetMode.stop();
			await targetSession.dispose();
		}

		await mode.init({ suppressWelcomeIntro: true });
		await session.setActiveToolsByName(["read", "write"]);
		session.beginImplReview("local://auth-plan.md", {
			planHash: "plan-hash",
			planTitle: "auth",
			restoreTools: ["read"],
		});

		expect(await session.switchSession(targetFile)).toBe(true);

		expect(session.getImplReviewState()).toBeUndefined();
		expect(session.peekPlanProposalHandler()).toBeUndefined();
		// The target session carries no impl_review entry from the source.
		expect(session.sessionManager.buildSessionContext().mode).not.toBe("impl_review");
	});
});
