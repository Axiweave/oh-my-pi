/**
 * Speckit-auto mode: the pure rules that drive the spec-kit phases in one
 * session. The interactive layer owns timers, submits, and saved state; this
 * module reads a settled turn and decides the next step.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, NoulQuestion, StopReason } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { resolveJudge, sharedJudgmentCache } from "../judgment";
import answerPrompt from "../prompts/speckit-auto/answer.md" with { type: "text" };
import continuePrompt from "../prompts/speckit-auto/continue.md" with { type: "text" };
import judgePrompt from "../prompts/speckit-auto/judge.md" with { type: "text" };
import remediationPrompt from "../prompts/speckit-auto/remediation.md" with { type: "text" };
import { isUserTurnInitiator } from "../session/messages";
import type { ClassifyUnexpectedStopDeps } from "../session/unexpected-stop-classifier";

export type SpeckitPhase =
	| "specify"
	| "clarify"
	| "plan"
	| "tasks"
	| "analyze"
	| "remediation"
	| "implement"
	| "converge";

export interface SpeckitHold {
	/** `user`: waits for an answer. `needs-you`: error, limit, or unreadable turn. */
	kind: "user" | "needs-you";
	reason: string;
}

export interface SpeckitRun {
	phase: SpeckitPhase;
	/** Every phase turn the run started, in order. */
	history: SpeckitPhase[];
	remediationRounds: number;
	/** Extra implement and converge rounds, 0..convergeLimit. */
	convergeRounds: number;
	convergeLimit: number;
	/** The automatic answer was sent in this phase run. */
	autoAnswered: boolean;
	/** A run turn started and has not settled yet. */
	turnOpen: boolean;
	paused: boolean;
	hold?: SpeckitHold;
}

export interface SpeckitAutoState {
	enabled: boolean;
	run?: SpeckitRun;
}

export interface SpeckitVerdict {
	/** stopReason error, length, or aborted, with the reason. */
	failed?: string;
	/** false: reported error or early stop. undefined: cannot tell. */
	completed: boolean | undefined;
	waits: boolean | undefined;
	/** The only open question asks to proceed with the recommendation. */
	routine: boolean;
	/** Clarify only. */
	ready?: boolean;
	/** Analyze only. */
	analyze?: { critical: number; high: number } | "unreadable";
	/** Analyze only, judge only: the user asked to fix the analyze findings and the reply reports the fixes. */
	fixed?: boolean;
	/** Converge only. */
	converge?: "complete" | "added" | "none";
}

export type SpeckitEndResult = "complete" | "open-tasks" | "stopped";

export type SpeckitAction =
	| { kind: "start"; phase: SpeckitPhase }
	| { kind: "answer" }
	| { kind: "remediate" }
	| { kind: "hold"; hold: SpeckitHold }
	| { kind: "end"; result: SpeckitEndResult }
	| { kind: "notice"; text: string; after: SpeckitAction };

/** The phases that have a `/speckit.<phase>` command, in run order. */
export const SPECKIT_PHASE_COMMANDS: readonly SpeckitPhase[] = [
	"specify",
	"clarify",
	"plan",
	"tasks",
	"analyze",
	"implement",
	"converge",
];
export const SPECKIT_REMEDIATION_ROUNDS = 2;
export const SPECKIT_AUTO_ENTRY = "speckit-auto";
/** Phase that `/speckit-auto next` starts; `undefined` ends the run. */
export const SPECKIT_SUCCESSOR: Record<SpeckitPhase, SpeckitPhase | undefined> = {
	specify: "clarify",
	clarify: "plan",
	plan: "tasks",
	tasks: "analyze",
	analyze: "implement",
	remediation: "analyze",
	implement: "converge",
	converge: undefined,
};

const DEFAULT_CONVERGE_ROUNDS = 3;
/** Characters of the message end that the judge and the text cues read. */
const TAIL_CHARS = 6000;
/** Yes-probability at or above which a judge answer counts as yes. */
const JUDGE_THRESHOLD = 0.5;

export const SPECKIT_ANSWER_TEXT = prompt.render(answerPrompt);
export const SPECKIT_REMEDIATION_TEXT = prompt.render(remediationPrompt);
export const renderSpeckitContinue = (phase: SpeckitPhase): string => prompt.render(continuePrompt, { phase });

/** Judge question templates by answer id, one `## <id>` section each. */
const JUDGE_SECTIONS: Record<string, string> = Object.fromEntries(
	judgePrompt
		.split(/^## /m)
		.slice(1)
		.map(section => {
			const newline = section.indexOf("\n");
			return [section.slice(0, newline).trim(), section.slice(newline + 1)];
		}),
);

const isPhase = (value: unknown): value is SpeckitPhase => typeof value === "string" && value in SPECKIT_SUCCESSOR;
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

export function parseSpeckitPhaseCommand(text: string): { name: string; phase?: SpeckitPhase } | undefined {
	const name = /^\/speckit\.([a-z]+)(?:\s|$)/.exec(text)?.[1];
	if (name === undefined) return undefined;
	return { name, phase: SPECKIT_PHASE_COMMANDS.find(phase => phase === name) };
}

export function newSpeckitRun(phase: SpeckitPhase, convergeLimit: number): SpeckitRun {
	return {
		phase,
		history: [phase],
		remediationRounds: 0,
		convergeRounds: 0,
		convergeLimit,
		autoAnswered: false,
		turnOpen: true,
		paused: false,
	};
}

export const normalizeConvergeRounds = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_CONVERGE_ROUNDS;

function parseRun(data: unknown): SpeckitRun | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const run = data as Record<string, unknown>;
	if (
		!isPhase(run.phase) ||
		!Array.isArray(run.history) ||
		!run.history.every(isPhase) ||
		!isCount(run.remediationRounds) ||
		!isCount(run.convergeRounds) ||
		!isCount(run.convergeLimit)
	) {
		return undefined;
	}
	const saved = run.hold as Partial<SpeckitHold> | undefined;
	return {
		phase: run.phase,
		history: [...run.history],
		remediationRounds: run.remediationRounds,
		convergeRounds: run.convergeRounds,
		convergeLimit: run.convergeLimit,
		autoAnswered: run.autoAnswered === true,
		turnOpen: run.turnOpen === true,
		paused: run.paused === true,
		hold:
			(saved?.kind === "user" || saved?.kind === "needs-you") && typeof saved.reason === "string"
				? { kind: saved.kind, reason: saved.reason }
				: undefined,
	};
}

/** Validates a saved `speckit-auto` entry; `undefined` means "mode off". An invalid run is dropped. */
export function parseSpeckitAutoState(data: unknown): SpeckitAutoState | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const { enabled, run } = data as Record<string, unknown>;
	if (typeof enabled !== "boolean") return undefined;
	return { enabled, run: parseRun(run) };
}

const hold = (kind: SpeckitHold["kind"], reason: string): SpeckitAction => ({ kind: "hold", hold: { kind, reason } });
const start = (phase: SpeckitPhase): SpeckitAction => ({ kind: "start", phase });
/** Phases where any question goes to the user (row 2). */
const ASKS_USER: Partial<Record<SpeckitPhase, true>> = {
	specify: true,
	clarify: true,
	analyze: true,
	remediation: true,
};
/** Phases that need `completed === true` to advance (row 7). */
const NEEDS_COMPLETED: Partial<Record<SpeckitPhase, true>> = {
	specify: true,
	plan: true,
	tasks: true,
	implement: true,
	remediation: true,
};

/** The decision table in data-model.md, rows 1-23, top to bottom. Pure. */
export function decideSpeckitStep(run: SpeckitRun, verdict: SpeckitVerdict): SpeckitAction {
	const { phase } = run;
	if (verdict.failed) return hold("needs-you", verdict.failed);
	if (verdict.waits === true) {
		if (!ASKS_USER[phase] && verdict.routine && !run.autoAnswered) return { kind: "answer" };
		return hold("user", "answer the question");
	}
	if (verdict.completed === false) return hold("needs-you", "the phase reported an error or stopped early");
	if ((phase === "specify" || phase === "clarify") && verdict.waits === undefined) {
		return hold("needs-you", "cannot tell if the phase waits; /speckit-auto next advances");
	}
	if (NEEDS_COMPLETED[phase] && verdict.completed !== true) {
		return hold("needs-you", "cannot tell if the phase finished; /speckit-auto next advances");
	}
	switch (phase) {
		case "clarify":
			if (verdict.ready !== true) return hold("needs-you", "clarify did not report the spec ready");
			break;
		case "analyze": {
			const report = verdict.analyze;
			if (report === undefined || report === "unreadable") {
				// A user-requested fix is a remediation round the user started: check it with a new analyze.
				if (verdict.fixed !== true) return hold("needs-you", "no readable analyze report");
				return run.remediationRounds < SPECKIT_REMEDIATION_ROUNDS
					? start("analyze")
					: hold(
							"needs-you",
							`fixes applied after ${SPECKIT_REMEDIATION_ROUNDS} rounds; run /speckit.analyze to check them`,
						);
			}
			if (report.critical > 0) {
				return run.remediationRounds < SPECKIT_REMEDIATION_ROUNDS
					? { kind: "remediate" }
					: hold(
							"needs-you",
							`${report.critical} CRITICAL findings remain after ${SPECKIT_REMEDIATION_ROUNDS} rounds`,
						);
			}
			if (report.high > 0) {
				return {
					kind: "notice",
					text: `Speckit auto: analyze found ${report.high} HIGH findings. Continuing to implement.`,
					after: start("implement"),
				};
			}
			break;
		}
		case "converge":
			if (verdict.converge === "complete") return { kind: "end", result: "complete" };
			if (verdict.converge === "added") {
				return run.convergeRounds < run.convergeLimit ? start("implement") : { kind: "end", result: "open-tasks" };
			}
			return hold("needs-you", "converge reported no result");
	}
	// Rows 8, 9, 15, and 20-23: every remaining phase starts its successor.
	return start(SPECKIT_SUCCESSOR[phase]!);
}

const FAILURES: Partial<Record<StopReason, string>> = {
	error: "the provider returned an error",
	length: "the reply hit the output limit",
	aborted: "the turn was aborted",
};
/** Table rows without their label cell: a coverage label such as "failure handling" is not an error. */
const TABLE_LABEL = /^[ \t]*\|[^|\n]*/gm;
/** A zero count ("0 failed", "0 tests failed", "zero `Error:` lines", "no failures") is not a failure; "and"/"but" end the count. */
const ZERO_COUNT =
	/\b(?:0|[Zz]ero|[Nn]o)\b[ \t`*_]*(?:(?!(?:and|but|or|then)\b)[A-Za-z-]+[ \t`*_]+){0,2}?(?:ERROR\b|Error:|[Ff]ail(?:ed|ures?)\b)/g;
const ERROR_CUE = /\bERROR\b|\bError:|\b[Ff]ail(?:ed|ure)\b|\b[Bb]locked\b/;
const QUESTION_END = /\?[*_"'`)\]]*[ \t]*$/;
const QUESTION_CUE = new RegExp(
	`${QUESTION_END.source}|\\*\\*Question:\\*\\*|Your choice|You can reply|Format: Short answer|Wait for user response|\\(yes/no\\)`,
	"m",
);
/** The analyze offer to suggest remediation edits, or to draft them on a reply; never a sentence with a question mark in the reply form. */
const ANALYZE_OFFER =
	/\b(?:suggest|propose)\b[^\n]*\bremediation\b|\breply\b(?![^\n]*\?)[^\n]*\bremediate\b[^\n]*\b(?:will|can)\b[^\n]*\b(?:draft|prepare|propose|apply)\b/i;
const CHECKLIST_GATE = "Do you want to proceed with implementation anyway? (yes/no)";
const PHASE_COMMAND = new RegExp(`/speckit\\.(${SPECKIT_PHASE_COMMANDS.join("|")})\\b`, "g");
/** A sentence ends at `.`, `!`, or `?` before whitespace, or at the line end; `tasks.md` and `/speckit.plan` do not end one. */
const SENTENCE = /\S[^\n]*?(?:[.!?](?=\s|$)|$)/gm;
/** The lead of a handoff sentence, as in "Run /speckit.X next.", "Next: /speckit.X", or "Ready for /speckit.X". "Run /speckit.plan first" is a prerequisite. */
const HANDOFF_LEAD =
	/^[\s>*_`-]*(?:(?:then|now)[ \t]+)?(?:run\b|next(?:[ \t]+(?:step|command))?[*_]*:|(?:suggested|recommended)[ \t]+next[ \t]+(?:step|command)[*_]*:|ready[ \t]+for\b|proceed[ \t]+(?:to|with)\b)(?![^\n]*\b(?:first|before)\b)/i;
const namesOtherPhase = (phase: SpeckitPhase, text: string): boolean =>
	Array.from(text.matchAll(PHASE_COMMAND)).some(match => match[1] !== phase);
/** A closing statement that offers to start another phase, as in "Run `/speckit.implement`, or say `go`". */
const isHandoff = (phase: SpeckitPhase, sentence: string): boolean =>
	namesOtherPhase(phase, sentence) && HANDOFF_LEAD.test(sentence) && !QUESTION_END.test(sentence);
/**
 * The reply offers another phase: a handoff sentence, or a question that names another phase command. The mode
 * runs the next phase itself; a "proceed" answer would run that phase inside this turn and skip the pipeline (FR-022).
 */
const offersOtherPhase = (phase: SpeckitPhase, tail: string): boolean =>
	(tail.match(SENTENCE) ?? []).some(
		sentence => namesOtherPhase(phase, sentence) && (HANDOFF_LEAD.test(sentence) || QUESTION_END.test(sentence)),
	);
const PAST_TENSE = "(?:wrote|written|created|generated|complete|completed)";
/** A line that reports `file` as written, in either word order. */
const reportsWritten = (file: string): string => `^(?=[^\\n]*\\b${file}\\b)(?=[^\\n]*\\b${PAST_TENSE}\\b)`;
/** A recommendation to run `phase` next, as in "Run `/speckit.tasks` next." or "Next: /speckit.analyze". */
const recommendsNext = (phase: SpeckitPhase): string =>
	`\\bnext\\b[^\\n]*/speckit\\.${phase}\\b|/speckit\\.${phase}\\b[^\\n]*\\bnext\\b`;
/** Phase report cues; every pattern of the phase must match. */
const REPORT_CUES: Partial<Record<SpeckitPhase, RegExp[]>> = {
	specify: [/\bspec\.md\b/, /\/speckit\.(?:clarify|plan)\b/],
	plan: [/\bplan\.md\b/, new RegExp(`${reportsWritten("plan\\.md")}|${recommendsNext("tasks")}`, "im")],
	tasks: [
		/\btasks\.md\b/,
		new RegExp(
			`${reportsWritten("tasks\\.md")}|${recommendsNext("analyze")}|\\b(?:total|contains)\\b[^\\n]*?\\b\\d+\\**[ \\t]+tasks\\b`,
			"im",
		),
	],
	implement: [/\ball (?:\d+ )?(?:\w+ )?tasks\b[^\n]*\b(?:complete|completed|done)\b/i],
	remediation: [/^[ \t]*Remediation complete\.[ \t]*$/m],
};
const DEFERRED_ROW = /^[ \t]*\|.*\|[ \t]*\**Deferred\**[ \t]*\|.*$/gm;
/** Clarify's Deferred status covers "better suited for planning" (clarify.md 278) and unresolved high-impact items (233). */
const DEFERRED_TO_PLAN = /\b(?:for|to|during|in|at)[ \t]+(?:the[ \t]+)?plan(?:ning)?\b/i;
const DEFERRED_BLOCKS = /\bhigh[- ]impact\b|\bunresolved\b|\bmust\b|\bbefore\b/i;
/** Any readiness evidence: a final message with it is read alone, so an older blocking row cannot override it. */
const READY_EVIDENCE = /No critical ambiguities detected|\/speckit\.(?:plan|clarify)\b|^[ \t]*\|.*\|[ \t]*\**Deferred\**[ \t]*\|/im;
const APPENDED_COUNT = /\bappended\s+\d+\b[^\n]*\btasks?\b|\b\d+\s+(?:\w+\s+)?tasks?\b[^\n]*\bappended\b/i;
const ANALYZE_HEADING = /^#{1,6}[ \t]*Specification Analysis Report\b/m;

function readAnalyzeReport(text: string): SpeckitVerdict["analyze"] {
	if (!ANALYZE_HEADING.test(text)) return "unreadable";
	let table = false;
	let critical = 0;
	let high = 0;
	let severityColumn = -1;
	for (const line of text.split("\n")) {
		const row = line.trim();
		if (!row.startsWith("|")) {
			severityColumn = -1;
			continue;
		}
		const cells = row
			.slice(1, row.endsWith("|") ? -1 : undefined)
			.split("|")
			.map(cell => cell.replace(/[*_`]/g, "").trim().toUpperCase());
		if (severityColumn < 0) {
			severityColumn = cells.indexOf("SEVERITY");
			table ||= severityColumn >= 0;
		} else if (cells[severityColumn] === "CRITICAL") critical++;
		else if (cells[severityColumn] === "HIGH") high++;
	}
	const metric = /Critical Issues Count[\s:|*]*(\d+)/i.exec(text)?.[1];
	if (!table && !(metric === "0" && /\b(?:no|0)\s+(?:issues|findings)\b/i.test(text))) return "unreadable";
	return { critical: Math.max(critical, Number(metric ?? 0)), high };
}

/** The final message's analyze report, else the last report of the turn's earlier messages. */
function readTurnAnalyzeReport(text: string, earlier: string): SpeckitVerdict["analyze"] {
	const report = readAnalyzeReport(text);
	if (report !== "unreadable") return report;
	const last = Array.from(earlier.matchAll(new RegExp(ANALYZE_HEADING.source, "gm"))).at(-1)?.index;
	return last === undefined ? "unreadable" : readAnalyzeReport(earlier.slice(last));
}

function readConverge(tail: string): SpeckitVerdict["converge"] {
	const complete = /✅[\s*_]*Converged/.test(tail);
	const added = /\btasks_appended\b/.test(tail) || (APPENDED_COUNT.test(tail) && /Phase \d+: Convergence/.test(tail));
	if (complete === added) return "none";
	return complete ? "complete" : "added";
}

function readReady(tail: string): boolean | undefined {
	for (const row of tail.match(DEFERRED_ROW) ?? []) {
		if (!DEFERRED_TO_PLAN.test(row) || DEFERRED_BLOCKS.test(row)) return undefined;
	}
	if (/No critical ambiguities detected/i.test(tail)) return true;
	return /\/speckit\.plan\b/.test(tail) && !/\/speckit\.clarify\b/.test(tail) ? true : undefined;
}

const assistantText = (message: AssistantMessage): string =>
	message.content.flatMap(content => (content.type === "text" ? [content.text] : [])).join("\n");

/** True for a message that opens a user turn. Turns that omp starts on its own (attribution `agent`, wakes, redirects) are part of the phase. */
export const isSpeckitUserTurn = (
	message: AgentMessage,
): message is Extract<AgentMessage, { role: "user" | "developer" | "custom" }> =>
	(message.role === "user" && message.attribution !== "agent") ||
	(message.role === "developer" && message.userInitiated === true) ||
	(message.role === "custom" && isUserTurnInitiator(message));

/** Text of the assistant messages before `reply` in its turn. Converge can report its outcome there, before its summary. */
export function speckitEarlierText(messages: readonly AgentMessage[], reply: AssistantMessage): string {
	const parts: string[] = [];
	for (let index = messages.lastIndexOf(reply) - 1; index >= 0 && !isSpeckitUserTurn(messages[index]!); index--) {
		const message = messages[index]!;
		if (message.role === "assistant") parts.push(assistantText(message));
	}
	return parts.reverse().join("\n");
}

/**
 * The reply tail without closing offers, which are never questions (FR-022): for analyze, the remediation offer
 * sentence, and after clarify, a handoff sentence that offers another phase. The rest of the paragraph stays.
 * Specify and clarify keep the handoff: their checks read the recommended next command.
 */
const askedText = (phase: SpeckitPhase, tail: string): string =>
	phase === "specify" || phase === "clarify"
		? tail
		: tail.replace(SENTENCE, sentence =>
				(phase === "analyze" && ANALYZE_OFFER.test(sentence)) || isHandoff(phase, sentence) ? "" : sentence,
			);

/**
 * Deterministic parts of the verdict plus the text-only fallback for the judged parts (research R6).
 * `earlier` is the text of the turn's earlier assistant messages; the converge result and the analyze report read it.
 */
export function readSpeckitTextVerdict(phase: SpeckitPhase, message: AssistantMessage, earlier = ""): SpeckitVerdict {
	const text = assistantText(message);
	const tail = text.slice(-TAIL_CHARS);
	const error = ERROR_CUE.test(tail.replace(TABLE_LABEL, "").replace(ZERO_COUNT, ""));
	const asked = askedText(phase, tail);
	const question = QUESTION_CUE.test(asked);
	const reported = REPORT_CUES[phase]?.every(cue => cue.test(tail)) ?? false;
	// Clarify can print its readiness in an earlier message of the turn and end with a short summary.
	const ready = phase === "clarify" ? readReady(READY_EVIDENCE.test(tail) ? tail : `${earlier}\n${tail}`) : undefined;
	// Specify and clarify ask the user: with no question, only their report proves they do not wait (row 6).
	const settled = phase === "specify" ? reported : phase === "clarify" ? ready === true : true;
	return {
		failed:
			message.stopReason === "error" && message.errorMessage
				? `${FAILURES.error}: ${message.errorMessage}`
				: FAILURES[message.stopReason],
		completed: error ? false : !question && reported ? true : undefined,
		waits: question || (settled ? false : undefined),
		// The gate must be the only question; the full tail, so a removed closing offer still forbids the answer.
		routine:
			!error &&
			asked.includes(CHECKLIST_GATE) &&
			!QUESTION_CUE.test(asked.replace(CHECKLIST_GATE, "")) &&
			!offersOtherPhase(phase, tail),
		ready,
		analyze: phase === "analyze" ? readTurnAnalyzeReport(text, earlier) : undefined,
		converge: phase === "converge" ? readConverge(`${earlier}\n${tail}`) : undefined,
	};
}

export type SpeckitJudgeDeps = ClassifyUnexpectedStopDeps;

/**
 * Verdict for a settled phase turn: failure, analyze counts, and converge
 * result from the text; completed, waits, routine, ready, and fixed from one
 * judge call, or from the text fallback when the judge cannot answer. `turn.request`
 * is the user's own text that opened the turn, if the user started it. `turn.earlier`
 * is the text of the turn's earlier assistant messages. Never throws.
 */
export async function classifySpeckitTurn(
	phase: SpeckitPhase,
	message: AssistantMessage,
	deps: SpeckitJudgeDeps,
	turn: { request?: string; earlier?: string } = {},
): Promise<SpeckitVerdict> {
	const { request, earlier } = turn;
	const verdict = readSpeckitTextVerdict(phase, message, earlier);
	if (verdict.failed) return verdict;
	// Only a user turn in analyze without a report can be a user-requested fix.
	const askFixed = request !== undefined && verdict.analyze === "unreadable";
	try {
		const judge = resolveJudge({
			settings: deps.settings,
			registry: deps.registry,
			sessionModel: deps.model,
			sessionId: deps.sessionId,
			metadataResolver: deps.metadataResolver,
			purpose: "speckit-auto",
			onUsage: deps.onUsage,
			telemetry: deps.telemetry,
			cache: sharedJudgmentCache(),
		});
		const questions: Record<string, NoulQuestion> = {};
		for (const [id, template] of Object.entries(JUDGE_SECTIONS)) {
			if ((id !== "ready" || phase === "clarify") && (id !== "fixed" || askFixed)) {
				questions[id] = { type: "noul", instructions: prompt.render(template, { phase }) };
			}
		}
		const tail = assistantText(message).slice(-TAIL_CHARS);
		const text = askedText(phase, tail);
		const { answers } = await judge.judge(
			{ state: askFixed ? { phase, request, message: text } : { phase, message: text }, questions },
			{ signal: deps.signal },
		);
		const yes = (id: string): boolean => answers[id].noul >= JUDGE_THRESHOLD;
		// The judge reads analyze findings and converge gaps as failures; a readable outcome with no error cue is the step's result.
		const outcome =
			(verdict.analyze !== undefined && verdict.analyze !== "unreadable") ||
			(verdict.converge !== undefined && verdict.converge !== "none");
		const completed = yes("completed") || (outcome && verdict.completed !== false);
		return {
			...verdict,
			// A user turn can be a side request (a commit, a question): only the phase's own report proves the
			// phase finished, so the judge alone cannot start the next phase.
			completed:
				completed && request !== undefined && REPORT_CUES[phase] && verdict.completed !== true ? undefined : completed,
			waits: yes("waits"),
			// Never routine next to the text error cue (row 3 precedes row 5). The full tail: a removed closing
			// offer still forbids the "proceed" answer.
			routine: yes("routine") && verdict.completed !== false && !offersOtherPhase(phase, tail),
			ready: phase === "clarify" ? yes("ready") : undefined,
			...(askFixed ? { fixed: yes("fixed") } : {}),
		};
	} catch (error) {
		logger.debug("speckit-auto: turn check failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return verdict;
	}
}

const RESULT_TEXT: Record<SpeckitEndResult, string> = {
	complete: "complete",
	"open-tasks": "ended with open tasks",
	stopped: "stopped",
};

export const formatSpeckitSummary = (run: SpeckitRun, result: SpeckitEndResult): string =>
	`Speckit auto run ${RESULT_TEXT[result]}. Phases: ${run.history.join(" → ")}. Remediation rounds: ${run.remediationRounds}/${SPECKIT_REMEDIATION_ROUNDS}. Converge rounds: ${run.convergeRounds}/${run.convergeLimit}.`;
