import type { HighlightStream } from "@oh-my-pi/pi-natives";
import type { Component } from "../tui";
import { Text } from "../components/text";
import { getLanguageFromPath } from "../lang-from-path";
import { createHighlightStream, highlightCode, type Theme } from "../theme/theme";
import { fileHyperlink, renderStatusLine } from "../render";
import { framedToolCard } from "../render/tool-card";
import {
	cachedRenderedString,
	createRenderedStringCache,
	Ellipsis,
	formatDiagnostics,
	formatErrorDetail,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	PREVIEW_LIMITS,
	previewWindowRows,
	type RenderedStringCache,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
	wrapTextWithAnsi,
} from "../render/render-utils";
import type { FileDiagnosticsResult } from "./lsp";
import type { OutputMeta } from "./output-meta";
import type { RenderResultOptions, ToolActivityContext, ToolActivitySummary, ToolRenderer } from "./renderer";
import { couldBecomeXdUrl, parseXdUrl } from "./xd-url";
import {
	renderXdevCall,
	renderXdevResult,
	xdevActivitySummary,
	type XdevRenderDispatch,
	type XdevMountedRenderer,
} from "./xdev";
import { isResolutionDeviceName, renderResolutionDeviceCall } from "./resolve";
import { REPORT_ISSUE_DEVICE_NAME, renderReportIssueDeviceCall } from "./report-tool-issue";

/** Details returned by the write tool for transcript rendering. */
export interface WriteToolDetails {
	diagnostics?: FileDiagnosticsResult;
	meta?: OutputMeta;
	/** Set when the file was auto-chmod'd because content begins with a `#!` shebang. */
	madeExecutable?: boolean;
	/** Absolute filesystem path the write resolved to. Used by the renderer to wrap
	 * the (possibly cwd-relative) header path in an OSC 8 `file://` hyperlink. */
	resolvedPath?: string;
	/** Set when the write dispatched an `xd://` tool device; drives renderer delegation. */
	xdev?: XdevRenderDispatch;
}

interface WriteRenderArgs {
	path?: unknown;
	file_path?: unknown;
	content?: unknown;
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

/** Bounded newline scan: whether `text` spans more than `maxLines` lines.
 *  Runs on every live compose (the repaint predicate below), so it must not
 *  materialize the split the way `countLines` does. */
function exceedsLineCount(text: string, maxLines: number): boolean {
	if (!text) return false;
	let lines = 1;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		if (++lines > maxLines) return true;
	}
	return false;
}

function writeContentOf(args: unknown): string {
	if (args == null || typeof args !== "object" || !("content" in args)) return "";
	const content = args.content;
	return typeof content === "string" ? content : "";
}

function formatLineCountSuffix(lineCount: number, uiTheme: Theme): string {
	if (lineCount <= 0) return "";
	return uiTheme.fg("dim", ` · ${lineCount} line${lineCount === 1 ? "" : "s"}`);
}

function normalizeDisplayText(text: unknown): string {
	let displayText = "";
	if (typeof text === "string") {
		displayText = text;
	} else if (text !== undefined && text !== null) {
		displayText = String(text);
	}
	return displayText.replace(/\r/g, "");
}

/**
 * Minimum line-number gutter width for write previews. The streaming preview's
 * gutter must stay byte-stable as the line count grows: a width derived purely
 * from `String(totalLines).length` widens at the 10/100/1000-line crossings,
 * causing the live preview to jitter. Reserving 3 digits keeps the gutter
 * constant through 999 lines and keeps the streamed rows aligned with the
 * final result render.
 */
const WRITE_GUTTER_MIN_WIDTH = 3;

const writeStreamingPreviewStateKey = Symbol("writeStreamingPreviewState");

/**
 * Per-component state for incrementally rendering a streamed write.
 * The ToolExecutionComponent's persistent render options carry the state, so
 * it lives exactly as long as the component and cannot leak across tool calls.
 */
interface WriteStreamingPreviewState {
	/** Prior full content; append-only growth is validated with an exact prefix check. */
	previous: string;
	/** `1 + count("\n")` over the scanned content. */
	lineCount: number;
	/** Raw offset immediately after the last newline consumed by `highlighter`. */
	completeLength: number;
	/** Highlighted, complete logical lines; the unfinished trailing line is rendered plain. */
	highlightedLines: string[];
	/** Stateful parser carrying syntax scopes across appended complete lines. */
	highlighter: HighlightStream | null;
	language: string | undefined;
	uiTheme: Theme;
	/** Content length for which the trailing line was flushed as final (`argsComplete`); -1 when none. */
	finalFlushedLength: number;
	/** Highlighted trailing line from the final flush; rendered in place of the plain tail. */
	finalTrailing: string;
}

interface WriteStreamingPreviewStateCarrier {
	[writeStreamingPreviewStateKey]?: WriteStreamingPreviewState;
}

function createWriteStreamingPreviewState(language: string | undefined, uiTheme: Theme): WriteStreamingPreviewState {
	return {
		previous: "",
		lineCount: 1,
		completeLength: 0,
		highlightedLines: [],
		highlighter: createHighlightStream(language, uiTheme),
		language,
		uiTheme,
		finalFlushedLength: -1,
		finalTrailing: "",
	};
}

/**
 * Advance line counting and syntax highlighting only across newly appended
 * content. Complete lines are retained because Ctrl+O can expand the preview;
 * the current partial line stays plain until its terminating newline arrives.
 * Once args are final, the trailing line is flushed through the highlighter
 * (its only push without a trailing newline) so a settled-but-queued preview
 * keeps syntax colors, including for one-line files.
 */
function updateStreamingPreview(
	streamKey: WriteStreamingPreviewStateCarrier | undefined,
	content: string,
	language: string | undefined,
	uiTheme: Theme,
	argsComplete = false,
): WriteStreamingPreviewState | undefined {
	if (streamKey === undefined) return undefined;

	let state = streamKey[writeStreamingPreviewStateKey];
	if (
		state === undefined ||
		state.language !== language ||
		state.uiTheme !== uiTheme ||
		content.length < state.previous.length ||
		!content.startsWith(state.previous) ||
		// A final flush consumed the trailing partial line; later growth would
		// re-feed it, so restart the parser instead of corrupting its state.
		(state.finalFlushedLength !== -1 && content.length !== state.finalFlushedLength)
	) {
		state = createWriteStreamingPreviewState(language, uiTheme);
		streamKey[writeStreamingPreviewStateKey] = state;
	}

	let completeLength = state.completeLength;
	for (let i = state.previous.length; i < content.length; i++) {
		if (content.charCodeAt(i) === 10) {
			state.lineCount++;
			completeLength = i + 1;
		}
	}
	if (completeLength > state.completeLength) {
		const chunk = content.slice(state.completeLength, completeLength).replace(/\r/g, "");
		let chunkHighlighted = chunk;
		if (state.highlighter) {
			try {
				chunkHighlighted = state.highlighter.push(chunk);
			} catch {
				state.highlighter = null;
			}
		}
		const lines = chunkHighlighted.split("\n");
		lines.pop();
		state.highlightedLines.push(...lines);
		state.completeLength = completeLength;
	}
	if (argsComplete && state.finalFlushedLength !== content.length && !content.endsWith("\n")) {
		const trailing = content.slice(state.completeLength).replace(/\r/g, "");
		if (trailing.length > 0) {
			let trailingHighlighted = trailing;
			if (state.highlighter) {
				try {
					trailingHighlighted = state.highlighter.push(trailing);
				} catch {
					state.highlighter = null;
				}
			}
			state.finalTrailing = trailingHighlighted;
			state.finalFlushedLength = content.length;
		}
	}
	state.previous = content;
	return state;
}

/**
 * Total body rows a collapsed write preview occupies once its content overflows
 * the window. Both the streaming preview and the finished result pad to exactly
 * this many rows, so the frame's height is constant from the first overflowing
 * tick through the final render — no per-tick flicker, no collapse on settle.
 */
function writePreviewRowBudget(): number {
	return Math.max(1, Math.min(PREVIEW_LIMITS.EXPANDED_LINES, previewWindowRows()));
}

/**
 * Select the trailing logical lines whose wrapped-row count fits `rowBudget`
 * visual rows at `innerWidth`, walking backward from the end so cost is
 * proportional to the visible suffix, not the whole payload.
 *
 * A window sized in logical lines (the prior behavior) makes the frame's
 * height jitter every tick: lines vary in length, and the output block wraps
 * each one to the frame's inner width, so a fixed line count still yields a
 * wildly different row count depending on which lines happen to be in the
 * window. Mirrors `sliceStreamingDiffTail` in tools/edit.ts, which solves the
 * same problem for the edit tool's streaming diff preview.
 *
 * Packing whole lines still leaves a remainder (a 2-row line cannot fill a
 * 1-row gap), so `visualRows` is reported and callers pad the shortfall to keep
 * the emitted row count constant.
 */
function sliceStreamingContentTail(
	content: string,
	innerWidth: number,
	rowBudget: number,
): { start: number; end: number; consumedLines: number; visualRows: number; stripped: number } {
	if (content.length === 0) return { start: 0, end: 0, consumedLines: 0, visualRows: 0, stripped: 0 };
	// Drop the one conventional file-ending newline so the window spends its rows
	// on real content instead of the empty line past it. Everything below measures
	// and slices against this same `end`: the earlier mismatch (measure stripped,
	// render unstripped) is what made the frame gain a row on exactly those ticks
	// where content ended on a newline. `stripped` lets the caller keep gutter
	// numbering aligned with the file.
	const stripped = content.charCodeAt(content.length - 1) === 10 ? 1 : 0;
	const end = content.length - stripped;
	const rowLimit = Math.max(1, rowBudget);
	let start = end;
	let cursor = end;
	let visualRows = 0;
	let consumedLines = 0;
	while (cursor >= 0) {
		const newline = cursor > 0 ? content.lastIndexOf("\n", cursor - 1) : -1;
		const lineStart = newline + 1;
		const lineRows = Math.max(1, wrapTextWithAnsi(replaceTabs(content.slice(lineStart, cursor)), innerWidth).length);
		if (visualRows > 0 && visualRows + lineRows > rowLimit) break;
		visualRows += lineRows;
		start = lineStart;
		consumedLines++;
		if (newline < 0) break;
		cursor = newline;
	}
	return { start, end, consumedLines, visualRows, stripped };
}

/**
 * Emit collapsed-preview body rows already wrapped to `innerWidth`, so the row
 * count the caller budgeted is the row count the frame actually draws.
 *
 * Measuring rows one way and letting the output block wrap another way is
 * what made this frame change size for so long. Emitting pre-wrapped rows keeps
 * a single source of truth: every row here already fits the frame, so the block
 * re-wraps nothing. Continuation rows carry no gutter, matching how the block's
 * own wrapping rendered them.
 *
 * Over-budget rows are cut from the far end — `tail` keeps the newest rows (the
 * streaming edge), `head` keeps the first. Only a single line taller than the
 * whole budget can trigger that: the fitters admit an over-budget line solely
 * as the first one, so the cut trims that one line instead of dropping lines the
 * caller already counted as visible.
 */
function previewBodyRows(
	highlighted: readonly string[],
	firstLineNumber: number,
	lineNumberWidth: number,
	innerWidth: number,
	targetRows: number,
	anchor: "head" | "tail",
	uiTheme: Theme,
): string[] {
	const rows: string[] = [];
	for (let i = 0; i < highlighted.length; i++) {
		const gutter = uiTheme.fg("dim", `${String(firstLineNumber + i).padStart(lineNumberWidth, " ")} `);
		const wrapped = wrapTextWithAnsi(replaceTabs(highlighted[i] ?? ""), innerWidth);
		if (wrapped.length === 0) {
			rows.push(gutter);
			continue;
		}
		for (let r = 0; r < wrapped.length; r++) rows.push(r === 0 ? `${gutter}${wrapped[r]}` : (wrapped[r] ?? ""));
	}
	if (rows.length <= targetRows) return rows;
	return anchor === "tail" ? rows.slice(rows.length - targetRows) : rows.slice(0, targetRows);
}

function formatStreamingContent(
	content: string,
	expanded: boolean,
	language: string | undefined,
	uiTheme: Theme,
	contentWidth: number,
	spinnerFrame?: number,
	cache?: RenderedStringCache,
	streamKey?: WriteStreamingPreviewStateCarrier,
	argsComplete?: boolean,
): string {
	if (!content) return "";
	const bodyText = cachedRenderedString(cache, uiTheme, expanded, `${language ?? ""}:${contentWidth}`, content, () => {
		const state = updateStreamingPreview(streamKey, content, language, uiTheme, argsComplete === true);
		// The unfinished trailing line: plain until its terminating newline arrives,
		// highlighted once `argsComplete` flushed it through the stateful parser.
		let trailingLine = "";
		if (state) {
			const flushed = argsComplete === true && state.finalFlushedLength === content.length;
			trailingLine = flushed ? state.finalTrailing : content.slice(state.completeLength).replace(/\r/g, "");
			// Carriage-return-only content normalizes to nothing: render it exactly
			// like the empty payload it is.
			if (state.lineCount === 1 && trailingLine.length === 0) return "";
		}
		let totalLines: number;
		let startIndex = 0;
		let lineNumberWidth: number;
		let markerShown = false;
		let contentTarget = 0;
		// The collapsed window's lines, already highlighted when a stream state
		// exists — the incremental parser is never asked to re-tokenize the payload.
		let windowLines: readonly string[] = [];
		let visibleText = "";
		if (expanded) {
			if (state) {
				totalLines = state.lineCount;
				windowLines = [...state.highlightedLines, trailingLine];
			} else {
				visibleText = normalizeDisplayText(content);
				if (visibleText.length === 0) return "";
				totalLines = countLines(visibleText);
			}
			startIndex = 0;
			lineNumberWidth = Math.max(WRITE_GUTTER_MIN_WIDTH, String(totalLines).length);
		} else {
			totalLines = state ? state.lineCount : countLines(content);
			lineNumberWidth = Math.max(WRITE_GUTTER_MIN_WIDTH, String(totalLines).length);
			// Row budget in on-screen rows, not logical lines — see
			// sliceStreamingContentTail for why. innerWidth subtracts the gutter
			// (`NNN `) since the gutter and its first wrapped row share a line.
			const innerWidth = Math.max(1, contentWidth - lineNumberWidth - 1);
			const budget = writePreviewRowBudget();
			// Reserve the trailing "(streaming)" row, plus the "(N earlier lines)"
			// row while the head is capped, so the body totals `budget` rows.
			let fit = sliceStreamingContentTail(content, innerWidth, Math.max(1, budget - 2));
			const measuredTotal = totalLines - fit.stripped;
			if (fit.consumedLines >= measuredTotal && fit.visualRows <= budget - 2) {
				// Whole file already fits: no earlier-lines marker is needed, so the
				// content may claim the row that marker would have taken.
				fit = sliceStreamingContentTail(content, innerWidth, Math.max(1, budget - 1));
			}
			startIndex = measuredTotal - fit.consumedLines;
			// The marker row is shown either because lines are hidden, or because a
			// single over-budget line had its rows cut. Decided before emission so
			// the reservation and the emitted rows cannot disagree.
			markerShown = startIndex > 0 || fit.visualRows > budget - 2;
			contentTarget = Math.max(1, budget - (markerShown ? 2 : 1));
			if (state) {
				// The window ends on the unfinished tail whenever the payload does not
				// end on a newline, so the tail rides along as its last line.
				const window = state.highlightedLines.slice(startIndex, startIndex + fit.consumedLines);
				if (window.length < fit.consumedLines) window.push(trailingLine);
				windowLines = window;
			} else {
				// Slice to the measured `end`, never to `content.length`: measuring one
				// span and rendering another is the mismatch this whole path exists to
				// avoid.
				visibleText = content.slice(fit.start, fit.end).replace(/\r/g, "");
			}
		}
		const hidden = startIndex;
		// An empty window is legitimate (a budget that fits only the file-ending
		// newline): emit zero content rows and let the padding hold the height,
		// rather than bailing out and collapsing the frame to its borders.
		let highlighted: readonly string[] = [];
		if (state) {
			highlighted = !expanded && windowLines.every(line => line.length === 0) ? [] : windowLines;
		} else if (visibleText.length > 0) {
			highlighted = highlightCode(visibleText, language);
		}

		let text = "\n\n";
		if (expanded) {
			for (let i = 0; i < highlighted.length; i++) {
				const gutter = uiTheme.fg("dim", `${String(i + 1).padStart(lineNumberWidth, " ")} `);
				text += `${gutter}${replaceTabs(highlighted[i] ?? "")}\n`;
			}
			return text;
		}
		const innerWidth = Math.max(1, contentWidth - lineNumberWidth - 1);
		const rows = previewBodyRows(
			highlighted,
			startIndex + 1,
			lineNumberWidth,
			innerWidth,
			contentTarget,
			"tail",
			uiTheme,
		);
		// Nothing visible and nothing hidden means the payload carries no renderable
		// line yet (carriage returns only): render no preview at all, exactly as an
		// empty payload does. When lines *are* hidden the frame stays, padded, so a
		// window that fits only the file-ending newline cannot collapse it.
		if (rows.length === 0 && hidden === 0) return "";
		if (markerShown) {
			const label = hidden > 0 ? `… (${hidden} earlier line${hidden === 1 ? "" : "s"})` : "…";
			text += `${uiTheme.fg("dim", label)}\n`;
			// Filler sits below the marker, never at the head: callers strip leading
			// blank body rows, which would silently eat the padding and restore the
			// jitter this is here to remove.
			for (let i = rows.length; i < contentTarget; i++) text += "\n";
		}
		for (const row of rows) text += `${row}\n`;
		return text;
	});
	if (bodyText.length === 0) return "";
	// The animated glyph lives on this trailing line — inside the transcript's
	// volatile-tail holdback — never in the header: an animating head row pins
	// the native-scrollback commit boundary at the top of the block, so a long
	// expanded preview could never scroll-append mid-stream.
	const spinner = spinnerFrame !== undefined ? `${formatStatusIcon("running", uiTheme, spinnerFrame)} ` : "";
	return `${bodyText}${spinner}${uiTheme.fg("dim", `… (streaming)`)}`;
}

function renderContentPreview(
	content: string,
	expanded: boolean,
	language: string | undefined,
	uiTheme: Theme,
	contentWidth: number,
	cache?: RenderedStringCache,
): string {
	if (!content) return "";
	return cachedRenderedString(cache, uiTheme, expanded, `${language ?? ""}:${contentWidth}`, content, () => {
		const rawLines = normalizeDisplayText(content).split("\n");
		const totalLines = rawLines.length;
		const lineNumberWidth = Math.max(WRITE_GUTTER_MIN_WIDTH, String(totalLines).length);
		if (expanded) {
			const highlighted = highlightCode(rawLines.join("\n"), language);
			let full = "\n\n";
			for (let i = 0; i < highlighted.length; i++) {
				const gutter = uiTheme.fg("dim", `${String(i + 1).padStart(lineNumberWidth, " ")} `);
				full += `${gutter}${replaceTabs(highlighted[i] ?? "")}\n`;
			}
			return full.trimEnd();
		}
		// Cap by on-screen ROWS, not logical lines: a fixed line count yields a
		// wildly different rendered height depending on how many of those lines
		// wrap at the frame's inner width. Shares `previewBodyRows` with the
		// streaming path so the finished box lands on the same height as the last
		// streaming frame instead of jumping.
		const innerWidth = Math.max(1, contentWidth - lineNumberWidth - 1);
		const budget = writePreviewRowBudget();
		// One row reserved for the trailing "N more lines" chrome, mirroring the
		// streaming path's reservation so both settle at `budget` body rows.
		const rowLimit = Math.max(1, budget - 1);
		let visualRows = 0;
		let consumed = 0;
		for (const line of rawLines) {
			const lineRows = Math.max(1, wrapTextWithAnsi(replaceTabs(line), innerWidth).length);
			if (consumed > 0 && visualRows + lineRows > rowLimit) break;
			visualRows += lineRows;
			consumed++;
		}
		const hidden = totalLines - consumed;
		// Chrome shows either because lines are hidden, or because a single
		// over-budget line had its rows cut. Decided before emission so the
		// reservation and the emitted rows cannot disagree.
		const chromeShown = hidden > 0 || visualRows > rowLimit;
		const contentTarget = chromeShown ? rowLimit : budget;
		const highlighted = highlightCode(rawLines.slice(0, consumed).join("\n"), language);
		const rows = previewBodyRows(highlighted, 1, lineNumberWidth, innerWidth, contentTarget, "head", uiTheme);

		let text = "\n\n";
		for (const row of rows) text += `${row}\n`;
		if (chromeShown) {
			// Filler precedes the chrome row so `trimEnd()` below cannot strip it.
			for (let i = rows.length; i < contentTarget; i++) text += "\n";
			const hint = formatExpandHint(uiTheme, expanded, true);
			const moreLine = hidden > 0 ? `${formatMoreItems(hidden, "line")}${hint ? ` ${hint}` : ""}` : `… ${hint}`;
			text += uiTheme.fg("dim", moreLine);
		}
		return text.trimEnd();
	});
}

/** Render context for the write tool: resolves an `xd://`-mounted tool so its live renderer drives device dispatch previews. */
export interface WriteRenderContext {
	resolveXdevMounted?: (name: string) => XdevMountedRenderer | undefined;
}

/** Render file writes and delegated tool-device calls. */
export const writeToolRenderer = {
	/** Compact one-line activity: device writes read as the mounted tool (`LSP · references foo`), file writes as `Write · <path>`. */
	activitySummary(args: unknown, context: ToolActivityContext): ToolActivitySummary {
		const writeArgs = (args ?? {}) as WriteRenderArgs;
		const rawPath =
			typeof writeArgs.file_path === "string"
				? writeArgs.file_path
				: typeof writeArgs.path === "string"
					? writeArgs.path
					: "";
		if (!rawPath) return { label: "Write" };
		const xdev = parseXdUrl(rawPath);
		if (xdev?.name) {
			const resolveMounted = (context.renderContext as WriteRenderContext | undefined)?.resolveXdevMounted;
			return xdevActivitySummary(xdev.name, writeArgs.content, resolveMounted);
		}
		return { label: "Write", detail: shortenPath(rawPath) };
	},

	renderCall(
		args: WriteRenderArgs,
		options: RenderResultOptions & WriteStreamingPreviewStateCarrier & { renderContext?: WriteRenderContext },
		uiTheme: Theme,
	): Component | undefined {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		// Render NOTHING until the streamed path arrives and provably is not an
		// xd:// device. Device writes then render as queued until execution starts,
		// after which they delegate to the mounted tool's renderer.
		// A present-but-malformed path (array/object from a bad provider parse)
		// is definitively not xd:// — fall through to the legacy frame.
		if (args.path === undefined && args.file_path === undefined) return undefined;
		if (rawPath && couldBecomeXdUrl(rawPath)) {
			const xdev = parseXdUrl(rawPath);
			// The path string is settled once the content field started streaming.
			const pathSettled = args.content !== undefined;
			if (!xdev?.name || !pathSettled) return undefined;
			if (isResolutionDeviceName(xdev.name)) return renderResolutionDeviceCall(xdev.name, args.content, uiTheme);
			if (xdev.name === REPORT_ISSUE_DEVICE_NAME) return renderReportIssueDeviceCall(args.content, uiTheme);
			return renderXdevCall(xdev.name, args.content, options, uiTheme, options.renderContext?.resolveXdevMounted);
		}
		const filePath = shortenPath(rawPath);
		const lang = rawPath ? (getLanguageFromPath(rawPath) ?? "text") : "text";
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		// No status icon on the head row: it's the head of the framed block, and
		// native-scrollback commits are prefix-only — an animated glyph would pin
		// the commit boundary at the top, and the pending hourglass just adds
		// noise. The liveness cue rides the trailing "(streaming)" line instead.
		const header = renderStatusLine(
			{
				title: "Write",
				description: `${langIcon} ${pathDisplay}`,
			},
			uiTheme,
		);
		// Raw content, not normalizeDisplayText(args.content): the collapsed
		// streaming path normalizes only its tail window, so a full-payload
		// normalize on every reveal tick would re-introduce the O(n²) streaming
		// cost formatStreamingContent avoids. Non-string content still falls
		// back to the normalizing stringify.
		const content = typeof args.content === "string" ? args.content : normalizeDisplayText(args.content);
		const streamingCache = createRenderedStringCache();
		return framedToolCard(uiTheme, ({ contentWidth }) => {
			const body = content
				? formatStreamingContent(
						content,
						Boolean(options?.expanded),
						lang,
						uiTheme,
						contentWidth,
						options?.spinnerFrame,
						streamingCache,
						// `options` is the ToolExecutionComponent's persistent
						// render-state object — a stable identity across reveal ticks
						// that keys the incremental preview state. `argsComplete`
						// flushes the trailing line through the highlighter once.
						options,
						options?.argsComplete,
					)
				: "";
			const bodyLines = body ? body.split("\n") : [];
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ content: bodyLines }] : [],
				phase: "pending",
				borderColor: "borderMuted",
			};
		});
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: WriteToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: WriteRenderContext },
		uiTheme: Theme,
		args?: WriteRenderArgs,
	): Component {
		// xd:// dispatch results render as the mounted tool's own result.
		const xdev = result.details?.xdev;
		if (xdev) {
			const delegated = renderXdevResult(xdev, result, options, uiTheme, options.renderContext?.resolveXdevMounted);
			if (delegated) return delegated;
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			return new Text(uiTheme.fg("toolOutput", replaceTabs(text)), 0, 0);
		}
		const rawPath =
			typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
		const filePath = shortenPath(rawPath);
		const fileContent = normalizeDisplayText(args?.content);
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		// The header shows the cwd-relative path but links to the absolute path the
		// write resolved to (args.path may be relative, which would yield a broken
		// `file://` URI). Falls back to plain text when the result lacks a path.
		const linkTarget = result.details?.resolvedPath;
		const styledPath = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const pathDisplay = filePath && linkTarget ? fileHyperlink(linkTarget, styledPath) : styledPath;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text ?? "";
			const header = renderStatusLine(
				{ icon: "error", title: "Write", description: `${langIcon} ${pathDisplay}` },
				uiTheme,
			);
			return framedToolCard(uiTheme, () => ({
				header,
				sections: [{ content: formatErrorDetail(errorText, uiTheme).split("\n") }],
				phase: "error",
				borderColor: "error",
			}));
		}

		const isPartial = options.isPartial === true;
		const progressText = result.content?.find(c => c.type === "text")?.text ?? "";
		const lineCount = countLines(fileContent);
		const lineSuffix = formatLineCountSuffix(lineCount, uiTheme);
		const execSuffix =
			!isPartial && result.details?.madeExecutable
				? `${uiTheme.fg("dim", " · ")}${uiTheme.fg("success", "made executable!")}`
				: "";
		const header = renderStatusLine(
			{
				icon: isPartial ? "running" : undefined,
				iconOverride: isPartial ? undefined : uiTheme.styledSymbol("tool.write", "accent"),
				spinnerFrame: options.spinnerFrame,
				title: "Write",
				description: `${langIcon} ${pathDisplay}${lineSuffix}${execSuffix}`,
			},
			uiTheme,
		);
		const diagnostics = result.details?.diagnostics;

		const previewCache = createRenderedStringCache();
		return framedToolCard(uiTheme, ({ contentWidth }) => {
			const { expanded } = options;
			let body = renderContentPreview(fileContent, expanded, lang, uiTheme, contentWidth, previewCache);
			if (isPartial && progressText) {
				const safeProgressText = truncateToWidth(
					replaceTabs(progressText),
					TRUNCATE_LENGTHS.LINE,
					Ellipsis.Unicode,
				);
				body = `${uiTheme.fg("muted", safeProgressText)}${body ? `\n${body}` : ""}`;
			}
			if (!isPartial && diagnostics) {
				const diagText = formatDiagnostics(diagnostics, expanded, uiTheme, fp =>
					uiTheme.getLangIcon(getLanguageFromPath(fp)),
				);
				if (diagText.trim()) {
					const diagLines = diagText.split("\n");
					const firstNonEmpty = diagLines.findIndex(line => line.trim());
					if (firstNonEmpty >= 0) body += `\n${diagLines.slice(firstNonEmpty).join("\n")}`;
				}
			}
			const bodyLines = body.split("\n");
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ content: bodyLines }] : [],
				phase: isPartial ? "partial" : "success",
				borderColor: "borderMuted",
			};
		});
	},
	mergeCallAndResult: true,
	// The collapsed pending preview follows the streaming edge with a tail
	// window once the content outgrows it (`… (N earlier lines)` + last rows);
	// the first partial result re-anchors the frame to the top of the file, so
	// tail rows already committed to viewport/native scrollback would survive
	// as stale content above the new frame without a full replay. Expanded and
	// short previews stay top-anchored and skip the (scrollback-wiping) reset.
	forceFirstResultViewportRepaint: (args: unknown, options: RenderResultOptions) =>
		!options.expanded && exceedsLineCount(writeContentOf(args), PREVIEW_LIMITS.EXPANDED_LINES),
} satisfies ToolRenderer<WriteRenderArgs, WriteToolDetails>;
