import { OmpErrors, type } from "@oh-my-pi/omptype";

export type PlanWorkflow = "parallel" | "iterative" | "debate";

export interface PlanDebateEvidence {
	path: string;
	startLine?: number;
	endLine?: number;
	explanation: string;
}

export interface PlanDebateFinding {
	id: string;
	title: string;
	problem: string;
	requiredChange: string;
	evidence: PlanDebateEvidence[];
}

interface PlanDebateStateBase {
	round: number;
	planHash?: string;
	summary?: string;
	findings?: PlanDebateFinding[];
}

export type PlanDebateState =
	| (PlanDebateStateBase & { phase: "drafting" })
	| (PlanDebateStateBase & { phase: "reviewing"; planHash: string; activeReviewId: string })
	| (PlanDebateStateBase & {
			phase: "changes_requested";
			planHash: string;
			summary: string;
			findings: PlanDebateFinding[];
	  })
	| (PlanDebateStateBase & {
			phase: "deadlocked";
			planHash: string;
			summary: string;
			findings: PlanDebateFinding[];
	  })
	| (PlanDebateStateBase & { phase: "consensus"; planHash: string; summary: string })
	| (PlanDebateStateBase & { phase: "failed"; planHash: string; error: string });

export interface PlanModeState {
	enabled: boolean;
	planFilePath: string;
	workflow: PlanWorkflow;
	debate?: PlanDebateState;
	reentry?: boolean;
}

const planDebateEvidenceSchema = type({
	path: "string > 0",
	"startLine?": "number.integer >= 1",
	"endLine?": "number.integer >= 1",
	explanation: "string",
});
const planDebateFindingSchema = type({
	id: "string > 0",
	title: "string > 0",
	problem: "string > 0",
	requiredChange: "string > 0",
	evidence: planDebateEvidenceSchema.array(),
});
const serializedDebateStateSchema = type({
	phase: "'drafting' | 'reviewing' | 'changes_requested' | 'deadlocked' | 'consensus' | 'failed'",
	round: "number.integer >= 0",
	"planHash?": "string > 0",
	"activeReviewId?": "string > 0",
	"summary?": "string",
	"findings?": planDebateFindingSchema.array(),
	"error?": "string > 0",
});
const serializedPlanModeStateSchema = type({
	"enabled?": "boolean",
	planFilePath: "string > 0",
	"workflow?": "'parallel' | 'iterative' | 'debate'",
	"debate?": serializedDebateStateSchema,
	"reentry?": "boolean",
});

function parseDebateState(value: typeof serializedDebateStateSchema.infer): PlanDebateState | undefined {
	const common = {
		round: value.round,
		...(value.planHash ? { planHash: value.planHash } : {}),
		...(value.summary === undefined ? {} : { summary: value.summary }),
		...(value.findings === undefined ? {} : { findings: value.findings }),
	};
	switch (value.phase) {
		case "drafting":
			return { phase: "drafting", ...common };
		case "reviewing":
			if (!value.planHash || !value.activeReviewId) return undefined;
			return {
				phase: "failed",
				...common,
				planHash: value.planHash,
				error: "The plan review stopped before the session resumed.",
			};
		case "changes_requested":
			if (!value.planHash || value.summary === undefined || !value.findings?.length) return undefined;
			return {
				phase: "changes_requested",
				...common,
				planHash: value.planHash,
				summary: value.summary,
				findings: value.findings,
			};
		case "deadlocked":
			if (!value.planHash || value.summary === undefined || !value.findings?.length) return undefined;
			return {
				phase: "deadlocked",
				...common,
				planHash: value.planHash,
				summary: value.summary,
				findings: value.findings,
			};
		case "consensus":
			if (!value.planHash || value.summary === undefined || (value.findings?.length ?? 0) > 0) return undefined;
			return { phase: "consensus", ...common, planHash: value.planHash, summary: value.summary };
		case "failed":
			if (!value.planHash || !value.error) return undefined;
			return { phase: "failed", ...common, planHash: value.planHash, error: value.error };
	}
}

export function serializePlanModeState(state: PlanModeState): Record<string, unknown> {
	return {
		enabled: state.enabled,
		planFilePath: state.planFilePath,
		workflow: state.workflow,
		...(state.debate ? { debate: state.debate } : {}),
		...(state.reentry === undefined ? {} : { reentry: state.reentry }),
	};
}

export function parsePlanModeState(
	data: Record<string, unknown> | undefined,
	defaultEnabled = true,
): PlanModeState | undefined {
	const parsed = serializedPlanModeStateSchema(data);
	if (parsed instanceof OmpErrors) return undefined;
	const workflow = parsed.workflow ?? "parallel";
	const debate = parsed.debate === undefined ? undefined : parseDebateState(parsed.debate);
	if (workflow === "debate" && parsed.debate !== undefined && debate === undefined) return undefined;
	return {
		enabled: parsed.enabled ?? defaultEnabled,
		planFilePath: parsed.planFilePath,
		workflow,
		...(workflow === "debate" && debate ? { debate } : {}),
		...(parsed.reentry === undefined ? {} : { reentry: parsed.reentry }),
	};
}
