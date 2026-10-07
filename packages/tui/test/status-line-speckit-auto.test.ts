import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "../src/status-line/segments";
import { describeSegment, renderSegment } from "../src/status-line/segments";
import type { SpeckitAutoStatusState } from "../src/status-line/types";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function createContext(
	speckitAuto: SegmentContext["speckitAuto"],
	loopMode: SegmentContext["loopMode"] = null,
	prewalk: SegmentContext["prewalk"] = null,
): SegmentContext {
	return {
		session: {} as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode,
		speckitAuto,
		prewalk,
		goalMode: null,
		vibeMode: null,
		vim: null,
		collab: null,
		stream: null,
		recording: false,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		ideSelection: null,
		ideFile: null,
		activeMs: 0,
		turnElapsedMs: null,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

const STATES: readonly SpeckitAutoStatusState[] = ["waiting", "running", "next", "user", "needs-you", "paused"];

describe("status line speckit-auto mode segment", () => {
	it("is hidden when the mode is off", () => {
		expect(renderSegment("mode", createContext(null)).visible).toBe(false);
		expect(describeSegment("mode", createContext(null))).toBeNull();
	});

	it("names the mode without a phase when no run is active", () => {
		const content = Bun.stripANSI(renderSegment("mode", createContext({ state: "waiting" })).content);
		expect(content).toContain("Speckit auto");
		expect(content).toContain("waiting");
	});

	for (const state of STATES) {
		it(`shows the phase and a distinct text for state ${state}, warning only when paused`, () => {
			const status = { phase: "implement", state, reason: "converge needs a decision" };
			const rendered = renderSegment("mode", createContext(status));
			const text = Bun.stripANSI(rendered.content);
			const described = describeSegment("mode", createContext(status));
			const paused = state === "paused";

			expect(rendered.visible).toBe(true);
			// The mode icon leads; the pause icon appears once, and only when paused.
			expect(text).toBe(`${theme.icon.speckitAuto} ${described?.spans.map(s => s.t).join("")}`);
			expect(text.split(theme.icon.pause).length - 1).toBe(paused ? 1 : 0);
			expect(text).toContain("implement");
			expect(rendered.content === theme.fg("warning", text)).toBe(paused);
			expect(described?.tone === "warning").toBe(paused);
			if (state === "needs-you") expect(text).toContain("converge needs a decision");
			// Each state reads differently, so the user can tell them apart.
			for (const other of STATES) {
				if (other === state) continue;
				const otherText = Bun.stripANSI(renderSegment("mode", createContext({ ...status, state: other })).content);
				expect(otherText).not.toBe(text);
			}
		});
	}

	it("takes the mode slot before loop mode", () => {
		const text = Bun.stripANSI(
			renderSegment("mode", createContext({ phase: "plan", state: "running" }, { state: "running" })).content,
		);
		expect(text).toContain("Speckit auto");
		expect(text).not.toContain("Loop");
	});

	it("shows prewalk beside the active mode instead of hiding it", () => {
		const prewalk = { enabled: true };
		const both = createContext({ state: "waiting" }, null, prewalk);
		const text = Bun.stripANSI(renderSegment("mode", both).content);
		expect(text.indexOf("Speckit auto · waiting")).toBeGreaterThanOrEqual(0);
		expect(text.indexOf("Prewalk")).toBeGreaterThan(text.indexOf("Speckit auto · waiting"));
		const described = describeSegment("mode", both)?.spans.map(part => part.t).join("") ?? "";
		expect(described).toContain("Speckit auto · waiting");
		expect(described).toContain("Prewalk");

		const alone = createContext(null, null, prewalk);
		expect(Bun.stripANSI(renderSegment("mode", alone).content)).toContain("Prewalk");
		expect(Bun.stripANSI(renderSegment("mode", alone).content)).not.toContain("Speckit");
		expect(describeSegment("mode", alone)?.spans.map(part => part.t).join("")).toBe("Prewalk");
	});
});
