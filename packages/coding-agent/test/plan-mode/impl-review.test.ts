import { describe, expect, it } from "bun:test";
import { type ImplReviewer, ImplReviewGate } from "@oh-my-pi/pi-coding-agent/plan-mode/debate";
import {
	type ImplReviewState,
	parseImplReviewState,
	serializeImplReviewState,
} from "@oh-my-pi/pi-coding-agent/plan-mode/state";

const consensus = { verdict: "consensus" as const, summary: "The implementation matches the plan.", findings: [] };
const changes = {
	verdict: "changes_requested" as const,
	summary: "Step 3 is not implemented.",
	findings: [
		{
			id: "step-3",
			title: "Missing step 3",
			problem: "The plan's step 3 has no corresponding code.",
			requiredChange: "Implement the retry branch from step 3.",
			evidence: [{ path: "src/service.ts", explanation: "No retry branch exists here." }],
		},
	],
};

function createGate(reviewer: ImplReviewer, options?: { maxRounds?: number }) {
	let state: ImplReviewState | undefined = {
		planFilePath: "local://debate-plan.md",
		planHash: "plan-hash",
		planTitle: "debate-plan",
		phase: "implementing",
		round: 0,
	};
	const gate = new ImplReviewGate({
		getState: () => state,
		commitState: next => {
			state = next;
		},
		...(options?.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
	});
	const controller = new AbortController();
	const propose = (signal = controller.signal) =>
		gate.propose({
			planTitle: "debate-plan",
			reviewer,
			signal,
			proposalToolCallId: "proposal-1",
		});
	return { gate, propose, getState: () => state, controller };
}

describe("ImplReviewGate", () => {
	it("makes consensus terminal and idempotent without extra reviewer runs", async () => {
		let calls = 0;
		const harness = createGate(async request => {
			calls++;
			expect(request.planFilePath).toBe("local://debate-plan.md");
			expect(request.planHash).toBe("plan-hash");
			expect(request.parentToolCallId).toBe("proposal-1");
			return consensus;
		});

		expect(await harness.propose()).toEqual({ outcome: "consensus", round: 1 });
		expect(harness.getState()).toMatchObject({ phase: "consensus", round: 1, summary: consensus.summary });
		expect(await harness.propose()).toEqual({ outcome: "consensus", round: 1 });
		expect(calls).toBe(1);
	});

	it("escalates to a terminal deadlock at the round cap", async () => {
		let calls = 0;
		const harness = createGate(
			async () => {
				calls++;
				return changes;
			},
			{ maxRounds: 2 },
		);

		expect(await harness.propose()).toEqual({
			outcome: "changes_requested",
			round: 1,
			summary: changes.summary,
			findings: changes.findings,
		});
		expect(await harness.propose()).toEqual({
			outcome: "deadlocked",
			round: 2,
			summary: changes.summary,
			findings: changes.findings,
		});
		expect(harness.getState()).toMatchObject({ phase: "deadlocked", round: 2 });

		// Deadlock is terminal: duplicate submissions cost nothing.
		expect((await harness.propose()).outcome).toBe("deadlocked");
		expect(calls).toBe(2);
	});

	it("keeps the round number when retrying after a failure", async () => {
		const verdicts: unknown[] = [];
		const controller = new AbortController();
		const harness = createGate(async request => {
			if (request.signal.aborted) throw new Error("The implementation review was cancelled.");
			verdicts.push(request.round);
			return consensus;
		});

		controller.abort();
		const failed = await harness.propose(controller.signal);
		expect(failed.outcome).toBe("failed");
		expect(harness.getState()).toMatchObject({ phase: "failed", round: 1 });

		expect(await harness.propose()).toEqual({ outcome: "consensus", round: 1 });
		expect(verdicts).toEqual([1]);
		// The successful retry must not keep the old failure in terminal state.
		expect(harness.getState()).toMatchObject({ phase: "consensus" });
		expect(harness.getState()?.error).toBeUndefined();
	});

	it("roundtrips a deadlocked state including restoreTools", () => {
		const state: ImplReviewState = {
			planFilePath: "local://debate-plan.md",
			planHash: "plan-hash",
			planTitle: "debate-plan",
			phase: "deadlocked",
			round: 3,
			summary: changes.summary,
			findings: changes.findings,
			restoreTools: ["read", "grep"],
		};
		const parsed = parseImplReviewState(serializeImplReviewState(state));
		expect(parsed).toEqual(state);
	});

	it("parses a persisted reviewing phase to a retryable failure", () => {
		const parsed = parseImplReviewState(
			serializeImplReviewState({
				planFilePath: "local://debate-plan.md",
				planHash: "plan-hash",
				planTitle: "debate-plan",
				phase: "reviewing",
				round: 2,
				activeReviewId: "review-1",
			}),
		);
		expect(parsed).toMatchObject({
			phase: "failed",
			round: 2,
			error: "The implementation review stopped before the session resumed.",
		});
	});
});
