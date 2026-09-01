/**
 * Contract: after a debate plan is approved, the implementation-review state
 * keeps the session converging on `ask`/`write xd://propose`, and the reviewer
 * only ever runs against the exact approved plan bytes.
 *
 *  T1. Plan integrity: a mutated or missing plan file yields mismatch guidance
 *      and never reaches the reviewer; the exact approved bytes do.
 *  T2. A pending review reminds at terminal settle, resumes after tool
 *      progress, and is bounded by the reminder cap.
 *  T3. A terminal review (consensus) stops enforcement, and a following
 *      beginImplReview starts with a fresh reminder cap.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { hashPlanContent, type ImplReviewer } from "@oh-my-pi/pi-coding-agent/plan-mode/debate";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}
function countReminders(messages: readonly AgentMessage[]): number {
	return messages.filter(message => message.role === "developer" && message.attribution === "agent").length;
}

function proposalContext(toolCallId = "impl-review-proposal") {
	return { signal: new AbortController().signal, toolCallId };
}

const consensusVerdict = { verdict: "consensus", summary: "The implementation matches the plan.", findings: [] };

describe("AgentSession implementation review", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authDir = TempDir.createSync("@pi-impl-review-auth-");
		authStorage = await AuthStorage.create(authDir.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, authDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		authDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-impl-review-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			await tempDir?.remove();
		}
	});

	function createSession(responses: MockResponse[], runImplReviewer?: ImplReviewer) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");
		const toolRegistry = new Map<string, AgentTool>([
			["ask", makeTool("ask")],
			["write", makeTool("write")],
			["read", makeTool("read")],
		]);
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [...toolRegistry.values()],
				messages: [],
			},
			streamFn: mock.stream,
		});
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
			}),
			modelRegistry,
			toolRegistry,
			builtInToolNames: ["ask", "write", "read"],
			advisorTools: [],
			...(runImplReviewer ? { runImplReviewer } : {}),
		});
		session = created;
		return { session: created, mock };
	}

	async function writePlan(target: AgentSession, url: string, content: string): Promise<string> {
		const planPath = resolveLocalUrlToPath(url, {
			getArtifactsDir: () => target.sessionManager.getArtifactsDir(),
			getSessionId: () => target.sessionManager.getSessionId(),
		});
		await Bun.write(planPath, content);
		return planPath;
	}

	it("T1: only the exact approved plan bytes reach the reviewer", async () => {
		let reviewerCalls = 0;
		const harness = createSession([], async () => {
			reviewerCalls++;
			return consensusVerdict;
		});
		const approved = "# Impl plan\n\nStep 1.\n";
		const planPath = await writePlan(harness.session, "local://impl-plan.md", "# Impl plan\n\nMutated.\n");
		harness.session.beginImplReview("local://impl-plan.md", {
			planHash: hashPlanContent(approved),
			planTitle: "impl-plan",
		});

		// Mutated bytes: mismatch guidance, reviewer never runs, state untouched.
		const mutated = await harness.session.prepareImplReviewProposal(proposalContext());
		expect(mutated.details).toEqual({ outcome: "plan_mismatch" });
		expect(reviewerCalls).toBe(0);
		expect(harness.session.getImplReviewState()?.phase).toBe("implementing");

		// Missing file: same.
		await fs.rm(planPath);
		const missing = await harness.session.prepareImplReviewProposal(proposalContext());
		expect(missing.details).toEqual({ outcome: "plan_mismatch" });
		expect(reviewerCalls).toBe(0);

		// Exact approved bytes: the reviewer runs and reaches consensus.
		await Bun.write(planPath, approved);
		const accepted = await harness.session.prepareImplReviewProposal(proposalContext());
		expect(accepted.details).toEqual({ outcome: "consensus", round: 1 });
		expect(reviewerCalls).toBe(1);
		expect(harness.session.getImplReviewState()?.phase).toBe("consensus");
	});

	it("T1b: a plan mutated while the reviewer runs never yields consensus", async () => {
		const approved = "# Impl plan\n\nStep 1.\n";
		let planPath = "";
		let reviewerCalls = 0;
		const harness = createSession([], async () => {
			reviewerCalls++;
			// Concurrent editor: the plan changes after the pre-review hash check,
			// only during the first review.
			if (reviewerCalls === 1) await Bun.write(planPath, "# Impl plan\n\nMutated mid-review.\n");
			return consensusVerdict;
		});
		planPath = await writePlan(harness.session, "local://impl-plan.md", approved);
		harness.session.beginImplReview("local://impl-plan.md", {
			planHash: hashPlanContent(approved),
			planTitle: "impl-plan",
		});

		const tainted = await harness.session.prepareImplReviewProposal(proposalContext());
		expect(tainted.details).toEqual({ outcome: "plan_mismatch" });
		expect(reviewerCalls).toBe(1);
		// The tainted verdict is dropped, not cached: the review returns to
		// implementing, and restoring the bytes re-runs the reviewer.
		expect(harness.session.getImplReviewState()?.phase).toBe("implementing");
		await Bun.write(planPath, approved);
		const accepted = await harness.session.prepareImplReviewProposal(proposalContext());
		expect(accepted.details).toEqual({ outcome: "consensus", round: 2 });
		expect(reviewerCalls).toBe(2);
	});

	it("T1c: consensus restores the pre-augmentation toolset", async () => {
		const harness = createSession([], async () => consensusVerdict);
		const approved = "# Impl plan\n\nStep 1.\n";
		await writePlan(harness.session, "local://impl-plan.md", approved);
		await harness.session.setActiveToolsByName(["read", "write"]);
		harness.session.beginImplReview("local://impl-plan.md", {
			planHash: hashPlanContent(approved),
			planTitle: "impl-plan",
			restoreTools: ["read"],
		});

		const accepted = await harness.session.prepareImplReviewProposal(proposalContext());
		expect(accepted.details).toEqual({ outcome: "consensus", round: 1 });
		expect(harness.session.getEnabledToolNames()).toEqual(["read"]);
		expect(harness.session.getImplReviewState()).toMatchObject({ phase: "consensus" });
		expect(harness.session.getImplReviewState()?.restoreTools).toBeUndefined();
	});

	it("T2: a pending review reminds at settle, resumes after progress, bounded by the cap", async () => {
		const harness = createSession([
			{ content: ["implementing A"] },
			{ content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }] },
			{ content: ["implementing B"] },
			{ content: [{ type: "toolCall", name: "read", arguments: { path: "b" } }] },
			{ content: ["implementing C"] },
			{ content: [{ type: "toolCall", name: "read", arguments: { path: "c" } }] },
			{ content: ["implementing D"] },
		]);
		harness.session.beginImplReview("local://impl-plan.md", {
			planHash: "plan-hash",
			planTitle: "impl-plan",
		});

		await harness.session.prompt("implement the plan");
		await harness.session.waitForIdle();

		expect(countReminders(harness.session.agent.state.messages)).toBe(3);
		expect(harness.mock.calls.length).toBe(7);
		expect(harness.session.getImplReviewState()?.phase).toBe("implementing");
	});

	it("T3: consensus ends enforcement and the next review starts with a fresh cap", async () => {
		const harness = createSession(
			[
				{ content: ["implementing A"] },
				{ content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }] },
				{ content: ["implementing B"] },
				{ content: [{ type: "toolCall", name: "read", arguments: { path: "b" } }] },
				{ content: ["implementing C"] },
				{ content: [{ type: "toolCall", name: "read", arguments: { path: "c" } }] },
				{ content: ["implementing D"] },
				// Second review contract after the terminal consensus.
				{ content: ["second review A"] },
				{ content: [{ type: "toolCall", name: "read", arguments: { path: "d" } }] },
				{ content: ["second review B"] },
			],
			async () => consensusVerdict,
		);
		const approved = "# Impl plan\n\nStep 1.\n";
		await writePlan(harness.session, "local://impl-plan.md", approved);
		harness.session.beginImplReview("local://impl-plan.md", {
			planHash: hashPlanContent(approved),
			planTitle: "impl-plan",
		});

		await harness.session.prompt("implement the plan");
		await harness.session.waitForIdle();
		expect(countReminders(harness.session.agent.state.messages)).toBe(3);

		const accepted = await harness.session.prepareImplReviewProposal(proposalContext());
		expect(accepted.details).toEqual({ outcome: "consensus", round: 1 });

		// A settled review stops the enforcement loop entirely.
		await harness.session.prompt("wrap up");
		await harness.session.waitForIdle();
		expect(countReminders(harness.session.agent.state.messages)).toBe(3);

		// A new review contract starts with a fresh reminder budget.
		harness.session.beginImplReview("local://impl-plan.md", {
			planHash: hashPlanContent(approved),
			planTitle: "impl-plan",
		});
		await harness.session.prompt("implement the follow-up");
		await harness.session.waitForIdle();
		expect(countReminders(harness.session.agent.state.messages)).toBeGreaterThanOrEqual(4);
	});
});
