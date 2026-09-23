import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MAGIC_KEYWORDS } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { CollapsedSyntheticMessageComponent, UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { chipLabel, modelChipStyle, modelMentionChipLabel } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { imageReferenceHyperlink } from "@oh-my-pi/pi-tui/prompt/image-references";
import { setMagicKeywords } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { getEditorTheme, initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { Container, visibleWidth } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	Settings.instance.set("tui.hyperlinks", "always");
	await initTheme(false);
	// The host registers keywords at startup; without this nothing glows.
	setMagicKeywords(MAGIC_KEYWORDS);
});

afterAll(() => {
	setMagicKeywords([]);
	resetSettingsForTest();
});

function render(text: string): string {
	return new UserMessageComponent(text).render(80).join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("UserMessageComponent magic-keyword highlighting", () => {
	it("gradient-paints a magic keyword in the rendered (sent) message bubble", () => {
		const raw = render("please orchestrate the rollout");
		// Visible text is preserved.
		expect(Bun.stripANSI(raw)).toContain("please orchestrate the rollout");
		// The keyword is gradient-painted: a per-character foreground sequence is emitted,
		// and the word no longer survives as a contiguous run in the rendered bytes.
		expect(raw).toContain("\x1b[38");
		expect(raw).not.toContain("orchestrate");
	});

	it("does not paint a keyword inside an inline code span", () => {
		const raw = render("ship the `orchestrate` helper");
		expect(Bun.stripANSI(raw)).toContain("orchestrate");
		// Code spans render through the code style as a single run — the word stays intact.
		expect(raw).toContain("orchestrate");
	});

	it("does not paint a keyword inside a fenced code block", () => {
		const raw = render("intro\n```\norchestrate\n```");
		expect(Bun.stripANSI(raw)).toContain("orchestrate");
		expect(raw).toContain("orchestrate");
	});

	it("collapses image markers to identity-colored chip tokens in the rendered bubble", () => {
		// Wire format stays `[Image #1, WxH]`; the bubble shows the composer's compact chip.
		const raw = render("please inspect [Image #1, 800x600] before continuing");
		expect(Bun.stripANSI(raw)).toContain(`${chipLabel("image", 1)} before continuing`);
		expect(Bun.stripANSI(raw)).not.toContain("[Image #1");
		expect(raw).toContain("\x1b[1m");
	});

	it("collapses model tags before Markdown and renders the visible label in model styling", () => {
		const label = modelMentionChipLabel("Claude (Fast)");
		const bubbleReset = `${theme.getFgOnBgAnsi("userMessageText", "userMessageBg")}${theme.getBgAnsi("userMessageBg")}`;
		const raw = render('ask <model agent="m1" name="Claude (Fast)"/> then continue');
		expect(Bun.stripANSI(raw)).toContain(`ask ${label} then continue`);
		expect(raw).not.toContain("<model agent=");
		expect(raw).toContain(modelChipStyle(label, bubbleReset));
		expect(raw).toContain(theme.getFgAnsi("statusLineModel"));
	});

	it("wraps image references in file hyperlinks when a blob path is available", () => {
		const imagePath = path.resolve("/tmp/omp-image.png");
		const imageUri = url.pathToFileURL(path.resolve(imagePath)).href;
		const raw = new UserMessageComponent("please inspect [Image #1]", { imageLinks: [imagePath] })
			.render(80)
			.join("\n");
		expect(Bun.stripANSI(raw)).toContain(chipLabel("image", 1));
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(imageUri);
	});

	it("renders a video marker as a video chip linked to its source", () => {
		const videoPath = path.resolve("/tmp/omp-video.mp4");
		const videoUri = url.pathToFileURL(videoPath).href;
		const raw = new UserMessageComponent("please inspect [Video #1, 960x480]", { imageLinks: [videoPath] })
			.render(80)
			.join("\n");
		expect(Bun.stripANSI(raw)).toContain(chipLabel("video", 1));
		expect(Bun.stripANSI(raw)).not.toContain("[Video #1");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(videoUri);
	});

	it("wraps draft editor image references in file hyperlinks when a blob path is available", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.imageReferenceHyperlink = imageReferenceHyperlink;
		const imagePath = path.resolve("/tmp/omp-image.png");
		const imageUri = url.pathToFileURL(path.resolve(imagePath)).href;
		editor.imageLinks = [imagePath];
		editor.setText("please inspect [Image #1]");
		const raw = editor.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(imageUri);
	});

	it("rebuilds user messages with image hyperlinks when image links are not precomputed", () => {
		const displayPath = path.resolve("/tmp/abc123.png");
		const displayUri = url.pathToFileURL(path.resolve(displayPath)).href;
		const chatContainer = new Container();
		const sessionManagerMock = {
			putBlobSync: () => ({
				hash: "abc123",
				path: path.resolve("/tmp/abc123"),
				displayPath,
				get ref() {
					return "blob:sha256:abc123";
				},
			}),
		};
		const helpers = new UiHelpers({
			chatContainer,
			sessionManager: sessionManagerMock,
			viewSession: { sessionManager: sessionManagerMock },
			transcriptMessageComponents: new WeakMap(),
		} as unknown as InteractiveModeContext);
		const message: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "please inspect [Image #1]" },
				{ type: "image", data: Buffer.from("image-bytes").toString("base64"), mimeType: "image/png" },
			],
			attribution: "user",
			timestamp: Date.now(),
		};

		helpers.addMessageToChat(message);
		const component = chatContainer.children.at(-1);
		if (!component) throw new Error("Expected user message component to be appended");
		const raw = component.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain(chipLabel("image", 1));
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(displayUri);
	});

	it("highlights paste markers in the draft editor without a hyperlink", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("see [Paste #1, +30 lines] now");
		const raw = editor.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Paste #1, +30 lines]");
		// The marker label is bold-wrapped (highlighted), unlike surrounding plain text.
		expect(raw).toContain("\x1b[1m[Paste #1, +30 lines]");
		// Paste markers are not clickable, so no OSC-8 hyperlink is emitted (contrast with images).
		expect(raw).not.toContain("\x1b]8;id=");
	});

	it("hyperlinks the metadata-bearing image marker format", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.imageReferenceHyperlink = imageReferenceHyperlink;
		const imagePath = path.resolve("/tmp/omp-image.png");
		const imageUri = url.pathToFileURL(path.resolve(imagePath)).href;
		editor.imageLinks = [imagePath];
		editor.setText("see [Image #1, 800x600] now");
		const raw = editor.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1, 800x600]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(imageUri);
	});
});

describe("UserMessageComponent OSC 133 prompt zone", () => {
	const OSC_A = "\x1b]133;A\x07";
	const OSC_B = "\x1b]133;B\x07";
	const OSC_C = "\x1b]133;C\x07";
	const OSC_D = "\x1b]133;D;0\x07";
	const OSC_ANY = /\x1b\]133;[^\x07]*\x07/g;
	const seed = 0x133;

	it.each([8, 24, 80])("marks one input without changing its presentation at width=%s, seed=307", width => {
		// Conservation and bounds: markers preserve visible rows and exclude padding.
		const texts = [0, 1, width - 2, width - 1, 2 * width + 1].map(length =>
			Array.from({ length }, (_, i) => String.fromCharCode(97 + ((seed + i) % 26))).join(""),
		);
		texts.push(" \n \n ", "first line\nsecond line\nthird line", "中文 café\nnext line", "# Heading\n\nBody");
		for (const text of texts) {
			const detail = `seed=${seed}, width=${width}, text=${JSON.stringify(text)}`;
			const rows = new UserMessageComponent(text).render(width);
			const plain = rows.map(row => Bun.stripANSI(row));
			const synthetic = new UserMessageComponent(text, { synthetic: true }).render(width);
			expect(plain, detail).toEqual(synthetic.map(row => Bun.stripANSI(row)));
			expect(synthetic.join(""), detail).not.toContain("\x1b]133;");
			const first = plain.findIndex(row => row.trim().length > 0);
			const last = plain.findLastIndex(row => row.trim().length > 0);
			const markers = Array.from(rows.join("").matchAll(OSC_ANY), match => match[0]);
			expect(markers, detail).toEqual(first < 0 ? [] : [OSC_A, OSC_B, OSC_C, OSC_D]);
			if (first < 0) continue;
			const start = rows[first]!;
			expect(start.indexOf(OSC_A), detail).toBe(0);
			expect(visibleWidth(start.slice(OSC_A.length, start.indexOf(OSC_B))), detail).toBe(1);
			expect(rows[last]!.endsWith(OSC_C + OSC_D), detail).toBe(true);
			for (let index = 0; index < rows.length; index++) {
				if (index !== first && index !== last) expect(rows[index], detail).not.toContain("\x1b]133;");
			}
		}
	});

	it("keeps reactions outside the input boundary, including synthetic bubbles", () => {
		for (const synthetic of [false, true]) {
			const bubble = new UserMessageComponent("only line", { synthetic });
			bubble.setReaction("\u{1F44D}");
			const rows = bubble.render(80);
			expect(rows[0]).toContain("\u{1F44D}");
			expect(rows[0]).not.toContain("\x1b]133;");
			expect(countOccurrences(rows.join(""), OSC_A)).toBe(synthetic ? 0 : 1);
		}
	});

	it("keeps one prompt zone when a command body expands and collapses", () => {
		const card = new CollapsedSyntheticMessageComponent("body line\nmore body", undefined, "/tmpl a b", true);
		const collapsed = card.render(80).join("\n");
		for (const expanded of [true, false]) {
			card.setExpanded(expanded);
			const raw = card.render(80).join("\n");
			expect(Array.from(raw.matchAll(OSC_ANY), match => match[0])).toEqual([OSC_A, OSC_B, OSC_C, OSC_D]);
			expect(Bun.stripANSI(raw).includes("body line")).toBe(expanded);
			if (!expanded) expect(raw).toBe(collapsed);
		}
	});
});
