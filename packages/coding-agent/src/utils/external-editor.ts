/**
 * Utilities for launching an external text editor ($VISUAL / $EDITOR), with an
 * attached-terminal handoff: an Emacs client that marked the keystroke with a
 * nonce is offered the file first, and the configured editor runs only when no
 * client accepts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isInsideTmux, matchesKey, type Terminal, wrapTmuxPassthrough } from "@oh-my-pi/pi-tui";
import { $env, $which, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Returns the user's preferred editor command, or a platform default.
 *
 * Resolution order:
 *   1. `$VISUAL`
 *   2. `$EDITOR`
 *   3. `notepad` on Windows (always present in `%SystemRoot%\System32`)
 *
 * POSIX returns `undefined` when neither variable is set so the caller can
 * surface a warning that nudges the user to configure one.
 */
export function getEditorCommand(): string | undefined {
	const configured = $env.VISUAL?.trim() || $env.EDITOR?.trim();
	if (configured) return configured;
	if (process.platform === "win32") return "notepad";
	return undefined;
}

export interface OpenInEditorOptions {
	/** File extension for the temp file (default: ".md"). */
	extension?: string;
	/** Keep the file's trailing newline instead of trimming it from the returned text. */
	trimTrailingNewline?: boolean;
}

export interface OpenInEditorHandoffOptions extends OpenInEditorOptions {
	/** Client nonce taken with `takeEditorOrigin()` as the entry's first synchronous statement; "" when none. */
	origin: string;
	/** The only place edited text is applied. Awaited before the TUI restarts and before the helper resolves. */
	apply?: (text: string) => void | Promise<void>;
}

/** The subset of TUI the handoff needs; the real TUI satisfies it structurally. */
export interface EditorHost {
	terminal: Pick<Terminal, "write">;
	stop(): void;
	start(): void;
}

/** Milliseconds an attached client has to acknowledge a request. */
export const EDITOR_ACK_TIMEOUT_MS = 500;

type EditorAnswer = "ack" | "done" | "cancel";

let pending: { id: string; queue: EditorAnswer[]; wake?: () => void } | undefined;

// Origin marker armed by an Emacs client. Valid for exactly the next input event
// (the key the marker describes, in any encoding); the event after that clears it.
let armed: { nonce: string; key: "ctrl+g" | "enter"; seen: boolean } | undefined;

const EDITOR_PACKET = /^\x1b_pi:editor-(open|submit|ack|done|cancel);([^\s/\x00-\x1f\x7f-\x9f]*)\x1b\\$/u;

/**
 * Input-listener hook. Consumes `pi:editor-*` packets, tracks the armed origin
 * lease, and consumes ctrl+c as cancel while a request is pending. Returns a
 * consume result for handled input, undefined otherwise.
 */
export function handleEditorInput(data: string): { consume: true } | undefined {
	const match = EDITOR_PACKET.exec(data);
	if (match) {
		const kind = match[1];
		const value = match[2] ?? "";
		if (kind === "open" || kind === "submit") {
			armed = {
				nonce: value,
				key: kind === "open" ? "ctrl+g" : "enter",
				seen: false,
			};
		} else if (pending && pending.id === value) {
			settle(kind as EditorAnswer);
		}
		return { consume: true };
	}
	if (armed) {
		if (!armed.seen && matchesKey(data, armed.key)) armed.seen = true;
		else armed = undefined;
	}
	if (pending && matchesKey(data, "ctrl+c")) {
		settle("cancel");
		return { consume: true };
	}
	return undefined;
}

/** Take the armed client nonce. Call as the entry's first synchronous statement. */
export function takeEditorOrigin(): string | undefined {
	const nonce = armed?.nonce;
	armed = undefined;
	return nonce;
}

/** Whether an editor request is pending (tests and diagnostics). */
export function isEditorRequestPending(): boolean {
	return pending !== undefined;
}

function waitForAnswer(timeoutMs: number | undefined): Promise<EditorAnswer | "timeout"> {
	const { promise, resolve } = Promise.withResolvers<EditorAnswer | "timeout">();
	const current = pending;
	if (!current) {
		resolve("timeout");
		return promise;
	}
	// Answers that arrived before this wait (e.g. done right behind ack) are queued, not lost.
	const queued = current.queue.shift();
	if (queued) {
		resolve(queued);
		return promise;
	}
	const timer = timeoutMs === undefined ? undefined : setTimeout(() => resolve("timeout"), timeoutMs);
	current.wake = () => {
		clearTimeout(timer);
		current.wake = undefined;
		resolve(current.queue.shift()!);
	};
	return promise;
}

function settle(answer: EditorAnswer): void {
	if (!pending) return;
	pending.queue.push(answer);
	pending.wake?.();
}

/** Ghostel `ghostel_cmd` argument quoting: backslash and double quote escaped, whole value in double quotes. */
function quoteOscArg(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Subprocess argv and Windows quoting mode used to launch an external editor. */
export interface EditorSpawnCommand {
	cmd: string[];
	windowsVerbatimArguments: boolean;
}

/** Resolves shell argv without letting the host runtime re-quote the editor command. */
export function resolveEditorSpawnCommand(
	editorCmd: string,
	tmpFile: string,
	platform: NodeJS.Platform = process.platform,
): EditorSpawnCommand {
	const windows = platform === "win32";
	// cmd.exe strips the outer /s /c quote pair; Bun must pass the embedded
	// editor/path quotes verbatim instead of applying argv escaping to them.
	const cmd = windows
		? ["cmd.exe", "/d", "/s", "/c", `"${editorCmd} "${tmpFile}""`]
		: [$which("sh") ?? "sh", "-c", `${editorCmd} "$1"`, "sh", tmpFile];
	return { cmd, windowsVerbatimArguments: windows };
}

/**
 * Opens `content` in an editor and applies the edited text through `options.apply`.
 *
 * Order: offer the file to the attached client that armed `options.origin`
 * (OSC 52;e request, 500 ms ack window, TUI kept running); on decline, stop the
 * TUI, run `$VISUAL`/`$EDITOR`, restart the TUI. Callers must not stop or start
 * the TUI around this call.
 *
 * Returns a status only: the text when applied, `null` when canceled, busy, or
 * the editor failed, `undefined` when no editor is configured.
 */
export async function openInEditor(
	ui: EditorHost,
	content: string,
	options: OpenInEditorHandoffOptions,
): Promise<string | null | undefined> {
	if (pending) return null;
	const id = `r-${Snowflake.next()}`;
	// Reserve the single-flight slot before the first await.
	pending = { id, queue: [] };
	const tmpFile = path.join(os.tmpdir(), `omp-editor-${Snowflake.next()}${options.extension ?? ".md"}`);
	const readEdited = async (): Promise<string | null> => {
		let text: string;
		try {
			text = await Bun.file(tmpFile).text();
		} catch {
			return null;
		}
		if (options.trimTrailingNewline !== false) text = text.replace(/\n$/, "");
		await options.apply?.(text);
		return text;
	};

	try {
		await Bun.write(tmpFile, content);

		// A request without a nonce never opens a buffer in any client, so it is not offered.
		if (options.origin !== "") {
			const request = `\x1b]52;e;${quoteOscArg("claude-code-ide-session-editor-request")} ${quoteOscArg(id)} ${quoteOscArg(options.origin)} ${quoteOscArg(tmpFile)}\x1b\\`;
			ui.terminal.write(isInsideTmux() ? wrapTmuxPassthrough(request) : request);
			const offered = await waitForAnswer(EDITOR_ACK_TIMEOUT_MS);
			if (offered === "cancel") return null;
			if (offered === "ack") {
				// ponytail: no abort is pushed to Emacs after an ack; a ctrl+c here only
				// cancels locally and a late Emacs answer carries a stale id we ignore.
				return (await waitForAnswer(undefined)) === "done" ? await readEdited() : null;
			}
		}

		// Declined: the external editor owns the terminal from here on.
		pending = undefined;
		const editorCmd = getEditorCommand();
		if (!editorCmd) return undefined;
		ui.stop();
		try {
			const spawnCommand = resolveEditorSpawnCommand(editorCmd, tmpFile);
			// Inherit the real pane pty so terminal editors (including emacsclient,
			// which resolves the device via ttyname) render into the visible pane.
			const child = Bun.spawn(spawnCommand.cmd, {
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
				windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments,
			});
			return (await child.exited) === 0 ? await readEdited() : null;
		} finally {
			ui.start();
		}
	} finally {
		pending = undefined;
		try {
			await fs.rm(tmpFile, { force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}
