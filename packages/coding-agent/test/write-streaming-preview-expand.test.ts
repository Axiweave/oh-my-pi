import { afterEach, describe, expect, it, vi } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import {
	decodeStreamedToolArgs,
	streamingStringKeysForTool,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/tool-args-reveal";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { TUI } from "@oh-my-pi/pi-tui";

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");
const hasLine = (lines: readonly string[], n: number): boolean =>
	new RegExp(`\\bline ${n}\\b`).test(stripAnsi(lines.join("\n")));

describe("write streaming preview honors Ctrl+O expansion", () => {
	let initialized = false;

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function makePendingWrite(lineCount: number) {
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const content = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n");
		// No updateResult() -> the call stays pending, exercising the streaming
		// `renderCall` path (formatStreamingContent), not the merged result render.
		return new ToolExecutionComponent("write", { file_path: "/tmp/foo.ts", content }, {}, undefined, uiStub);
	}

	async function getUiTheme() {
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) {
			throw new Error("expected an initialized theme");
		}
		return uiTheme;
	}

	it("collapses a streaming write to a bounded tail and lifts the cap on expand", async () => {
		// 40 lines > WRITE_STREAMING_PREVIEW_LINES (12): the head must be hidden
		// while collapsed and the streaming edge (tail) kept visible.
		const comp = await makePendingWrite(40);

		const collapsed = comp.render(80);
		// Tail-anchored: the streaming edge (last lines) is visible...
		expect(hasLine(collapsed, 40)).toBe(true);
		// ...but the head is capped away with an "earlier lines" marker.
		expect(hasLine(collapsed, 1)).toBe(false);
		expect(stripAnsi(collapsed.join("\n"))).toContain("earlier line");

		comp.setExpanded(true);
		const expanded = comp.render(80);
		// Ctrl+O lifts the cap: the full file (head through tail) is shown,
		// and the "earlier lines" marker is gone.
		expect(hasLine(expanded, 1)).toBe(true);
		expect(hasLine(expanded, 40)).toBe(true);
		expect(stripAnsi(expanded.join("\n"))).not.toContain("earlier line");
		// Expanding must strictly grow the preview, not just reformat it.
		expect(expanded.length).toBeGreaterThan(collapsed.length);
	});

	it("does not cap a short streaming write that already fits the window", async () => {
		const comp = await makePendingWrite(4);
		const collapsed = comp.render(80);
		expect(hasLine(collapsed, 1)).toBe(true);
		expect(hasLine(collapsed, 4)).toBe(true);
		expect(stripAnsi(collapsed.join("\n"))).not.toContain("earlier line");
	});
	it("reuses the highlighted streaming body across frame renders", async () => {
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		expect(uiTheme).toBeDefined();
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const highlightSpy = vi
			.spyOn(themeModule, "highlightCode")
			.mockImplementation((code: string) => code.split("\n"));
		const component = writeToolRenderer.renderCall(
			{ path: "/tmp/cache.ts", content: "const a = 1;\nconst b = 2;" },
			options,
			uiTheme!,
		);
		if (!component) throw new Error("expected a rendered component for a non-xdev write path");

		// Width now sits in the cache salt: the collapsed tail window is sized in
		// on-screen rows (wrap-width dependent), so a width change must re-highlight.
		component.render(80);
		component.render(120);
		expect(highlightSpy).toHaveBeenCalledTimes(2);

		component.render(120);
		expect(highlightSpy).toHaveBeenCalledTimes(2);

		options.spinnerFrame = 1;
		component.render(120);
		expect(highlightSpy).toHaveBeenCalledTimes(2);
	});

	it("coerces truthy non-string content for pending write previews", async () => {
		const uiTheme = await getUiTheme();
		const runtimeContent = ["object first\r\nobject second"];

		const component = writeToolRenderer.renderCall(
			{ path: "/tmp/runtime-content.ts", content: runtimeContent },
			{ expanded: true, isPartial: true, spinnerFrame: 0 },
			uiTheme,
		);
		if (!component) throw new Error("expected a rendered component for a non-xdev write path");

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("object first");
		expect(rendered).toContain("object second");
		expect(rendered).toMatch(/\b2 object second\b/);
		expect(rendered).not.toContain("\r");
	});

	it("coerces truthy non-string content for merged write results", async () => {
		const uiTheme = await getUiTheme();
		const runtimeContent = ["merged first\r\nmerged second"];

		const component = writeToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Wrote /tmp/runtime-content.ts" }],
				details: { resolvedPath: "/tmp/runtime-content.ts" },
			},
			{ expanded: true, isPartial: false },
			uiTheme,
			{ path: "/tmp/runtime-content.ts", content: runtimeContent },
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("merged first");
		expect(rendered).toContain("merged second");
		expect(rendered).toContain("2 lines");
		expect(rendered).toMatch(/\b2 merged second\b/);
		expect(rendered).not.toContain("\r");
	});

	it("renders execution progress as a partial result without diagnostics", async () => {
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) {
			throw new Error("expected an initialized theme");
		}

		const progressText = `Writing 12 bytes to tab\tpath/${"segment/".repeat(20)}UNTRUNCATED_TAIL_SENTINEL.ts...`;
		const component = writeToolRenderer.renderResult(
			{
				content: [{ type: "text", text: progressText }],
				details: {
					resolvedPath: "/tmp/progress.ts",
					diagnostics: {
						errored: true,
						summary: "1 error",
						messages: ["diagnostic sentinel"],
					},
				},
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			uiTheme,
			{ path: "/tmp/progress.ts", content: "const x = 1;" },
		);

		const rendered = stripAnsi(component.render(100).join("\n"));
		expect(rendered).toContain("Writing 12 bytes to tab");
		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain("UNTRUNCATED_TAIL_SENTINEL");
		expect(rendered).not.toContain("diagnostic sentinel");
	});

	it("shows content grown past the last throttled parse when rebuilt mid-stream", async () => {
		// Regression: a transcript rebuild (theme change, settings, focus replay)
		// recreates the pending write component while args still stream. The
		// rebuild must decode display args from the raw partialJson buffer — the
		// provider-parsed arguments lag by up to a throttled parse window, and
		// spreading them alone froze the preview at the last full parse.
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const staleContent = "line before throttle";
		// Provider parsed up to here…
		const seenByProvider = `{"path":"/tmp/foo.ts","content":"${staleContent}`;
		// …then the buffer grew, but not enough to re-trigger the 256-byte parse.
		const partialJson = `${seenByProvider}\\nGROWN_TAIL_SENTINEL`;
		const staleProviderArgs = { path: "/tmp/foo.ts", content: staleContent };

		const renderArgs = decodeStreamedToolArgs(partialJson, {
			rawInput: false,
			fullArgs: staleProviderArgs,
			streamingStringKeys: streamingStringKeysForTool("write", false),
		});
		// No updateResult() -> pending, exercising the streaming renderCall path
		// that reads args.content.
		const comp = new ToolExecutionComponent("write", renderArgs, {}, undefined, uiStub);

		const rendered = stripAnsi(comp.render(100).join("\n"));
		expect(rendered).toContain("GROWN_TAIL_SENTINEL");
	});
});

describe("collapsed write preview height is stable", () => {
	let uiTheme: Theme | undefined;

	async function theme(): Promise<Theme> {
		if (!uiTheme) {
			await themeModule.initTheme();
			uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		}
		if (!uiTheme) throw new Error("no theme available");
		return uiTheme;
	}

	/** Rendered row counts for every streaming prefix, plus the finished render. */
	async function heights(lines: readonly string[], width: number): Promise<{ streaming: number[]; finished: number }> {
		const ui = await theme();
		const path = "/tmp/height.md";
		const streaming = lines.map((_, i) => {
			const component = writeToolRenderer.renderCall(
				{ path, content: lines.slice(0, i + 1).join("\n") },
				{ expanded: false, isPartial: true, spinnerFrame: 0 },
				ui,
			);
			if (!component) throw new Error("expected a rendered streaming component");
			return component.render(width).length;
		});
		const finished = writeToolRenderer
			.renderResult(
				{ content: [{ type: "text", text: "wrote" }], details: { resolvedPath: path } },
				{ expanded: false, isPartial: false },
				ui,
				{ path, content: lines.join("\n") },
			)
			.render(width).length;
		return { streaming, finished };
	}

	// A fixed logical-line cap made the box height track *which* lines happened to
	// be in the window: mixing short lines with lines that wrap re-quantized the
	// rendered row count on nearly every tick, so the frame flickered as content
	// scrolled through it (and jumped again on completion).
	it("keeps one height once wrapping content overflows the window", async () => {
		const lines = Array.from({ length: 60 }, (_, i) =>
			i % 2 === 0
				? `- short ${i}`
				: `**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/readme-outline.md ${i}`,
		);
		const { streaming, finished } = await heights(lines, 80);
		const peak = Math.max(...streaming);
		const settled = streaming.slice(streaming.indexOf(peak));
		expect(settled.every(rowCount => rowCount === peak)).toBe(true);
		expect(finished).toBe(peak);
	});

	// A single logical line taller than the whole budget is admitted by the "at
	// least one line" rule; the tail slicer and the head slicer cut it at
	// different points, so streaming and finished disagreed on height.
	it("bounds a single line taller than the whole window", async () => {
		const { streaming, finished } = await heights(["x".repeat(4000), "short", "tail"], 80);
		const settled = streaming.slice(1);
		expect(settled.every(rowCount => rowCount === settled[0])).toBe(true);
		expect(finished).toBe(settled[0]);
	});

	// The window is budgeted in on-screen rows, so a shorter viewport must yield a
	// shorter box - and still a constant one.
	it("tracks the viewport row budget", async () => {
		const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const lines = Array.from({ length: 40 }, (_, i) => `- line ${i}`);
		try {
			Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
			const short = await heights(lines, 80);
			Object.defineProperty(process.stdout, "rows", { value: 50, configurable: true });
			const tall = await heights(lines, 80);
			expect(Math.max(...short.streaming)).toBeLessThan(Math.max(...tall.streaming));
			expect(short.finished).toBe(Math.max(...short.streaming));
			expect(tall.finished).toBe(Math.max(...tall.streaming));
		} finally {
			if (rows) Object.defineProperty(process.stdout, "rows", rows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	// A budget that fits only the file-ending newline once left the tail window
	// empty, and the renderer bailed out - collapsing the frame to its borders.
	it("never collapses to a bare frame when the window fits only the trailing newline", async () => {
		const ui = await theme();
		const component = writeToolRenderer.renderCall(
			{ path: "/tmp/height.md", content: `${"z".repeat(600)}\n` },
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			ui,
		);
		if (!component) throw new Error("expected a rendered streaming component");
		expect(component.render(40).length).toBeGreaterThan(3);
	});
});
