import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fsPromises } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractFileMentions, generateFileMentionMessages } from "@oh-my-pi/pi-coding-agent/utils/file-mentions";
import { EditStore } from "@oh-my-pi/pi-natives";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await removeWithRetries(dir);
	}
});

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-file-mentions-"));
	tempDirs.push(dir);
	return dir;
}

describe("generateFileMentionMessages path resolution", () => {
	test("auto-reads an exact file path", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await Bun.write(path.join(cwd, "src", "config.ts"), "export const x = 1;");

		const messages = await generateFileMentionMessages(["src/config.ts"], cwd);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		if (message?.role !== "fileMention") {
			throw new Error("expected file mention message");
		}
		expect(message.files).toHaveLength(1);
		expect(message.files[0]?.path).toBe("src/config.ts");
		expect(message.files[0]?.content).toContain("export const x = 1;");
	});

	test("lists an exact directory path", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await Bun.write(path.join(cwd, "src", "index.ts"), "ok");

		const messages = await generateFileMentionMessages(["src"], cwd);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		if (message?.role !== "fileMention") {
			throw new Error("expected file mention message");
		}
		expect(message.files[0]?.path).toBe("src");
		expect(message.files[0]?.content).toContain("index.ts");
	});

	test("does not fuzzy- or prefix-resolve mentions that are not real paths", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
		await Bun.write(path.join(cwd, "docs", "readme.md"), "hello");
		await fs.mkdir(path.join(cwd, "assets"), { recursive: true });
		await Bun.write(path.join(cwd, "assets", "widget-input.svg"), "<svg/>");

		// Partial path (old prefix match), scope-style token and bare substring (old fuzzy
		// match) must all resolve to nothing: the @-selector turns these into real paths
		// before send, so an unresolved mention is prose, not a file reference.
		expect(await generateFileMentionMessages(["docs/rea"], cwd)).toHaveLength(0);
		expect(await generateFileMentionMessages(["widget/"], cwd)).toHaveLength(0);
		expect(await generateFileMentionMessages(["widget"], cwd)).toHaveLength(0);
	});

	test("reads only the mentions that resolve to real paths", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "real.txt"), "present");

		const messages = await generateFileMentionMessages(["real.txt", "does-not-exist.txt"], cwd);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		if (message?.role !== "fileMention") {
			throw new Error("expected file mention message");
		}
		expect(message.files).toHaveLength(1);
		expect(message.files[0]?.path).toBe("real.txt");
		expect(message.files[0]?.content).toContain("present");
	});

	test("resolves quoted paths containing spaces", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "My Folder"), { recursive: true });
		await Bun.write(path.join(cwd, "My Folder", "my file.png"), "image content");

		const mentions = extractFileMentions("Please see @\"My Folder/my file.png\" and @'My Folder/my file.png'");
		expect(mentions).toEqual(["My Folder/my file.png"]);

		const messages = await generateFileMentionMessages(mentions, cwd);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		if (message?.role !== "fileMention") {
			throw new Error("expected file mention message");
		}
		expect(message.files).toHaveLength(1);
		expect(message.files[0]?.path).toBe("My Folder/my file.png");
	});

	test("skips auto-reading a binary file instead of injecting raw bytes", async () => {
		const cwd = await createTempDir();
		// TTF header begins with a NUL run; auto-reading it as text would leak
		// control bytes into the conversation (the reported bug).
		await Bun.write(path.join(cwd, "Silver.ttf"), Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x0c, 0x4f, 0x53]));
		// A non-NUL invalid-UTF8 blob must be refused too, not just NUL-bearing files.
		await Bun.write(path.join(cwd, "blob.bin"), Buffer.from([0x4d, 0x5a, 0xff, 0xfe, 0xc0, 0xc0]));

		const messages = await generateFileMentionMessages(["Silver.ttf", "blob.bin"], cwd);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		if (message?.role !== "fileMention") {
			throw new Error("expected file mention message");
		}
		expect(message.files).toHaveLength(2);
		for (const file of message.files) {
			expect(file.skippedReason).toBe("binary");
			expect(file.content).toContain("binary file");
			expect(file.content).not.toContain("\u0000");
		}
	});
});

describe("generateFileMentionMessages finite ranges", () => {
	const seed = 20260925;
	let state = seed;
	const next = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	};
	const makeLines = (partition: string, count: number) =>
		Array.from({ length: count }, (_, index) => `${partition}-${index}-${next().toString(16)}: café 雪 🦊 e\u0301`);

	for (const [endingName, ending] of [
		["LF", "\n"],
		["CRLF", "\r\n"],
		["CR", "\r"],
	] as const) {
		for (const trailing of [false, true]) {
			for (const span of ["first", "middle", "final", "single"]) {
				// Define the expected selection before constructing the saved source.
				const before = span === "first" ? [] : makeLines("before", 1 + (next() % 5));
				const selected = makeLines("selected", span === "single" ? 1 : 3 + (next() % 4));
				if (selected.length > 1) selected[1] = "";
				const after = span === "final" ? [] : makeLines("after", 1 + (next() % 5));
				const source = [...before, ...selected, ...after];
				const start = before.length + 1;
				const end = before.length + selected.length;
				const coordinates = selected.map((_, index) => start + index);
				const context = `seed=${seed}, ${endingName}, trailing=${trailing}, ${span}, range=${start}-${end}`;

				test(`attaches exact source lines and records only displayed provenance (${context})`, async () => {
					const cwd = await createTempDir();
					const filePath = "source.txt";
					const absolutePath = path.join(cwd, filePath);
					await Bun.write(absolutePath, source.join(ending) + (trailing ? ending : ""));
					const mention = `${filePath}:${start}-${end}`;
					const label = `${filePath}:${start === end ? start : `${start}-${end}`}`;
					const normalized = source.join("\n") + (trailing ? "\n" : "");

					for (const useHashLines of [false, true]) {
						const snapshotStore = new EditStore();
						const messages = await generateFileMentionMessages([mention], cwd, { useHashLines, snapshotStore });
						expect(messages, `${context}, hashLines=${useHashLines}`).toHaveLength(1);
						const message = messages[0];
						if (message?.role !== "fileMention") {
							throw new Error(`Expected a file mention message (${context}, hashLines=${useHashLines}).`);
						}
						expect(message.files).toHaveLength(1);
						const file = message.files[0];
						expect(file?.path).toBe(label);
						expect(file?.lineCount).toBe(selected.length);
						if (!useHashLines) {
							expect(file?.content).toBe(selected.join("\n"));
							continue;
						}

						const tag = snapshotStore.headHash(absolutePath);
						expect(tag).toMatch(/^[0-9A-F]{4}$/);
						if (!tag) throw new Error(`Expected a full-file snapshot (${context}).`);
						expect(snapshotStore.headText(absolutePath)).toBe(normalized);
						expect(snapshotStore.byHashText(absolutePath, tag)).toBe(normalized);
						expect(snapshotStore.headText(`${absolutePath}:${start}-${end}`)).toBeNull();
						expect(file?.content).toBe(
							`[${filePath}#${tag}]\n${selected.map((line, index) => `${coordinates[index]}:${line}`).join("\n")}`,
						);
						expect(snapshotStore.seenLines(absolutePath, tag)).toEqual(coordinates);
					}
				});
			}
		}
	}
});

describe("generateFileMentionMessages mixed mentions", () => {
	test("preserves whole files, single lines, and distinct authored ranges", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "whole.txt"), "whole file");
		await Bun.write(path.join(cwd, "source notes.txt"), "one\ntwo\nthree\nfour\nfive");
		const prompt =
			'@whole.txt @"source notes.txt:2" @"source notes.txt:2-2" @"source notes.txt:4-9" @"source notes.txt:4-6" @"source notes.txt:2"';
		const messages = await generateFileMentionMessages(extractFileMentions(prompt), cwd);
		const files = messages.flatMap(message => (message.role === "fileMention" ? message.files : []));
		expect(files.map(file => [file.path, file.content, file.lineCount])).toEqual([
			["whole.txt", "whole file", 1],
			["source notes.txt:2", "two", 1],
			["source notes.txt:2", "two", 1],
			["source notes.txt:4-5", "four\nfive", 2],
			["source notes.txt:4-5", "four\nfive", 2],
		]);
	});

	test.skipIf(process.platform === "win32")(
		"prefers readable literal filenames over valid and invalid selectors",
		async () => {
			const cwd = await createTempDir();
			await Bun.write(path.join(cwd, "file"), "base must not appear");
			const names = ["file:2-3", "file:0-3", "file:3-1", "file:"];
			for (const name of names) await Bun.write(path.join(cwd, name), `literal ${name}`);
			const messages = await generateFileMentionMessages(
				extractFileMentions(names.map(name => `@"${name}"`).join(" ")),
				cwd,
			);
			const files = messages.flatMap(message => (message.role === "fileMention" ? message.files : []));
			expect(files.map(file => [file.path, file.content])).toEqual(names.map(name => [name, `literal ${name}`]));
		},
	);

	test("keeps trailing colon punctuation separate from quoted and fractional selectors", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "file"), "ordinary whole file");
		const messages = await generateFileMentionMessages(extractFileMentions('@file: @"file:" @file:2.3'), cwd);
		const files = messages.flatMap(message => (message.role === "fileMention" ? message.files : []));
		expect(files.map(file => [file.path, file.content])).toEqual([["file", "ordinary whole file"]]);
	});
});

describe("generateFileMentionMessages range boundaries", () => {
	test("rejects invalid selections without losing an independent valid mention", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "source"), "outside\nselected\nlast\n");
		await Bun.write(path.join(cwd, "empty"), "");
		const invalid = [
			"source:0-3",
			"source:-1-3",
			"source:3-1",
			"source:2.3",
			"source:1.5-3",
			"source:9007199254740992",
			"source:1-9007199254740992",
			"source:2-",
			"source:1,3",
			"source:raw:1-3",
			"source#L2",
			"source:4-9",
			"empty:1",
			"missing:1-3",
		];
		for (const mention of invalid) {
			const messages = await generateFileMentionMessages([mention, "source:2"], cwd);
			const files = messages.flatMap(message => (message.role === "fileMention" ? message.files : []));
			expect(
				files.map(file => [file.path, file.content]),
				mention,
			).toEqual([["source:2", "selected"]]);
		}
	});

	test("preserves selected blank lines and clips only the requested end", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "blank"), "\n");
		await Bun.write(path.join(cwd, "source"), "outside\nselected\n\n");
		for (const useHashLines of [false, true]) {
			const snapshotStore = new EditStore();
			const messages = await generateFileMentionMessages(["blank:1", "source:2-99", "source:4"], cwd, {
				useHashLines,
				snapshotStore,
			});
			const files = messages.flatMap(message => (message.role === "fileMention" ? message.files : []));
			expect(files.map(file => [file.path, file.lineCount])).toEqual([
				["blank:1", 1],
				["source:2-3", 2],
			]);
			if (useHashLines) {
				expect(files[0]?.content.split("\n").slice(1)).toEqual(["1:"]);
				expect(files[1]?.content.split("\n").slice(1)).toEqual(["2:selected", "3:"]);
				const tag = snapshotStore.headHash(path.join(cwd, "source"))!;
				expect(snapshotStore.seenLines(path.join(cwd, "source"), tag)).toEqual([2, 3]);
			} else {
				expect(files.map(file => file.content)).toEqual(["", "selected\n"]);
			}
		}
	});

	test("never converts directory, image, video, or binary ranges into source text", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "directory"));
		await Bun.write(path.join(cwd, "directory", "private.txt"), "do not list");
		await Bun.write(
			path.join(cwd, "image.png"),
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=",
				"base64",
			),
		);
		await Bun.write(path.join(cwd, "video.mp4"), "do not decode");
		await Bun.write(path.join(cwd, "binary"), new Uint8Array([0, 1, 2, 3]));
		const messages = await generateFileMentionMessages(
			["directory:1", "image.png:1", "video.mp4:1", "binary:1"],
			cwd,
		);
		const files = messages.flatMap(message => (message.role === "fileMention" ? message.files : []));
		expect(files.map(file => [file.path, file.skippedReason, file.image])).toEqual([
			["binary:1", "binary", undefined],
		]);
	});

	test.skipIf(process.platform === "win32")("does not reinterpret dangling literal links", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "source"), "base must not appear");
		await fs.symlink("missing-target", path.join(cwd, "source:1"));
		expect(await generateFileMentionMessages(["source:1"], cwd)).toEqual([]);
	});

	test("does not read a different file after an inconclusive literal-path probe", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "source"), "base must not appear");
		const probe = spyOn(fsPromises, "lstat").mockRejectedValueOnce(
			Object.assign(new Error("Access denied"), { code: "EACCES" }),
		);
		try {
			expect(await generateFileMentionMessages(["source:1"], cwd)).toEqual([]);
		} finally {
			probe.mockRestore();
		}
	});

	test("keeps the source-file size limit for a one-line selection", async () => {
		const cwd = await createTempDir();
		const limit = 5 * 1024 * 1024;
		for (const size of [limit - 1, limit, limit + 1]) {
			await Bun.write(path.join(cwd, "large"), `visible\n${"x".repeat(size - 8)}`);
			const messages = await generateFileMentionMessages(["large:1"], cwd);
			const file = messages.flatMap(message => (message.role === "fileMention" ? message.files : []))[0]!;
			expect(file.path, `source bytes=${size}`).toBe("large:1");
			if (size <= limit) expect(file.content).toBe("visible");
			else {
				expect(file.skippedReason).toBe("tooLarge");
				expect(file.byteSize).toBe(size);
				expect(file.content).not.toContain("visible");
			}
		}
	});

	test("limits selected output lines without marking notices or omitted rows as seen", async () => {
		const cwd = await createTempDir();
		for (const count of [2999, 3000, 3001]) {
			const selected = Array.from({ length: count }, (_, index) => `selected-${index}`);
			const source = ["outside-a", "outside-b", ...selected, "outside-z"].join("\n");
			const absolutePath = path.join(cwd, "lines");
			await Bun.write(absolutePath, source);
			const snapshotStore = new EditStore();
			const messages = await generateFileMentionMessages([`lines:3-${count + 2}`], cwd, {
				useHashLines: true,
				snapshotStore,
			});
			const file = messages.flatMap(message => (message.role === "fileMention" ? message.files : []))[0]!;
			const rows = file.content.split("\n").filter(line => /^\d+:/.test(line));
			expect(rows).toEqual(selected.slice(0, 3000).map((line, index) => `${index + 3}:${line}`));
			const tag = snapshotStore.headHash(absolutePath)!;
			expect(snapshotStore.headText(absolutePath)).toBe(source);
			expect(snapshotStore.seenLines(absolutePath, tag)).toEqual(rows.map((_, index) => index + 3));
			expect(file.lineCount).toBe(count);
			expect(file.content).not.toContain("outside-");
			if (count > 3000) {
				expect(file.content).toMatch(/\[Showing lines 3-3002 of 3004\./);
				expect(file.content).not.toMatch(/^\d+:\[Showing/m);
			}
		}
	});

	test("keeps UTF-8 byte limits and original coordinates for oversized selected lines", async () => {
		const cwd = await createTempDir();
		const limit = 50 * 1024;
		for (const bytes of [limit - 2, limit, limit + 2]) {
			const selected = "a".repeat(bytes % 3) + "雪".repeat(Math.floor(bytes / 3));
			const source = `outside\n${selected}\noutside-tail`;
			const absolutePath = path.join(cwd, "bytes");
			await Bun.write(absolutePath, source);
			const snapshotStore = new EditStore();
			const messages = await generateFileMentionMessages(["bytes:2"], cwd, { useHashLines: true, snapshotStore });
			const file = messages.flatMap(message => (message.role === "fileMention" ? message.files : []))[0]!;
			const row = file.content.split("\n").find(line => line.startsWith("2:"))!;
			const displayed = row.slice(2);
			expect(selected.startsWith(displayed)).toBe(true);
			expect(Buffer.byteLength(displayed)).toBeLessThanOrEqual(limit);
			if (bytes <= limit) expect(displayed).toBe(selected);
			else expect(Buffer.byteLength(displayed)).toBeGreaterThan(limit - 3);
			expect(file.content).not.toContain("�");
			expect(file.content).not.toContain("outside");
			const tag = snapshotStore.headHash(absolutePath)!;
			expect(snapshotStore.headText(absolutePath)).toBe(source);
			expect(snapshotStore.seenLines(absolutePath, tag)).toEqual([2]);
			if (bytes > limit) expect(file.content).toMatch(/\[Line 2 is /);
		}
	});
});
