import { describe, expect, it } from "bun:test";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";

const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, "");
const hasLine = (lines: readonly string[], n: number): boolean =>
	new RegExp(`\\bline ${n}\\b`).test(stripAnsi(lines.join("\n")));

/**
 * Parse the rendered collapsed preview back into the window it drew: the gutter
 * numbers it showed and the hidden count it claimed.
 *
 * The window is budgeted in *on-screen rows* (viewport-derived, chrome
 * inclusive), not in logical lines, so a test cannot restate its size without
 * simply reimplementing the formatter. Asserting the rendered window against
 * the payload keeps the real contract: contiguous numbering, a tail anchored on
 * the newest line, and a hidden count that accounts for every line not shown.
 */
function renderedWindow(rendered: readonly string[]): { numbers: number[]; hidden: number } {
	const text = stripAnsi(rendered.join("\n"));
	const numbers: number[] = [];
	for (const row of text.split("\n")) {
		const gutter = /^\s*│\s*(\d+) /.exec(row);
		if (gutter) numbers.push(Number(gutter[1]));
	}
	const marker = /… \((\d+) earlier lines?\)/.exec(text);
	return { numbers, hidden: marker ? Number(marker[1]) : 0 };
}

describe("write streaming preview incremental line tracking", () => {
	let initialized = false;

	async function getUiTheme() {
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		return uiTheme;
	}

	function renderCollapsed(content: string, options: { expanded: boolean; isPartial: boolean; spinnerFrame: number }) {
		return getUiTheme().then(uiTheme => {
			const component = writeToolRenderer.renderCall({ path: "/tmp/inc.ts", content }, options, uiTheme);
			if (!component) throw new Error("expected a rendered component for a non-xdev write path");
			return component.render(120);
		});
	}

	it("tracks an append-only stream through one shared render-state object", async () => {
		// The reveal loop rebuilds via renderCall once per tick with the SAME
		// persistent options object; simulate growth 5 → 12 → 13 → 25 → 40 lines.
		// The incremental line index must keep gutter numbers absolute across every
		// tick, so a stale index shows up as a shifted or discontiguous window.
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const allLines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);

		for (const count of [5, 12, 13, 25, 40]) {
			const content = allLines.slice(0, count).join("\n");
			const rendered = await renderCollapsed(content, options);
			const { numbers, hidden } = renderedWindow(rendered);
			// Tail anchored on the newest line, contiguous, and every line not shown
			// is accounted for by the marker.
			expect(numbers.at(-1)).toBe(count);
			expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => numbers[0]! + i));
			expect(hidden).toBe(count - numbers.length);
			expect(numbers[0]).toBe(hidden + 1);
			for (const lineNum of numbers) expect(hasLine(rendered, lineNum)).toBe(true);
			if (hidden > 0) expect(hasLine(rendered, hidden)).toBe(false);
		}
	});

	it("windows the tail across a size battery", async () => {
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		for (const count of [1, 2, 3, 11, 12, 13, 40, 41]) {
			const content = Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
			const rendered = await renderCollapsed(content, options);
			const text = stripAnsi(rendered.join("\n"));
			const { numbers, hidden } = renderedWindow(rendered);
			expect(numbers.at(-1)).toBe(count);
			expect(hidden).toBe(count - numbers.length);
			// Each shown gutter number carries its own line's text.
			for (const lineNum of numbers) expect(text).toContain(`${lineNum} line ${lineNum}`);
			if (hidden > 0) expect(text).toContain(`… (${hidden} earlier line${hidden === 1 ? "" : "s"})`);
			else expect(text).not.toContain("earlier line");
		}
	});

	it("does not compare the full accumulated payload when validating append-only growth", async () => {
		const uiTheme = await getUiTheme();
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const first = Array.from({ length: 2_000 }, () => "x".repeat(64)).join("\n");
		writeToolRenderer.renderCall({ path: "/tmp/inc.ts", content: first }, options, uiTheme)?.render(120);

		const originalStartsWith = String.prototype.startsWith;
		let wholePrefixComparisons = 0;
		String.prototype.startsWith = function (this: string, searchString: string, position?: number): boolean {
			if (searchString === first) wholePrefixComparisons++;
			return originalStartsWith.call(this, searchString, position);
		};
		try {
			writeToolRenderer
				.renderCall({ path: "/tmp/inc.ts", content: `${first}\nlast` }, options, uiTheme)
				?.render(120);
		} finally {
			String.prototype.startsWith = originalStartsWith;
		}

		expect(wholePrefixComparisons).toBe(0);
	});

	it("normalizes CRLF only in the rendered tail, with correct line numbers", async () => {
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\r\n");
		const rendered = await renderCollapsed(content, options);
		const text = stripAnsi(rendered.join("\n"));
		const { numbers, hidden } = renderedWindow(rendered);
		expect(text).not.toContain("\r");
		expect(numbers.at(-1)).toBe(20);
		expect(hidden).toBe(20 - numbers.length);
		expect(hasLine(rendered, hidden)).toBe(false);
		expect(hasLine(rendered, hidden + 1)).toBe(true);
	});

	// The file-ending newline is dropped from the window: it is not a line the
	// user wrote, and spending the tail's last slot on it once left the window
	// holding nothing but that empty line — collapsing the frame to its borders
	// on exactly the ticks where content ended on a newline.
	it("spends the window on real lines, not the file-ending newline", async () => {
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const content = `${Array.from({ length: 13 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
		const rendered = await renderCollapsed(content, options);
		const { numbers, hidden } = renderedWindow(rendered);
		expect(numbers.at(-1)).toBe(13);
		expect(hidden).toBe(13 - numbers.length);
		expect(hasLine(rendered, 13)).toBe(true);
	});

	it("renders carriage-return-only content like the previous normalized empty payload", async () => {
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const empty = await renderCollapsed("", options);
		const carriageReturns = await renderCollapsed("\r\r", {
			expanded: false,
			isPartial: true,
			spinnerFrame: 0,
		});
		expect(carriageReturns).toEqual(empty);
	});

	it("resets cleanly when a restarted stream is longer but not append-only", async () => {
		// A restarted stream can reuse the component render state with a longer
		// replacement buffer; the bounded suffix guard must reset the index.
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const first = "alpha 1\nalpha 2";
		await renderCollapsed(first, options);

		const restarted = `beta ${"x".repeat(100)}\nbeta 2`;
		const rendered = await renderCollapsed(restarted, options);
		const text = stripAnsi(rendered.join("\n"));
		expect(text).not.toContain("earlier line");
		expect(text).toContain("beta");
		expect(text).not.toContain("alpha");
	});

	it("resumes append tracking across a CR boundary without miscounting", async () => {
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const part1 = "line 1\r\nline 2\r";
		const part2 = "line 1\r\nline 2\r\nline 3\r\nline 4";
		await renderCollapsed(part1, options);
		const rendered = await renderCollapsed(part2, options);
		expect(renderedWindow(rendered).numbers).toEqual([1, 2, 3, 4]);
		expect(hasLine(rendered, 4)).toBe(true);
		expect(hasLine(rendered, 1)).toBe(true);
		expect(stripAnsi(rendered.join("\n"))).not.toContain("earlier line");
	});
});
