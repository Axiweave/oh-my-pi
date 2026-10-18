/**
 * Yes/no judge questions about an assistant's final reply, answered by the
 * live `judge` role chain resolved by {@link resolveJudge}:
 * - `stopped`: a text-only turn promised to act and then ended.
 * - `needsUser`: a reply that ends while the agent's own background jobs run
 *   waits for the user, not only for the jobs.
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import {
	type AssistantMessage,
	type JudgmentState,
	judgeQuestions,
	type Model,
	type NoulQuestion,
} from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { type JudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import needsUserFile from "../prompts/judge/needs-user.json" with { type: "json" };
import questionFile from "../prompts/judge/unexpected-stop.json" with { type: "json" };

/**
 * Yes-probability at or above which a question counts as yes.
 * Keyword judges answer exactly 0 or 1; TypeSafe's calibrated probability
 * lands in between, and a coin-flip message must not trigger a retry or a
 * needs-input notification.
 */
const YES_THRESHOLD = 0.5;

/**
 * The yes/no `stopped` question. Criteria stay bulleted examples: on
 * lfm2-1.2b / qwen2.5-1.5b, prose criteria cost ~3 points of recall.
 */
const QUESTIONS = judgeQuestions(questionFile);
const NEEDS_USER_QUESTIONS = judgeQuestions(needsUserFile);

/**
 * Leading characters of the user's request shown to the judge: enough for the
 * ask and its constraints ("don't change anything") without letting a pasted
 * log crowd a small judge model's context.
 */
const REQUEST_CHARS = 2000;

/** A text-only terminal turn and the operator request it replies to. */
export interface UnexpectedStopTurn {
	/** Visible text of the assistant's terminal message. */
	message: string;
	/**
	 * The operator's latest request. Without it the judge cannot tell an answer
	 * that offers optional next steps from one that stopped short of the ask.
	 */
	request?: string;
}

export interface ClassifyUnexpectedStopDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId: string;
	/** Active session model; last resort of the judge role chain. */
	model?: Model;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	/** Session ledger for the classification's billed attempts. */
	onUsage?: (usage: JudgmentUsage) => void;
	telemetry?: AgentTelemetryConfig;
	signal?: AbortSignal;
}

/** Detects terminal turns eligible for mechanical recovery or smart classification. */
export function isUnexpectedStopCandidate(message: AssistantMessage): boolean {
	if (message.stopReason !== "stop") return false;
	let hasContent = false;
	for (const content of message.content) {
		// A tool call or image is deliverable output; retrying would repeat it.
		if (content.type === "toolCall" || content.type === "image") return false;
		if (content.type === "text" && /\S/.test(content.text)) {
			hasContent = true;
		}
		// A signed thinking-only stop is still a candidate: reasoning models can
		// trap the intended response (or a truncated fragment) in a thinking block
		// with no text, or end on a signature-only block whose reasoning text was
		// withheld. #isEmptyAssistantStop treats a non-whitespace signature as
		// terminal (not empty), so such stops bypass the empty-stop path entirely.
		// Match that predicate here — unsigned thinking-only stops stay with the
		// empty-stop retry path (and its cap) rather than being re-handled here.
		if (content.type === "thinking" && /\S/.test(content.thinkingSignature ?? "")) {
			hasContent = true;
		}
	}
	return hasContent;
}

/** `true` for an unexpected stop, `false` for a normal end of turn, `undefined` when no judge could answer. */
export function classifyUnexpectedStop(
	stop: UnexpectedStopTurn,
	deps: ClassifyUnexpectedStopDeps,
): Promise<boolean | undefined> {
	return judgeYes("unexpected-stop", "stopped", QUESTIONS.stopped, stop, deps);
}

/**
 * `true` when a reply that ends while the agent's own background jobs run
 * needs the user (a question, a decision, an approval), `false` when it only
 * waits for the jobs, `undefined` when no judge could answer.
 */
export function classifyNeedsUser(
	turn: UnexpectedStopTurn,
	deps: ClassifyUnexpectedStopDeps,
): Promise<boolean | undefined> {
	return judgeYes("needs-user", "needsUser", NEEDS_USER_QUESTIONS.needsUser, turn, deps);
}

/** One yes/no judge question `id` about `turn`; `purpose` labels the ledger and telemetry. Never throws. */
async function judgeYes(
	purpose: string,
	id: string,
	question: NoulQuestion,
	turn: UnexpectedStopTurn,
	deps: ClassifyUnexpectedStopDeps,
): Promise<boolean | undefined> {
	try {
		const judge = resolveJudge({
			settings: deps.settings,
			registry: deps.registry,
			sessionModel: deps.model,
			sessionId: deps.sessionId,
			metadataResolver: deps.metadataResolver,
			purpose,
			onUsage: deps.onUsage,
			telemetry: deps.telemetry,
			cache: sharedJudgmentCache(),
		});
		const request = turn.request?.trim().slice(0, REQUEST_CHARS);
		const state: JudgmentState = request ? { request, message: turn.message } : { message: turn.message };
		const { answers } = await judge.judge({ state, questions: { [id]: question } }, { signal: deps.signal });
		return answers[id].noul >= YES_THRESHOLD;
	} catch (error) {
		logger.debug(`${purpose}: classification failed`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
