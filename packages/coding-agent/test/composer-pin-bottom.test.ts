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

	const budgetCases = [
		{ rows: 8, historyTop: 0, transcript: 1, chrome: 1 },
		{ rows: 8, historyTop: 3, transcript: 2, chrome: 1 },
		{ rows: 8, historyTop: 3, transcript: 2, chrome: 6 },
		{ rows: 8, historyTop: 7, transcript: 3, chrome: 2 },
		{ rows: 8, historyTop: 8, transcript: 2, chrome: 1 },
		{ rows: 8, historyTop: 11, transcript: 2, chrome: 1 },
		{ rows: 25, historyTop: 0, transcript: 0, chrome: 7 },
		{ rows: 25, historyTop: 4, transcript: 40, chrome: 7 },
		{ rows: 12, historyTop: 2, transcript: 5, chrome: 0 },
	];

	it("keeps every pinned frame inside the writer's anchor budget", () => {
		// The writer anchors `historyRows` rows above the viewport and writes the
		// frame below them, so the frame may never claim more than the rows that
		// are left. Two paths used to overshoot by exactly the difference between
		// their budget and the real one: the filler was measured against the
		// retirement floor — a session-long minimum that the live chrome outgrows
		// for the rest of the run — and the composed tail was clipped against the
		// full screen height. Each overshoot writes past the screen bottom, so
		// every render scrolls the oldest live row into native scrollback.
		for (const { rows, historyTop, transcript, chrome } of budgetCases) {
			const label = `rows=${rows} history=${historyTop} transcript=${transcript} chrome=${chrome}`;
			const budget = Math.max(0, rows - historyTop);
			const composer = makeComposer(true);
			const chat = new TranscriptContainer();
			if (transcript > 0) {
				chat.addChild(new Block(Array.from({ length: transcript }, (_, i) => `row-${i}`)));
			}
			const chromeRows = Array.from({ length: chrome }, (_, i) => `chrome-${i}`);
			composer.setRuntimeChildren([chat, new Footer(chromeRows)]);

			// A frame painted before the chrome settles captures the floor; the
			// chrome then grows, which must not raise the frame's claim.
			composer.renderFrame({ columns: 40, rows, historyRows: historyTop });
			composer.setRuntimeChildren([chat, new Footer([...chromeRows, "chrome-extra"])]);
			const plan = composer.renderFrame({ columns: 40, rows, historyRows: historyTop });

			expect(plan.viewport.length, label).toBeLessThanOrEqual(budget);
			// Newest rows win and the chrome's last row keeps the bottom edge: the
			// pin survives every budget, including one the chrome alone exhausts.
			if (chrome > 0 && budget > 0) {
				expect(plan.viewport.at(-1), label).toBe("chrome-extra");
			}
			// The overflow clips rows; it must never paint one twice.
			const painted = plan.viewport.filter(row => row.trim().length > 0);
			expect(new Set(painted).size, label).toBe(painted.length);
			// Filler is only allowed to occupy rows the content cannot use: a live
			// row dropped while filler sits in the frame leaves its previous paint
			// on screen, since the frame no longer covers that row.
			const content = plan.viewport.filter(row => row.startsWith("row-") || row.startsWith("chrome-")).length;
			expect(content, label).toBe(Math.min(transcript + chromeRows.length + 1, budget));
			// A larger budget never shows fewer rows.
			const wider = composer.renderFrame({ columns: 40, rows: rows + 4, historyRows: historyTop });
			expect(wider.viewport.length, label).toBeGreaterThanOrEqual(plan.viewport.length);
			// With the pin on and nothing to retire, the tail fills whatever the
			// writer left, so the composer group stays glued to the screen bottom
			// instead of floating. A frame that offers history is the exception:
			// its geometry describes the anchor before that batch is appended.
			if (plan.history === undefined) expect(plan.viewport.length, label).toBe(budget);
		}
	});
});
