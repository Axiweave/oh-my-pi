/**
 * Speckit-auto mode: the pure rules that drive the spec-kit phases in one
 * session. The interactive layer owns timers, submits, and saved state; this
 * module reads a settled turn and decides the next step.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ChoiceAnswer, ChoiceQuestion, StopReason } from "@oh-my-pi/pi-ai";
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
	/** The user started implement or converge: the run goes through every phase in any scope. */
	editing: boolean;
	hold?: SpeckitHold;
	/** The open turn is the user's reply to a `user` hold, so it goes on with the phase instead of a side request. */
	answering?: boolean;
}

/** How far a run goes: `full` runs every phase; `tasks` ends the run before implement unless the user starts it. */
export type SpeckitAutoScope = "full" | "tasks";

export interface SpeckitAutoState {
	enabled: boolean;
	scope: SpeckitAutoScope;
	run?: SpeckitRun;
}

/**
 * The next step that the judge picks for a settled phase turn. `advance` starts the successor phase, `proceed`
 * sends the automatic answer, `remediate` and `recheck` are analyze fix rounds, `complete` and `added` are the
 * converge outcomes, and `ask`, `error`, and `unclear` hold the run.
 */
export type SpeckitNext =
	| "advance"
	| "proceed"
	| "remediate"
	| "recheck"
	| "complete"
	| "added"
	| "ask"
	| "error"
	| "unclear";

export interface SpeckitVerdict {
	/** stopReason error, length, or aborted, with the reason. */
	failed?: string;
	/** The judge's pick; `undefined` when the judge could not answer. */
	next?: SpeckitNext;
	/** Analyze only: the report counts from the text, for the CRITICAL bound and the HIGH notice. */
	analyze?: { critical: number; high: number } | "unreadable";
}

/** Text-pattern hints for the judge; the judge decides, the hints only help it read the reply. */
export interface SpeckitEvidence {
	analyze?: { critical: number; high: number } | "unreadable";
	/** Lines with an error word, so the judge can tell a reported failure from a feature's failure case. */
	errorLines: string[];
	reportCue?: boolean;
	readyCue?: boolean;
	closingOffers: string[];
}

export type SpeckitEndResult = "complete" | "open-tasks" | "stopped" | "planned";

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
/** The phases a `tasks` scope run may start; the others edit code. */
const TASKS_SCOPE: Partial<Record<SpeckitPhase, true>> = {
	specify: true,
	clarify: true,
	plan: true,
	tasks: true,
	analyze: true,
	remediation: true,
};
export const speckitScopeAllows = (scope: SpeckitAutoScope, phase: SpeckitPhase): boolean =>
	scope === "full" || TASKS_SCOPE[phase] === true;
/** The scope a run follows: a run the user moved into editing follows `full`. */
export const speckitRunScope = (run: SpeckitRun, scope: SpeckitAutoScope): SpeckitAutoScope =>
	run.editing ? "full" : scope;

const DEFAULT_CONVERGE_ROUNDS = 3;
/** Characters of the message end that the judge and the text cues read. */
const TAIL_CHARS = 6000;

export const SPECKIT_ANSWER_TEXT = prompt.render(answerPrompt);
export const SPECKIT_REMEDIATION_TEXT = prompt.render(remediationPrompt);
export const renderSpeckitContinue = (phase: SpeckitPhase): string => prompt.render(continuePrompt, { phase });

const [judgeRule, ...judgeSections] = judgePrompt.split(/^## /m);
/** The blocking-versus-auxiliary rule before the first section; sections embed it as `{{blocking}}`. */
const JUDGE_BLOCKING = judgeRule.trim();
/** Judge question templates by answer id, one `## <id>` section each. */
const JUDGE_SECTIONS: Record<string, string> = Object.fromEntries(
	judgeSections.map(section => {
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

const PHASE_NAMES = SPECKIT_PHASE_COMMANDS.join("|");
const LOAD_WORD = new RegExp(`^speckit[.-](${PHASE_NAMES})$`);
const LOAD_PATH = new RegExp(
	`(?:^|/)speckit\\.(${PHASE_NAMES})\\.md$|(?:^|/)speckit-(${PHASE_NAMES})/SKILL\\.md$|^skill://speckit-(${PHASE_NAMES})(?:/SKILL\\.md)?$`,
);

/**
 * The phase whose instructions a tool call loads: a `specify … speckit.<phase>` shell command, or a `read` of
 * `speckit.<phase>.md` or the `speckit-<phase>` skill. Searches and writes never count (contracts/phase-load.md).
 */
export function speckitPhaseLoad(toolName: string, args: unknown): SpeckitPhase | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const { command, path, async } = args as { command?: unknown; path?: unknown; async?: unknown };
	if (toolName === "bash" && typeof command === "string" && async !== true) {
		let phase: SpeckitPhase | undefined;
		for (const segment of command.split(/;|&&|\|\||\||\n/)) {
			const words = segment
				.trim()
				.split(/\s+/)
				.map(word => word.replace(/^(['"])(.*)\1$/, "$2"));
			if (words[0]?.split("/").at(-1) !== "specify") continue;
			for (const word of words.slice(1)) {
				const match = LOAD_WORD.exec(word)?.[1] as SpeckitPhase | undefined;
				if (match) phase = match;
			}
		}
		return phase;
	}
	if (toolName === "read" && typeof path === "string") {
		const match = LOAD_PATH.exec(path.replace(/(?::(?:raw|conflicts|img|-?\d[\d+,-]*))+$/, ""));
		return (match?.[1] ?? match?.[2] ?? match?.[3]) as SpeckitPhase | undefined;
	}
	return undefined;
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
		editing: !speckitScopeAllows("tasks", phase),
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
		editing: run.editing === true,
		hold:
			(saved?.kind === "user" || saved?.kind === "needs-you") && typeof saved.reason === "string"
				? { kind: saved.kind, reason: saved.reason }
				: undefined,
		answering: run.answering === true || undefined,
	};
}

/** Validates a saved `speckit-auto` entry; `undefined` means "mode off". An invalid run is dropped. */
export function parseSpeckitAutoState(data: unknown): SpeckitAutoState | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const { enabled, scope, run } = data as Record<string, unknown>;
	if (typeof enabled !== "boolean") return undefined;
	return { enabled, scope: scope === "tasks" ? "tasks" : "full", run: parseRun(run) };
}

const hold = (kind: SpeckitHold["kind"], reason: string): SpeckitAction => ({ kind: "hold", hold: { kind, reason } });
const start = (phase: SpeckitPhase): SpeckitAction => ({ kind: "start", phase });
/** Phases where any question goes to the user: the automatic answer never runs there. */
const ASKS_USER: Partial<Record<SpeckitPhase, true>> = {
	specify: true,
	clarify: true,
	analyze: true,
	remediation: true,
};
const HOLDS: readonly SpeckitNext[] = ["ask", "error", "unclear"];

/** The steps the judge may pick in `phase`; `userTurn` adds the analyze re-check of a user-requested fix. */
export function speckitOutcomes(phase: SpeckitPhase, userTurn: boolean): SpeckitNext[] {
	if (phase === "analyze") return ["advance", "remediate", ...(userTurn ? (["recheck"] as const) : []), ...HOLDS];
	if (phase === "converge") return ["complete", "added", "proceed", ...HOLDS];
	return ["advance", ...(ASKS_USER[phase] ? [] : (["proceed"] as const)), ...HOLDS];
}

/** The judge's next step within the run bounds (data-model.md decision table), then the scope stop. Pure. */
export function decideSpeckitStep(
	run: SpeckitRun,
	verdict: SpeckitVerdict,
	scope: SpeckitAutoScope = "full",
): SpeckitAction {
	return limitToScope(decideFullStep(run, verdict), speckitRunScope(run, scope));
}

/** A start or remediation outside the scope ends the run; a notice before it drops, since its text announces that start. */
function limitToScope(action: SpeckitAction, scope: SpeckitAutoScope): SpeckitAction {
	if (action.kind === "notice") {
		const after = limitToScope(action.after, scope);
		return after.kind === "end" ? after : action;
	}
	const phase = action.kind === "start" ? action.phase : action.kind === "remediate" ? "remediation" : undefined;
	return phase && !speckitScopeAllows(scope, phase) ? { kind: "end", result: "planned" } : action;
}

const unclear = (): SpeckitAction =>
	hold("needs-you", "cannot tell if the phase finished; /speckit-auto next advances");

/** The judge's pick within the run bounds: round limits, one automatic answer, and no implement past a CRITICAL count. */
function decideFullStep(run: SpeckitRun, verdict: SpeckitVerdict): SpeckitAction {
	const { phase } = run;
	if (verdict.failed) return hold("needs-you", verdict.failed);
	const report = typeof verdict.analyze === "object" ? verdict.analyze : { critical: 0, high: 0 };
	const roundsLeft = run.remediationRounds < SPECKIT_REMEDIATION_ROUNDS;
	switch (verdict.next) {
		case undefined:
			return hold("needs-you", "the turn check failed; /speckit-auto next advances");
		case "ask":
			return hold("user", "answer the question");
		case "error":
			return hold("needs-you", "the phase reported an error or stopped early");
		case "proceed":
			return ASKS_USER[phase] || run.autoAnswered ? hold("user", "answer the question") : { kind: "answer" };
		case "recheck":
			if (phase !== "analyze") break;
			return roundsLeft
				? start("analyze")
				: hold(
						"needs-you",
						`fixes applied after ${SPECKIT_REMEDIATION_ROUNDS} rounds; run /speckit.analyze to check them`,
					);
		case "complete":
			if (phase === "converge") return { kind: "end", result: "complete" };
			break;
		case "added":
			if (phase !== "converge") break;
			return run.convergeRounds < run.convergeLimit ? start("implement") : { kind: "end", result: "open-tasks" };
		case "remediate":
		case "advance":
			if (phase === "converge") break;
			if (phase !== "analyze") return verdict.next === "advance" ? start(SPECKIT_SUCCESSOR[phase]!) : unclear();
			// The report's CRITICAL count bounds the judge: analyze never advances past one (FR-017).
			if (verdict.next === "remediate" || report.critical > 0) {
				if (roundsLeft) return { kind: "remediate" };
				return report.critical > 0
					? hold(
							"needs-you",
							`${report.critical} CRITICAL findings remain after ${SPECKIT_REMEDIATION_ROUNDS} rounds`,
						)
					: hold("user", "answer the question");
			}
			return report.high > 0
				? {
						kind: "notice",
						text: `Speckit auto: analyze found ${report.high} HIGH findings. Continuing to implement.`,
						after: start("implement"),
					}
				: start("implement");
	}
	return unclear();
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
/** The analyze offer to suggest remediation edits or fixes, or to draft them on a reply. */
const ANALYZE_OFFER =
	/\b(?:suggest|propose)\b[^\n]*\b(?:remediation|fix(?:es)?|edits?)\b|\breply\b[^\n]*\bremediate\b[^\n]*\b(?:will|can)\b[^\n]*\b(?:draft|prepare|propose|apply)\b/i;
const PHASE_COMMAND = new RegExp(`/speckit\\.(${SPECKIT_PHASE_COMMANDS.join("|")})\\b`, "g");
/** A sentence ends at `.`, `!`, or `?` before whitespace, or at the line end; `tasks.md` and `/speckit.plan` do not end one. */
const SENTENCE = /\S[^\n]*?(?:[.!?](?=\s|$)|$)/gm;
/** The lead of a handoff sentence, as in "Run /speckit.X next.", "Next: /speckit.X", or "Ready for /speckit.X". "Run /speckit.plan first" is a prerequisite. */
const HANDOFF_LEAD =
	/^[\s>*_`-]*(?:(?:then|now)[ \t]+)?(?:run\b|next(?:[ \t]+(?:step|command))?[*_]*:|(?:suggested|recommended)[ \t]+next[ \t]+(?:step|command)[*_]*:|ready[ \t]+for\b|proceed[ \t]+(?:to|with)\b)(?![^\n]*\b(?:first|before)\b)/i;
const namesOtherPhase = (phase: SpeckitPhase, text: string): boolean =>
	Array.from(text.matchAll(PHASE_COMMAND)).some(match => match[1] !== phase);
/** A closing offer: a handoff or a question that names another phase command, or the analyze remediation offer. */
const isClosingOffer = (phase: SpeckitPhase, sentence: string): boolean =>
	(phase === "analyze" && ANALYZE_OFFER.test(sentence)) ||
	(namesOtherPhase(phase, sentence) && (HANDOFF_LEAD.test(sentence) || QUESTION_END.test(sentence)));
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
const READY_EVIDENCE =
	/No critical ambiguities detected|\/speckit\.(?:plan|clarify)\b|^[ \t]*\|.*\|[ \t]*\**Deferred\**[ \t]*\|/im;
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

/** The text-pattern hints for the judge; `earlier` is the text of the turn's earlier assistant messages. */
export function readSpeckitEvidence(phase: SpeckitPhase, message: AssistantMessage, earlier = ""): SpeckitEvidence {
	const text = assistantText(message);
	const tail = text.slice(-TAIL_CHARS);
	const cues = REPORT_CUES[phase];
	return {
		...(phase === "analyze" ? { analyze: readTurnAnalyzeReport(text, earlier) } : {}),
		errorLines: tail
			.replace(TABLE_LABEL, "")
			.replace(ZERO_COUNT, "")
			.split("\n")
			.filter(line => ERROR_CUE.test(line))
			.map(line => line.trim()),
		...(cues ? { reportCue: cues.every(cue => cue.test(tail)) } : {}),
		// Clarify can print its readiness in an earlier message of the turn and end with a short summary.
		...(phase === "clarify"
			? { readyCue: readReady(READY_EVIDENCE.test(tail) ? tail : `${earlier}\n${tail}`) === true }
			: {}),
		closingOffers: (tail.match(SENTENCE) ?? []).filter(sentence => isClosingOffer(phase, sentence)),
	};
}

export type SpeckitJudgeDeps = ClassifyUnexpectedStopDeps;

/**
 * Verdict for a settled phase turn: the failure from the stop reason, then one judge call that picks the next
 * step from the reply, with the text-pattern evidence as hints. `next` stays `undefined` when the judge cannot
 * answer, so the run holds. `turn.request` is the user's own text that opened the turn, if the user started it.
 * `turn.answers` marks that text as the reply to a question the phase asked. `turn.earlier` is the text of the
 * turn's earlier assistant messages. Never throws.
 */
export async function classifySpeckitTurn(
	phase: SpeckitPhase,
	message: AssistantMessage,
	deps: SpeckitJudgeDeps,
	turn: { request?: string; answers?: boolean; earlier?: string } = {},
): Promise<SpeckitVerdict> {
	const { request, answers, earlier = "" } = turn;
	const evidence = readSpeckitEvidence(phase, message, earlier);
	const failed =
		message.stopReason === "error" && message.errorMessage
			? `${FAILURES.error}: ${message.errorMessage}`
			: FAILURES[message.stopReason];
	const verdict: SpeckitVerdict = { failed, analyze: evidence.analyze };
	if (failed) return verdict;
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
		const outcomes = speckitOutcomes(phase, request !== undefined);
		const question: ChoiceQuestion<SpeckitNext> = {
			type: "choice",
			instructions: prompt.render(JUDGE_SECTIONS.next!, { phase, blocking: JUDGE_BLOCKING }),
			criteria: Object.fromEntries(
				outcomes.map(outcome => [outcome, prompt.render(JUDGE_SECTIONS[outcome]!, { phase }).trim()]),
			) as Record<SpeckitNext, string>,
		};
		const result = await judge.judge(
			{
				state: {
					phase,
					message: assistantText(message).slice(-TAIL_CHARS),
					...(earlier ? { earlier: earlier.slice(-TAIL_CHARS) } : {}),
					evidence: { ...evidence },
					...(request !== undefined ? { request, answers: answers === true } : {}),
				},
				questions: { next: question },
			},
			{ signal: deps.signal },
		);
		return { ...verdict, next: (result.answers.next as ChoiceAnswer<SpeckitNext>).choice };
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
	planned: "stopped before implement",
};

export function formatSpeckitSummary(run: SpeckitRun, result: SpeckitEndResult): string {
	// A tasks-scope stop after an implement turn names where it stopped; implement already ran.
	const text =
		result === "planned" && run.history.includes("implement")
			? `stopped after ${run.phase} (tasks mode)`
			: RESULT_TEXT[result];
	return `Speckit auto run ${text}. Phases: ${run.history.join(" → ")}. Remediation rounds: ${run.remediationRounds}/${SPECKIT_REMEDIATION_ROUNDS}. Converge rounds: ${run.convergeRounds}/${run.convergeLimit}.`;
}
