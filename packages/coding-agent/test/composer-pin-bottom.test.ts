import { afterEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { CollapsedSyntheticMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import type { Component } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

/**
 * Behavioral tests for `Composer#renderFrame`'s `pinBottom` preference: the
 * composer group (editor + status, standing in for `Footer` here) must
 * occupy the last viewport row even when the transcript above it is shorter
 * than the terminal, with blank filler rows absorbing the slack. Without the
 * pin the provider returns the shorter, unpadded frame (legacy behavior);
 * the terminal writer anchors it, not the provider.
 */

/** Mutable rows used to exercise transcript growth and retirement. */
class Block implements Component {
	#rows: string[];
	constructor(
		rows: string[],
		private readonly finalized = false,
	) {
		this.#rows = rows;
	}
	isTranscriptBlockFinalized(): boolean {
		return this.finalized;
	}
	render(): readonly string[] {
		return this.#rows;
	}
}

/** Ref-stable footer standing in for the editor + status group. */
class Footer implements Component {
	constructor(private readonly lines: string[]) {}
	render(): readonly string[] {
		return this.lines;
	}
}

const composers: Composer[] = [];
afterEach(() => {
	for (const composer of composers) composer.stop();
	composers.length = 0;
});

function makeComposer(pinBottom: boolean): Composer {
	const terminal = new VirtualTerminal(40, 8, 1_000);
	const composer = new Composer({ terminal, preferences: { ...COMPOSER_DEFAULTS, quiet: true, pinBottom } });
	composers.push(composer);
	composer.start({ playWelcomeIntro: false });
	return composer;
}

describe("Composer#renderFrame pinBottom", () => {
	it("pads the transcript with blank rows so the footer lands on the last row", () => {
		const composer = makeComposer(true);
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["line-a", "line-b", "line-c"]));
		composer.setRuntimeChildren([transcript, new Footer(["> prompt"])]);

		const plan = composer.renderFrame({ columns: 40, rows: 8 });
		expect(plan.viewport).toEqual(["line-a", "line-b", "line-c", "", "", "", "", "> prompt"]);
	});

	it("inserts no filler when the transcript already fills the viewport", () => {
		const composer = makeComposer(true);
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["a", "b", "c", "d", "e", "f", "g"]));
		composer.setRuntimeChildren([transcript, new Footer(["> prompt"])]);

		const plan = composer.renderFrame({ columns: 40, rows: 8 });
		expect(plan.viewport).toEqual(["a", "b", "c", "d", "e", "f", "g", "> prompt"]);
	});

	it("stays unpadded with pinBottom disabled (legacy behavior)", () => {
		const composer = makeComposer(false);
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["line-a", "line-b", "line-c"]));
		composer.setRuntimeChildren([transcript, new Footer(["> prompt"])]);

		const plan = composer.renderFrame({ columns: 40, rows: 8 });
		expect(plan.viewport).toEqual(["line-a", "line-b", "line-c", "> prompt"]);
	});

	it("resizes the filler as the transcript grows so the footer never moves", () => {
		const composer = makeComposer(true);
		const transcript = new TranscriptContainer();
		const first = new Block(["line-a", "line-b", "line-c"]);
		transcript.addChild(first);
		composer.setRuntimeChildren([transcript, new Footer(["> prompt"])]);

		expect(composer.renderFrame({ columns: 40, rows: 8 }).viewport.at(-1)).toBe("> prompt");

		transcript.removeChild(first);
		transcript.addChild(new Block(["line-a", "line-b", "line-c", "line-d", "line-e", "line-f"]));
		const grown = composer.renderFrame({ columns: 40, rows: 8 });
		expect(grown.viewport).toEqual(["line-a", "line-b", "line-c", "line-d", "line-e", "line-f", "", "> prompt"]);
	});
	it("still pins the footer after history has committed, bounded by historyRows", () => {
		// Regression for the composer floating up once tool output collapses
		// and a batch retires to native scrollback: the writer reports how
		// many rows it already anchored above the viewport via
		// `viewport.historyRows`, and padding must respect that budget instead
		// of shutting off entirely the first time anything commits.
		const composer = makeComposer(true);
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["line-a", "line-b"]));
		composer.setRuntimeChildren([transcript, new Footer(["> prompt"])]);

		// 3 rows already anchored as history above this 8-row viewport: only 5
		// rows remain, so the footer lands on row 5 (index 4), not row 8.
		const plan = composer.renderFrame({ columns: 40, rows: 8, historyRows: 3 });
		expect(plan.viewport).toEqual(["line-a", "line-b", "", "", "> prompt"]);
	});

	it("never pads past the remaining budget once history nearly fills the screen", () => {
		const composer = makeComposer(true);
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["line-a"]));
		composer.setRuntimeChildren([transcript, new Footer(["> prompt"])]);

		// Content fits below the visible history, so no filler is needed.
		const plan = composer.renderFrame({ columns: 40, rows: 8, historyRows: 6 });
		expect(plan.viewport).toEqual(["line-a", "> prompt"]);
	});

	it.each([false, true])("keeps growing live content and chrome visible with pinBottom=%s", async pinBottom => {
		// Conservation: moving committed history must not lose or duplicate live rows.
		const terminal = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { quiet: true, pinBottom },
		});
		composers.push(composer);
		const transcript = new TranscriptContainer();
		const committed = Array.from({ length: 20 }, (_, i) => `COMMITTED_${i}`);
		transcript.addChild(new Block(committed, true));
		const live = ["READ_OLD"];
		const chrome = ["EDITOR"];
		transcript.addChild(new Block(live));
		composer.setRuntimeChildren([transcript, new Footer(chrome)]);
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);

		const states = [
			{ live: Array.from({ length: 4 }, (_, i) => `READ_${i}`), chrome: ["EDITOR"] },
			{ live: Array.from({ length: 4 }, (_, i) => `READ_${i}`), chrome: ["TODO", "TODO_DONE", "EDITOR", "STATUS"] },
			{ live: ["READ_UPDATED"], chrome: ["EDITOR"] },
			{ live: [], chrome: ["EDITOR"] },
		];
		for (const state of states) {
			live.splice(0, live.length, ...state.live);
			chrome.splice(0, chrome.length, ...state.chrome);
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			const buffer = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			expect(buffer.filter(row => row.startsWith("COMMITTED_"))).toEqual(committed);
			expect(buffer.filter(row => /^(READ_|TODO|EDITOR|STATUS)/.test(row))).toEqual([
				...state.live,
				...state.chrome,
			]);
			const scrollback = buffer.slice(0, terminal.getBufferPosition().baseY);
			expect(scrollback.some(row => /^(READ_|TODO|EDITOR|STATUS)/.test(row))).toBe(false);
			if (pinBottom) expect(terminal.getViewport().at(-1)?.trimEnd()).toBe(state.chrome.at(-1));
		}
	});

	it.each([false, true])(
		"preserves command and tool rows during output after HUD growth with pinBottom=%s",
		async pinBottom => {
			// Conservation: every settled row stays exactly once in the viewport or native scrollback.
			const terminal = new VirtualTerminal(90, 24, 1_000);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { quiet: true, pinBottom },
			});
			composers.push(composer);
			const transcript = new TranscriptContainer();
			const committed = Array.from({ length: 40 }, (_, i) => `COMMITTED_${i}`);
			transcript.addChild(new Block(committed, true));
			const chrome = ["EDITOR"];
			composer.setRuntimeChildren([transcript, new Footer(chrome)]);
			composer.start({ playWelcomeIntro: false });
			await scheduler.settle(terminal);
			transcript.addChild(new CollapsedSyntheticMessageComponent("task prompt", undefined, "/speckit.tasks", true));
			const toolRows = ["READ .specify/extensions.yml", ...Array.from({ length: 8 }, (_, i) => `BASH_OUTPUT_${i}`)];
			transcript.addChild(new Block(toolRows, true));
			chrome.unshift("TODO", "TASK_1", "TASK_2", "TASK_3", "WORKING");
			const assistant = new AssistantMessageComponent();
			transcript.addChild(assistant);
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			};
			for (let count = 0; count <= 6; count++) {
				const text = Array.from({ length: count }, (_, i) => `ASSISTANT_OUTPUT_${i}`).join("\n\n");
				assistant.updateContent({ ...message, content: [{ type: "text", text }] }, { transient: true });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				const buffer = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
				expect(buffer.filter(row => row.includes("/speckit.tasks"))).toHaveLength(2);
				expect(buffer.filter(row => /^(COMMITTED_|READ |BASH_OUTPUT_)/.test(row))).toEqual([
					...committed,
					...toolRows,
				]);
			}
			chrome.splice(0, chrome.length, "EDITOR");
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			const buffer = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			expect(buffer.filter(row => row.includes("/speckit.tasks"))).toHaveLength(2);
			expect(buffer.filter(row => /^(COMMITTED_|READ |BASH_OUTPUT_)/.test(row))).toEqual([
				...committed,
				...toolRows,
			]);
			expect(buffer.some(row => /^(TODO|TASK_|WORKING)/.test(row))).toBe(false);
			if (pinBottom) expect(terminal.getViewport().at(-1)?.trimEnd()).toBe("EDITOR");
		},
	);

	it("does not scroll repeatedly after the status grows", async () => {
		const terminal = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { quiet: true, pinBottom: true },
		});
		composers.push(composer);
		const transcript = new TranscriptContainer();
		transcript.addChild(
			new Block(
				Array.from({ length: 20 }, (_, i) => `COMMITTED_${i}`),
				true,
			),
		);
		transcript.addChild(new Block(["READ"]));
		const chrome = ["EDITOR"];
		composer.setRuntimeChildren([transcript, new Footer(chrome)]);
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);
		chrome.push("STATUS");
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		const settledBase = terminal.getBufferPosition().baseY;
		for (const draft of ["a", "ab", "abc", ""]) {
			chrome[0] = `EDITOR ${draft}`;
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(terminal.getBufferPosition().baseY).toBe(settledBase);
			expect(
				terminal
					.getViewport()
					.slice(-3)
					.map(row => row.trimEnd()),
			).toEqual(["READ", `EDITOR ${draft}`.trimEnd(), "STATUS"]);
		}
	});
});
