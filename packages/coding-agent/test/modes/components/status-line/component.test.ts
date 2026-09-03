import { beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createGallerySegmentContext } from "../../../../src/cli/gallery-fixtures/segments";
import { Settings, settings } from "../../../../src/config/settings";
import { clearIdeSelection, subscribeIdeSelection } from "../../../../src/mcp/ide-selection";
import type { MCPManager } from "../../../../src/mcp/manager";
import { StatusLineComponent } from "../../../../src/modes/components/status-line/component";
import { renderSegment } from "../../../../src/modes/components/status-line/segments";
import { loadTheme } from "../../../../src/modes/theme/loader";
import { getThemeByName, setThemeInstance, theme } from "../../../../src/modes/theme/theme";
import type { AgentSession } from "../../../../src/session/agent-session";

/** Minimal stand-in for MCPManager that captures the registered listener. */
function fakeIdeManager(): { manager: MCPManager; fire: (server: string, method: string, params: unknown) => void } {
	let listener: ((server: string, method: string, params: unknown) => void) | undefined;
	const manager = {
		addNotificationListener: (fn: (server: string, method: string, params: unknown) => void) => {
			listener = fn;
			return () => {
				listener = undefined;
			};
		},
	} as unknown as MCPManager;
	return { manager, fire: (server, method, params) => listener?.(server, method, params) };
}

// The cost assertions below care about how the two costs are rendered, not about
// terminal width. The status line also shows the cwd and git branch, so a long
// checkout path or branch name eats the budget and pushes the cost segment out
// at a realistic 120 columns. Render these two cases wide enough that the
// segment always fits, and let the width-sensitive behavior stay covered by the
// truncation tests that target it directly.
const WIDE_ENOUGH_FOR_COST_SEGMENT = 400;

function makeSessionWithLastMessage(
	lastMessage: unknown,
	prewalkArmed: boolean = false,
	{
		cost = 0,
		advisorCost = 0,
		usingSubscription = false,
		advisorUsingSubscription = false,
		modelName,
		sessionName = "test-session",
	}: {
		cost?: number;
		advisorCost?: number;
		usingSubscription?: boolean;
		advisorUsingSubscription?: boolean;
		modelName?: string;
		sessionName?: string;
	} = {},
) {
	return {
		messages: lastMessage ? [lastMessage] : [],
		model: { id: modelName ?? "test-model", name: modelName, contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 42, contextWindow: 128000 }),
		state: {
			messages: lastMessage ? [lastMessage] : [],
			model: { id: modelName ?? "test-model", name: modelName, contextWindow: 128000 },
		},
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost,
				tokensPerSecond: null,
			}),
			getSessionName: () => sessionName,
		},
		getPrewalkState: () => (prewalkArmed ? { target: { id: "cheap-model", provider: "openai" } } : undefined),
		getAsyncJobSnapshot: () => undefined,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({
			configured: advisorCost > 0,
			advisors: advisorCost > 0 ? [{ name: "test", status: "running" as const }] : [],
		}),
		getAdvisorCost: () => advisorCost,
		isAdvisorUsingSubscription: () => advisorUsingSubscription,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: {
			isUsingOAuth: () => usingSubscription,
		},
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("StatusLineComponent", () => {
	it("fingerprints tool-call arguments containing bigint values", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage({
				role: "assistant",
				timestamp: 1,
				content: [
					{
						type: "toolCall",
						name: "read",
						arguments: { offset: 1n, nested: { limit: 2n } },
					},
				],
			}) as unknown as AgentSession,
		);

		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 42, contextWindow: 128000 });
	});

	it("renders Prewalk annotation when prewalk is armed", () => {
		const statusLine = new StatusLineComponent(makeSessionWithLastMessage(null, true) as unknown as AgentSession);

		// By default preset, 'mode' segment is included in left/right segments.
		// Let's get the border and see if Prewalk is rendered.
		const border = statusLine.getTopBorder(100);
		// SGR codes might be included, so we check if the stripped content contains "Prewalk"
		const stripped = border.content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("Prewalk");
	});

	it("renders the claude 3-line footer with model, git/cwd, and hints", () => {
		const statusLine = new StatusLineComponent(makeSessionWithLastMessage(null) as unknown as AgentSession);
		statusLine.setComposerStyle({
			statusAttachment: "none",
			bottomBar: "full",
			bottomBarGap: false,
			footerMode: "claude3",
		});
		statusLine.setHookStatus("advisor", "advisor running");

		const lines = statusLine.render(200);
		const stripped = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));

		expect(lines.length).toBe(3);
		expect(stripped[0]).toContain("test-model");
		expect(stripped[1]).toContain(path.basename(process.cwd()));
		expect(stripped[2]).toContain("advisor running");
	});
	it("keeps the claude footer model on the theme model color", () => {
		const statusLine = new StatusLineComponent(makeSessionWithLastMessage(null) as unknown as AgentSession);
		statusLine.setComposerStyle({
			statusAttachment: "none",
			bottomBar: "full",
			bottomBarGap: false,
			footerMode: "claude3",
		});

		const [modelLine] = statusLine.render(200);
		expect(modelLine).toContain(`${theme.getFgAnsi("statusLineModel")}${theme.icon.model} test-model`);
	});

	it("omits the claude footer hints row when no hints are active", () => {
		const statusLine = new StatusLineComponent(makeSessionWithLastMessage(null) as unknown as AgentSession);
		statusLine.setComposerStyle({
			statusAttachment: "none",
			bottomBar: "full",
			bottomBarGap: false,
			footerMode: "claude3",
		});

		const lines = statusLine.render(200);
		expect(lines.length).toBe(2); // model + git/cwd only
	});

	it("renders the claude footer for any shape when composerStyle.footerMode is claude3", () => {
		settings.override("composerStyle.footerMode", "claude3");
		try {
			const statusLine = new StatusLineComponent(makeSessionWithLastMessage(null) as unknown as AgentSession);
			// No footerMode on the style — the config override forces the footer.
			statusLine.setComposerStyle({ statusAttachment: "none", bottomBar: "full", bottomBarGap: false });
			statusLine.setHookStatus("advisor", "advisor running");

			const lines = statusLine.render(200);
			const stripped = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));

			expect(lines.length).toBe(3);
			expect(stripped[0]).toContain("test-model");
			expect(stripped[1]).toContain(path.basename(process.cwd()));
			expect(stripped[2]).toContain("advisor running");
		} finally {
			settings.clearOverride("composerStyle.footerMode");
		}
	});

	it("right-aligns the open IDE file on the claude footer's model line", () => {
		const { manager, fire } = fakeIdeManager();
		const unsubscribe = subscribeIdeSelection(manager);
		try {
			fire("ide", "selection_changed", { filePath: "/a/b/foo.ts", selection: { isEmpty: true } });

			const statusLine = new StatusLineComponent(makeSessionWithLastMessage(null) as unknown as AgentSession);
			statusLine.setComposerStyle({
				statusAttachment: "none",
				bottomBar: "full",
				bottomBarGap: false,
				footerMode: "claude3",
			});

			const lines = statusLine.render(200);
			const stripped = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));

			expect(stripped[0]).toContain("test-model");
			expect(stripped[0]).toContain("In foo.ts");
			// hfill: the file marker sits well to the right of the model, separated by a gap.
			expect(stripped[0].indexOf("In foo.ts")).toBeGreaterThan(stripped[0].indexOf("test-model") + 10);
		} finally {
			unsubscribe();
			clearIdeSelection();
		}
	});

	it("renders startup placeholders without values from the prior session", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, false, {
				cost: 2.67,
				modelName: "Stale Model",
				sessionName: "stale-session",
			}) as unknown as AgentSession,
		);

		const live = Bun.stripANSI(statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content);
		expect(live).toContain("Stale Model");
		expect(live).toContain("stale-session");
		expect(live).toContain("2.67");

		const placeholder = Bun.stripANSI(statusLine.renderStartupPlaceholder(WIDE_ENOUGH_FOR_COST_SEGMENT, "box"));
		expect(placeholder.match(/…/g)?.length).toBeGreaterThanOrEqual(3);
		expect(placeholder).toContain(`${theme.icon.model} …`);
		expect(placeholder).toContain(`${theme.icon.folder} …`);
		expect(placeholder).toContain("$…");
		expect(placeholder).not.toContain("Stale Model");
		expect(placeholder).not.toContain("stale-session");
		expect(placeholder).not.toContain("2.67");
	});

	it("preserves segment icons and colors while masking their values", () => {
		const ctx = {
			...createGallerySegmentContext(),
			sessionAccent: false,
			startupPlaceholder: true,
		};
		const model = renderSegment("model", ctx);
		const path = renderSegment("path", ctx);
		const git = renderSegment("git", ctx);
		const text = Bun.stripANSI([model.content, path.content, git.content].join(" "));

		expect(text).toContain(`${theme.icon.model} …`);
		expect(text).toContain(`${theme.icon.folder} …`);
		expect(text).toContain(`${theme.icon.branch} …`);
		expect(text).toContain("*…");
		expect(text).toContain("+…");
		expect(text).toContain("?…");
		expect(text).not.toContain("Sonnet 4.5");
		expect(text).not.toContain("/workspace/oh-my-pi");
		expect(text).not.toContain("gallery/reference");
		expect(model.content).toContain(theme.getFgAnsi("statusLineModel"));
		expect(path.content).toContain(theme.getFgAnsi("statusLinePath"));
		expect(git.content).toContain(theme.getFgAnsi("statusLineGitDirty"));
	});
	it("renders primary and advisor costs separately with subscription indicator in Unicode preset", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, false, {
				cost: 2.67,
				advisorCost: 0.41,
				usingSubscription: true,
			}) as unknown as AgentSession,
		);

		const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("S2.67 + 👁 $0.41");
	});

	it("renders advisor cost with subscription prefix when advisor is on subscription in Unicode preset", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, false, {
				cost: 2.67,
				advisorCost: 0.41,
				usingSubscription: true,
				advisorUsingSubscription: true,
			}) as unknown as AgentSession,
		);

		const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("S2.67 + 👁 S0.41");
	});

	it("renders ASCII preset fallback with (adv) for advisor costs", async () => {
		const baseTheme = await getThemeByName("dark");
		if (!baseTheme) throw new Error("theme unavailable");
		const asciiTheme = await loadTheme("dark", { symbolPresetOverride: "ascii" });
		setThemeInstance(asciiTheme);
		try {
			const statusLine = new StatusLineComponent(
				makeSessionWithLastMessage(null, false, {
					cost: 2.67,
					advisorCost: 0.41,
					usingSubscription: true,
					advisorUsingSubscription: true,
				}) as unknown as AgentSession,
			);
			const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
			expect(stripped).toContain("S2.67 + S0.41 (adv)");
		} finally {
			setThemeInstance(baseTheme);
		}
	});

	it("omits advisor cost when the advisor has never been active", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null, false, {
				cost: 2.67,
				usingSubscription: true,
			}) as unknown as AgentSession,
		);

		const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("S2.67");
		expect(stripped).not.toContain("(adv)");
	});

	it("renders Nerd Font symbols for subscription and advisor costs", async () => {
		const baseTheme = await getThemeByName("dark");
		if (!baseTheme) throw new Error("theme unavailable");
		const nerdTheme = await loadTheme("dark", { symbolPresetOverride: "nerd" });
		setThemeInstance(nerdTheme);
		try {
			const statusLine = new StatusLineComponent(
				makeSessionWithLastMessage(null, false, {
					cost: 2.67,
					advisorCost: 0.41,
					usingSubscription: true,
					advisorUsingSubscription: true,
				}) as unknown as AgentSession,
			);
			const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
			expect(stripped).toContain("\u{f067a} 2.67 + \uea70 \u{f067a} 0.41");
		} finally {
			setThemeInstance(baseTheme);
		}
	});
});
