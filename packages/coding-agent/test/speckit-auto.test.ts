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
			[
				"| Category | Status |\n|---|---|\n| Security | Deferred | High-impact access policy unresolved. Must resolve before planning. |\nNext: /speckit.plan",
				undefined,
			],
			["I updated the spec.", undefined],
		])("%s → %p", (text, ready) => {
			expect(readSpeckitTextVerdict("clarify", message(text)).ready).toBe(ready as boolean | undefined);
		});

		it("waits only with a question, does not wait only with a ready cue, and is unknown otherwise (row 6)", () => {
			const waits = (text: string) => readSpeckitTextVerdict("clarify", message(text)).waits;
			expect(waits("No critical ambiguities detected.")).toBe(false);
			expect(waits("**Question:** Which export formats matter?")).toBe(true);
			expect(waits("I updated the spec.")).toBeUndefined();
			const unknown = readSpeckitTextVerdict("clarify", message("I updated the spec."));
			expect(decideSpeckitStep(newSpeckitRun("clarify", 3), unknown)).toMatchObject({
				kind: "hold",
				hold: { reason: expect.stringContaining("waits") },
			});
			// Real reply: the readiness line is in an earlier message of the turn.
			const earlier = readSpeckitTextVerdict(
				"clarify",
				message("Ready for the implementation plan."),
				"Proceed to planning. **No critical ambiguities detected worth formal clarification.**",
			);
			expect(earlier).toMatchObject({ waits: false, ready: true });
			// The final message's readiness wins over an older blocking row from an earlier message.
			const blocking = "| Security | Deferred | High-impact access policy unresolved. |";
			expect(
				readSpeckitTextVerdict(
					"clarify",
					message("No critical ambiguities detected. Run /speckit.plan next."),
					blocking,
				).ready,
			).toBe(true);
			expect(readSpeckitTextVerdict("clarify", message("Ready for the implementation plan."), blocking).ready).toBe(
				undefined,
			);
		});
	});

	describe("specify waits", () => {
		it.each([
			["Wrote spec.md. Next: /speckit.clarify", false],
			["Wrote spec.md. Which export formats matter?", true],
			["I looked at the repository layout.", undefined],
		])("%s → %p", (text, waits) => {
			expect(readSpeckitTextVerdict("specify", message(text)).waits).toBe(waits as boolean | undefined);
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
			["implement", "All 26 implementation tasks are marked complete.", true],
			[
				"tasks",
				"**Completion report**\n\n- Tasks: `specs/029-global-concurrency-default/tasks.md`\n- Total: 27 tasks.",
				true,
			],
			["tasks", "Review [tasks.md](specs/029-x/tasks.md). It contains **26 tasks**.", true],
			["plan", "- IMPL_PLAN: `specs/029-x/plan.md`\n\nRun `/speckit.tasks` next.", true],
			["plan", "Generated plan.md. Should I also add a quickstart?", undefined],
		] as const)("%s: %s → %p", (phase, text, completed) => {
			expect(readSpeckitTextVerdict(phase, message(text)).completed).toBe(completed);
		});
	});

	describe("error cue", () => {
		it.each([
			["610 passed, 2 skipped, 0 failed.", true],
			["124 passed, 0 failed.", true],
			["| Category | Status |\n|---|---|\n| Edge cases and failure handling | Clear |", true],
			["Committed as `HEAD` (3 files, zero `Error:` lines in the staged diff).", true],
			["Tests: 0 tests failed, 0 checks failed.", true],
			["No tests failed.", true],
			["0 checks failed, 2 tests failed.", false],
			["Created 0 files and failed to write plan.md.", false],
			["ERROR: build broke.", false],
			["Error: tasks.md is missing.", false],
			["3 failed.", false],
			["T012 failed.", false],
			["The constitution gate failed.", false],
			["Blocked: the API key is missing.", false],
			["| Task | Status |\n|---|---|\n| T012 | failed |", false],
		])("All tasks completed. %s → completed %p", (text, completed) => {
			expect(readSpeckitTextVerdict("implement", message(`All tasks completed. ${text}`)).completed).toBe(completed);
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

		it("is not routine next to another question", () => {
			expect(
				readSpeckitTextVerdict("implement", message(`${gate}\n\nShould the export include private records too?`)),
			).toMatchObject({ waits: true, routine: false });
		});

		it("stays routine when the reply only mentions another phase command", () => {
			const mention = `The previous /speckit.analyze report has no CRITICAL findings.\n\n${gate}`;
			expect(readSpeckitTextVerdict("implement", message(mention))).toMatchObject({ waits: true, routine: true });
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
			expect(
				readSpeckitTextVerdict(
					"analyze",
					message(
						report(
							`${header}\n\nWould you like me to suggest concrete remediation edits for the top 0 issues? Should exports include private records too?`,
						),
					),
				).waits,
			).toBe(true);
		});

		it("reads the report from an earlier message of the turn when the final message has none", () => {
			const opener: UserMessage = { role: "user", content: "/speckit.analyze", timestamp: 1 };
			const found = message(report(`${header}\n${row("C1", "CRITICAL")}\n${row("A1", "HIGH")}`));
			const final = message(
				"Analysis is complete.\n\nWould you like me to suggest concrete remediation edits for the three findings?",
			);
			const earlier = speckitEarlierText([opener, found, final], final);
			const verdict = readSpeckitTextVerdict("analyze", final, earlier);

			expect(verdict.analyze).toEqual({ critical: 1, high: 1 });
			expect(decideSpeckitStep(newSpeckitRun("analyze", 3), verdict)).toEqual({ kind: "remediate" });
			expect(readSpeckitTextVerdict("analyze", final).analyze).toBe("unreadable");
			// The final message's own report wins.
			const own = message(report(`${header}\n${row("A2", "HIGH")}`));
			expect(readSpeckitTextVerdict("analyze", own, earlier).analyze).toEqual({ critical: 0, high: 1 });
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

	it("hides a closing offer to run another phase from the judge and never auto-answers one", async () => {
		const seen: string[] = [];
		vi.spyOn(judgment, "resolveJudge").mockReturnValue({
			judge: async (input: { state: { message: string } }) => {
				seen.push(input.state.message);
				return { answers: { completed: { noul: 0.9 }, waits: { noul: 0.9 }, routine: { noul: 0.9 } } };
			},
		} as unknown as judgment.ChainJudge);
		const report = "**Completion report**\n\n- Total: 27 tasks.";
		const offer = "Run `/speckit.implement`, or say `go` and I will run the phases with one agent per US1 slice.";

		const offered = await classifySpeckitTurn("tasks", message(`${report}\n\n${offer}`), deps);
		expect(seen.at(-1)).toContain("Completion report");
		expect(seen.at(-1)).not.toContain(offer);
		// Even a judge that still reads a question there never gets the "proceed" answer.
		expect(offered.routine).toBe(false);
		expect(decideSpeckitStep(newSpeckitRun("tasks", 3), offered).kind).not.toBe("answer");
		expect(readSpeckitTextVerdict("tasks", message(`${report}\n\n${offer}`)).waits).toBe(false);

		// An offer with a question cue reaches the judge, and the mode holds instead of answering it.
		const asked = await classifySpeckitTurn(
			"tasks",
			message(`${report}\n\nShall I run /speckit.implement now?`),
			deps,
		);
		expect(seen.at(-1)).toContain("/speckit.implement");
		expect(asked.routine).toBe(false);
		expect(decideSpeckitStep(newSpeckitRun("tasks", 3), asked)).toMatchObject({ kind: "hold" });

		// Clarify keeps its recommended next command for the ready check.
		await classifySpeckitTurn(
			"clarify",
			message("No critical ambiguities detected.\n\nNext: run /speckit.plan."),
			deps,
		);
		expect(seen.at(-1)).toContain("/speckit.plan");

		// The reply's own phase command is not an offer: the implement checklist gate stays routine.
		const gate =
			"Checklists are incomplete; /speckit.implement stopped.\n\nDo you want to proceed with implementation anyway? (yes/no)";
		expect((await classifySpeckitTurn("implement", message(gate), deps)).routine).toBe(true);
		expect(readSpeckitTextVerdict("implement", message(gate)).routine).toBe(true);
		expect(readSpeckitTextVerdict("implement", message(`Then run /speckit.converge.\n\n${gate}`)).routine).toBe(
			false,
		);
	});

	it("hides only the handoff sentence from the judge and keeps the rest of the paragraph", async () => {
		const seen: string[] = [];
		vi.spyOn(judgment, "resolveJudge").mockReturnValue({
			judge: async (input: { state: { message: string } }) => {
				seen.push(input.state.message);
				return { answers: { completed: { noul: 0.9 }, waits: { noul: 0.9 }, routine: { noul: 0.9 } } };
			},
		} as unknown as judgment.ChainJudge);

		await classifySpeckitTurn("tasks", message("Created tasks.md with 24 tasks. Next: /speckit.analyze."), deps);
		expect(seen.at(-1)).toContain("Created tasks.md with 24 tasks.");
		expect(seen.at(-1)).not.toContain("/speckit.analyze");

		const scope = "Choose whether this feature stores personal data before /speckit.tasks.";
		await classifySpeckitTurn("plan", message(`Generated plan.md.\n\n${scope}`), deps);
		expect(seen.at(-1)).toContain(scope);

		const failure = "Could not run /speckit.implement because tasks.md is missing.";
		await classifySpeckitTurn("tasks", message(failure), deps);
		expect(seen.at(-1)).toContain(failure);

		// A mention of another phase command is not an offer: the implement checklist gate stays routine.
		const gate = `The previous /speckit.analyze report has no CRITICAL findings.\n\nDo you want to proceed with implementation anyway? (yes/no)`;
		expect((await classifySpeckitTurn("implement", message(gate), deps)).routine).toBe(true);
	});

	it("never takes the judge's routine answer next to the text error cue", async () => {
		vi.spyOn(judgment, "resolveJudge").mockReturnValue({
			judge: async () => ({
				answers: { completed: { noul: 0.9 }, waits: { noul: 0.9 }, routine: { noul: 0.9 } },
			}),
		} as unknown as judgment.ChainJudge);
		const reply = message("ERROR: build broke.\n\nDo you want to proceed with implementation anyway? (yes/no)");
		const verdict = await classifySpeckitTurn("implement", reply, deps);

		expect(verdict.routine).toBe(false);
		expect(decideSpeckitStep(newSpeckitRun("implement", 3), verdict)).toMatchObject({ kind: "hold" });
	});

	const judgeSays = (completed: number, seen: string[] = []) =>
		vi.spyOn(judgment, "resolveJudge").mockReturnValue({
			judge: async (input: { state: { message: string } }) => {
				seen.push(input.state.message);
				return { answers: { completed: { noul: completed }, waits: { noul: 0.1 }, routine: { noul: 0.1 } } };
			},
		} as unknown as judgment.ChainJudge);

	it("hides a 'Reply remediate' analyze offer from the judge and keeps an approval request", async () => {
		const seen: string[] = [];
		judgeSays(0.9, seen);
		const offer = "Reply `remediate` and I will draft the edits for U1, U2, I1, and I3 for your approval.";
		await classifySpeckitTurn("analyze", message(`Critical Issues Count: 0\n\n${offer}`), deps);
		expect(seen.at(-1)).not.toContain("remediate");
		const approve = "Edits 2 and 6 change behavior. Reply `apply all` or list the numbers.";
		await classifySpeckitTurn("analyze", message(approve), deps);
		expect(seen.at(-1)).toContain(approve);
		const question = "Reply `remediate` if I should also apply the edits to the contracts?";
		await classifySpeckitTurn("analyze", message(question), deps);
		expect(seen.at(-1)).toContain(question);
	});

	it("never starts the next phase from the judge alone after a user turn without the phase report", async () => {
		judgeSays(0.9);
		const run = newSpeckitRun("implement", 3);
		// A side request (smart-commit) after a hold: the judge reads its reply as finished.
		const side = await classifySpeckitTurn(
			"implement",
			message("The index is empty. No commits were pushed."),
			deps,
			{
				request: "commit this",
			},
		);
		expect(side.completed).toBeUndefined();
		expect(decideSpeckitStep(run, side)).toMatchObject({ kind: "hold" });
		// Converge advances only on its text outcome, never on the judge.
		const sideConverge = await classifySpeckitTurn(
			"converge",
			message("The index is empty. No commits were pushed."),
			deps,
			{
				request: "commit this",
			},
		);
		expect(decideSpeckitStep(newSpeckitRun("converge", 3), sideConverge)).toMatchObject({ kind: "hold" });
		// The phase report still advances a user turn, and a phase command turn still trusts the judge.
		const done = await classifySpeckitTurn("implement", message("All tasks completed."), deps, {
			request: "continue",
		});
		expect(decideSpeckitStep(run, done)).toMatchObject({ kind: "start", phase: "converge" });
		const own = await classifySpeckitTurn("implement", message("The work is finished."), deps);
		expect(decideSpeckitStep(run, own)).toMatchObject({ kind: "start", phase: "converge" });
	});

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
