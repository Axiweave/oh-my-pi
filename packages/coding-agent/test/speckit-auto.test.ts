import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as judgment from "@oh-my-pi/pi-coding-agent/judgment";
import {
	classifySpeckitTurn,
	decideSpeckitStep,
	newSpeckitRun,
	normalizeConvergeRounds,
	parseSpeckitAutoState,
	parseSpeckitPhaseCommand,
	readSpeckitEvidence,
	SPECKIT_PHASE_COMMANDS,
	SPECKIT_REMEDIATION_ROUNDS,
	type SpeckitAction,
	type SpeckitAutoScope,
	type SpeckitAutoState,
	type SpeckitEndResult,
	type SpeckitNext,
	type SpeckitPhase,
	type SpeckitRun,
	type SpeckitVerdict,
	speckitEarlierText,
	speckitOutcomes,
	speckitPhaseLoad,
	speckitScopeAllows,
} from "@oh-my-pi/pi-coding-agent/modes/speckit-auto";
import { createAssistantMessage } from "./helpers/agent-session-setup";

afterEach(() => {
	vi.restoreAllMocks();
});

const message = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
	...createAssistantMessage(text),
	stopReason,
});

/** mulberry32: small seeded PRNG so a failing sequence replays from its printed seed. */
function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Applies an action to the run the way the interactive layer does: a start
 * changes the phase and resets the answer flag, converge → implement counts a
 * converge round, remediate counts a round, and a hold gets a user reply that
 * keeps the phase.
 */
function applyAction(run: SpeckitRun, action: SpeckitAction): SpeckitEndResult | undefined {
	switch (action.kind) {
		case "notice":
			return applyAction(run, action.after);
		case "end":
			return action.result;
		case "answer":
			run.autoAnswered = true;
			return undefined;
		case "hold":
			return undefined;
		case "remediate":
			run.remediationRounds++;
			run.phase = "remediation";
			break;
		case "start":
			if (run.phase === "converge" && action.phase === "implement") run.convergeRounds++;
			// An analyze start inside analyze re-checks a user-requested fix: that fix was a remediation round.
			if (run.phase === "analyze" && action.phase === "analyze") run.remediationRounds++;
			run.phase = action.phase;
			break;
	}
	run.history.push(run.phase);
	run.autoAnswered = false;
	return undefined;
}

/** Drives the judge's picks for the run's current phase until the run ends, at most 40 steps. */
function drive(
	run: SpeckitRun,
	judge: (run: SpeckitRun) => SpeckitVerdict,
	scope: SpeckitAutoScope = "full",
): SpeckitEndResult | undefined {
	for (let step = 0; step < 40; step++) {
		const result = applyAction(run, decideSpeckitStep(run, judge(run), scope));
		if (result) return result;
	}
	return undefined;
}

const count = (run: SpeckitRun, phase: SpeckitPhase): number => run.history.filter(entry => entry === phase).length;

const NEXTS: readonly (SpeckitNext | undefined)[] = [
	"advance",
	"proceed",
	"remediate",
	"recheck",
	"complete",
	"added",
	"ask",
	"error",
	"unclear",
	undefined,
];
const HOLDING: readonly (SpeckitNext | undefined)[] = ["ask", "error", "unclear", undefined];
/** The judge's clean pick: every phase finishes its work. */
const cleanFor = (run: SpeckitRun): SpeckitVerdict => ({
	next: run.phase === "converge" ? "complete" : "advance",
	...(run.phase === "analyze" ? { analyze: { critical: 0, high: 0 } } : {}),
});

describe("decideSpeckitStep over seeded verdict sequences", () => {
	const SEED = 0x5eed_0009;
	const RUNS = 1500;
	const MAX_STEPS = 120;

	it.each([0, 1, 3, 7])("keeps the judge's holds, the bounds, and the SC-004 limits with convergeLimit %i", limit => {
		const random = seeded(SEED + limit);
		const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
		for (let index = 0; index < RUNS; index++) {
			const run = newSpeckitRun("specify", limit);
			const sequence: SpeckitVerdict[] = [];
			const fail = (rule: string): never => {
				throw new Error(
					`${rule}\nseed=${SEED + limit} run=${index} limit=${limit}\nhistory=${run.history.join(",")}\nverdicts=${JSON.stringify(sequence)}`,
				);
			};
			let answersInPhaseRun = 0;
			for (let step = 0; step < MAX_STEPS; step++) {
				const verdict: SpeckitVerdict = {
					failed: random() < 0.08 ? "provider error" : undefined,
					next: pick(NEXTS),
					analyze: pick([
						"unreadable",
						undefined,
						{ critical: 0, high: 0 },
						{ critical: 1, high: 0 },
						{ critical: 0, high: 2 },
						{ critical: 2, high: 1 },
					] as const),
				};
				sequence.push(verdict);
				const phase = run.phase;
				const action = decideSpeckitStep(run, verdict);
				if (verdict.failed && action.kind !== "hold") fail("acted after a failed turn");
				if (HOLDING.includes(verdict.next) && action.kind !== "hold") fail(`acted on the judge's ${verdict.next}`);
				if (action.kind === "answer" && verdict.next !== "proceed") fail("answered without a proceed pick");
				if (action.kind === "answer" && (phase === "specify" || phase === "clarify" || phase === "analyze")) {
					fail(`answered in ${phase}`);
				}
				if (action.kind === "answer" && ++answersInPhaseRun > 1) fail("second answer in one phase run");
				if (
					phase === "analyze" &&
					action.kind === "start" &&
					action.phase === "analyze" &&
					verdict.next !== "recheck"
				) {
					fail("re-ran analyze without a judged re-check");
				}
				const critical = typeof verdict.analyze === "object" && verdict.analyze.critical > 0;
				const started = action.kind === "notice" ? action.after : action;
				if (phase === "analyze" && critical && started.kind === "start" && started.phase === "implement") {
					fail("started implement past a CRITICAL finding");
				}
				const result = applyAction(run, action);
				if (run.phase !== phase) answersInPhaseRun = 0;
				if (count(run, "clarify") > 1) fail("more than one clarify start");
				if (count(run, "analyze") > 3) fail("more than 3 analyze turns");
				if (run.remediationRounds > 2) fail("more than 2 remediation rounds");
				if (count(run, "implement") > 1 + limit) fail(`more than ${1 + limit} implement turns`);
				if (result) break;
			}
		}
	});

	it("runs every phase in order and ends complete on clean picks", () => {
		const run = newSpeckitRun("specify", 3);
		expect(drive(run, cleanFor)).toBe("complete");
		expect(run.history).toEqual([...SPECKIT_PHASE_COMMANDS]);
	});

	it.each([
		[0, 1],
		[1, 2],
		[3, 4],
	])("with convergeLimit %i ends with open tasks after %i converge turns that add tasks", (limit, converges) => {
		const run = newSpeckitRun("implement", limit);
		const pick = (run: SpeckitRun): SpeckitVerdict => ({ next: run.phase === "converge" ? "added" : "advance" });
		expect(drive(run, pick)).toBe("open-tasks");
		expect(count(run, "converge")).toBe(converges);
		expect(run.convergeRounds).toBe(limit);
	});

	it("turns an analyze advance past a CRITICAL count into fix rounds, then holds with the count", () => {
		const run = newSpeckitRun("analyze", 3);
		const actions: SpeckitAction[] = [];
		for (let step = 0; step < 5; step++) {
			const verdict: SpeckitVerdict =
				run.phase === "analyze" ? { next: "advance", analyze: { critical: 1, high: 0 } } : { next: "advance" };
			const action = decideSpeckitStep(run, verdict);
			actions.push(action);
			applyAction(run, action);
		}
		expect(actions.map(action => action.kind)).toEqual(["remediate", "start", "remediate", "start", "hold"]);
		expect(actions.at(-1)).toMatchObject({
			hold: { kind: "needs-you", reason: expect.stringContaining("CRITICAL") },
		});
		expect(run.remediationRounds).toBe(SPECKIT_REMEDIATION_ROUNDS);
		// A judged fix offer with no CRITICAL count holds for the user once the rounds are used.
		expect(decideSpeckitStep(run, { next: "remediate", analyze: { critical: 0, high: 0 } })).toMatchObject({
			hold: { kind: "user" },
		});
	});

	it("holds the run when the judge cannot answer, in every phase", () => {
		for (const phase of [...SPECKIT_PHASE_COMMANDS, "remediation"] as const) {
			expect(decideSpeckitStep(newSpeckitRun(phase, 3), {})).toMatchObject({
				kind: "hold",
				hold: { kind: "needs-you", reason: expect.stringContaining("turn check failed") },
			});
		}
	});

	const scopeVerdict = (random: () => number): SpeckitVerdict => {
		const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
		return {
			next: pick(NEXTS),
			analyze: pick([
				{ critical: 0, high: 0 },
				{ critical: 1, high: 0 },
				{ critical: 0, high: 2 },
			] as const),
		};
	};

	it("in the tasks scope never starts implement or converge, and clean picks end planned after analyze", () => {
		const SCOPE_SEED = 0x5eed_0010;
		const random = seeded(SCOPE_SEED);
		const starts = SPECKIT_PHASE_COMMANDS.filter(phase => speckitScopeAllows("tasks", phase));
		for (let index = 0; index < RUNS; index++) {
			const run = newSpeckitRun(starts[Math.floor(random() * starts.length)]!, 3);
			for (let step = 0; step < MAX_STEPS; step++) {
				const action = decideSpeckitStep(run, scopeVerdict(random), "tasks");
				const started =
					action.kind === "start" ? action.phase : action.kind === "remediate" ? "remediation" : undefined;
				if (started === "implement" || started === "converge") {
					throw new Error(`started ${started}\nseed=${SCOPE_SEED} run=${index} history=${run.history.join(",")}`);
				}
				if (applyAction(run, action)) break;
			}
		}
		const run = newSpeckitRun("specify", 3);
		expect(drive(run, cleanFor, "tasks")).toBe("planned");
		expect(run.history).toEqual(["specify", "clarify", "plan", "tasks", "analyze"]);
	});

	it("in the tasks scope decides like full once the user starts implement or converge", () => {
		const EDIT_SEED = 0x5eed_0011;
		const random = seeded(EDIT_SEED);
		for (let index = 0; index < RUNS; index++) {
			const run = newSpeckitRun(random() < 0.5 ? "implement" : "converge", 3);
			for (let step = 0; step < MAX_STEPS; step++) {
				const verdict = scopeVerdict(random);
				const action = decideSpeckitStep(run, verdict, "tasks");
				const full = decideSpeckitStep(run, verdict, "full");
				if (!Bun.deepEquals(action, full)) {
					throw new Error(
						`tasks ${JSON.stringify(action)} != full ${JSON.stringify(full)}\nseed=${EDIT_SEED} run=${index} history=${run.history.join(",")}`,
					);
				}
				if (applyAction(run, action)) break;
			}
		}
	});
});

describe("parseSpeckitPhaseCommand", () => {
	it.each([
		["/speckit.plan", { name: "plan", phase: "plan" }],
		["/speckit.plan with args", { name: "plan", phase: "plan" }],
		["/speckit.planx", { name: "planx", phase: undefined }],
		["/speckit.checklist", { name: "checklist", phase: undefined }],
		["run /speckit.plan", undefined],
	] as const)("%s", (text, expected) => {
		expect(parseSpeckitPhaseCommand(text)).toEqual(expected);
	});
});

describe("speckitPhaseLoad", () => {
	it.each([
		['specify project command speckit.tasks --json > /tmp/tk.json; echo "exit=$?"', "tasks"],
		["~/.local/bin/specify project command speckit-plan", "plan"],
		["cd repo && specify project command 'speckit.analyze'", "analyze"],
		["specify project command speckit.plan && specify project command speckit.tasks", "tasks"],
		["grep -rn speckit.tasks .specify/", undefined],
		["specify check", undefined],
		["specify project command speckit.checklist", undefined],
		["echo specify speckit.tasks", undefined],
		["uvx --from spec-kit specify project command speckit.tasks", undefined],
		["FOO=1 specify project command speckit.tasks", undefined],
	] as const)("bash %s", (command, expected) => {
		expect(speckitPhaseLoad("bash", { command })).toBe(expected);
	});

	it("never counts an async bash job, whose end comes before any output", () => {
		expect(
			speckitPhaseLoad("bash", { command: "specify project command speckit.tasks", async: true }),
		).toBeUndefined();
	});

	it.each([
		[".omp/commands/speckit.tasks.md", "tasks"],
		[".omp/commands/speckit.plan.md:1-120", "plan"],
		[".omp/commands/speckit.plan.md:raw:2-4", "plan"],
		[".omp/commands/speckit.plan.md:-60", "plan"],
		["skill://speckit-implement", "implement"],
		["skill://speckit-clarify/SKILL.md", "clarify"],
		[".omp/skills/speckit-converge/SKILL.md", "converge"],
		["specs/017-x/tasks.md", undefined],
		[".omp/commands/speckit.checklist.md", undefined],
		[".omp/commands/notspeckit.tasks.md", undefined],
	] as const)("read %s", (path, expected) => {
		expect(speckitPhaseLoad("read", { path })).toBe(expected);
	});

	it.each(["write", "edit", "grep", "glob"])("never counts %s, so writes and searches stay out", tool => {
		const args = {
			command: "specify speckit.tasks",
			path: ".omp/commands/speckit.tasks.md",
			pattern: "speckit.tasks",
		};
		expect(speckitPhaseLoad(tool, args)).toBeUndefined();
	});

	it.each([undefined, null, "specify speckit.tasks", { command: 1 }, { path: ["speckit.tasks.md"] }])(
		"rejects the argument shape %p",
		args => {
			expect(speckitPhaseLoad("bash", args)).toBeUndefined();
			expect(speckitPhaseLoad("read", args)).toBeUndefined();
		},
	);

	const SEED = 0x5eed_0017;
	/** A shell command with one `specify … speckit<sep><phase>` segment among unrelated ones. */
	function generate(random: () => number, head: string) {
		const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
		const phase = pick(SPECKIT_PHASE_COMMANDS);
		const quote = pick(["", "'", '"']);
		const word = `${quote}speckit${pick([".", "-"])}${phase}${quote}`;
		const flags = Array.from({ length: Math.floor(random() * 3) }, () => pick(["--json", "-v", "--force"]));
		const segment = [head, pick(["project command", "command", ""]), word, ...flags].filter(Boolean).join(" ");
		const noise = () => Array.from({ length: Math.floor(random() * 3) }, () => pick(["echo x", "cd repo", "ls -la"]));
		const parts = [...noise(), segment, ...noise()];
		const command = parts.reduce((joined, part) => `${joined}${pick([";", " && ", " || ", " | ", "\n"])}${part}`);
		return { phase, command };
	}

	it(`finds the phase of any wrapped specify call (seed ${SEED})`, () => {
		const random = seeded(SEED);
		for (let index = 0; index < 500; index++) {
			const head = ["specify", "/usr/local/bin/specify", "~/.local/bin/specify"][index % 3]!;
			const { phase, command } = generate(random, head);
			if (speckitPhaseLoad("bash", { command }) !== phase) throw new Error(`seed=${SEED} case=${index}\n${command}`);
		}
	});

	it(`ignores the same commands when specify is not the program (seed ${SEED + 1})`, () => {
		const random = seeded(SEED + 1);
		for (let index = 0; index < 500; index++) {
			const head = ["grep -rn", "echo", "cat", "rg", "./specify.sh"][index % 5]!;
			const { command } = generate(random, head);
			if (speckitPhaseLoad("bash", { command }) !== undefined)
				throw new Error(`seed=${SEED + 1} case=${index}\n${command}`);
		}
	});
});

describe("parseSpeckitAutoState", () => {
	const run: SpeckitRun = {
		...newSpeckitRun("analyze", 2),
		history: ["specify", "clarify", "plan", "tasks", "analyze"],
		remediationRounds: 1,
		editing: true,
		hold: { kind: "needs-you", reason: "no readable analyze report" },
	};

	it("round-trips a valid state through JSON", () => {
		const state: SpeckitAutoState = { enabled: true, scope: "tasks", run };
		expect(parseSpeckitAutoState(JSON.parse(JSON.stringify(state)))).toEqual(state);
	});

	it.each([
		["an unknown phase", { ...run, phase: "deploy" }],
		["a negative count", { ...run, convergeRounds: -1 }],
		["a non-array history", { ...run, history: "specify" }],
	])("drops a run with %s and keeps enabled in the full scope", (_, badRun) => {
		expect(parseSpeckitAutoState({ enabled: true, run: badRun })).toEqual({
			enabled: true,
			scope: "full",
			run: undefined,
		});
	});

	it.each([null, "on", 3, { enabled: "yes" }, {}])("treats %p as mode off", data => {
		expect(parseSpeckitAutoState(data)).toBeUndefined();
	});
});

describe("normalizeConvergeRounds", () => {
	it.each([
		[Number.NaN, 3],
		[Number.POSITIVE_INFINITY, 3],
		[-1, 0],
		[2.7, 2],
		[0, 0],
		[3, 3],
	])("%p → %p", (value, expected) => {
		expect(normalizeConvergeRounds(value)).toBe(expected);
	});
});

describe("speckitEarlierText", () => {
	it("reads only the assistant messages after the turn opener", () => {
		const previous = message("Outcome: `tasks_appended`.");
		const opener: UserMessage = { role: "user", content: "/speckit.converge", timestamp: 1 };
		const outcome = message("Added T027–T029 under Phase 7.");
		const summary = message("Only Phase 7 was appended.");

		expect(speckitEarlierText([previous, opener, outcome, summary], summary)).toBe("Added T027–T029 under Phase 7.");
		expect(speckitEarlierText([previous, opener, summary], summary)).toBe("");
	});
});

describe("readSpeckitEvidence", () => {
	it.each([
		["No critical ambiguities detected worth formal clarification.", true],
		["Coverage is good. Suggested next command: /speckit.plan", true],
		["Proceed with /speckit.plan, or run /speckit.clarify again later.", false],
		[
			"| Category | Status |\n|---|---|\n| Performance | Deferred | high impact, quota reached |\nNext: /speckit.plan",
			false,
		],
		[
			"| Category | Status |\n|---|---|\n| Performance | Deferred | better suited for planning |\nNext: /speckit.plan",
			true,
		],
		["| Category | Status |\n|---|---|\n| Logging | Outstanding | low impact |\nNext: /speckit.plan", true],
		["I updated the spec.", false],
	])("clarify readyCue: %s → %p", (text, ready) => {
		expect(readSpeckitEvidence("clarify", message(text)).readyCue).toBe(ready);
	});

	it("reads the clarify readiness from an earlier message, and the final message's readiness wins", () => {
		const ready = "Proceed to planning. **No critical ambiguities detected worth formal clarification.**";
		expect(readSpeckitEvidence("clarify", message("Ready for the plan."), ready).readyCue).toBe(true);
		const blocking = "| Security | Deferred | High-impact access policy unresolved. |";
		expect(
			readSpeckitEvidence("clarify", message("No critical ambiguities detected. Run /speckit.plan next."), blocking)
				.readyCue,
		).toBe(true);
		expect(readSpeckitEvidence("clarify", message("Ready for the plan."), blocking).readyCue).toBe(false);
	});

	it.each([
		["plan", "Generated plan.md, research.md, and data-model.md.", true],
		["plan", "I will create plan.md next.", false],
		["tasks", "Created tasks.md with 24 tasks.", true],
		["tasks", "Review [tasks.md](specs/029-x/tasks.md). It contains **26 tasks**.", true],
		["tasks", "I will create tasks.md next.", false],
		["implement", "All 26 implementation tasks are marked complete.", true],
		["implement", "I will now work through all tasks in order.", false],
		["remediation", "Changed spec.md and tasks.md.\n\nRemediation complete.", true],
		["remediation", "I will fix the findings in spec.md.", false],
	] as const)("%s reportCue: %s → %p", (phase, text, reported) => {
		expect(readSpeckitEvidence(phase, message(text)).reportCue).toBe(reported);
	});

	it.each([
		["610 passed, 2 skipped, 0 failed.", false],
		["| Category | Status |\n|---|---|\n| Edge cases and failure handling | Clear |", false],
		["Committed as `HEAD` (3 files, zero `Error:` lines in the staged diff).", false],
		["Tests: 0 tests failed, 0 checks failed.", false],
		["No tests failed.", false],
		["0 checks failed, 2 tests failed.", true],
		["Created 0 files and failed to write plan.md.", true],
		["ERROR: build broke.", true],
		["T012 failed.", true],
		["Blocked: the API key is missing.", true],
		["| Task | Status |\n|---|---|\n| T012 | failed |", true],
	])("errorLines: %s → %p", (text, error) => {
		expect(readSpeckitEvidence("implement", message(`All tasks completed. ${text}`)).errorLines.length > 0).toBe(
			error,
		);
	});

	const SEED = 0x5eed_0020;
	it(`lists every generated closing offer and no other sentence (seed ${SEED})`, () => {
		const random = seeded(SEED);
		const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
		for (let index = 0; index < 300; index++) {
			const phase = pick(["plan", "tasks", "analyze", "implement"] as const);
			const other = pick(SPECKIT_PHASE_COMMANDS.filter(name => name !== phase));
			const offer =
				phase === "analyze" && random() < 0.5
					? `Would you like me to ${pick(["suggest", "propose"])} ${pick(["concrete remediation edits", "concrete fixes", "fixes", "edits"])} for the top ${1 + Math.floor(random() * 9)} issues?`
					: pick([
							`Run \`/speckit.${other}\` next.`,
							`Next: /speckit.${other}`,
							`Shall I run /speckit.${other} now?`,
						]);
			const body = pick(["Generated the report.", "The previous /speckit.plan run is recorded.", "T3 is done."]);
			const offers = readSpeckitEvidence(phase, message(`${body}\n\n${offer}`)).closingOffers;
			if (offers.length !== 1 || offers[0] !== offer) {
				throw new Error(`seed=${SEED} case=${index} phase=${phase}\n${offer}\n→ ${JSON.stringify(offers)}`);
			}
		}
	});

	describe("analyze report", () => {
		const header =
			"| ID | Category | Severity | Location(s) | Summary | Recommendation |\n|----|----|----|----|----|----|";
		const row = (id: string, severity: string) => `| ${id} | Coverage | ${severity} | spec.md:L10 | gap | fix |`;
		const report = (body: string) => `## Specification Analysis Report\n\n${body}`;
		const read = (text: string, earlier?: string) => readSpeckitEvidence("analyze", message(text), earlier).analyze;

		it("reads a zero-findings report with Critical Issues Count: 0 as 0/0", () => {
			expect(read(report("No issues found.\n\n**Metrics:**\n- Critical Issues Count: 0"))).toEqual({
				critical: 0,
				high: 0,
			});
		});

		it("counts CRITICAL and HIGH rows, bold or plain", () => {
			expect(
				read(report(`${header}\n${row("C1", "CRITICAL")}\n${row("A1", "**HIGH**")}\n${row("A2", "LOW")}`)),
			).toEqual({ critical: 1, high: 1 });
		});

		it("takes a Critical Issues Count larger than the row count", () => {
			expect(read(report(`${header}\n${row("C1", "CRITICAL")}\n\n- Critical Issues Count: 3`))).toEqual({
				critical: 3,
				high: 0,
			});
		});

		it("reads rows from the whole message, past the judged tail", () => {
			const text = report(`${header}\n${row("C1", "CRITICAL")}\n\n${"Detail line.\n".repeat(800)}`);
			expect(read(text)).toEqual({ critical: 1, high: 0 });
		});

		it("is unreadable with the metric but no table, or without the heading", () => {
			expect(read(report("**Metrics:**\n- Critical Issues Count: 0"))).toBe("unreadable");
			expect(read(`${header}\n${row("C1", "CRITICAL")}\n- Critical Issues Count: 1`)).toBe("unreadable");
		});

		it("reads the report from an earlier message of the turn, and the final message's own report wins", () => {
			const earlier = report(`${header}\n${row("C1", "CRITICAL")}\n${row("A1", "HIGH")}`);
			expect(read("Analysis is complete.", earlier)).toEqual({ critical: 1, high: 1 });
			expect(read("Analysis is complete.")).toBe("unreadable");
			expect(read(report(`${header}\n${row("A2", "HIGH")}`), earlier)).toEqual({ critical: 0, high: 1 });
		});
	});
});

describe("classifySpeckitTurn", () => {
	const deps = { settings: {} as Settings, registry: {} as ModelRegistry, sessionId: "s" };
	const header = "| ID | Category | Severity | Summary |\n|---|---|---|---|";
	/** The analyze reply that held a real run: one CRITICAL row and a closing offer worded "fixes". */
	const offer = "Would you like me to suggest concrete fixes for the top 5 issues (C1, I1, I2, G1, G2)?";
	const analyzeReply = `## Specification Analysis Report\n\n${header}\n| C1 | Constitution | CRITICAL | no test map |\n| I1 | Inconsistency | HIGH | MVP order |\n\n${offer}`;

	interface JudgeCall {
		state: Record<string, unknown> & { message: string; evidence: Record<string, unknown> };
		questions: { next: { type: string; criteria: Record<string, string> } };
	}
	const judgePicks = (pick: SpeckitNext | Error, calls: JudgeCall[] = []) =>
		vi.spyOn(judgment, "resolveJudge").mockReturnValue({
			judge: async (input: JudgeCall) => {
				calls.push(input);
				if (pick instanceof Error) throw pick;
				return { answers: { next: { type: "choice", choice: pick } } };
			},
		} as unknown as judgment.ChainJudge);

	it("shows the judge the whole reply with the closing offer as evidence, and follows its pick", async () => {
		const calls: JudgeCall[] = [];
		judgePicks("remediate", calls);
		const verdict = await classifySpeckitTurn("analyze", message(analyzeReply), deps);

		expect(calls[0].state.message).toContain(offer);
		expect(calls[0].state.evidence).toMatchObject({ analyze: { critical: 1, high: 1 }, closingOffers: [offer] });
		expect(verdict).toEqual({ failed: undefined, next: "remediate", analyze: { critical: 1, high: 1 } });
		expect(decideSpeckitStep(newSpeckitRun("analyze", 3), verdict)).toEqual({ kind: "remediate" });
	});

	it("holds when the judge fails, and never asks the judge about a failed stop", async () => {
		const calls: JudgeCall[] = [];
		judgePicks(new Error("no judge model"), calls);
		const verdict = await classifySpeckitTurn("plan", message("Generated plan.md."), deps);
		expect(verdict.next).toBeUndefined();
		expect(decideSpeckitStep(newSpeckitRun("plan", 3), verdict)).toMatchObject({
			hold: { kind: "needs-you", reason: expect.stringContaining("turn check failed") },
		});

		calls.length = 0;
		judgePicks("advance", calls);
		for (const stopReason of ["error", "length", "aborted"] as const) {
			const failed = await classifySpeckitTurn("plan", message("Generated plan.md.", stopReason), deps);
			expect(failed.failed).toBeString();
			expect(decideSpeckitStep(newSpeckitRun("plan", 3), failed).kind).toBe("hold");
		}
		expect(calls).toHaveLength(0);
	});

	it("offers each phase only the steps it can take, each with a rendered rubric", async () => {
		const calls: JudgeCall[] = [];
		judgePicks("unclear", calls);
		for (const phase of [...SPECKIT_PHASE_COMMANDS, "remediation"] as const) {
			for (const request of [undefined, "Fix the findings."]) {
				calls.length = 0;
				await classifySpeckitTurn(phase, message("Done."), deps, { request });
				const options = Object.keys(calls[0].questions.next.criteria);
				expect(options).toEqual(speckitOutcomes(phase, request !== undefined));
				for (const rubric of Object.values(calls[0].questions.next.criteria)) {
					expect(rubric.length).toBeGreaterThan(20);
					expect(rubric).not.toContain("{{");
				}
				expect(options.includes("advance")).toBe(phase !== "converge");
				expect(options.includes("proceed")).toBe(["plan", "tasks", "implement", "converge"].includes(phase));
				expect(options.includes("recheck")).toBe(phase === "analyze" && request !== undefined);
				expect(options.includes("complete")).toBe(phase === "converge");
			}
		}
	});

	it("gives the judge the earlier replies, and the user's text with its answer mark only on a user turn", async () => {
		const calls: JudgeCall[] = [];
		judgePicks("advance", calls);
		await classifySpeckitTurn("converge", message("Done."), deps, { earlier: "Checked 14 FRs." });
		expect(calls[0].state.earlier).toBe("Checked 14 FRs.");
		expect(calls[0].state).not.toHaveProperty("request");

		await classifySpeckitTurn("plan", message("Recorded option 1."), deps, { request: "ok 1", answers: true });
		expect(calls[1].state).toMatchObject({ request: "ok 1", answers: true });
		expect(calls[1].state).not.toHaveProperty("earlier");
		await classifySpeckitTurn("plan", message("Committed."), deps, { request: "commit this" });
		expect(calls[2].state).toMatchObject({ request: "commit this", answers: false });
	});
});
