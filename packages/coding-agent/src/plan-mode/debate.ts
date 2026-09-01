import { OmpErrors, type } from "@oh-my-pi/omptype";
import type { ImplReviewState, PlanDebateFinding, PlanModeState } from "./state";

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
	| { outcome: "deadlocked"; planHash: string; summary: string; findings: PlanDebateFinding[] }
	| { outcome: "reviewing"; planHash: string }
	| { outcome: "failed"; planHash: string; error: string };

/** Distinct plan revisions the reviewer may reject before the gate escalates
 *  the unresolved review to human approval instead of looping forever. */
export const DEFAULT_PLAN_DEBATE_MAX_ROUNDS = 3;

export function hashPlanContent(planContent: string): string {
	return Bun.SHA256.hash(planContent, "hex");
}

export class PlanDebateGate {
	#inFlight?: Promise<PlanDebateGateOutcome>;
	readonly #getState: () => PlanModeState | undefined;
	readonly #commitState: (state: PlanModeState) => void;
	readonly #maxRounds: number;

	constructor(options: {
		getState: () => PlanModeState | undefined;
		commitState: (state: PlanModeState) => void;
		maxRounds?: number;
	}) {
		this.#getState = options.getState;
		this.#commitState = options.commitState;
		this.#maxRounds = Math.max(1, Math.floor(options.maxRounds ?? DEFAULT_PLAN_DEBATE_MAX_ROUNDS));
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
		if (debate?.phase === "deadlocked" && debate.planHash === planHash) {
			return { outcome: "deadlocked", planHash, summary: debate.summary, findings: debate.findings };
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
			const deadlocked = attempt.round >= this.#maxRounds;
			this.#commitState({
				...live,
				debate: {
					phase: deadlocked ? "deadlocked" : "changes_requested",
					round: attempt.round,
					planHash: attempt.planHash,
					summary: result.summary,
					findings: result.findings,
				},
			});
			return {
				outcome: deadlocked ? "deadlocked" : "changes_requested",
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

export interface ImplReviewRequest {
	planFilePath: string;
	planTitle: string;
	planHash: string;
	round: number;
	priorSummary?: string;
	priorFindings?: PlanDebateFinding[];
	parentToolCallId: string;
	signal: AbortSignal;
}

export type ImplReviewer = (request: ImplReviewRequest) => Promise<unknown>;

export interface ImplReviewProposal {
	planTitle: string;
	reviewer: ImplReviewer;
	signal: AbortSignal;
	proposalToolCallId: string;
}

export type ImplReviewGateOutcome =
	| { outcome: "consensus"; round: number }
	| { outcome: "changes_requested"; round: number; summary: string; findings: PlanDebateFinding[] }
	| { outcome: "deadlocked"; round: number; summary: string; findings: PlanDebateFinding[] }
	| { outcome: "reviewing" }
	| { outcome: "failed"; error: string };

/** Round-keyed gate for the post-approval implementation review. Plan identity
 *  (the approved plan hash) is enforced by the caller before the gate runs. */
export class ImplReviewGate {
	#inFlight?: Promise<ImplReviewGateOutcome>;
	readonly #getState: () => ImplReviewState | undefined;
	readonly #commitState: (state: ImplReviewState) => void;
	readonly #maxRounds: number;

	constructor(options: {
		getState: () => ImplReviewState | undefined;
		commitState: (state: ImplReviewState) => void;
		maxRounds?: number;
	}) {
		this.#getState = options.getState;
		this.#commitState = options.commitState;
		this.#maxRounds = Math.max(1, Math.floor(options.maxRounds ?? DEFAULT_PLAN_DEBATE_MAX_ROUNDS));
	}

	async propose(proposal: ImplReviewProposal): Promise<ImplReviewGateOutcome> {
		const state = this.#getState();
		if (!state) {
			return { outcome: "failed", error: "Implementation review is not active." };
		}
		if (state.phase === "consensus") {
			return { outcome: "consensus", round: state.round };
		}
		if (state.phase === "deadlocked") {
			return {
				outcome: "deadlocked",
				round: state.round,
				summary: state.summary ?? "",
				findings: state.findings ?? [],
			};
		}
		if (this.#inFlight) return { outcome: "reviewing" };

		const round = state.phase === "failed" ? Math.max(1, state.round) : state.round + 1;
		const reviewId = crypto.randomUUID();
		const priorSummary = state.summary;
		const priorFindings = state.findings;
		this.#commitState({
			...state,
			phase: "reviewing",
			round,
			activeReviewId: reviewId,
			// A retry from `failed` must not carry the old failure into the new
			// review or a later verdict; the flat state would otherwise keep it.
			error: undefined,
			...(priorSummary === undefined ? {} : { summary: priorSummary }),
			...(priorFindings === undefined ? {} : { findings: priorFindings }),
		});

		const run = this.#runReview(proposal, {
			planFilePath: state.planFilePath,
			reviewId,
			round,
			priorSummary,
			priorFindings,
		});
		this.#inFlight = run;
		try {
			return await run;
		} finally {
			if (this.#inFlight === run) this.#inFlight = undefined;
		}
	}

	async #runReview(
		proposal: ImplReviewProposal,
		attempt: {
			planFilePath: string;
			reviewId: string;
			round: number;
			priorSummary?: string;
			priorFindings?: PlanDebateFinding[];
		},
	): Promise<ImplReviewGateOutcome> {
		try {
			const pending = this.#getState();
			const raw = await proposal.reviewer({
				planFilePath: attempt.planFilePath,
				planTitle: proposal.planTitle,
				planHash: pending?.planHash ?? "",
				round: attempt.round,
				...(attempt.priorSummary === undefined ? {} : { priorSummary: attempt.priorSummary }),
				...(attempt.priorFindings === undefined ? {} : { priorFindings: attempt.priorFindings }),
				parentToolCallId: proposal.proposalToolCallId,
				signal: proposal.signal,
			});
			if (proposal.signal.aborted) throw new Error("The implementation review was cancelled.");
			const result = reviewResultSchema(raw);
			if (result instanceof OmpErrors) {
				throw new Error("The implementation reviewer returned malformed structured output.");
			}
			if (result.verdict === "consensus" && result.findings.length > 0) {
				throw new Error("The implementation reviewer returned findings with a consensus verdict.");
			}
			if (result.verdict === "changes_requested" && result.findings.length === 0) {
				throw new Error("The implementation reviewer requested changes without findings.");
			}
			const live = this.#ownedState(attempt);
			if (!live) return { outcome: "failed", error: "The implementation review became stale." };
			if (result.verdict === "consensus") {
				this.#commitState({
					...live,
					phase: "consensus",
					round: attempt.round,
					activeReviewId: undefined,
					summary: result.summary,
					findings: undefined,
				});
				return { outcome: "consensus", round: attempt.round };
			}
			const deadlocked = attempt.round >= this.#maxRounds;
			this.#commitState({
				...live,
				phase: deadlocked ? "deadlocked" : "changes_requested",
				round: attempt.round,
				activeReviewId: undefined,
				summary: result.summary,
				findings: result.findings,
			});
			return {
				outcome: deadlocked ? "deadlocked" : "changes_requested",
				round: attempt.round,
				summary: result.summary,
				findings: result.findings,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const live = this.#ownedState(attempt);
			if (live) {
				this.#commitState({
					...live,
					phase: "failed",
					round: attempt.round,
					activeReviewId: undefined,
					error: message,
					...(attempt.priorSummary === undefined ? {} : { summary: attempt.priorSummary }),
					...(attempt.priorFindings === undefined ? {} : { findings: attempt.priorFindings }),
				});
			}
			return { outcome: "failed", error: message };
		}
	}

	#ownedState(attempt: { reviewId: string; round: number }): ImplReviewState | undefined {
		const state = this.#getState();
		return state?.phase === "reviewing" && state.activeReviewId === attempt.reviewId && state.round === attempt.round
			? state
			: undefined;
	}
}
