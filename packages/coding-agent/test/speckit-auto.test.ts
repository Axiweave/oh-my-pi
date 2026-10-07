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
	readSpeckitTextVerdict,
	SPECKIT_PHASE_COMMANDS,
	type SpeckitAction,
	type SpeckitEndResult,
	type SpeckitPhase,
	type SpeckitRun,
	speckitEarlierText,
	type SpeckitVerdict,
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

/** Drives verdicts until the run ends; returns the result, or undefined when the verdicts run out. */
function drive(run: SpeckitRun, verdicts: Iterable<SpeckitVerdict>): SpeckitEndResult | undefined {
	for (const verdict of verdicts) {
		const result = applyAction(run, decideSpeckitStep(run, verdict));
		if (result) return result;
	}
	return undefined;
}

const count = (run: SpeckitRun, phase: SpeckitPhase): number => run.history.filter(entry => entry === phase).length;

describe("decideSpeckitStep over seeded verdict sequences", () => {
	const SEED = 0x5eed_0009;
	const RUNS = 1500;
	const MAX_STEPS = 120;

	it.each([0, 1, 3, 7])("keeps the safety rules and the SC-004 bounds with convergeLimit %i", limit => {
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
					completed: pick([true, true, true, false, undefined]),
					waits: pick([false, false, false, true, undefined]),
					routine: random() < 0.5,
					ready: pick([true, true, false, undefined]),
					analyze: pick([
						"unreadable",
						undefined,
						{ critical: 0, high: 0 },
						{ critical: 1, high: 0 },
						{ critical: 0, high: 2 },
						{ critical: 2, high: 1 },
					] as const),
					fixed: pick([true, false, undefined]),
					converge: pick(["complete", "added", "added", "added", "none", undefined] as const),
				};
				sequence.push(verdict);
				const phase = run.phase;
				const action = decideSpeckitStep(run, verdict);
				if (verdict.failed && action.kind !== "hold") fail("acted after a failed turn");
				if (
					verdict.completed === false &&
					action.kind !== "hold" &&
					!(action.kind === "answer" && verdict.waits === true && verdict.routine)
				) {
					fail("acted after completed === false");
				}
				if ((phase === "specify" || phase === "clarify") && verdict.waits !== false && action.kind !== "hold") {
					fail(`automatic action in ${phase} with waits ${verdict.waits}`);
				}
				if (action.kind === "answer" && ++answersInPhaseRun > 1) fail("second answer in one phase run");
				if (
					phase === "analyze" &&
					action.kind === "start" &&
					action.phase === "analyze" &&
					verdict.fixed !== true
				) {
					fail("re-ran analyze without a user-requested fix");
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

	it("runs every phase in order and ends complete on clean verdicts", () => {
		const run = newSpeckitRun("specify", 3);
		const clean: SpeckitVerdict = {
			completed: true,
			waits: false,
			routine: false,
			ready: true,
			analyze: { critical: 0, high: 0 },
			converge: "complete",
		};
		expect(drive(run, Array(SPECKIT_PHASE_COMMANDS.length).fill(clean))).toBe("complete");
		expect(run.history).toEqual([...SPECKIT_PHASE_COMMANDS]);
	});

	it.each([
		[0, 1],
		[1, 2],
		[3, 4],
	])("with convergeLimit %i ends with open tasks after %i converge turns that add tasks", (limit, converges) => {
		const run = newSpeckitRun("implement", limit);
		const added: SpeckitVerdict = { completed: true, waits: false, routine: false, converge: "added" };
		expect(drive(run, Array(40).fill(added))).toBe("open-tasks");
		expect(count(run, "converge")).toBe(converges);
		expect(run.convergeRounds).toBe(limit);
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

describe("parseSpeckitAutoState", () => {
	const run: SpeckitRun = {
		...newSpeckitRun("analyze", 2),
		history: ["specify", "clarify", "plan", "tasks", "analyze"],
		remediationRounds: 1,
		hold: { kind: "needs-you", reason: "no readable analyze report" },
	};

	it("round-trips a valid state through JSON", () => {
		const state = { enabled: true, run };
		expect(parseSpeckitAutoState(JSON.parse(JSON.stringify(state)))).toEqual(state);
	});

	it.each([
		["an unknown phase", { ...run, phase: "deploy" }],
		["a negative count", { ...run, convergeRounds: -1 }],
		["a non-array history", { ...run, history: "specify" }],
	])("drops a run with %s and keeps enabled", (_, badRun) => {
		expect(parseSpeckitAutoState({ enabled: true, run: badRun })).toEqual({ enabled: true, run: undefined });
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

describe("readSpeckitTextVerdict", () => {
	it.each(["error", "length", "aborted"] as const)("marks a %s stop as failed", stopReason => {
		expect(readSpeckitTextVerdict("plan", message("Generated plan.md.", stopReason)).failed).toBeString();
	});

	it("does not mark a normal stop as failed", () => {
		expect(readSpeckitTextVerdict("plan", message("Generated plan.md.")).failed).toBeUndefined();
	});

	describe("clarify ready", () => {
		it.each([
			["No critical ambiguities detected worth formal clarification.", true],
			["Coverage is good. Suggested next command: /speckit.plan", true],
			["Proceed with /speckit.plan, or run /speckit.clarify again later.", undefined],
			[
				"| Category | Status |\n|---|---|\n| Performance | Deferred | high impact, quota reached |\nNext: /speckit.plan",
				undefined,
			],
			[
				"| Category | Status |\n|---|---|\n| Performance | Deferred | better suited for planning |\nNext: /speckit.plan",
				true,
			],
			["| Category | Status |\n|---|---|\n| Logging | Outstanding | low impact |\nNext: /speckit.plan", true],
			["I updated the spec.", undefined],
		])("%s → %p", (text, ready) => {
			expect(readSpeckitTextVerdict("clarify", message(text)).ready).toBe(ready as boolean | undefined);
		});
	});

	describe("converge result", () => {
		it.each([
			["✅ Converged — the implementation satisfies the spec, plan, and tasks.", "complete"],
			["✅ **Converged — the implementation satisfies the spec, plan, and tasks.**", "complete"],
			["Outcome: `tasks_appended`. Run /speckit.implement next.", "added"],
			["Appended 3 tasks under ## Phase 4: Convergence.", "added"],
			["I will add a ## Phase 4: Convergence section if needed.", "none"],
			["## Convergence Findings\n\n| ID | Finding |\n|---|---|\n| C1 | missing test |", "none"],
			["✅ Converged\nOutcome: tasks_appended", "none"],
		])("%s → %s", (text, converge) => {
			expect(readSpeckitTextVerdict("converge", message(text)).converge).toBe(
				converge as SpeckitVerdict["converge"],
			);
		});

		it("reads the outcome that an earlier message of the converge turn reported", () => {
			const previous = message("Outcome: `tasks_appended`.");
			const opener: UserMessage = { role: "user", content: "/speckit.converge", timestamp: 1 };
			const outcome = message("**Outcome: `tasks_appended`.** Added T027–T029 under Phase 7.");
			const summary = message("Only Phase 7 was appended.\n\n**Status: partial—not converged.**");
			const earlier = speckitEarlierText([previous, opener, outcome, summary], summary);

			expect(readSpeckitTextVerdict("converge", summary, earlier).converge).toBe("added");
			expect(readSpeckitTextVerdict("converge", summary).converge).toBe("none");
			// The turn before the opener never counts, and two different outcomes in one turn hold.
			expect(speckitEarlierText([previous, opener, summary], summary)).toBe("");
			expect(readSpeckitTextVerdict("converge", message("✅ **Converged**"), earlier).converge).toBe("none");
		});
	});

	describe("fallback completed", () => {
		it.each([
			["plan", "Generated plan.md, research.md, and data-model.md.", true],
			["plan", "I will create plan.md next.", undefined],
			["tasks", "Created tasks.md with 24 tasks.", true],
			["tasks", "I will create tasks.md next.", undefined],
			["implement", "All tasks completed. The test suite passes.", true],
			["implement", "I will now work through all tasks in order.", undefined],
			["remediation", "Changed spec.md and tasks.md.\n\nRemediation complete.", true],
			["remediation", "I will fix the findings in spec.md.", undefined],
			["plan", "Generated plan.md.\nERROR: constitution gate failed.", false],
			["tasks", "ERROR: constitution gate failed.", false],
			["implement", "ERROR: constitution gate failed.", false],
			["remediation", "ERROR: constitution gate failed.", false],
			["plan", "Generated plan.md. Should I also add a quickstart?", undefined],
		] as const)("%s: %s → %p", (phase, text, completed) => {
			expect(readSpeckitTextVerdict(phase, message(text)).completed).toBe(completed);
		});
	});

	describe("implement checklist gate", () => {
		const gate =
			"| Checklist | Total | Completed | Incomplete | Status |\n|---|---|---|---|---|\n| ux.md | 12 | 9 | 3 | ✗ FAIL |\n\n**STOP**: Some checklists have unchecked items. Do you want to proceed with implementation anyway? (yes/no)";

		it("is a routine question that waits", () => {
			expect(readSpeckitTextVerdict("implement", message(gate))).toMatchObject({ waits: true, routine: true });
		});

		it("is not routine next to a reported error", () => {
			expect(readSpeckitTextVerdict("implement", message(`ERROR: build broke.\n\n${gate}`))).toMatchObject({
				waits: true,
				routine: false,
				completed: false,
			});
		});
	});

	describe("analyze report", () => {
		const header =
			"| ID | Category | Severity | Location(s) | Summary | Recommendation |\n|----|----|----|----|----|----|";
		const row = (id: string, severity: string) => `| ${id} | Coverage | ${severity} | spec.md:L10 | gap | fix |`;
		const report = (body: string) => `## Specification Analysis Report\n\n${body}`;
		const read = (text: string) => readSpeckitTextVerdict("analyze", message(text)).analyze;

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

		it("is unreadable with the metric but no table and no zero-findings line", () => {
			expect(read(report("**Metrics:**\n- Critical Issues Count: 0"))).toBe("unreadable");
		});

		it("is unreadable without the heading", () => {
			expect(read(`${header}\n${row("C1", "CRITICAL")}\n- Critical Issues Count: 1`)).toBe("unreadable");
		});

		it("does not treat the closing remediation offer as a question", () => {
			const offer = "Would you like me to suggest concrete remediation edits for the top 3 issues?";
			expect(readSpeckitTextVerdict("analyze", message(report(`${header}\n\n${offer}`))).waits).toBe(false);
			expect(
				readSpeckitTextVerdict(
					"analyze",
					message(report(`${header}\n\nShould the export cover PDF too?\n\n${offer}`)),
				).waits,
			).toBe(true);
		});
	});
});

describe("classifySpeckitTurn", () => {
	const deps = { settings: {} as Settings, registry: {} as ModelRegistry, sessionId: "s" };
	const text = `## Specification Analysis Report\n\n| ID | Severity |\n|---|---|\n| C1 | CRITICAL |\n\nI will create plan.md.`;

	it("takes completed, waits, and routine from the judge and the report counts from the text", async () => {
		vi.spyOn(judgment, "resolveJudge").mockReturnValue({
			judge: async () => ({
				answers: { completed: { noul: 0.9 }, waits: { noul: 0.1 }, routine: { noul: 0.5 } },
			}),
		} as unknown as judgment.ChainJudge);
		expect(await classifySpeckitTurn("analyze", message(text), deps)).toMatchObject({
			completed: true,
			waits: false,
			routine: true,
			analyze: { critical: 1, high: 0 },
		});
	});

	it("falls back to the text verdict when the judge fails", async () => {
		vi.spyOn(judgment, "resolveJudge").mockReturnValue({
			judge: async () => {
				throw new Error("no judge model");
			},
		} as unknown as judgment.ChainJudge);
		expect(await classifySpeckitTurn("analyze", message(text), deps)).toEqual(
			readSpeckitTextVerdict("analyze", message(text)),
		);
	});

	const judgeSays = (completed: number, seen: string[] = []) =>
		vi.spyOn(judgment, "resolveJudge").mockReturnValue({
			judge: async (input: { state: { message: string } }) => {
				seen.push(input.state.message);
				return { answers: { completed: { noul: completed }, waits: { noul: 0.1 }, routine: { noul: 0.1 } } };
			},
		} as unknown as judgment.ChainJudge);

	it("keeps a readable analyze report or converge result completed when the judge reads it as a failure", async () => {
		judgeSays(0.1);
		const appended = "Outcome: tasks_appended. Appended 1 task under ## Phase 3: Convergence.";
		expect((await classifySpeckitTurn("analyze", message(text), deps)).completed).toBe(true);
		expect((await classifySpeckitTurn("converge", message(appended), deps)).completed).toBe(true);
		// An error cue, an unreadable report, or no converge result still holds.
		expect((await classifySpeckitTurn("analyze", message(`${text}\nERROR: script failed.`), deps)).completed).toBe(
			false,
		);
		expect((await classifySpeckitTurn("analyze", message("I looked around."), deps)).completed).toBe(false);
		expect((await classifySpeckitTurn("converge", message("Nothing to report."), deps)).completed).toBe(false);
	});

	it("never shows the judge the analyze remediation offer", async () => {
		const seen: string[] = [];
		judgeSays(0.9, seen);
		const offer = "Would you like me to suggest concrete remediation edits for the top 1 issues?";
		await classifySpeckitTurn("analyze", message(`${text}\n\n${offer}`), deps);
		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toContain(offer);
		expect(seen[0]).toContain("CRITICAL");
	});

	it("asks whether the user requested a fix only for a user turn in analyze without a readable report", async () => {
		const calls: { state: Record<string, unknown>; questions: Record<string, unknown> }[] = [];
		vi.spyOn(judgment, "resolveJudge").mockReturnValue({
			judge: async (input: (typeof calls)[number]) => {
				calls.push(input);
				const answers = Object.fromEntries(Object.keys(input.questions).map(id => [id, { noul: 0.9 }]));
				return { answers: { ...answers, waits: { noul: 0.1 } } };
			},
		} as unknown as judgment.ChainJudge);
		const fix = "All three findings are addressed. Updated spec.md and tasks.md.";
		const request = "Fix the analyze findings.";

		expect((await classifySpeckitTurn("analyze", message(fix), deps, { request })).fixed).toBe(true);
		expect(calls[0].state).toMatchObject({ phase: "analyze", request });
		expect(Object.keys(calls[0].questions)).toContain("fixed");

		// A readable report, a turn the mode started, or another phase never asks it.
		for (const [phase, reply, from] of [
			["analyze", text, request],
			["analyze", fix, undefined],
			["tasks", fix, request],
		] as const) {
			calls.length = 0;
			expect((await classifySpeckitTurn(phase, message(reply), deps, { request: from })).fixed).toBeUndefined();
			expect(Object.keys(calls[0].questions)).not.toContain("fixed");
			expect(calls[0].state).not.toHaveProperty("request");
		}
	});
});
