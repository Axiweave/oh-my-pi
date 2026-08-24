import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import type { Component } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

/**
 * Behavioral tests for `Composer#renderFrame`'s `pinBottom` preference: the
 * composer group (editor + status, standing in for `Footer` here) must
 * occupy the last viewport row even when the transcript above it is shorter
 * than the terminal, with blank filler rows absorbing the slack. Without the
 * pin the provider returns the shorter, unpadded frame (legacy behavior);
 * the terminal writer anchors it, not the provider.
 */

/** Live transcript block: never finalizes, so it never retires to history. */
class Block implements Component {
	#rows: string[];
	constructor(rows: string[]) {
		this.#rows = rows;
	}
	isTranscriptBlockFinalized(): boolean {
		return false;
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

function makeComposer(pinBottom: boolean): Composer {
	const terminal = new VirtualTerminal(40, 8, 1_000);
	const composer = new Composer({ terminal, preferences: { ...COMPOSER_DEFAULTS, quiet: true, pinBottom } });
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

		// 6 rows of history already anchored: only 2 rows remain for the live
		// tail (transcript row + footer) — no filler must be inserted, and the
		// returned viewport must never claim more than the 2 remaining rows.
		const plan = composer.renderFrame({ columns: 40, rows: 8, historyRows: 6 });
		expect(plan.viewport).toEqual(["line-a", "> prompt"]);
	});
});
