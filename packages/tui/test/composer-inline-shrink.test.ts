import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, Container, getKeybindings, setKeybindings, Text } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

const ROWS = 40;
const COLUMNS = 100;
const TRANSCRIPT_ROWS = 60;
const TRANSCRIPT_PREFIX = "Settled transcript row ";

/** Below-transcript chrome that inflates on demand, mimicking a confirmation dialog or a tall multi-line editor swapped in above the input. */
class InlineWidget implements Component {
	rows = 0;
	render(): readonly string[] {
		return Array.from({ length: this.rows }, (_, i) => `Live widget row ${i}`);
	}
}

interface Harness {
	terminal: VirtualTerminal;
	scheduler: VirtualRenderScheduler;
	composer: Composer;
	transcript: TranscriptContainer;
	widget: InlineWidget;
	/** Turn-scoped chrome between transcript and editor (loader, todo/subagent HUDs). */
	hud: InlineWidget;
	editor: Container;
}

function makeHarness(columns = COLUMNS, rows = ROWS, transcriptRows = TRANSCRIPT_ROWS, pinBottom = true): Harness {
	const terminal = new VirtualTerminal(columns, rows);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true, pinBottom },
	});
	const transcript = new TranscriptContainer();
	for (let i = 0; i < transcriptRows; i++) {
		const row = i;
		transcript.addChild({ render: () => [`${TRANSCRIPT_PREFIX}${row}`] });
	}
	const hud = new InlineWidget();
	const editor = new Container();
	const widget = new InlineWidget();
	editor.addChild(widget);
	editor.addChild(new Text("EDITOR", 0, 0));
	composer.setRuntimeChildren([transcript, hud, editor]);
	composer.start({ playWelcomeIntro: false });
	return { terminal, scheduler, composer, transcript, widget, hud, editor };
}

/** Settle, grow the inline chrome, settle, shrink it back, settle. */
async function cycleWidget(h: Harness): Promise<void> {
	await h.scheduler.settle(h.terminal);
	h.widget.rows = 24;
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
	h.widget.rows = 0;
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
}

beforeAll(async () => {
	await initTheme();
});

describe("composer inline shrink (#11007)", () => {
	it("preserves response rows while reading and answering an ask at the reported 54x112 geometry", async () => {
		const h = makeHarness(112, 54);
		await h.scheduler.settle(h.terminal);
		let submitted = false;
		const dialog = new AskDialogComponent(
			[
				{
					id: "approve",
					question: "Approve this section and the complete design for writing the spec?",
					options: [{ label: "Approve" }, { label: "Revise" }],
				},
			],
			{
				onSubmit: () => {
					submitted = true;
					h.editor.clear();
					h.editor.addChild(new Text("EDITOR", 0, 0));
					h.composer.ui.requestRender();
				},
				onCancel: () => {},
				onPrompt: () => Promise.resolve(undefined),
			},
		);
		h.editor.clear();
		h.editor.addChild(dialog);
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const visibleRows = (): number[] =>
			h.terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
				.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(visibleRows()).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		dialog.handleInput("\r");
		await h.scheduler.settle(h.terminal);
		expect(submitted).toBe(true);
		expect(visibleRows()).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(53);
		dialog.dispose();
		h.composer.stop();
	});

	it("leaves a short transcript top-anchored after an inline panel closes", async () => {
		const h = makeHarness(COLUMNS, ROWS, 3, false);
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 6;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const row = (needle: string): number =>
			h.terminal.getViewport().findIndex(line => Bun.stripANSI(line).trimEnd().startsWith(needle));
		expect(row(`${TRANSCRIPT_PREFIX}0`)).toBe(0);
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(row(`${TRANSCRIPT_PREFIX}0`)).toBe(0);
		expect(row("EDITOR")).toBeLessThan(ROWS - 1);
		h.composer.stop();
	});

	it("keeps settled transcript rows reachable while an inline ask panel is expanded (#12398)", async () => {
		const h = makeHarness(COLUMNS, ROWS, TRANSCRIPT_ROWS, false);
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 24;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		// The ask panel can remain open indefinitely. Its growth must not hide
		// settled response rows from both the live screen and native scrollback.
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const after = h.terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
		expect(
			after.filter(row => row.startsWith(TRANSCRIPT_PREFIX)).map(row => Number(row.slice(TRANSCRIPT_PREFIX.length))),
		).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		h.composer.stop();
	});

	it("lets a reset to an empty transcript shrink in place instead of pinning to the bottom", async () => {
		const h = makeHarness(COLUMNS, ROWS, TRANSCRIPT_ROWS, false);
		await h.scheduler.settle(h.terminal);
		// A new session: scrollback is cleared and nothing replays into it.
		h.composer.setRuntimeChildren([new TranscriptContainer(), h.hud, h.editor]);
		h.composer.ui.resetDisplay();
		await h.scheduler.settle(h.terminal);
		h.widget.rows = ROWS + 5;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 3;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(3);
		h.composer.stop();
	});

	it("keeps every response row once after an ask closes below a response taller than the screen", async () => {
		const terminal = new VirtualTerminal(COLUMNS, ROWS);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		// The response straddles the top edge. Rows the panel displaces retire
		// against the current chrome height, so none is lost or written twice.
		transcript.addChild({ render: () => Array.from({ length: 80 }, (_, i) => `${TRANSCRIPT_PREFIX}${i}`) });
		transcript.addChild({ render: () => Array.from({ length: 11 }, (_, i) => `Tool row ${i}`) });
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		composer.setRuntimeChildren([transcript, editor]);
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);
		const dialog = new AskDialogComponent(
			[{ id: "q", question: "Is it good?", options: [{ label: "Yes" }, { label: "No" }] }],
			{
				onSubmit: () => {
					editor.clear();
					editor.addChild(new Text("EDITOR", 0, 0));
					composer.ui.requestRender();
				},
				onCancel: () => {},
				onPrompt: () => Promise.resolve(undefined),
			},
		);
		editor.clear();
		editor.addChild(dialog);
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		dialog.handleInput("\r");
		await scheduler.settle(terminal);
		expect(terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		const indices = terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: 80 }, (_, i) => i));
		dialog.dispose();
		composer.stop();
	});

	it("brings rows an ask panel covered back on screen when the ask is hidden", async () => {
		// The default app bindings (Alt+H hides a pending ask).
		const previous = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory());
		try {
			const h = makeHarness();
			await h.scheduler.settle(h.terminal);
			const dialog = new AskDialogComponent(
				[
					{
						id: "q",
						question: "Is it good?",
						options: ["A", "B", "C", "D"].map(label => ({ label, description: `${label} described` })),
					},
				],
				{ onSubmit: () => {}, onCancel: () => {}, onPrompt: () => Promise.resolve(undefined) },
				{ tui: h.composer.ui },
			);
			h.editor.clear();
			h.editor.addChild(dialog);
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			const reachable = (): number[] =>
				h.terminal
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row).trimEnd())
					.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
					.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
			// Alt+H collapses the pending ask to one line: the rows it covered
			// already retired against the open panel's height, so all stay reachable.
			dialog.handleInput("\x1bh");
			await h.scheduler.settle(h.terminal);
			const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			expect(view[ROWS - 1]).toContain("Ask hidden");
			expect(reachable()).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
			// Showing it again covers them without writing anything twice.
			dialog.handleInput("\x1bh");
			await h.scheduler.settle(h.terminal);
			const shown = reachable();
			expect(new Set(shown).size).toBe(shown.length);
			dialog.dispose();
			h.composer.stop();
		} finally {
			setKeybindings(previous);
		}
	});

	it("keeps the editor pinned to the bottom after transient below-transcript chrome shrinks", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		const before = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(before.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);

		await cycleWidget(h);

		const after = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		// Regression: the editor used to strand ~24 blank rows below it after the
		// shrink because retired transcript rows never returned to the live tail.
		expect(after.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		const lastContent = after.reduce((last, row, i) => (row.length > 0 ? i : last), -1);
		expect(lastContent).toBe(ROWS - 1);

		h.composer.stop();
	});

	it("retires transcript rows contiguously with no duplication or gaps across the grow/shrink cycle", async () => {
		const h = makeHarness();
		// Conservation holds during expansion too, not only after hidden rows can reappear.
		for (const rows of [0, 24, 0]) {
			h.widget.rows = rows;
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			const indices = h.terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
				.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
			expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		}

		h.composer.stop();
	});

	it("keeps the editor pinned after a height resize while inline chrome is expanded", async () => {
		const shorter = ROWS - 10;
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// Resize while expanded, then shrink. The editor must remain at the bottom.
		h.widget.rows = 24;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		h.terminal.resize(COLUMNS, shorter);
		await h.scheduler.advance(h.terminal, 300);
		for (let frame = 0; frame < 5; frame++) {
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const after = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(after.findIndex(row => row.includes("EDITOR"))).toBe(shorter - 1);
		const lastContent = after.reduce((last, row, i) => (row.length > 0 ? i : last), -1);
		expect(lastContent).toBe(shorter - 1);

		h.composer.stop();
	});

	it("preserves transcript spacing when the chrome grows a few rows", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// Growth must preserve inter-block spacing rather than compress every block to one row.
		h.widget.rows = 3;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const editorRow = view.findIndex(row => row.includes("EDITOR"));
		expect(editorRow).toBe(ROWS - 1);
		const transcriptRows = view.slice(0, editorRow - 3);
		const separators = transcriptRows.filter(
			(row, i) => row === "" && transcriptRows[i - 1]?.startsWith(TRANSCRIPT_PREFIX),
		);
		expect(separators.length).toBeGreaterThan(0);
		expect(transcriptRows.at(-1)).toBe(`${TRANSCRIPT_PREFIX}${TRANSCRIPT_ROWS - 1}`);

		h.composer.stop();
	});

	it("retires settled rows displaced by persistent chrome instead of hiding them until it shrinks", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// A working loader + todo HUD stay up for a whole turn. Settled rows they
		// displace must reach native scrollback, not vanish between history and
		// the viewport until the turn ends.
		h.hud.rows = 4;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(view.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);

		h.composer.stop();
	});

	it("keeps every streamed word exactly once when the working loader goes away", async () => {
		const h = makeHarness(COLUMNS, 30);
		await h.scheduler.settle(h.terminal);
		const message = new AssistantMessageComponent();
		h.transcript.addChild(message);
		h.hud.rows = 2; // the working loader, up for the whole turn
		const reply = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1,
		});
		let text = "";
		for (let p = 0; p < 12; p++) {
			const words = Array.from({ length: 25 + (p % 4) * 10 }, (_, w) => `p${p}w${w}`).join(" ");
			for (const chunk of [words.slice(0, words.length / 2), words]) {
				message.updateContent(reply(`${text}${chunk}`), { transient: true });
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
			}
			text += `${words}\n\n`;
		}
		message.updateContent(reply(text.trim()));
		message.markTranscriptBlockFinalized();
		h.hud.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const words = h.terminal
			.getScrollBuffer()
			.join(" ")
			.split(/\s+/)
			.map(word => Bun.stripANSI(word))
			.filter(word => /^p\d+w\d+$/.test(word));
		expect(new Set(words).size).toBe(words.length);
		expect(words.length).toBe(text.split(/\s+/).filter(Boolean).length);
		h.composer.stop();
	});

	it("keeps the editor on the bottom row when a live block collapses under retired history", async () => {
		const h = makeHarness();
		const transcript = new TranscriptContainer();
		for (let i = 0; i < TRANSCRIPT_ROWS; i++) transcript.addChild({ render: () => [`${TRANSCRIPT_PREFIX}${i}`] });
		// A streaming tool preview that collapses to its short result.
		let toolRows = 12;
		transcript.addChild({ render: () => Array.from({ length: toolRows }, (_, i) => `Tool row ${i}`) });
		h.composer.setRuntimeChildren([transcript, h.hud, h.editor]);
		await h.scheduler.settle(h.terminal);
		toolRows = 4;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(view.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		expect(view.filter(row => row.startsWith("Tool row "))).toHaveLength(4);
		h.composer.stop();
	});
});
