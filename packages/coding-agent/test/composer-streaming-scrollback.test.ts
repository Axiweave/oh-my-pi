import { afterEach, describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { Composer, type ComposerPreferences } from "@oh-my-pi/pi-coding-agent/modes/composer";
import type { Component } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

/**
 * Behavioral regression for `display.streamingScrollback`: with the
 * preference enabled, `Composer` reconciles the transcript's full current
 * Markdown — including an unfinalized assistant reply — into native terminal
 * history instead of the legacy tail-only viewport. These tests drive a real
 * `Composer` + `TranscriptContainer` + `AssistantMessageComponent` through the
 * actual TUI render/write pipeline and read back the terminal's own buffers,
 * never private composer state.
 */

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet",
		usage: USAGE,
		stopReason: "stop",
		timestamp: 1,
	};
}

function scrollBuffer(terminal: VirtualTerminal): string[] {
	return terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
}

/** Rows already committed to native scrollback, excluding the live viewport. */
function historyRows(terminal: VirtualTerminal): string[] {
	const { baseY } = terminal.getBufferPosition();
	return terminal
		.getScrollBuffer()
		.map(row => Bun.stripANSI(row).trimEnd())
		.slice(0, baseY);
}

function countRows(rows: readonly string[], needle: string): number {
	return rows.filter(row => row.includes(needle)).length;
}

function markerText(i: number, tag = "orig"): string {
	return `MARK${String(i).padStart(3, "0")}_${tag}`;
}

function paragraphText(i: number, tag = "orig"): string {
	return `${markerText(i, tag)} padded filler text so this paragraph wraps across several rows of the narrow test viewport.`;
}

function paragraphs(count: number, tag = "orig"): string {
	return Array.from({ length: count }, (_, i) => paragraphText(i, tag)).join("\n\n");
}

/** Mutable, never-finalizing block standing in for a tool card with a bounded, changing preview. */
class MutableBlock implements Component {
	#rows: string[];
	constructor(rows: string[]) {
		this.#rows = rows;
	}
	setLines(rows: string[]): void {
		this.#rows = rows;
	}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	render(): readonly string[] {
		return this.#rows;
	}
}

interface Rig {
	composer: Composer;
	terminal: VirtualTerminal;
	scheduler: VirtualRenderScheduler;
	transcript: TranscriptContainer;
}

const composers: Composer[] = [];
afterEach(() => {
	for (const composer of composers) composer.stop();
	composers.length = 0;
});

function makeRig(preferences: Partial<ComposerPreferences> = {}, columns = 40, rows = 8): Rig {
	const terminal = new VirtualTerminal(columns, rows, 4_000);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { quiet: true, ...preferences },
	});
	composers.push(composer);
	const transcript = new TranscriptContainer();
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.start({ playWelcomeIntro: false });
	return { composer, terminal, scheduler, transcript };
}

async function settle(rig: Rig): Promise<void> {
	rig.composer.ui.requestRender();
	await rig.scheduler.settle(rig.terminal);
}

/** Feed `count` numbered paragraphs into `assistant` one at a time, settling a real frame after each. */
async function streamNumberedParagraphs(rig: Rig, assistant: AssistantMessageComponent, count: number): Promise<void> {
	for (let i = 1; i <= count; i++) {
		assistant.updateContent(assistantMessage(paragraphs(i)), { transient: true });
		await settle(rig);
	}
}

describe("Composer streaming scrollback", () => {
	it("keeps every streamed marker once when enabled and omits the earliest marker by default", async () => {
		const disabled = makeRig({}, 40, 8);
		const disabledAssistant = new AssistantMessageComponent();
		disabled.transcript.addChild(disabledAssistant);
		await streamNumberedParagraphs(disabled, disabledAssistant, 80);
		// Legacy tail-only behavior: an unfinalized block never retires to
		// history, so the earliest paragraph never reaches native scrollback.
		expect(scrollBuffer(disabled.terminal).some(row => row.includes(markerText(0)))).toBe(false);
		disabled.composer.stop();

		const enabled = makeRig({ streamingScrollback: true }, 40, 8);
		const enabledAssistant = new AssistantMessageComponent();
		enabled.transcript.addChild(enabledAssistant);
		await streamNumberedParagraphs(enabled, enabledAssistant, 80);
		const buffer = scrollBuffer(enabled.terminal);
		for (let i = 0; i < 80; i++) expect(countRows(buffer, markerText(i))).toBe(1);
		enabled.composer.stop();
	});

	it("appends new tail rows without touching already-committed markers, and a no-op repaint adds nothing new", async () => {
		const rig = makeRig({ streamingScrollback: true }, 40, 8);
		const assistant = new AssistantMessageComponent();
		rig.transcript.addChild(assistant);
		await streamNumberedParagraphs(rig, assistant, 30);
		expect(countRows(scrollBuffer(rig.terminal), markerText(0))).toBe(1);

		// Pure append: paragraphs 0-29 are byte-identical, 30-39 are new.
		assistant.updateContent(assistantMessage(paragraphs(40)), { transient: true });
		await settle(rig);
		const afterSecond = scrollBuffer(rig.terminal);
		expect(countRows(afterSecond, markerText(0))).toBe(1);
		expect(countRows(afterSecond, markerText(35))).toBe(1);

		// Repaint with no content change: the buffer must not move or duplicate.
		await settle(rig);
		expect(scrollBuffer(rig.terminal)).toEqual(afterSecond);

		rig.composer.stop();
	});

	it("keeps the start of a long unbroken paragraph and an open code fence readable before finalization", async () => {
		const rig = makeRig({ streamingScrollback: true }, 40, 10);
		const assistant = new AssistantMessageComponent();
		rig.transcript.addChild(assistant);

		// One continuous paragraph (soft breaks only, no blank-line boundary)
		// spanning many screens at this width.
		const words = Array.from({ length: 400 }, (_, i) => (i === 0 ? "PARASTART" : i === 399 ? "PARAEND" : `w${i}`));
		const longParagraph = words.join(" ");
		assistant.updateContent(assistantMessage(longParagraph), { transient: true });
		await settle(rig);
		expect(countRows(scrollBuffer(rig.terminal), "PARASTART")).toBe(1);

		// Multi-screen open (unterminated) code fence appended after it.
		const codeLines = Array.from({ length: 200 }, (_, i) => `FENCELINE${String(i).padStart(3, "0")}`);
		const withOpenFence = `${longParagraph}\n\n\`\`\`text\n${codeLines.join("\n")}`;
		assistant.updateContent(assistantMessage(withOpenFence), { transient: true });
		await settle(rig);
		const buffer = scrollBuffer(rig.terminal);
		expect(countRows(buffer, "PARASTART")).toBe(1);
		expect(countRows(buffer, "FENCELINE000")).toBe(1);

		rig.composer.stop();
	});

	it("replaces the committed prefix wholesale when an already-committed marker is rewritten, not just appended", async () => {
		const rig = makeRig({ streamingScrollback: true }, 40, 8);
		const assistant = new AssistantMessageComponent();
		rig.transcript.addChild(assistant);
		await streamNumberedParagraphs(rig, assistant, 30);
		expect(countRows(scrollBuffer(rig.terminal), markerText(0, "orig"))).toBe(1);

		// Rewrite paragraph 0 in place: same position and count, corrected text.
		const rewritten = [
			paragraphText(0, "fix"),
			...Array.from({ length: 29 }, (_, i) => paragraphText(i + 1, "orig")),
		].join("\n\n");
		assistant.updateContent(assistantMessage(rewritten), { transient: true });
		await settle(rig);

		const buffer = scrollBuffer(rig.terminal);
		expect(countRows(buffer, markerText(0, "orig"))).toBe(0);
		expect(countRows(buffer, markerText(0, "fix"))).toBe(1);
		// Untouched later paragraphs are neither lost nor duplicated by the replacement.
		expect(countRows(buffer, markerText(15, "orig"))).toBe(1);

		rig.composer.stop();
	});

	it("finalizing the message keeps exactly one copy of the final content, including a late fence closure", async () => {
		const rig = makeRig({ streamingScrollback: true }, 40, 8);
		const assistant = new AssistantMessageComponent();
		rig.transcript.addChild(assistant);

		const intro = paragraphs(10);
		const codeLines = Array.from({ length: 20 }, (_, i) => `CODE${String(i).padStart(2, "0")}`);
		const openFence = `${intro}\n\n\`\`\`text\n${codeLines.join("\n")}`;
		assistant.updateContent(assistantMessage(openFence), { transient: true });
		await settle(rig);
		expect(countRows(scrollBuffer(rig.terminal), "CODE00")).toBe(1);

		// Close the fence and finalize: a non-transient render can re-highlight
		// the whole fence, so this must still land as exactly one copy.
		const closedFence = `${openFence}\n\`\`\`\n\nFINAL_TAIL_MARKER`;
		assistant.updateContent(assistantMessage(closedFence));
		assistant.markTranscriptBlockFinalized();
		await settle(rig);
		await settle(rig); // drain any follow-up frame the logical commit requests

		const buffer = scrollBuffer(rig.terminal);
		for (let i = 0; i < 10; i++) expect(countRows(buffer, markerText(i))).toBe(1);
		for (const line of codeLines) expect(countRows(buffer, line)).toBe(1);
		expect(countRows(buffer, "FINAL_TAIL_MARKER")).toBe(1);
		const finalRows = new AssistantMessageComponent(assistantMessage(closedFence))
			.render(40)
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(Boolean);
		expect(buffer.filter(Boolean).slice(0, finalRows.length)).toEqual(finalRows);

		rig.composer.stop();
	});

	it.each(["rebuild", "append", "preserve"] as const)(
		"preserves a typed draft through %s resizes and mode changes",
		async resizeScrollback => {
			const rig = makeRig({ streamingScrollback: true, resizeScrollback }, 40, 8);
			const assistant = new AssistantMessageComponent();
			rig.transcript.addChild(assistant);
			await streamNumberedParagraphs(rig, assistant, 30);
			expect(countRows(scrollBuffer(rig.terminal), markerText(0))).toBe(1);

			rig.terminal.sendInput("DRAFT_MARKER");
			await settle(rig);
			expect(historyRows(rig.terminal).some(row => row.includes("DRAFT_MARKER"))).toBe(false);
			expect(countRows(scrollBuffer(rig.terminal), "DRAFT_MARKER")).toBe(1);

			// Resize: the draft and the editor stay singular.
			rig.terminal.resize(30, 10);
			await rig.scheduler.advance(rig.terminal, 200);
			expect(rig.composer.editor.getText()).toBe("DRAFT_MARKER");
			expect(countRows(scrollBuffer(rig.terminal), "DRAFT_MARKER")).toBe(1);
			for (let i = 0; i < 30; i++) expect(countRows(scrollBuffer(rig.terminal), markerText(i))).toBe(1);
			rig.terminal.resize(40, 8);
			await rig.scheduler.advance(rig.terminal, 200);
			for (let i = 0; i < 30; i++) expect(countRows(scrollBuffer(rig.terminal), markerText(i))).toBe(1);
			rig.terminal.resize(40, 12);
			await rig.scheduler.advance(rig.terminal, 200);
			for (let i = 0; i < 30; i++) expect(countRows(scrollBuffer(rig.terminal), markerText(i))).toBe(1);

			// Toggle off: tail-only behavior returns for the still-active message,
			// so the earliest marker must no longer be visible anywhere.
			rig.composer.setPreferences({ streamingScrollback: false });
			await settle(rig);
			expect(rig.composer.editor.getText()).toBe("DRAFT_MARKER");
			expect(countRows(scrollBuffer(rig.terminal), "DRAFT_MARKER")).toBe(1);
			expect(historyRows(rig.terminal).some(row => row.includes("DRAFT_MARKER"))).toBe(false);
			expect(scrollBuffer(rig.terminal).some(row => row.includes(markerText(0)))).toBe(false);

			// Toggle back on: full-stream history returns without duplicating the draft.
			rig.composer.setPreferences({ streamingScrollback: true });
			await settle(rig);
			expect(rig.composer.editor.getText()).toBe("DRAFT_MARKER");
			expect(countRows(scrollBuffer(rig.terminal), "DRAFT_MARKER")).toBe(1);
			expect(countRows(scrollBuffer(rig.terminal), markerText(0))).toBe(1);

			rig.composer.stop();
		},
	);

	it("replaces a preceding mutable block's stale rows while keeping the assistant's earliest text available", async () => {
		const rig = makeRig({ streamingScrollback: true }, 40, 10);
		const tool = new MutableBlock(["TOOLV1 line alpha", "TOOLV1 line beta"]);
		rig.transcript.addChild(tool);
		const assistant = new AssistantMessageComponent();
		rig.transcript.addChild(assistant);

		assistant.updateContent(assistantMessage(paragraphs(20)), { transient: true });
		await settle(rig);
		let buffer = scrollBuffer(rig.terminal);
		expect(countRows(buffer, "TOOLV1 line alpha")).toBe(1);
		expect(countRows(buffer, markerText(0))).toBe(1);

		// The tool card's own bounded preview changes; its stale rows must not linger.
		tool.setLines(["TOOLV2 line gamma", "TOOLV2 line delta", "TOOLV2 line epsilon"]);
		await settle(rig);
		buffer = scrollBuffer(rig.terminal);
		expect(countRows(buffer, "TOOLV1 line alpha")).toBe(0);
		expect(countRows(buffer, "TOOLV1 line beta")).toBe(0);
		expect(countRows(buffer, "TOOLV2 line gamma")).toBe(1);
		expect(countRows(buffer, markerText(0))).toBe(1);

		rig.composer.stop();
	});
});
