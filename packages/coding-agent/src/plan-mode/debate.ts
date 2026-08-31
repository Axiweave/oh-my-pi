import { OmpErrors, type } from "@oh-my-pi/omptype";
import type { PlanDebateFinding, PlanModeState } from "./state";

const reviewEvidenceSchema = type({
	path: "string > 0",
	"startLine?": "number.integer >= 1",
	"endLine?": "number.integer >= 1",
	explanation: "string <= 1000",
});
const reviewFindingSchema = type({
	id: "string > 0",
	title: "1 <= string <= 120",
	problem: "1 <= string <= 2000",
	requiredChange: "1 <= string <= 2000",
	evidence: reviewEvidenceSchema.array().atLeastLength(1).atMostLength(4),
});
const reviewResultSchema = type({
	verdict: "'consensus' | 'changes_requested'",
	summary: "string <= 1000",
	findings: reviewFindingSchema.array().atMostLength(8),
});

export type PlanDebateReviewResult = typeof reviewResultSchema.infer;

export const PLAN_DEBATE_REVIEW_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["verdict", "summary", "findings"],
	properties: {
		verdict: { type: "string", enum: ["consensus", "changes_requested"] },
		summary: { type: "string", maxLength: 1000 },
		findings: {
			type: "array",
			maxItems: 8,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "title", "problem", "requiredChange", "evidence"],
				properties: {
					id: { type: "string", minLength: 1 },
					title: { type: "string", minLength: 1, maxLength: 120 },
					problem: { type: "string", minLength: 1, maxLength: 2000 },
					requiredChange: { type: "string", minLength: 1, maxLength: 2000 },
					evidence: {
						type: "array",
						minItems: 1,
						maxItems: 4,
						items: {
							type: "object",
							additionalProperties: false,
							required: ["path", "explanation"],
							properties: {
								path: { type: "string", minLength: 1 },
								startLine: { type: "integer", minimum: 1 },
								endLine: { type: "integer", minimum: 1 },
								explanation: { type: "string", maxLength: 1000 },
							},
						},
					},
				},
			},
		},
	},
} as const;

export interface PlanDebateReviewerRequest {
	planFilePath: string;
	planTitle: string;
	planHash: string;
	round: number;
	priorSummary?: string;
	priorFindings?: PlanDebateFinding[];
	parentToolCallId: string;
	signal: AbortSignal;
}

export type PlanDebateReviewer = (request: PlanDebateReviewerRequest) => Promise<unknown>;

export interface PlanDebateProposal {
	planFilePath: string;
	planContent: string;
	planTitle: string;
	reviewer: PlanDebateReviewer;
	signal: AbortSignal;
	proposalToolCallId: string;
}

export type PlanDebateGateOutcome =
	| { outcome: "ready_for_approval"; planHash: string }
	| { outcome: "changes_requested"; planHash: string; summary: string; findings: PlanDebateFinding[] }
	| { outcome: "reviewing"; planHash: string }
	| { outcome: "failed"; planHash: string; error: string };

export function hashPlanContent(planContent: string): string {
	return Bun.SHA256.hash(planContent, "hex");
}

export class PlanDebateGate {
	#inFlight?: Promise<PlanDebateGateOutcome>;
	readonly #getState: () => PlanModeState | undefined;
	readonly #commitState: (state: PlanModeState) => void;

	constructor(options: {
		getState: () => PlanModeState | undefined;
		commitState: (state: PlanModeState) => void;
	}) {
		this.#getState = options.getState;
		this.#commitState = options.commitState;
	}

	async propose(proposal: PlanDebateProposal): Promise<PlanDebateGateOutcome> {
		const planHash = hashPlanContent(proposal.planContent);
		const state = this.#getState();
		if (!state?.enabled || state.workflow !== "debate") {
			return { outcome: "failed", planHash, error: "Debate mode is no longer active." };
		}
		const debate = state.debate;
		if (debate?.phase === "consensus" && debate.planHash === planHash) {
			return { outcome: "ready_for_approval", planHash };
		}
		if (debate?.phase === "changes_requested" && debate.planHash === planHash) {
			return {
				outcome: "changes_requested",
				planHash,
				summary: debate.summary,
				findings: debate.findings,
			};
		}
		if (this.#inFlight) return { outcome: "reviewing", planHash };

		const sameFailedPlan = debate?.phase === "failed" && debate.planHash === planHash;
		const round = sameFailedPlan ? Math.max(1, debate.round) : (debate?.round ?? 0) + 1;
		const reviewId = crypto.randomUUID();
		const priorSummary = debate?.summary;
		const priorFindings = debate?.findings;
		this.#commitState({
			...state,
			debate: {
				phase: "reviewing",
				round,
				planHash,
				activeReviewId: reviewId,
				...(priorSummary === undefined ? {} : { summary: priorSummary }),
				...(priorFindings === undefined ? {} : { findings: priorFindings }),
			},
		});

		const run = this.#runReview(proposal, { planHash, reviewId, round, priorSummary, priorFindings });
		this.#inFlight = run;
		try {
			return await run;
		} finally {
			if (this.#inFlight === run) this.#inFlight = undefined;
		}
	}

	async #runReview(
		proposal: PlanDebateProposal,
		attempt: {
			planHash: string;
			reviewId: string;
			round: number;
			priorSummary?: string;
			priorFindings?: PlanDebateFinding[];
		},
	): Promise<PlanDebateGateOutcome> {
		try {
			const raw = await proposal.reviewer({
				planFilePath: proposal.planFilePath,
				planTitle: proposal.planTitle,
				planHash: attempt.planHash,
				round: attempt.round,
				...(attempt.priorSummary === undefined ? {} : { priorSummary: attempt.priorSummary }),
				...(attempt.priorFindings === undefined ? {} : { priorFindings: attempt.priorFindings }),
				parentToolCallId: proposal.proposalToolCallId,
				signal: proposal.signal,
			});
			if (proposal.signal.aborted) throw new Error("The plan review was cancelled.");
			const result = reviewResultSchema(raw);
			if (result instanceof OmpErrors) throw new Error("The plan reviewer returned malformed structured output.");
			if (result.verdict === "consensus" && result.findings.length > 0) {
				throw new Error("The plan reviewer returned findings with a consensus verdict.");
			}
			if (result.verdict === "changes_requested" && result.findings.length === 0) {
				throw new Error("The plan reviewer requested changes without findings.");
			}
			const live = this.#ownedState(attempt);
			if (!live) return { outcome: "failed", planHash: attempt.planHash, error: "The plan review became stale." };
			if (result.verdict === "consensus") {
				this.#commitState({
					...live,
					debate: {
						phase: "consensus",
						round: attempt.round,
						planHash: attempt.planHash,
						summary: result.summary,
					},
				});
				return { outcome: "ready_for_approval", planHash: attempt.planHash };
			}
			this.#commitState({
				...live,
				debate: {
					phase: "changes_requested",
					round: attempt.round,
					planHash: attempt.planHash,
					summary: result.summary,
					findings: result.findings,
				},
			});
			return {
				outcome: "changes_requested",
				planHash: attempt.planHash,
				summary: result.summary,
				findings: result.findings,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const live = this.#ownedState(attempt);
			if (live) {
				this.#commitState({
					...live,
					debate: {
						phase: "failed",
						round: attempt.round,
						planHash: attempt.planHash,
						error: message,
						...(attempt.priorSummary === undefined ? {} : { summary: attempt.priorSummary }),
						...(attempt.priorFindings === undefined ? {} : { findings: attempt.priorFindings }),
					},
				});
			}
			return { outcome: "failed", planHash: attempt.planHash, error: message };
		}
	}

	#ownedState(attempt: { planHash: string; reviewId: string; round: number }): PlanModeState | undefined {
		const state = this.#getState();
		const debate = state?.debate;
		return state?.enabled &&
			state.workflow === "debate" &&
			debate?.phase === "reviewing" &&
			debate.planHash === attempt.planHash &&
			debate.activeReviewId === attempt.reviewId &&
			debate.round === attempt.round
			? state
			: undefined;
	}
}
