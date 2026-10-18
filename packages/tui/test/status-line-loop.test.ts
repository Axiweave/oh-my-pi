import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { SegmentContext } from "../src/status-line/segments";
import { describeSegment, formatLoopInterval, renderSegment } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createContext(loopMode: SegmentContext["loopMode"]): SegmentContext {
	return {
		session: {} as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		speckitAuto: null,
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

function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}

describe("status line loop mode segment", () => {
	it("warns that the next prompt becomes the repeated loop body", () => {
		const rendered = renderSegment(
			"mode",
			createContext({ state: "waiting", limit: { kind: "iterations", initial: 10, remaining: 10 } }),
		);

		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.loop, "Loop: next prompt repeats 10/10"));
	});

	it("shows the live remaining duration while a loop is running", () => {
		const now = Date.parse("2026-07-17T12:00:00Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		const rendered = renderSegment(
			"mode",
			createContext({
				state: "running",
				limit: { kind: "duration", durationMs: 90_000, deadlineMs: now + 90_000 },
			}),
		);

		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.loop, "Loop running 1m30s left"));
	});

	it("distinguishes a paused loop from an active loop", () => {
		const rendered = renderSegment("mode", createContext({ state: "paused" }));
		const icon = theme.icon.pause || theme.icon.loop;

		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(icon, "Loop paused"));
		expect(rendered.content).toBe(theme.fg("warning", withIcon(icon, "Loop paused")));
	});

	it("shows the gating condition alongside the remaining iterations", () => {
		const rendered = renderSegment(
			"mode",
			createContext({
				state: "running",
				limit: { kind: "iterations", initial: 3, remaining: 3 },
				condition: { command: "bun test", until: true },
			}),
		);

		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.loop, "Loop running 3/3 until: bun test"));
	});

	// The command is arbitrary user input; an unbounded one would push every
	// other segment off the status line.
	it("bounds a long condition command", () => {
		const rendered = renderSegment(
			"mode",
			createContext({
				state: "running",
				condition: { command: `bun test ${"x".repeat(200)}`, until: false },
			}),
		);
		const content = Bun.stripANSI(rendered.content);

		expect(content.startsWith(withIcon(theme.icon.loop, "Loop running while: bun test x"))).toBe(true);
		expect(content.length).toBeLessThan(60);
	});

	const NEXT_RUN_AT = Date.parse("2026-07-17T10:21:00Z");
	const nextClock = new Date(NEXT_RUN_AT).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	const renderText = (loop: SegmentContext["loopMode"]) =>
		Bun.stripANSI(renderSegment("mode", createContext(loop)).content);
	const describeText = (loop: SegmentContext["loopMode"]) =>
		describeSegment("mode", createContext(loop))
			?.spans.map(s => s.t)
			.join("");

	it("shows the fixed interval and the next run time before the limit and condition", () => {
		const loop: SegmentContext["loopMode"] = {
			state: "running",
			intervalMs: 15 * 60_000,
			nextRunAt: NEXT_RUN_AT,
			limit: { kind: "iterations", initial: 3, remaining: 2 },
			condition: { command: "gh pr checks", until: true },
		};
		const expected = `Loop running every 15m next ${nextClock} 2/3 until: gh pr checks`;

		expect(renderText(loop)).toBe(withIcon(theme.icon.loop, expected));
		expect(describeText(loop)).toBe(expected);
	});

	it("hides the next run time while paused", () => {
		const loop: SegmentContext["loopMode"] = { state: "paused", intervalMs: 3_600_000, nextRunAt: NEXT_RUN_AT };

		expect(renderText(loop)).toBe(withIcon(theme.icon.pause || theme.icon.loop, "Loop paused every 1h"));
		expect(describeText(loop)).toBe("Loop paused every 1h");
	});

	it("renders a non-interval loop exactly as before", () => {
		const base: SegmentContext["loopMode"] = {
			state: "running",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
			condition: { command: "bun test", until: true },
		};
		const withUnset = { ...base, intervalMs: undefined, nextRunAt: undefined };

		expect(renderSegment("mode", createContext(withUnset)).content).toBe(
			renderSegment("mode", createContext(base)).content,
		);
		expect(describeSegment("mode", createContext(withUnset))).toEqual(describeSegment("mode", createContext(base)));
	});

	it("formats intervals as compact text that reads back to the same duration", () => {
		const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };
		const seed = 0x5eed_1007;
		let state = seed;
		const next = (max: number) => {
			state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
			return state % max;
		};
		const shapes = [
			() => (1 + next(48)) * UNIT_MS.h,
			() => (1 + next(59)) * UNIT_MS.m,
			() => (1 + next(59)) * UNIT_MS.s,
			() => (1 + next(48)) * UNIT_MS.h + (1 + next(59)) * UNIT_MS.m + (1 + next(59)) * UNIT_MS.s,
		];
		for (let i = 0; i < 400; i++) {
			const ms = shapes[i % shapes.length]();
			const text = formatLoopInterval(ms);
			let readBack = 0;
			for (const [, count, unit] of text.matchAll(/(\d+)([hms])/g)) readBack += Number(count) * UNIT_MS[unit];
			const ok = /^(\d+h)?(\d+m)?(\d+s)?$/.test(text) && readBack === ms;
			if (!ok) throw new Error(`seed=${seed} i=${i} ms=${ms} text=${text} readBack=${readBack}`);
		}
	});
});
