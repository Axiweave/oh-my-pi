import { afterEach, describe, expect, it, vi } from "bun:test";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { HighlightStream } from "@oh-my-pi/pi-natives";

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

	afterEach(() => {
		vi.restoreAllMocks();
	});

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

	it("does not re-tokenize the whole markdown window as streamed content grows", async () => {
		const uiTheme = await getUiTheme();
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const highlightSpy = vi.spyOn(themeModule, "highlightCode");
		const lines = Array.from(
			{ length: 40 },
			(_, index) => `- Step ${index + 1}: update \`src/example-${index + 1}.ts\` and verify the result`,
		);

		let rendered: readonly string[] = [];
		for (let count = 1; count <= lines.length; count++) {
			const component = writeToolRenderer.renderCall(
				{ path: "/tmp/plan.md", content: lines.slice(0, count).join("\n") },
				options,
				uiTheme,
			);
			if (!component) throw new Error("expected a rendered component for a non-xdev write path");
			rendered = component.render(120);
		}

		expect(stripAnsi(rendered.join("\n"))).toContain("Step 40");
		expect(highlightSpy).not.toHaveBeenCalled();
	});

	it("resets on same-length prefix replacement above a preserved tail", async () => {
		// A restarted stream can reuse the render state with a replacement that
		// preserves more tail than any bounded suffix guard could validate, so
		// only an exact append check may treat growth as incremental.
		const uiTheme = await getUiTheme();
		const options = { expanded: true, isPartial: true, spinnerFrame: 0 };
		const render = (content: string) => {
			const component = writeToolRenderer.renderCall({ path: "/tmp/restart.ts", content }, options, uiTheme);
			if (!component) throw new Error("expected a rendered component for a non-xdev write path");
			return component.render(120);
		};
		const tail = `${"x".repeat(80)}\n`;
		render(`const original = 1;\n${tail}`);

		const text = stripAnsi(render(`const replaced = 1;\n${tail}const extra = 3;\n`).join("\n"));
		expect(text).toContain("replaced");
		expect(text).not.toContain("original");
		expect(text).toContain("extra");
	});

	it("feeds only newline-terminated chunks to the highlight stream", async () => {
		const uiTheme = await getUiTheme();
		const pushes: string[] = [];
		vi.spyOn(themeModule, "createHighlightStream").mockImplementation(
			() =>
				({
					push: (chunk: string) => {
						pushes.push(chunk);
						return chunk;
					},
				}) as unknown as HighlightStream,
		);
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		let acc = "";
		for (const piece of ["const a = ", "1;\nconst b = ", "2;\nconst c = 3"]) {
			acc += piece;
			const component = writeToolRenderer.renderCall({ path: "/tmp/chunks.ts", content: acc }, options, uiTheme);
			if (!component) throw new Error("expected a rendered component for a non-xdev write path");
			component.render(120);
		}
		expect(pushes).toEqual(["const a = 1;\n", "const b = 2;\n"]);
		const component = writeToolRenderer.renderCall({ path: "/tmp/chunks.ts", content: acc }, options, uiTheme);
		if (!component) throw new Error("expected a rendered component for a non-xdev write path");
		expect(stripAnsi(component.render(120).join("\n"))).toContain("const c = 3");
	});

	it("highlights the trailing line once args are complete", async () => {
		const uiTheme = await getUiTheme();
		const pushes: string[] = [];
		vi.spyOn(themeModule, "createHighlightStream").mockImplementation(
			() =>
				({
					push: (chunk: string) => {
						pushes.push(chunk);
						return `H(${chunk})`;
					},
				}) as unknown as HighlightStream,
		);
		const content = "const solo = 1;";
		const streamingOptions = { expanded: true, isPartial: true, spinnerFrame: 0 };
		const streaming = writeToolRenderer.renderCall({ path: "/tmp/solo.ts", content }, streamingOptions, uiTheme);
		if (!streaming) throw new Error("expected a rendered component for a non-xdev write path");
		const streamingText = stripAnsi(streaming.render(120).join("\n"));
		expect(streamingText).toContain("const solo = 1;");
		expect(streamingText).not.toContain("H(");
		expect(pushes).toEqual([]);

		const settledOptions = { expanded: true, isPartial: true, spinnerFrame: 0, argsComplete: true };
		const settled = writeToolRenderer.renderCall({ path: "/tmp/solo.ts", content }, settledOptions, uiTheme);
		if (!settled) throw new Error("expected a rendered component for a non-xdev write path");
		expect(stripAnsi(settled.render(120).join("\n"))).toContain("H(const solo = 1;)");
		expect(pushes).toEqual(["const solo = 1;"]);
		settled.render(120);
		expect(pushes).toEqual(["const solo = 1;"]);
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
