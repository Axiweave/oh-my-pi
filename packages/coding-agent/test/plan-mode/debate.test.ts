import { describe, expect, it } from "bun:test";
import { hashPlanContent, PlanDebateGate, type PlanDebateReviewer } from "@oh-my-pi/pi-coding-agent/plan-mode/debate";
import {
	type PlanModeState,
	parsePlanModeState,
	serializePlanModeState,
} from "@oh-my-pi/pi-coding-agent/plan-mode/state";

const consensus = { verdict: "consensus" as const, summary: "The plan is ready.", findings: [] };
const changes = {
	verdict: "changes_requested" as const,
	summary: "Add the missing failure path.",
	findings: [
		{
			id: "failure-path",
			title: "Missing failure path",
			problem: "The plan only covers success.",
			requiredChange: "Add the error transition.",
			evidence: [{ path: "src/service.ts", explanation: "This call can reject." }],
		},
	],
};

function createGate(reviewer: PlanDebateReviewer, options?: { maxRounds?: number }) {
	let state: PlanModeState | undefined = {
		enabled: true,
		planFilePath: "local://debate-plan.md",
		workflow: "debate",
		debate: { phase: "drafting", round: 0 },
	};
	const gate = new PlanDebateGate({
		getState: () => state,
		commitState: next => {
			state = next;
		},
		...(options?.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
	});
	const controller = new AbortController();
	const propose = (planContent: string, signal = controller.signal) =>
		gate.propose({
			planFilePath: "local://debate-plan.md",
			planContent,
			planTitle: "debate-plan",
			reviewer,
			signal,
			proposalToolCallId: "proposal-1",
		});
	return { gate, propose, getState: () => state, setState: (next: PlanModeState | undefined) => (state = next) };
}

describe("PlanDebateGate", () => {
	it("caches requested changes until the plan bytes change", async () => {
		let calls = 0;
		const harness = createGate(async () => {
			calls++;
			return changes;
		});

		expect(await harness.propose("draft one")).toEqual({
			outcome: "changes_requested",
			planHash: hashPlanContent("draft one"),
			summary: changes.summary,
			findings: changes.findings,
		});
		expect((await harness.propose("draft one")).outcome).toBe("changes_requested");
		expect(calls).toBe(1);

		expect((await harness.propose("draft two")).outcome).toBe("changes_requested");
		expect(calls).toBe(2);
		expect(harness.getState()?.debate).toMatchObject({
			phase: "changes_requested",
			round: 2,
			planHash: hashPlanContent("draft two"),
		});
	});

	it("returns consensus for the exact reviewed bytes and caches it", async () => {
		let calls = 0;
		const harness = createGate(async request => {
			calls++;
			expect(request.parentToolCallId).toBe("proposal-1");
			return consensus;
		});

		const first = await harness.propose("approved bytes");
		const second = await harness.propose("approved bytes");
		expect(first).toEqual({ outcome: "ready_for_approval", planHash: hashPlanContent("approved bytes") });
		expect(second).toEqual(first);
		expect(calls).toBe(1);
	});

	it("escalates to a deadlock at the round cap and stops re-reviewing the same bytes", async () => {
		let calls = 0;
		const harness = createGate(
			async () => {
				calls++;
				return changes;
			},
			{ maxRounds: 2 },
		);

		expect((await harness.propose("draft one")).outcome).toBe("changes_requested");
		expect(await harness.propose("draft two")).toEqual({
			outcome: "deadlocked",
			planHash: hashPlanContent("draft two"),
			summary: changes.summary,
			findings: changes.findings,
		});
		expect(harness.getState()?.debate).toMatchObject({ phase: "deadlocked", round: 2 });

		// Same bytes never trigger another review; the human decision stays unlocked.
		expect((await harness.propose("draft two")).outcome).toBe("deadlocked");
		expect(calls).toBe(2);

		// A changed plan past the cap gets exactly one more review, then escalates again.
		expect((await harness.propose("draft three")).outcome).toBe("deadlocked");
		expect(calls).toBe(3);
	});

	it("persists a deadlocked debate across session resume", () => {
		const serialized = serializePlanModeState({
			enabled: true,
			planFilePath: "local://debate-plan.md",
			workflow: "debate",
			debate: {
				phase: "deadlocked",
				round: 3,
				planHash: "abc",
				summary: changes.summary,
				findings: changes.findings,
			},
		});
		expect(parsePlanModeState(serialized)?.debate).toMatchObject({ phase: "deadlocked", round: 3, planHash: "abc" });
	});

	it("runs one review and rejects stale completion after mode re-entry", async () => {
		const pending = Promise.withResolvers<unknown>();
		let calls = 0;
		const harness = createGate(async () => {
			calls++;
			return pending.promise;
		});
		const first = harness.propose("first bytes");
		expect((await harness.propose("second bytes")).outcome).toBe("reviewing");
		expect(calls).toBe(1);

		harness.setState({
			enabled: true,
			planFilePath: "local://debate-plan.md",
			workflow: "debate",
			debate: { phase: "drafting", round: 1 },
		});
		pending.resolve(consensus);
		expect(await first).toEqual({
			outcome: "failed",
			planHash: hashPlanContent("first bytes"),
			error: "The plan review became stale.",
		});
		expect(harness.getState()?.debate?.phase).toBe("drafting");
	});

	it("persists debate state and makes an interrupted review retryable", () => {
		const serialized = serializePlanModeState({
			enabled: true,
			planFilePath: "local://debate-plan.md",
			workflow: "debate",
			debate: { phase: "reviewing", round: 3, planHash: "abc", activeReviewId: "review-1" },
		});
		expect(parsePlanModeState(serialized)?.debate).toEqual({
			phase: "failed",
			round: 3,
			planHash: "abc",
			error: "The plan review stopped before the session resumed.",
		});
		expect(parsePlanModeState({ planFilePath: "local://legacy-plan.md" })?.workflow).toBe("parallel");
	});

	it("surfaces cancellation and malformed reviewer output as retryable failures", async () => {
		const controller = new AbortController();
		controller.abort();
		const cancelled = createGate(async () => consensus);
		expect((await cancelled.propose("draft", controller.signal)).outcome).toBe("failed");
		expect(cancelled.getState()?.debate).toMatchObject({ phase: "failed", error: "The plan review was cancelled." });

		const malformed = createGate(async () => ({ verdict: "consensus", summary: "bad", findings: changes.findings }));
		expect((await malformed.propose("draft")).outcome).toBe("failed");
		expect(malformed.getState()?.debate).toMatchObject({
			phase: "failed",
			error: "The plan reviewer returned findings with a consensus verdict.",
		});
	});
});
