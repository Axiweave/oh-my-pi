import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	EDITOR_ACK_TIMEOUT_MS,
	type EditorHost,
	getEditorCommand,
	handleEditorInput,
	isEditorRequestPending,
	openInEditor,
	resolveEditorSpawnCommand,
	takeEditorOrigin,
} from "../src/utils/external-editor";

/** Terminal-facing host: records writes, counts stop/start, and resolves `requested` when the OSC request lands. */
class FakeHost implements EditorHost {
	output = "";
	stops = 0;
	starts = 0;
	readonly requested: Promise<void>;
	readonly #requested = Promise.withResolvers<void>();
	terminal = {
		write: (data: string) => {
			this.output += data;
			this.#requested.resolve();
		},
	};
	constructor() {
		this.requested = this.#requested.promise;
	}
	stop(): void {
		this.stops += 1;
	}
	start(): void {
		this.starts += 1;
	}
	/** The OSC request's arguments: [command, id, nonce, path]. */
	request(): string[] {
		const match = /\x1b\]52;e;(.*)\x1b\\$/.exec(this.output);
		if (!match) throw new Error(`no request in ${JSON.stringify(this.output)}`);
		return [...match[1]!.matchAll(/"((?:\\.|[^"\\])*)"/g)].map(m => m[1]!.replaceAll(/\\(.)/g, "$1"));
	}
}

function packet(kind: string, value: string): string {
	return `\x1b_pi:editor-${kind};${value}\x1b\\`;
}

/** Wait for the request, then answer it with the given packets. */
async function answer(host: FakeHost, ...kinds: string[]): Promise<void> {
	await host.requested;
	const id = host.request()[1]!;
	for (const kind of kinds) expect(handleEditorInput(packet(kind, id))).toEqual({ consume: true });
}

/** Wait for the request, then let the ack window elapse under fake timers. */
async function decline(host: FakeHost): Promise<void> {
	await host.requested;
	vi.advanceTimersByTime(EDITOR_ACK_TIMEOUT_MS);
}

interface MutableProcess {
	platform: NodeJS.Platform;
}

function setPlatform(value: NodeJS.Platform): void {
	(process as unknown as MutableProcess).platform = value;
}

describe("getEditorCommand", () => {
	const originalPlatform = process.platform;
	const originalVisual = Bun.env.VISUAL;
	const originalEditor = Bun.env.EDITOR;

	afterEach(() => {
		setPlatform(originalPlatform);
		if (originalVisual === undefined) delete Bun.env.VISUAL;
		else Bun.env.VISUAL = originalVisual;
		if (originalEditor === undefined) delete Bun.env.EDITOR;
		else Bun.env.EDITOR = originalEditor;
	});

	it("prefers $VISUAL over $EDITOR and the platform default", () => {
		Bun.env.VISUAL = "nvim";
		Bun.env.EDITOR = "nano";
		setPlatform("win32");
		expect(getEditorCommand()).toBe("nvim");
	});

	it("falls back to $EDITOR when $VISUAL is unset", () => {
		delete Bun.env.VISUAL;
		Bun.env.EDITOR = "nano";
		expect(getEditorCommand()).toBe("nano");
	});

	it("trims whitespace so an accidentally padded value still works", () => {
		Bun.env.VISUAL = "  code --wait  ";
		delete Bun.env.EDITOR;
		expect(getEditorCommand()).toBe("code --wait");
	});

	it("treats a whitespace-only $VISUAL as unset and consults $EDITOR", () => {
		Bun.env.VISUAL = "   ";
		Bun.env.EDITOR = "vim";
		expect(getEditorCommand()).toBe("vim");
	});

	it("defaults to notepad on Windows when neither variable is set", () => {
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;
		setPlatform("win32");
		expect(getEditorCommand()).toBe("notepad");
	});

	it("returns undefined on POSIX when neither variable is set", () => {
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;
		setPlatform("linux");
		expect(getEditorCommand()).toBeUndefined();
	});
});

describe("openInEditor handoff", () => {
	const originalVisual = Bun.env.VISUAL;
	const originalEditor = Bun.env.EDITOR;
	let host: FakeHost;

	beforeEach(() => {
		vi.useFakeTimers();
		host = new FakeHost();
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;
		takeEditorOrigin();
	});

	afterEach(() => {
		vi.useRealTimers();
		if (originalVisual === undefined) delete Bun.env.VISUAL;
		else Bun.env.VISUAL = originalVisual;
		if (originalEditor === undefined) delete Bun.env.EDITOR;
		else Bun.env.EDITOR = originalEditor;
	});

	it("ack then done reads the file, awaits apply, and never stops the TUI", async () => {
		const applyStarted = Promise.withResolvers<string>();
		const applyGate = Promise.withResolvers<void>();
		const result = openInEditor(host, "draft\n", {
			origin: "n1",
			apply: async text => {
				applyStarted.resolve(text);
				await applyGate.promise;
			},
		});
		await host.requested;
		const [command, id, nonce, file] = host.request();
		expect(command).toBe("claude-code-ide-session-editor-request");
		expect(nonce).toBe("n1");
		expect(file!.endsWith(".md")).toBe(true);
		expect(fs.readFileSync(file!, "utf8")).toBe("draft\n");
		handleEditorInput(packet("ack", id!));
		fs.writeFileSync(file!, "edited\n");
		handleEditorInput(packet("done", id!));
		let settled = false;
		void result.then(() => {
			settled = true;
		});
		expect(await applyStarted.promise).toBe("edited");
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(settled).toBe(false);
		applyGate.resolve();
		expect(await result).toBe("edited");
		expect(host.stops).toBe(0);
		expect(host.starts).toBe(0);
		expect(fs.existsSync(file!)).toBe(false);
		expect(isEditorRequestPending()).toBe(false);
	});

	it("cancel returns null, keeps the draft, and applies nothing", async () => {
		const apply = vi.fn();
		const result = openInEditor(host, "draft", { origin: "n1", apply });
		await answer(host, "ack", "cancel");
		expect(await result).toBeNull();
		expect(apply).not.toHaveBeenCalled();
	});

	it("ignores answers for a stale request id", async () => {
		const result = openInEditor(host, "draft", { origin: "n1" });
		await host.requested;
		expect(handleEditorInput(packet("ack", "r-stale"))).toEqual({
			consume: true,
		});
		expect(handleEditorInput(packet("done", "r-stale"))).toEqual({
			consume: true,
		});
		expect(isEditorRequestPending()).toBe(true);
		await answer(host, "ack", "cancel");
		expect(await result).toBeNull();
	});

	it("no ack within the window and no editor returns undefined without stopping the TUI", async () => {
		const result = openInEditor(host, "draft", { origin: "n1" });
		await decline(host);
		expect(await result).toBeUndefined();
		expect(host.stops).toBe(0);
		expect(isEditorRequestPending()).toBe(false);
	});

	it("no ack with an editor stops the TUI, spawns it, awaits apply, then restarts", async () => {
		Bun.env.EDITOR = "editor";
		const order: string[] = [];
		host.stop = () => order.push("stop");
		host.start = () => order.push("start");
		const applyStarted = Promise.withResolvers<void>();
		const applyGate = Promise.withResolvers<void>();
		const spawn = spyOn(Bun, "spawn").mockImplementation((() => {
			order.push("spawn");
			return { exited: Promise.resolve(0) };
		}) as never);
		try {
			const result = openInEditor(host, "draft\n", {
				origin: "n1",
				apply: async () => {
					order.push("apply");
					applyStarted.resolve();
					await applyGate.promise;
				},
			});
			await decline(host);
			await applyStarted.promise;
			expect(order).toEqual(["stop", "spawn", "apply"]);
			applyGate.resolve();
			expect(await result).toBe("draft");
			expect(order).toEqual(["stop", "spawn", "apply", "start"]);
			expect(spawn.mock.calls[0]?.[1]).toMatchObject({
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
		} finally {
			spawn.mockRestore();
		}
	});

	it("an empty origin skips the offer and goes straight to the fallback", async () => {
		expect(await openInEditor(host, "draft", { origin: "" })).toBeUndefined();
		expect(host.output).toBe("");
	});

	it("editor exit code other than zero returns null without apply", async () => {
		Bun.env.EDITOR = "editor";
		const spawn = spyOn(Bun, "spawn").mockReturnValue({
			exited: Promise.resolve(1),
		} as never);
		const apply = vi.fn();
		try {
			expect(await openInEditor(host, "draft", { origin: "", apply })).toBeNull();
			expect(apply).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
		}
	});

	it("ctrl+c before the ack cancels, is consumed, and keeps the draft", async () => {
		const apply = vi.fn();
		const result = openInEditor(host, "draft", { origin: "n1", apply });
		await host.requested;
		expect(handleEditorInput("\x03")).toEqual({ consume: true });
		expect(await result).toBeNull();
		expect(apply).not.toHaveBeenCalled();
		expect(host.stops).toBe(0);
	});

	it("ctrl+c after the ack cancels and is consumed", async () => {
		const result = openInEditor(host, "draft", { origin: "n1" });
		await answer(host, "ack");
		expect(handleEditorInput("\x03")).toEqual({ consume: true });
		expect(await result).toBeNull();
	});

	it("ctrl+c with no pending request passes through", () => {
		expect(handleEditorInput("\x03")).toBeUndefined();
	});

	it("a second entry while one is pending returns null with no file and no packet", async () => {
		const first = openInEditor(host, "draft", { origin: "n1" });
		await host.requested;
		const outputBefore = host.output;
		expect(await openInEditor(host, "other", { origin: "n2" })).toBeNull();
		expect(host.output).toBe(outputBefore);
		await answer(host, "ack", "cancel");
		expect(await first).toBeNull();
	});

	it("round-trips 64 KB of mixed content on the handoff path", async () => {
		const chunk = 'quote " backslash \\ tab \t non-ascii ✓ é\n\n';
		const content = chunk.repeat(Math.ceil(65536 / chunk.length));
		const applied: string[] = [];
		const result = openInEditor(host, content, {
			origin: "n1",
			apply: text => void applied.push(text),
		});
		await answer(host, "ack", "done");
		expect(await result).toBe(content.replace(/\n$/, ""));
		expect(applied[0]).toBe(content.replace(/\n$/, ""));
	});

	it("round-trips 64 KB of mixed content on the fallback path", async () => {
		Bun.env.EDITOR = "editor";
		const chunk = 'quote " backslash \\ tab \t non-ascii ✓ é\n\n';
		const content = chunk.repeat(Math.ceil(65536 / chunk.length));
		const spawn = spyOn(Bun, "spawn").mockReturnValue({
			exited: Promise.resolve(0),
		} as never);
		try {
			expect(
				await openInEditor(host, content, {
					origin: "",
					trimTrailingNewline: false,
				}),
			).toBe(content);
		} finally {
			spawn.mockRestore();
		}
	});

	it("quotes backslashes and double quotes in the request arguments", async () => {
		const result = openInEditor(host, "x", { origin: 'a"b\\c' });
		await host.requested;
		expect(host.request()[2]).toBe('a"b\\c');
		await answer(host, "cancel");
		await result;
	});
});

describe("editor origin lease", () => {
	beforeEach(() => {
		takeEditorOrigin();
	});

	it("editor-open marker plus the raw key arms the nonce for that key", () => {
		expect(handleEditorInput(packet("open", "abc"))).toEqual({ consume: true });
		expect(handleEditorInput("\x07")).toBeUndefined();
		expect(takeEditorOrigin()).toBe("abc");
		expect(takeEditorOrigin()).toBeUndefined();
	});

	it("editor-submit marker plus Return arms the nonce for the submit", () => {
		handleEditorInput(packet("submit", "abc"));
		expect(handleEditorInput("\r")).toBeUndefined();
		expect(takeEditorOrigin()).toBe("abc");
	});

	it("the event after the key clears an untaken nonce", () => {
		handleEditorInput(packet("open", "abc"));
		handleEditorInput("\x07");
		handleEditorInput("x");
		expect(takeEditorOrigin()).toBeUndefined();
	});

	it("an ordinary character between the marker and the key clears the nonce", () => {
		handleEditorInput(packet("open", "abc"));
		handleEditorInput("x");
		handleEditorInput("\x07");
		expect(takeEditorOrigin()).toBeUndefined();
	});

	it("a plain key without a marker yields no origin", () => {
		handleEditorInput("\x07");
		expect(takeEditorOrigin()).toBeUndefined();
	});

	it("a pre-existing pi packet is not consumed here", () => {
		expect(handleEditorInput("\x1b_pi:prompt;help\x1b\\")).toBeUndefined();
	});
});

describe("openInEditor spawn", () => {
	it("passes the cmd.exe command line verbatim on Windows", () => {
		const tmpFile = String.raw`C:\Users\Example User\AppData\Local\Temp\omp-editor-123.omp.md`;

		expect(resolveEditorSpawnCommand('"C:\\Program Files\\Code.exe" --wait', tmpFile, "win32")).toEqual({
			cmd: [
				"cmd.exe",
				"/d",
				"/s",
				"/c",
				String.raw`""C:\Program Files\Code.exe" --wait "C:\Users\Example User\AppData\Local\Temp\omp-editor-123.omp.md""`,
			],
			windowsVerbatimArguments: true,
		});
	});

	it.skipIf(process.platform === "win32")("supports quoted editor paths containing spaces", async () => {
		const tempDir = TempDir.createSync("@external-editor-");
		const originalEditor = Bun.env.EDITOR;
		const originalVisual = Bun.env.VISUAL;
		try {
			const editorPath = path.join(tempDir.path(), "My Editor", "edit");
			fs.mkdirSync(path.dirname(editorPath), { recursive: true });
			await Bun.write(editorPath, '#!/bin/sh\nprintf "edited" > "$1"\n');
			fs.chmodSync(editorPath, 0o755);
			delete Bun.env.VISUAL;
			Bun.env.EDITOR = `"${editorPath}"`;

			const result = await openInEditor(new FakeHost(), "original", {
				origin: "",
			});

			expect(result).toBe("edited");
		} finally {
			if (originalEditor === undefined) delete Bun.env.EDITOR;
			else Bun.env.EDITOR = originalEditor;
			if (originalVisual === undefined) delete Bun.env.VISUAL;
			else Bun.env.VISUAL = originalVisual;
			await tempDir.remove();
		}
	});
});
