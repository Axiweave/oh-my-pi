import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { takeEditorOrigin } from "../../src/utils/external-editor";

/** One PTY write reaches the TUI as one event per sequence, as StdinBuffer splits it. */
function feed(term: VirtualTerminal, ...events: string[]): void {
	for (const event of events) term.sendInput(event);
}

describe("composer editor-origin markers", () => {
	let composer: Composer | undefined;

	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		composer?.stop();
		composer = undefined;
		takeEditorOrigin();
	});

	function start(): { term: VirtualTerminal; received: string[] } {
		const term = new VirtualTerminal(80, 24);
		composer = new Composer({
			terminal: term,
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const received: string[] = [];
		const original = composer.editor.handleInput.bind(composer.editor);
		composer.editor.handleInput = (data: string) => {
			received.push(data);
			original(data);
		};
		composer.start();
		return { term, received };
	}

	it("editor-open marker plus \\x07 arms the nonce, is consumed, and the key still reaches the editor", () => {
		const { term, received } = start();
		let originAtKey: string | undefined;
		const original = composer!.editor.handleInput;
		composer!.editor.handleInput = (data: string) => {
			if (data === "\x07") originAtKey = takeEditorOrigin();
			original(data);
		};
		feed(term, "\x1b_pi:editor-open;abc\x1b\\", "\x07");
		expect(received).toEqual(["\x07"]);
		expect(originAtKey).toBe("abc");
	});

	it("editor-open marker plus kitty CSI-u ctrl+g arms the nonce (the encoding zmx forwards from a non-leader client)", () => {
		const { term, received } = start();
		let originAtKey: string | undefined;
		const original = composer!.editor.handleInput;
		composer!.editor.handleInput = (data: string) => {
			if (data === "\x1b[103;5u") originAtKey = takeEditorOrigin();
			original(data);
		};
		feed(term, "\x1b_pi:editor-open;abc\x1b\\", "\x1b[103;5u");
		expect(received).toEqual(["\x1b[103;5u"]);
		expect(originAtKey).toBe("abc");
	});

	it("editor-submit marker plus \\r reaches the editor with the origin available", () => {
		const { term, received } = start();
		let originAtKey: string | undefined;
		const original = composer!.editor.handleInput;
		composer!.editor.handleInput = (data: string) => {
			if (data === "\r") originAtKey = takeEditorOrigin();
			original(data);
		};
		feed(term, "\x1b_pi:editor-submit;abc\x1b\\", "\r");
		expect(received).toEqual(["\r"]);
		expect(originAtKey).toBe("abc");
	});

	it("an ordinary character between the marker and the key clears the nonce", () => {
		const { term, received } = start();
		feed(term, "\x1b_pi:editor-open;abc\x1b\\", "x", "\x07");
		expect(received).toEqual(["x", "\x07"]);
		expect(takeEditorOrigin()).toBeUndefined();
	});

	it("the event after the key clears an untaken nonce", () => {
		const { term } = start();
		feed(term, "\x1b_pi:editor-open;abc\x1b\\", "\x07", "y");
		expect(takeEditorOrigin()).toBeUndefined();
	});

	it("a plain key without a marker yields no origin", () => {
		const { term, received } = start();
		feed(term, "\x07");
		expect(received).toEqual(["\x07"]);
		expect(takeEditorOrigin()).toBeUndefined();
	});

	it("keeps consuming the existing pi:prompt packet", () => {
		const { term, received } = start();
		feed(term, "\x1b_pi:prompt;help\x1b\\");
		expect(received).toEqual([]);
		expect(composer!.editor.getText()).toBe("/help ");
	});
});
