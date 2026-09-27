import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgImagesAutoResize } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageResize from "@oh-my-pi/pi-coding-agent/utils/image-resize";
import { Input, TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import * as imageLoading from "@oh-my-pi/pi-tui/chat/image-loading";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { chipLabel } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import * as imageReferences from "@oh-my-pi/pi-tui/prompt/image-references";
import { imageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { createTestSession } from "./utilities";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
	"base64",
);
// A decodable 1x1 red BMP is not a PNG, even when its transfer digest matches.
const BMP = Buffer.from("Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AA==", "base64");
const MANIFEST_MIME = "application/vnd.ghostel.paste-v1+json";
const imageMime = Buffer.from("image/png").toBase64();
const manifestMime = Buffer.from(MANIFEST_MIME).toBase64();
const textMime = Buffer.from("text/plain").toBase64();

function packet(metadata: string, payload?: string): string {
	return `\x1b]5522;${metadata}${payload === undefined ? "" : `;${payload}`}\x1b\\`;
}

function observeTerminal(terminal: VirtualTerminal): string[] {
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	vi.spyOn(terminal, "write").mockImplementation(data => {
		writes.push(data);
		write(data);
	});
	return writes;
}

function startVerifiedPaste(terminal: VirtualTerminal, writes: string[]): string {
	terminal.sendInput(packet("type=read:status=OK:pw=cGFzdGU="));
	terminal.sendInput(packet(`type=read:status=DATA:mime=${manifestMime}`));
	terminal.sendInput(packet(`type=read:status=DATA:mime=${imageMime}`));
	terminal.sendInput(packet("type=read:status=DONE"));
	const request = writes.findLast(data => data.startsWith("\x1b]5522;type=read"));
	const id = request?.match(/:id=([^:;\x07\x1b]+)/)?.[1];
	if (!id) throw new Error("The receiver did not request a verified image.");
	return id;
}

function finishVerifiedPaste(terminal: VirtualTerminal, id: string, bytes = PNG): void {
	const manifest = {
		version: 1,
		mime: "image/png",
		bytes: bytes.length,
		sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
		remaining_ms: 10_000,
	};
	terminal.sendInput(packet(`type=read:status=OK:id=${id}`));
	terminal.sendInput(
		packet(`type=read:status=DATA:id=${id}:mime=${manifestMime}`, Buffer.from(JSON.stringify(manifest)).toBase64()),
	);
	terminal.sendInput(packet(`type=read:status=DATA:id=${id}:mime=${imageMime}`, bytes.toBase64()));
	terminal.sendInput(packet(`type=read:status=DONE:id=${id}`));
}

function pasteText(terminal: VirtualTerminal, text: string): void {
	terminal.sendInput(packet("type=read:status=OK:pw=cGFzdGU="));
	terminal.sendInput(packet(`type=read:status=DATA:mime=${textMime}`));
	terminal.sendInput(packet("type=read:status=DONE"));
	terminal.sendInput(packet("type=read:status=OK"));
	terminal.sendInput(packet(`type=read:status=DATA:mime=${textMime}`, Buffer.from(text).toBase64()));
	terminal.sendInput(packet("type=read:status=DONE"));
}

type PreparationStage = "validation" | "normalization" | "resize" | "storage" | "links" | "dimensions";

let settingsState: SettingsTestState | undefined;
let tempDir: TempDir;
const cleanups: Array<() => void> = [];

beforeAll(() => initTheme());
beforeEach(async () => {
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync(path.join(os.tmpdir(), "omp-verified-image-"));
	setAgentDir(tempDir.path());
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	cfgImagesAutoResize.set(settings, false);
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	tempDir.removeSync();
});

function createHarness() {
	const terminal = new VirtualTerminal(80, 24);
	const writes = observeTerminal(terminal);
	const ui = new TUI(terminal);
	vi.spyOn(ui, "requestRender").mockImplementation(() => {});
	const editor = new CustomEditor(getEditorTheme());
	editor.setText("draft ");
	const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
	const sessionChanges = new Set<() => void>();
	const state = { transitioning: false };
	const ctx = createInteractiveModeContext({
		ui,
		editor,
		sessionManager,
		keybindings: KeybindingsManager.inMemory(),
		dictationSpaceHold: () => ({ enabled: () => false, onStart: () => {}, onEnd: () => {} }),
		session: {
			get isSessionTransitioning() {
				return state.transitioning;
			},
			registerSessionChangeCallback: callback => {
				sessionChanges.add(callback);
				return () => sessionChanges.delete(callback);
			},
		},
	});
	const controller = new InputController(ctx, {
		readImage: async () => null,
		readText: async () => "",
	});
	controller.setupKeyHandlers();
	ui.setFocus(editor);
	ui.start();
	cleanups.push(() => {
		controller.disposeEnhancedPaste();
		ui.stop();
	});
	return { terminal, writes, ui, editor, sessionManager, sessionChanges, state, ctx, controller };
}

/** Hold one real preparation result. The final dimension result marks the last asynchronous step. */
function deferPreparation(stage: PreparationStage) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const dimensionsFinished = Promise.withResolvers<void>();
	let paused = false;
	let resizing = false;
	async function pause(): Promise<void> {
		if (paused) return;
		paused = true;
		entered.resolve();
		await release.promise;
	}
	const metadata = Bun.Image.prototype.metadata;
	vi.spyOn(Bun.Image.prototype, "metadata").mockImplementation(async function (this: Bun.Image) {
		const result = await metadata.call(this);
		if (!resizing) {
			if (stage === "dimensions") await pause();
			dimensionsFinished.resolve();
		}
		return result;
	});
	if (stage === "validation") {
		const validate = imageLoading.imageDecodeFailureReason;
		vi.spyOn(imageLoading, "imageDecodeFailureReason").mockImplementation(async (image, requireKnownFormat) => {
			const result = await validate(image, requireKnownFormat);
			await pause();
			return result;
		});
	} else if (stage === "normalization") {
		const normalize = imageLoading.ensureSupportedImageInput;
		vi.spyOn(imageLoading, "ensureSupportedImageInput").mockImplementation(async image => {
			const result = await normalize(image);
			await pause();
			return result;
		});
	} else if (stage === "resize") {
		cfgImagesAutoResize.set(settings, true);
		const resize = imageResize.resizeImage;
		vi.spyOn(imageResize, "resizeImage").mockImplementation(async (image, options) => {
			resizing = true;
			try {
				const result = await resize(image, options);
				await pause();
				return result;
			} finally {
				resizing = false;
			}
		});
	} else if (stage === "storage") {
		const write = Bun.write as (...args: unknown[]) => Promise<number>;
		vi.spyOn(Bun, "write").mockImplementation(async (...args: unknown[]) => {
			const result = await write(...args);
			const destination = args[0];
			if (typeof destination === "string" && path.basename(destination).startsWith("pasted-image-")) await pause();
			return result;
		});
	} else if (stage === "links") {
		vi.spyOn(InternalUrlRouter.instance(), "locateSync").mockReturnValue(undefined);
		const materialize = imageReferences.materializeImageReferenceLinks;
		vi.spyOn(imageReferences, "materializeImageReferenceLinks").mockImplementation(async (images, putBlob) => {
			const result = await materialize(images, putBlob);
			await pause();
			return result;
		});
	}
	return {
		entered: entered.promise,
		async finish() {
			release.resolve();
			await dimensionsFinished.promise;
			// No native work remains after the final dimension result. Drain its continuations.
			const settled = Promise.withResolvers<void>();
			setImmediate(settled.resolve);
			await settled.promise;
		},
	};
}

function expectUntouched(editor: CustomEditor): void {
	expect(editor.pendingImages).toEqual([]);
	expect(editor.pendingImageLinks).toEqual([]);
	expect(editor.imageLinks).toBeUndefined();
	expect(editor.getText()).toBe("draft ");
	expect(editor.getExpandedText()).toBe("draft ");
	expect(editor.composerChips()).toEqual([]);
}

function expectNoImageAtom(editor: CustomEditor): void {
	const label = chipLabel("image", 1);
	editor.insertText(label);
	expect(editor.getExpandedText()).toBe(`draft ${label}`);
}

describe("InputController enhanced-paste editor commit", () => {
	for (const bytes of [Buffer.alloc(0), PNG.subarray(0, 1), PNG.subarray(0, 40), Buffer.from("not an image"), BMP]) {
		it(`refuses invalid PNG data (${bytes.length} bytes) and accepts the next valid image`, async () => {
			const h = createHarness();
			const outcome = Promise.withResolvers<void>();
			vi.spyOn(h.ctx, "showStatus").mockImplementation(() => outcome.resolve());
			vi.spyOn(h.ui, "requestRender").mockImplementation(() => {
				if (h.editor.pendingImages.length) outcome.resolve();
			});
			finishVerifiedPaste(h.terminal, startVerifiedPaste(h.terminal, h.writes), bytes);
			await outcome.promise;
			expectUntouched(h.editor);
			expect(h.ctx.showStatus).toHaveBeenCalled();
			expect([...new Bun.Glob("**/pasted-image-*").scanSync(tempDir.path())]).toEqual([]);
			const held = deferPreparation("dimensions");
			finishVerifiedPaste(h.terminal, startVerifiedPaste(h.terminal, h.writes));
			await held.entered;
			await held.finish();
			expect(h.editor.pendingImages.map(image => image.data)).toEqual([PNG.toBase64()]);
			expect(h.editor.getExpandedText()).toBe("draft [Image #1, 1x1] ");
		});
	}

	for (const stage of ["validation", "normalization", "resize", "storage", "links", "dimensions"] as const) {
		it(`rejects expiry across awaited ${stage} without changing the draft`, async () => {
			const h = createHarness();
			let now = 1_000;
			vi.spyOn(performance, "now").mockImplementation(() => now);
			const held = deferPreparation(stage);
			const id = startVerifiedPaste(h.terminal, h.writes);
			finishVerifiedPaste(h.terminal, id);
			await held.entered;
			expectUntouched(h.editor);
			// Advance the monotonic clock without firing the receiver timer.
			now = 11_000;
			await held.finish();
			expectUntouched(h.editor);
			expectNoImageAtom(h.editor);
			expect(h.ctx.showStatus).toHaveBeenCalled();
		});
	}

	for (const change of ["editor", "view Session", "Session identity"] as const) {
		it(`rejects a ${change} change before DONE`, async () => {
			const h = createHarness();
			const id = startVerifiedPaste(h.terminal, h.writes);
			const replacement = new CustomEditor(getEditorTheme());
			replacement.setText("draft ");
			if (change === "editor") {
				h.ctx.editor = replacement;
				h.ui.setFocus(replacement);
			} else if (change === "view Session") {
				Object.defineProperty(h.ctx, "viewSession", { value: createInteractiveModeContext().session });
			} else {
				vi.spyOn(h.sessionManager, "getSessionId").mockReturnValue("another-session");
			}
			const held = deferPreparation("dimensions");
			finishVerifiedPaste(h.terminal, id);
			await held.entered;
			await held.finish();
			expectUntouched(h.editor);
			expectUntouched(replacement);
			expect(h.ctx.showStatus).toHaveBeenCalled();
		});
	}

	for (const change of [
		"stop",
		"Session",
		"Session identity",
		"transition",
		"focus",
		"editor",
		"view Session",
	] as const) {
		it(`rejects a ${change} change during dimension preparation`, async () => {
			const h = createHarness();
			const held = deferPreparation("dimensions");
			finishVerifiedPaste(h.terminal, startVerifiedPaste(h.terminal, h.writes));
			await held.entered;
			expectUntouched(h.editor);
			let replacement: CustomEditor | undefined;
			if (change === "stop") {
				h.ui.stop();
			} else if (change === "Session") {
				// Even a switch back to the original identity must not revive its canceled work.
				for (const callback of h.sessionChanges) callback();
			} else if (change === "Session identity") {
				vi.spyOn(h.sessionManager, "getSessionId").mockReturnValue("another-session");
			} else if (change === "transition") {
				h.state.transitioning = true;
			} else if (change === "focus") {
				h.ui.setFocus(new Input());
			} else if (change === "editor") {
				replacement = new CustomEditor(getEditorTheme());
				replacement.setText("draft ");
				h.ctx.editor = replacement;
				h.ui.setFocus(replacement);
			} else {
				Object.defineProperty(h.ctx, "viewSession", { value: createInteractiveModeContext().session });
			}
			await held.finish();
			expectUntouched(h.editor);
			if (replacement) expectUntouched(replacement);
			expectNoImageAtom(h.editor);
			expect(h.ctx.showStatus).toHaveBeenCalled();
		});
	}

	it("never inserts into a temporary replacement editor after the original editor regains focus", async () => {
		const h = createHarness();
		const normalize = imageLoading.ensureSupportedImageInput;
		const normalized = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		vi.spyOn(imageLoading, "ensureSupportedImageInput").mockImplementation(async image => {
			const result = await normalize(image);
			normalized.resolve();
			await releaseNormalize.promise;
			return result;
		});
		finishVerifiedPaste(h.terminal, startVerifiedPaste(h.terminal, h.writes));
		await normalized.promise;
		const replacement = new CustomEditor(getEditorTheme());
		replacement.setText("draft ");
		h.ctx.editor = replacement;
		h.ui.setFocus(replacement);
		const held = deferPreparation("dimensions");
		releaseNormalize.resolve();
		await held.entered;
		h.ctx.editor = h.editor;
		h.ui.setFocus(h.editor);
		await held.finish();
		expect(h.editor.getExpandedText()).toBe("draft [Image #1, 1x1] ");
		expect(h.editor.pendingImages).toHaveLength(1);
		expectUntouched(replacement);
		expectNoImageAtom(replacement);
	});

	it("commits a complete image once with its file link and matching atom", async () => {
		const h = createHarness();
		const held = deferPreparation("dimensions");
		const id = startVerifiedPaste(h.terminal, h.writes);
		finishVerifiedPaste(h.terminal, id);
		await held.entered;
		expectUntouched(h.editor);
		await held.finish();
		h.terminal.sendInput(packet(`type=read:status=DONE:id=${id}`));
		expect(h.editor.pendingImages).toHaveLength(1);
		expect(h.editor.getExpandedText()).toBe("draft [Image #1, 1x1] ");
		const image = h.editor.pendingImages[0]!;
		const link = h.editor.pendingImageLinks[0]!;
		expect(imageAttachmentSource(image)).toEqual({ path: link, kind: "image" });
		expect(h.editor.imageLinks).toEqual([link]);
		const savedPath = resolveLocalUrlToPath(link, {
			getArtifactsDir: () => h.sessionManager.getArtifactsDir(),
			getSessionId: () => h.sessionManager.getSessionId(),
		});
		expect(await Bun.file(savedPath).bytes()).toEqual(new Uint8Array(PNG));
	});

	it("keeps legacy image attachment on the same preparation path", async () => {
		const h = createHarness();
		const held = deferPreparation("dimensions");
		h.terminal.sendInput(packet("type=read:status=OK:pw=cGFzdGU="));
		h.terminal.sendInput(packet(`type=read:status=DATA:mime=${imageMime}`));
		h.terminal.sendInput(packet("type=read:status=DONE"));
		h.terminal.sendInput(packet("type=read:status=OK"));
		h.terminal.sendInput(packet(`type=read:status=DATA:mime=${imageMime}`, PNG.toBase64()));
		h.terminal.sendInput(packet("type=read:status=DONE"));
		await held.entered;
		expectUntouched(h.editor);
		await held.finish();
		expect(h.editor.pendingImages).toHaveLength(1);
		expect(h.editor.getExpandedText()).toBe("draft [Image #1, 1x1] ");
		expect(imageAttachmentSource(h.editor.pendingImages[0]!)).toEqual({
			path: h.editor.pendingImageLinks[0]!,
			kind: "image",
		});
	});

	it("numbers a later local image before a verified image whose dimensions are pending", async () => {
		const h = createHarness();
		const localPath = path.join(tempDir.path(), "local.png");
		await Bun.write(localPath, PNG);
		const held = deferPreparation("dimensions");
		finishVerifiedPaste(h.terminal, startVerifiedPaste(h.terminal, h.writes));
		await held.entered;
		expectUntouched(h.editor);
		await h.controller.handleImagePathPaste(localPath);
		expect(h.editor.getExpandedText()).toBe("draft [Image #1, 1x1] ");
		await held.finish();
		expect(h.editor.getExpandedText()).toBe("draft [Image #1, 1x1] [Image #2, 1x1] ");
		expect(h.editor.pendingImages.map(imageAttachmentSource)).toEqual([
			{ path: localPath, kind: "image" },
			{ path: h.editor.pendingImageLinks[1]!, kind: "image" },
		]);
		expect(h.editor.pendingImageLinks[0]).toBe(localPath);
		expect(h.editor.imageLinks).toEqual(h.editor.pendingImageLinks);
	});

	it("does not revive pending work or duplicate the receiver after stop and restart", async () => {
		const h = createHarness();
		const held = deferPreparation("dimensions");
		finishVerifiedPaste(h.terminal, startVerifiedPaste(h.terminal, h.writes));
		await held.entered;
		h.ui.stop();
		h.ui.start();
		h.controller.setupKeyHandlers();
		await held.finish();
		expectUntouched(h.editor);
		const committed = Promise.withResolvers<void>();
		const insertAtom = h.editor.insertAtom.bind(h.editor);
		vi.spyOn(h.editor, "insertAtom").mockImplementation((label, expansion) => {
			insertAtom(label, expansion);
			committed.resolve();
		});
		finishVerifiedPaste(h.terminal, startVerifiedPaste(h.terminal, h.writes));
		await committed.promise;
		expect(h.editor.getExpandedText()).toBe("draft [Image #1, 1x1] ");
		expect(h.editor.pendingImages).toHaveLength(1);
		expect(h.writes.filter(data => data.startsWith("\x1b]5522;type=read"))).toHaveLength(2);
	});

	it("routes legacy text to the actual focused prompt and keeps editor fallback", () => {
		const h = createHarness();
		const prompt = new Input();
		h.ui.setFocus(prompt);
		pasteText(h.terminal, "synthetic-key");
		expect(prompt.getValue()).toBe("synthetic-key");
		expectUntouched(h.editor);
		h.ui.setFocus(h.editor);
		pasteText(h.terminal, "body");
		expect(h.editor.getExpandedText()).toBe("draft body");
		h.ui.setFocus({ render: () => [], invalidate: () => {} });
		pasteText(h.terminal, " fallback");
		expect(h.editor.getExpandedText()).toBe("draft body fallback");
	});

	it("retains the local bracketed-paste promise through dimension preparation and trailing Enter", async () => {
		const h = createHarness();
		const localPath = path.join(tempDir.path(), "bracketed.png");
		await Bun.write(localPath, PNG);
		// File loading also probes dimensions. Hold only the final insertion probe.
		const normalize = imageLoading.ensureSupportedImageInput;
		const normalized = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		vi.spyOn(imageLoading, "ensureSupportedImageInput").mockImplementation(async image => {
			const result = await normalize(image);
			normalized.resolve();
			await releaseNormalize.promise;
			return result;
		});
		const submitted = Promise.withResolvers<string>();
		const submit = vi.fn((text: string) => submitted.resolve(text));
		h.editor.onSubmit = submit;
		h.terminal.sendInput(`\x1b[200~${localPath}\x1b[201~\r`);
		await normalized.promise;
		const held = deferPreparation("dimensions");
		releaseNormalize.resolve();
		await held.entered;
		expect(submit).not.toHaveBeenCalled();
		expectUntouched(h.editor);
		await held.finish();
		expect(await submitted.promise).toBe("draft [Image #1, 1x1]");
		expect(submit).toHaveBeenCalledTimes(1);
	});

	for (const change of ["editor", "view Session"] as const) {
		it(`cancels receipt across a real ${change} switch away and back`, async () => {
			const main = await createTestSession({ settingsOverrides: { "images.autoResize": false } });
			const sub = await createTestSession({ settingsOverrides: { "images.autoResize": false } });
			const terminal = new VirtualTerminal(80, 24);
			const writes = observeTerminal(terminal);
			const mode = new InteractiveMode(
				main.session,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				new Composer({ terminal }),
			);
			const registry = AgentRegistry.global();
			const ref = registry.register({
				id: "verified-paste-target",
				displayName: "Paste target",
				kind: "sub",
				session: sub.session,
				status: "idle",
			});
			vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
			vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
			try {
				mode.setEditorComponent(undefined);
				const original = mode.editor;
				original.setText("draft ");
				mode.ui.start();
				const stale = startVerifiedPaste(terminal, writes);
				if (change === "editor") {
					mode.setEditorComponent(undefined);
					mode.setEditorComponent(() => original);
				} else {
					await mode.focusAgentSession(ref.id);
					await mode.unfocusSession();
				}
				const fresh = startVerifiedPaste(terminal, writes);
				expect(fresh).not.toBe(stale);
				finishVerifiedPaste(terminal, stale);
				const held = deferPreparation("dimensions");
				finishVerifiedPaste(terminal, fresh);
				await held.entered;
				expectUntouched(original);
				await held.finish();
				expect(original.pendingImages).toHaveLength(1);
				expect(original.getExpandedText()).toBe("draft [Image #1, 1x1] ");
			} finally {
				mode.stop();
				mode.ui.stop();
				registry.unregister(ref.id, ref);
				await sub.cleanup();
				await main.cleanup();
			}
		});
	}

	it("disposes the receiver when InteractiveMode stops without owning the started TUI", async () => {
		const testSession = await createTestSession({ settingsOverrides: { "images.autoResize": false } });
		const terminal = new VirtualTerminal(80, 24);
		const writes = observeTerminal(terminal);
		const composer = new Composer({ terminal });
		const mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			composer,
		);
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		try {
			mode.setEditorComponent(undefined);
			mode.editor.setText("draft ");
			mode.ui.start();
			const held = deferPreparation("dimensions");
			finishVerifiedPaste(terminal, startVerifiedPaste(terminal, writes));
			await held.entered;
			mode.stop();
			await held.finish();
			expectUntouched(mode.editor);
			const readCount = writes.filter(data => data.startsWith("\x1b]5522;type=read")).length;
			const unownedPackets: string[] = [];
			const unsubscribe = mode.ui.addInputListener(data => {
				unownedPackets.push(data);
				return { consume: true };
			});
			const listing = packet("type=read:status=OK:pw=cGFzdGU=");
			terminal.sendInput(listing);
			expect(unownedPackets).toEqual([listing]);
			expect(writes.filter(data => data.startsWith("\x1b]5522;type=read"))).toHaveLength(readCount);
			const disableCount = writes.filter(data => data === "\x1b[?5522l").length;
			mode.ui.stop();
			expect(writes.filter(data => data === "\x1b[?5522l")).toHaveLength(disableCount);
			const enableCount = writes.filter(data => data === "\x1b[?5522h").length;
			mode.ui.start();
			expect(writes.filter(data => data === "\x1b[?5522h")).toHaveLength(enableCount);
			unsubscribe();
		} finally {
			mode.stop();
			mode.ui.stop();
			await testSession.cleanup();
		}
	});
});
