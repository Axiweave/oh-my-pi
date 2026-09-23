const QUEUE_PREFIXES: readonly string[] = ["->", "=>"];
/** Prefix matcher shared by queue-list parsing and editor highlighting. */
export const QUEUE_LIST_MARKER_RE = /^([\t ]*)(\d+|[A-Za-z]+)([.)])(?=[\t ]|$)/;
const CANONICAL_ROMAN_RE = /^(?=[MDCLXVI])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i;

interface EnumeratedItem {
	line: number;
	indent: string;
	marker: string;
	punctuation: string;
	content: string;
}

interface EnumeratedList {
	source: string;
	lines: string[];
	items: EnumeratedItem[];
}

/** Extract the message body from the `->` / `=>` yield-queue shorthand. */
export function parseQueueShorthand(text: string): string | undefined {
	const prefix = QUEUE_PREFIXES.find(candidate => text.startsWith(candidate));
	return prefix ? text.slice(prefix.length).trim() : undefined;
}

/** Where the queued message body starts: the line to edit, and the index within it. */
export interface QueueShorthandBodyStart {
	/** Body line index. A prefix alone on its line hands the body to line 1. */
	readonly line: number;
	/** Index of the body start within that line. */
	readonly anchor: number;
}

/**
 * Locate the queued message body. A `->` / `=>` prefix keeps its line, so body text
 * typed after the prefix stays on line 0. A prefix line with no text after it leaves
 * the body to the next line, which the host appends when the draft has none. A draft
 * without a prefix starts at the top of the message.
 */
export function queueShorthandBodyStart(text: string): QueueShorthandBodyStart {
	const lines = text.split("\n");
	const first = lines[0] ?? "";
	const prefix = QUEUE_PREFIXES.find(candidate => first.startsWith(candidate));
	if (!prefix) return { line: 0, anchor: 0 };
	const after = first.slice(prefix.length);
	if (after.trim() !== "") return { line: 0, anchor: prefix.length + (after.length - after.trimStart().length) };
	return { line: 1, anchor: 0 };
}

function parseEnumeratedItem(line: string, lineIndex: number): EnumeratedItem | undefined {
	const match = QUEUE_LIST_MARKER_RE.exec(line);
	if (!match) return undefined;
	const [matched, indent, marker, punctuation] = match;
	if (indent === undefined || marker === undefined || punctuation === undefined) return undefined;
	return { line: lineIndex, indent, marker, punctuation, content: line.slice(matched.length).trimStart() };
}

function decodeDecimal(marker: string): number | undefined {
	if (!/^\d+$/.test(marker)) return undefined;
	const value = Number(marker);
	return Number.isSafeInteger(value) ? value : undefined;
}

function decodeRoman(marker: string): number | undefined {
	if (!CANONICAL_ROMAN_RE.test(marker)) return undefined;
	const values: Readonly<Record<string, number>> = {
		I: 1,
		V: 5,
		X: 10,
		L: 50,
		C: 100,
		D: 500,
		M: 1000,
	};
	const upper = marker.toUpperCase();
	let value = 0;
	for (let index = 0; index < upper.length; index++) {
		const current = values[upper[index] ?? ""];
		if (current === undefined) return undefined;
		const next = values[upper[index + 1] ?? ""] ?? 0;
		value += current < next ? -current : current;
	}
	return value;
}

function decodeAlpha(marker: string): number | undefined {
	if (!/^[A-Za-z]+$/.test(marker)) return undefined;
	let value = 0;
	for (const char of marker.toUpperCase()) {
		value = value * 26 + char.charCodeAt(0) - 64;
		if (!Number.isSafeInteger(value)) return undefined;
	}
	return value;
}

function isSequential(markers: readonly string[], decode: (marker: string) => number | undefined): boolean {
	let previous = decode(markers[0] ?? "");
	if (previous === undefined) return false;
	for (let index = 1; index < markers.length; index++) {
		const current = decode(markers[index] ?? "");
		if (current === undefined || current !== previous + 1) return false;
		previous = current;
	}
	return true;
}

function isEnumeratedSequence(items: readonly EnumeratedItem[]): boolean {
	const markers = items.map(item => item.marker);
	if (markers.every(marker => /^\d+$/.test(marker))) return isSequential(markers, decodeDecimal);
	if (
		!markers.every(marker => marker === marker.toUpperCase()) &&
		!markers.every(marker => marker === marker.toLowerCase())
	) {
		return false;
	}
	return isSequential(markers, decodeRoman) || isSequential(markers, decodeAlpha);
}

function parseEnumeratedList(text: string): EnumeratedList | undefined {
	const source = text.trim();
	if (!source) return undefined;
	const lines = source.split(/\r?\n/);
	const first = parseEnumeratedItem(lines[0] ?? "", 0);
	if (!first) return undefined;

	const items = [first];
	for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
		const item = parseEnumeratedItem(lines[lineIndex] ?? "", lineIndex);
		if (item?.indent === first.indent) items.push(item);
	}
	if (items.length < 2 || items.some(item => item.punctuation !== first.punctuation) || !isEnumeratedSequence(items)) {
		return undefined;
	}
	return { source, lines, items };
}

/** Whether text currently forms a sequential queue list, including an unfinished trailing item. */
export function isQueuedMessageList(text: string): boolean {
	return parseEnumeratedList(text) !== undefined;
}

/** Split a sequential numeric, Roman-numeral, or alphabetic list into queue entries. */
export function splitQueuedMessages(text: string): string[] {
	const list = parseEnumeratedList(text);
	if (!list) {
		const source = text.trim();
		return source ? [source] : [];
	}

	const messages = list.items.map((item, index) => {
		const nextLine = list.items[index + 1]?.line ?? list.lines.length;
		return [item.content, ...list.lines.slice(item.line + 1, nextLine)].join("\n").trim();
	});
	while (messages.at(-1) === "") messages.pop();
	return messages.length > 0 && messages.every(Boolean) ? messages : [list.source];
}
