import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function createContext(
	ideSelection: SegmentContext["ideSelection"],
	ideFile: SegmentContext["ideFile"] = null,
): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
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
		speculationBlinkOn: false,
		subagentCount: 0,
		ideSelection,
		ideFile,
		activeMs: 0,
		turnElapsedMs: null,
		activeRepo: null,
		git: { branch: null, status: null, pr: null },
		worktree: null,
		usage: null,
	};
}

describe("ide_selection status line segment", () => {
	it("renders '1 line selected' for a single-line selection", () => {
		const rendered = renderSegment(
			"ide_selection",
			createContext({ lineStart: 42, lineEnd: 42, text: "x", filePath: "/a/b/foo.el" }),
		);
		expect(rendered.visible).toBe(true);
		const stripped = Bun.stripANSI(rendered.content);
		expect(stripped).toBe(`${theme.icon.file} 1 line selected`);
	});

	it("renders 'N lines selected' for a multi-line selection", () => {
		const rendered = renderSegment(
			"ide_selection",
			createContext({ lineStart: 10, lineEnd: 13, text: "x", filePath: "/a/b/foo.ts" }),
		);
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe(`${theme.icon.file} 4 lines selected`);
	});

	it("is invisible when there is no selection", () => {
		const rendered = renderSegment("ide_selection", createContext(null));
		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("is invisible when the selection has no file path", () => {
		const rendered = renderSegment(
			"ide_selection",
			createContext({ lineStart: 1, lineEnd: 2, text: "x", filePath: "" }),
		);
		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("renders 'In <file>' when there is no selection but a current file is known", () => {
		const rendered = renderSegment("ide_selection", createContext(null, "/a/b/foo.el"));
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe(`${theme.icon.file} In foo.el`);
	});

	it("is invisible when there is no selection and no current file", () => {
		const rendered = renderSegment("ide_selection", createContext(null, null));
		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});
});
