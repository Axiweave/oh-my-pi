import { beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function createContext(ideSelection: SegmentContext["ideSelection"]): SegmentContext {
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
		activeMs: 0,
		turnElapsedMs: null,
		activeRepo: null,
		git: { branch: null, status: null, pr: null },
		worktree: null,
		usage: null,
	};
}

describe("ide_selection status line segment", () => {
	it("renders basename with a single line number for a single-line selection", () => {
		const rendered = renderSegment(
			"ide_selection",
			createContext({ lineStart: 42, lineEnd: 42, text: "x", filePath: "/a/b/foo.el" }),
		);
		expect(rendered.visible).toBe(true);
		const stripped = Bun.stripANSI(rendered.content);
		expect(stripped).toBe(`${theme.icon.file} ${path.basename("/a/b/foo.el")}:42`);
	});

	it("renders a line range for a multi-line selection", () => {
		const rendered = renderSegment(
			"ide_selection",
			createContext({ lineStart: 10, lineEnd: 13, text: "x", filePath: "/a/b/foo.ts" }),
		);
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toContain("foo.ts:10-13");
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
});
