import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { SegmentContext } from "../src/status-line/segments";
import { describeSegment, renderSegment } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createContext(over: Partial<SegmentContext> = {}): SegmentContext {
	return {
		session: {} as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		masterMode: null,
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
		...over,
	};
}

const withIcon = (icon: string, text: string) => (icon ? `${icon} ${text}` : text);
const masterLabel = () => withIcon(theme.icon.agents, "Master");
const text = (over: Partial<SegmentContext>) => Bun.stripANSI(renderSegment("mode", createContext(over)).content);
const described = (over: Partial<SegmentContext>) =>
	describeSegment("mode", createContext(over))
		?.spans.map(s => s.t)
		.join("");

describe("status line master mode segment", () => {
	it("shows alone", () => {
		expect(text({ masterMode: { enabled: true } })).toBe(masterLabel());
		expect(described({ masterMode: { enabled: true } })).toBe("Master");
	});

	it("shows after the goal label", () => {
		const session = { getGoalModeState: () => undefined } as unknown as SegmentContext["session"];
		const over = { session, goalMode: { enabled: true, paused: false }, masterMode: { enabled: true } };
		expect(text(over).endsWith(` ${masterLabel()}`)).toBe(true);
		expect(text(over).startsWith(masterLabel())).toBe(false);
		expect(described(over)?.endsWith(" Master")).toBe(true);
	});

	it("shows after the loop label", () => {
		const loopMode = { state: "waiting", limit: { kind: "iterations", initial: 3, remaining: 3 } } as const;
		const over = { loopMode, masterMode: { enabled: true } };
		expect(text(over)).toBe(`${text({ loopMode })} ${masterLabel()}`);
		expect(described(over)).toBe(`${described({ loopMode })} Master`);
	});

	it("is hidden when null or disabled", () => {
		for (const masterMode of [null, { enabled: false }]) {
			expect(renderSegment("mode", createContext({ masterMode })).visible).toBe(false);
			expect(described({ masterMode })).toBeUndefined();
		}
	});
});
