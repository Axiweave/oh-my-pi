/**
 * Auto-read file mentions from user prompts.
 *
 * When users reference files with @path syntax (e.g., "@src/foo.ts"),
 * we automatically inject the file contents as a FileMentionMessage
 * so the agent doesn't need to read them manually.
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import type { EditStore } from "@oh-my-pi/pi-natives";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { formatAge, formatBytes, isProbablyBinary, readImageMetadata } from "@oh-my-pi/pi-utils";
import {
	formatHashlineHeader,
	formatNumberedLines,
	splitAddressableFileLines,
} from "@oh-my-pi/pi-tui/tools/hashline-format";
import { normalizeToLF } from "../edit/normalize";
import type { FileMentionMessage } from "../session/messages";
import {
	DEFAULT_MAX_BYTES,
	formatHeadTruncationNotice,
	truncateHead,
	truncateHeadBytes,
} from "@oh-my-pi/pi-tui/tools/streaming-output";
import { probeLiteralPathExists, resolveReadPath } from "../tools/path-utils";
import { formatDimensionNote, resizeImage } from "./image-resize";
import { VideoError, buildVideoContactSheetPng, formatVideoDetails, probeVideo, videoMimeForPath } from "./video";
import { createVideoPreviewImage, isVideoPath } from "@oh-my-pi/pi-tui/prompt/video";

/** Regex to match @filepath patterns in text */
const FILE_MENTION_REGEX = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
const LEADING_PUNCTUATION_REGEX = /^[`"'([{<]+/;
const TRAILING_PUNCTUATION_REGEX = /[)\]}>.,;:!?"'`]+$/;
const MENTION_BOUNDARY_REGEX = /[\s([{<"'`]/;
const DEFAULT_DIR_LIMIT = 500;

// Avoid OOM when users @mention very large files. Above these limits we skip
// auto-reading and only include the path in the message.
const MAX_AUTO_READ_TEXT_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_AUTO_READ_IMAGE_BYTES = 25 * 1024 * 1024; // 25MB

function isMentionBoundary(text: string, index: number): boolean {
	if (index === 0) return true;
	return MENTION_BOUNDARY_REGEX.test(text[index - 1]);
}

function sanitizeMentionPath(rawPath: string): string | null {
	let cleaned = rawPath.trim();
	cleaned = cleaned.replace(LEADING_PUNCTUATION_REGEX, "");
	cleaned = cleaned.replace(TRAILING_PUNCTUATION_REGEX, "");
	cleaned = cleaned.trim();
	return cleaned.length > 0 ? cleaned : null;
}

async function resolveMentionPath(
	filePath: string,
	cwd: string,
): Promise<{ resolvedPath: string; absolutePath: string; range?: { start: number; end: number } } | null> {
	// Literal filenames win. Only a confirmed missing entry permits a range suffix.
	let range: { start: number; end: number } | undefined;
	const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(filePath);
	if (match && (await probeLiteralPathExists(filePath, cwd)) === "missing") {
		const start = Number(match[2]);
		const end = Number(match[3] ?? match[2]);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
		filePath = match[1];
		range = { start, end };
	}
	const absolutePath = resolveReadPath(filePath, cwd);
	try {
		await Bun.file(absolutePath).stat();
		return { resolvedPath: filePath, absolutePath, range };
	} catch {
		return null;
	}
}

function buildTextOutput(
	textContent: string,
	startLine = 1,
	sourceLineCount?: number,
): { output: string; notice: string; lineCount: number } {
	const allLines = textContent.split("\n");
	const lineCount = allLines.length;
	const truncation = truncateHead(textContent);

	if (truncation.firstLineExceedsLimit) {
		const firstLine = allLines[0] ?? "";
		const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
		const snippet = truncateHeadBytes(firstLine, DEFAULT_MAX_BYTES);
		const notice =
			snippet.text.length > 0
				? `\n\n[Line ${startLine} is ${formatBytes(firstLineBytes)}, exceeds ${formatBytes(
						DEFAULT_MAX_BYTES,
					)} limit. Showing first ${formatBytes(snippet.bytes)} of the line.]`
				: `[Line ${startLine} is ${formatBytes(firstLineBytes)}, exceeds ${formatBytes(
						DEFAULT_MAX_BYTES,
					)} limit. Unable to display a valid UTF-8 snippet.]`;
		return { output: snippet.text, notice, lineCount };
	}

	return {
		output: truncation.content,
		notice: formatHeadTruncationNotice(truncation, { startLine, totalFileLines: sourceLineCount ?? lineCount }),
		lineCount,
	};
}

async function buildDirectoryListing(absolutePath: string): Promise<{ output: string; lineCount: number }> {
	let entries: string[];
	try {
		entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: absolutePath, dot: true, onlyFiles: false }));
	} catch {
		return { output: "(empty directory)", lineCount: 1 };
	}

	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

	const results: string[] = [];
	let entryLimitReached = false;

	for (const entry of entries) {
		if (results.length >= DEFAULT_DIR_LIMIT) {
			entryLimitReached = true;
			break;
		}

		const fullPath = path.join(absolutePath, entry);
		let suffix = "";
		let age = "";

		try {
			const stat = await Bun.file(fullPath).stat();
			if (stat.isDirectory()) {
				suffix = "/";
			}
			const ageSeconds = Math.floor((Date.now() - stat.mtimeMs) / 1000);
			age = formatAge(ageSeconds);
		} catch {
			continue;
		}

		const line = age ? `${entry}${suffix} (${age})` : `${entry}${suffix}`;
		results.push(line);
	}

	if (results.length === 0) {
		return { output: "(empty directory)", lineCount: 1 };
	}

	const rawOutput = results.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;

	const notices: string[] = [];
	if (entryLimitReached) {
		notices.push(`${DEFAULT_DIR_LIMIT} entries limit reached. Use limit=${DEFAULT_DIR_LIMIT * 2} for more`);
	}
	if (truncation.truncated) {
		notices.push(`${formatBytes(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}

	return { output, lineCount: output.split("\n").length };
}

/** Extract all @filepath mentions from text */
export function extractFileMentions(text: string): string[] {
	const matches = [...text.matchAll(FILE_MENTION_REGEX)];
	const mentions: string[] = [];

	for (const match of matches) {
		const index = match.index ?? 0;
		if (!isMentionBoundary(text, index)) continue;

		const rawPath = match[1] ?? match[2] ?? match[3];
		if (!rawPath) continue;

		const cleaned = match[1] !== undefined || match[2] !== undefined ? rawPath.trim() : sanitizeMentionPath(rawPath);
		if (!cleaned) continue;

		mentions.push(cleaned);
	}

	return [...new Set(mentions)];
}

/**
 * Generate a FileMentionMessage containing the contents of mentioned files.
 * Returns empty array if no files could be read.
 */
export async function generateFileMentionMessages(
	filePaths: string[],
	cwd: string,
	options?: { autoResizeImages?: boolean; useHashLines?: boolean; snapshotStore?: EditStore },
): Promise<AgentMessage[]> {
	if (filePaths.length === 0) return [];

	const autoResizeImages = options?.autoResizeImages ?? true;

	const files: FileMentionMessage["files"] = [];

	for (const filePath of filePaths) {
		const resolved = await resolveMentionPath(filePath, cwd);
		if (!resolved) {
			continue;
		}
		const { resolvedPath, absolutePath, range } = resolved;
		try {
			const stat = await Bun.file(absolutePath).stat();
			if (stat.isDirectory()) {
				if (range) continue;
				const { output, lineCount } = await buildDirectoryListing(absolutePath);
				files.push({ path: resolvedPath, content: output, lineCount });
				continue;
			}

			const imageMetadata = await readImageMetadata(absolutePath);
			const mimeType = imageMetadata?.mimeType;
			if (mimeType) {
				if (range) continue;
				if (stat.size > MAX_AUTO_READ_IMAGE_BYTES) {
					files.push({
						path: resolvedPath,
						content: `(skipped auto-read: too large, ${formatBytes(stat.size)})`,
						byteSize: stat.size,
						skippedReason: "tooLarge",
					});
					continue;
				}
				const buffer = await fs.readFile(absolutePath);
				if (buffer.length === 0) {
					continue;
				}

				const base64Content = buffer.toBase64();
				let image: ImageContent = { type: "image", mimeType, data: base64Content };
				let dimensionNote: string | undefined;

				if (autoResizeImages) {
					try {
						const resized = await resizeImage({ type: "image", data: base64Content, mimeType });
						dimensionNote = formatDimensionNote(resized);
						image = {
							type: "image",
							mimeType: resized.mimeType,
							data: resized.data,
						};
					} catch {
						image = { type: "image", mimeType, data: base64Content };
					}
				}

				files.push({ path: resolvedPath, content: dimensionNote ?? "", image });
				continue;
			}

			if (isVideoPath(absolutePath)) {
				if (range) continue;
				try {
					const meta = await probeVideo(absolutePath);
					const sheet = await buildVideoContactSheetPng(absolutePath, meta);
					let image: ImageContent = { type: "image", data: sheet.png.data, mimeType: sheet.png.mimeType };
					let dimensionNote: string | undefined;
					if (autoResizeImages) {
						try {
							const resized = await resizeImage(image);
							dimensionNote = formatDimensionNote(resized);
							image = { type: "image", mimeType: resized.mimeType, data: resized.data };
						} catch {
							// Keep the extracted sheet when resize fails.
						}
					}
					const details = formatVideoDetails(resolvedPath, meta, stat.size, videoMimeForPath(absolutePath));
					files.push({
						path: resolvedPath,
						content: `${details}\nPreview grid: ${sheet.thumbs} frames (${sheet.cols}x${sheet.rows})${dimensionNote ? `\n${dimensionNote}` : ""}`,
						image: createVideoPreviewImage(image, absolutePath),
					});
				} catch (error) {
					const reason = error instanceof VideoError ? error.message : "video preview failed";
					files.push({
						path: resolvedPath,
						content: `(skipped auto-read: ${reason})`,
						byteSize: stat.size,
						skippedReason: "binary",
					});
				}
				continue;
			}

			if (stat.size > MAX_AUTO_READ_TEXT_BYTES) {
				files.push({
					path: filePath,
					content: `(skipped auto-read: too large, ${formatBytes(stat.size)})`,
					byteSize: stat.size,
					skippedReason: "tooLarge",
				});
				continue;
			}
			if (await isProbablyBinary(absolutePath)) {
				files.push({
					path: filePath,
					content: `(skipped auto-read: binary file, ${formatBytes(stat.size)})`,
					byteSize: stat.size,
					skippedReason: "binary",
				});
				continue;
			}

			const content = await Bun.file(absolutePath).text();
			const snapshotStore = options?.useHashLines ? options.snapshotStore : undefined;
			const normalized = snapshotStore || range ? normalizeToLF(content) : content;
			const sourceLines = snapshotStore || range ? splitAddressableFileLines(normalized) : undefined;
			const startLine = range?.start ?? 1;
			const endLine = range ? Math.min(range.end, sourceLines!.length) : undefined;
			if (range && startLine > endLine!) continue;
			const displayText = range
				? sourceLines!.slice(startLine - 1, endLine).join("\n")
				: sourceLines
					? sourceLines.join("\n")
					: normalized;
			const { output: body, notice, lineCount } = buildTextOutput(displayText, startLine, sourceLines?.length);
			let output = range ? body : body + notice;
			if (snapshotStore) {
				const tag = snapshotStore.recordSnapshot(absolutePath, normalized);
				output = formatNumberedLines(output, startLine);
				if (range) snapshotStore.recordSeenLinesFromBody(absolutePath, tag, output);
				output = `${formatHashlineHeader(resolvedPath, tag)}\n${output}`;
			}
			if (range) output += notice;
			const label = range
				? `${resolvedPath}:${startLine}${startLine === endLine ? "" : `-${endLine}`}`
				: resolvedPath;
			files.push({ path: label, content: output, lineCount });
		} catch {
			// File doesn't exist or isn't readable - skip silently
		}
	}

	if (files.length === 0) return [];

	const message: FileMentionMessage = {
		role: "fileMention",
		files,
		timestamp: Date.now(),
	};

	return [message];
}
