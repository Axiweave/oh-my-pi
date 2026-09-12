import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, Container, type RenderScheduler, visibleWidth } from "@oh-my-pi/pi-tui";
import { Image } from "@oh-my-pi/pi-tui/components/image";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { getCellDimensions, ImageProtocol, setCellDimensions, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { withoutTerminalMultiplexer } from "../../tui/test/helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

withoutTerminalMultiplexer();

const composers: Composer[] = [];

class ResizeScheduler implements RenderScheduler {
	#now = 0;
	#pending = new Set<() => void>();

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void) {
		callback();
		return { cancel() {} };
	}

	scheduleRender(callback: () => void, _delayMs: number) {
		this.#pending.add(callback);
		return { cancel: () => this.#pending.delete(callback) };
	}

	settle(): void {
		this.#now += 120;
		const pending = [...this.#pending];
		this.#pending.clear();
		for (const callback of pending) callback();
	}
	advance(ms: number): void {
		this.#now += ms;
	}
}

class MutableComposerTail implements Component {
	status = "thinking low";

	invalidate(): void {}

	render(): readonly string[] {
		return ["╭─ EDITOR TOP ─╮", `│ ${this.status} │`, "╰─ EDITOR BOTTOM ─╯"];
	}
}
class WidthTranscriptBlock implements Component {
	constructor(readonly id: number) {}

	render(width: number): readonly string[] {
		return [`block-${this.id}@${width}`];
	}
}

class TrackingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

function plainBuffer(terminal: VirtualTerminal): string[] {
	return terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
}

function rowOf(rows: readonly string[], needle: string): number {
	return rows.findIndex(row => row.includes(needle));
}

function countRows(rows: readonly string[], needle: string): number {
	return rows.filter(row => row.includes(needle)).length;
}

function expectOneExactEditor(rows: readonly string[], status: string): number {
	const top = rowOf(rows, "EDITOR TOP");
	expect(countRows(rows, "EDITOR TOP")).toBe(1);
	expect(countRows(rows, status)).toBe(1);
	expect(countRows(rows, "EDITOR BOTTOM")).toBe(1);
	expect(rowOf(rows, status)).toBe(top + 1);
	expect(rowOf(rows, "EDITOR BOTTOM")).toBe(top + 2);
	return top;
}

function startRetiredWelcome(modelName: string): {
	composer: Composer;
	terminal: TrackingTerminal;
} {
	const terminal = new TrackingTerminal(80, 12);
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: new ResizeScheduler() },
		preferences: {
			...COMPOSER_DEFAULTS,
			quiet: false,
			resizeScrollback: "preserve",
		},
		welcome: { version: "test", modelName, providerName: "test-provider" },
	});
	composers.push(composer);
	composer.setRuntimeChildren([new TranscriptContainer(), new MutableComposerTail()]);
	composer.start({ playWelcomeIntro: false });
	return { composer, terminal };
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	try {
		for (const composer of composers) composer.ui.stop();
	} finally {
		composers.length = 0;
		vi.restoreAllMocks();
	}
});

describe("composer welcome native-history resize", () => {
	it.each([false, true])(
		"keeps one editor and retired welcome through thinking and resize frames (pinBottom=%p)",
		async pinBottom => {
			// Select the long auth-broker tip: it retires as three hard rows at
			// width 80 and must not be recomposed into fewer rows after widening.
			vi.spyOn(Math, "random").mockReturnValue(0.5);
			const terminal = new TrackingTerminal(80, 12);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: {
					...COMPOSER_DEFAULTS,
					pinBottom,
					streamingScrollback: false,
					quiet: false,
					resizeScrollback: "preserve",
				},
				welcome: {
					version: "test",
					modelName: "test-model",
					providerName: "test-provider",
				},
			});
			composers.push(composer);

			const transcript = new TranscriptContainer();
			const tail = new MutableComposerTail();
			composer.setRuntimeChildren([transcript, tail]);
			composer.start({ playWelcomeIntro: false });
			await scheduler.settle(terminal);

			expect(countRows(plainBuffer(terminal), "Welcome back!")).toBe(1);
			const initialAnchor = expectOneExactEditor(
				terminal.getViewport().map(row => Bun.stripANSI(row)),
				tail.status,
			);
			expect(initialAnchor).toBe(pinBottom ? terminal.rows - 3 : 9);
			const writesAfterRetirement = terminal.writes.length;

			for (let index = 0; index < 40; index++) {
				tail.status = index % 2 === 0 ? "thinking high" : "thinking low";
				composer.ui.requestRender(true);
				await scheduler.settle(terminal);
				const viewport = terminal.getViewport().map(row => Bun.stripANSI(row));
				expect(expectOneExactEditor(viewport, tail.status)).toBe(initialAnchor);
				expect(countRows(plainBuffer(terminal), "Welcome back!")).toBe(1);
			}

			let lastTransient: string[] = [];
			for (const [columns, rows] of [
				[96, 28],
				[104, 30],
				[100, 34],
			] as const) {
				terminal.resize(columns, rows);
				await scheduler.settle(terminal);
				lastTransient = terminal.getViewport().map(row => Bun.stripANSI(row));
				expect(countRows(lastTransient, "Welcome back!")).toBe(1);
				expectOneExactEditor(lastTransient, tail.status);
			}
			await scheduler.advance(terminal, 160);

			let settledViewport = terminal.getViewport().map(row => Bun.stripANSI(row));
			expect(countRows(settledViewport, "Welcome back!")).toBe(1);
			expect(rowOf(settledViewport, "Welcome back!")).toBe(rowOf(lastTransient, "Welcome back!"));
			const settledTop = expectOneExactEditor(settledViewport, tail.status);
			expect(settledTop).toBe(pinBottom ? terminal.rows - 3 : expectOneExactEditor(lastTransient, tail.status));
			expect(settledTop).toBeGreaterThan(rowOf(settledViewport, "Welcome back!"));
			if (pinBottom) expect(rowOf(settledViewport, "EDITOR BOTTOM")).toBe(terminal.rows - 1);
			expect(countRows(plainBuffer(terminal), "EDITOR TOP")).toBe(1);
			await scheduler.advance(terminal, 101);

			for (const [columns, rows] of [
				[92, 30],
				[72, 50],
			] as const) {
				terminal.resize(columns, rows);
				await scheduler.settle(terminal);
				lastTransient = terminal.getViewport().map(row => Bun.stripANSI(row));
				expect(countRows(lastTransient, "Welcome back!")).toBe(1);
				expectOneExactEditor(lastTransient, tail.status);
			}
			await scheduler.advance(terminal, 160);

			settledViewport = terminal.getViewport().map(row => Bun.stripANSI(row));
			expect(countRows(settledViewport, "Welcome back!")).toBe(1);
			expect(rowOf(settledViewport, "Welcome back!")).toBe(rowOf(lastTransient, "Welcome back!"));
			expect(expectOneExactEditor(settledViewport, tail.status)).toBeGreaterThan(
				rowOf(settledViewport, "Welcome back!"),
			);
			if (pinBottom) expect(rowOf(settledViewport, "EDITOR BOTTOM")).toBe(terminal.rows - 1);
			expect(countRows(plainBuffer(terminal), "EDITOR TOP")).toBe(1);
			expect(terminal.writes.slice(writesAfterRetirement).some(write => write.includes("\x1b[3J"))).toBe(false);
		},
	);

	it("preserves a wide glyph that straddles a retired-row resize boundary", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const { composer, terminal } = startRetiredWelcome("model-aaaa界-tail");
		const accepted = plainBuffer(terminal).find(row => row.includes("界"));
		expect(accepted).toBeDefined();
		const glyphIndex = accepted!.indexOf("界");
		const width = visibleWidth(accepted!.slice(0, glyphIndex)) + 1;
		expect(width).toBeLessThan(80);

		const resizeFrame = composer.renderResizeFrame({ columns: width, rows: 200 }).map(row => Bun.stripANSI(row));
		expect(countRows(resizeFrame, "界")).toBe(1);

		terminal.resize(width, 200);

		const transient = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(countRows(transient, "界")).toBe(1);
	});
	it("clips retired hard rows instead of reflowing them inside a multiplexer", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		Bun.env.TMUX = "/tmp/tmux-test/default,1,0";
		Bun.env.TERM = "tmux-256color";
		const marker = "MUX-SUFFIX";
		const { composer, terminal } = startRetiredWelcome(`model-aaaa${marker}`);
		const accepted = plainBuffer(terminal).find(row => row.includes(marker));
		expect(accepted).toBeDefined();
		expect(visibleWidth(accepted!)).toBeLessThanOrEqual(80);
		const markerIndex = accepted!.indexOf(marker);
		const width = visibleWidth(accepted!.slice(0, markerIndex)) - 1;
		expect(width).toBeGreaterThan(1);

		const resizeFrame = composer.renderResizeFrame({ columns: width, rows: 200 }).map(row => Bun.stripANSI(row));
		expect(countRows(resizeFrame, marker)).toBe(1);

		terminal.resize(width, 200);

		const transient = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(countRows(transient, marker)).toBe(0);
	});
	it("recomposes the retired welcome header at the settled width on a rebuild resize", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const terminal = new VirtualTerminal(60, 12);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: {
				...COMPOSER_DEFAULTS,
				quiet: false,
				resizeScrollback: "rebuild",
			},
			welcome: {
				version: "test",
				modelName: "test-model",
				providerName: "test-provider",
			},
		});
		composers.push(composer);
		composer.setRuntimeChildren([new TranscriptContainer(), new MutableComposerTail()]);
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);

		const narrow = plainBuffer(terminal);
		expect(countRows(narrow, "Welcome back!")).toBe(1);
		// Box width tracks the terminal: min(100, 60 - 2) = 58 columns.
		expect(Math.max(...narrow.map(row => visibleWidth(row)))).toBeLessThanOrEqual(58);

		terminal.resize(100, 12);
		await scheduler.advance(terminal, 160);

		const rebuilt = plainBuffer(terminal);
		expect(countRows(rebuilt, "Welcome back!")).toBe(1);
		// A hard-wrap reflow can never widen a committed 58-column row; only a
		// recompose at the settled width produces the 98-column box.
		expect(Math.max(...rebuilt.map(row => visibleWidth(row)))).toBeGreaterThan(58);
	});

	it("rebuilds retired transcript rows at the settled width by default", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		composers.push(composer);
		const transcript = new TranscriptContainer();
		for (let id = 0; id < 4; id++) transcript.addChild(new WidthTranscriptBlock(id));
		composer.setRuntimeChildren([transcript, new MutableComposerTail()]);
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);

		expect(plainBuffer(terminal)).toContain("block-0@20");

		terminal.resize(30, 4);
		await scheduler.advance(terminal, 160);

		const resized = plainBuffer(terminal);
		expect(resized.some(row => row.includes("@20"))).toBe(false);
		expect(resized).toContain("block-0@30");
		expect(resized).toContain("block-3@30");
	});

	it("recomposes a cached history batch when the image budget retries", () => {
		const originalProtocol = TERMINAL.imageProtocol;
		const originalTerminalId = TERMINAL.id;
		const originalCellDimensions = { ...getCellDimensions() };
		const originalGraphics = { ...getKittyGraphics() };
		Reflect.set(TERMINAL, "imageProtocol", ImageProtocol.Kitty);
		Reflect.set(TERMINAL, "id", "xterm");
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		setKittyGraphics({ unicodePlaceholders: false });

		const terminal = new TrackingTerminal(40, 4);
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: new ResizeScheduler() },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		composers.push(composer);
		composer.ui.setMaxInlineImages(1);
		const transcript = new TranscriptContainer();
		const block = new Container();
		for (const key of ["first", "second", "third"]) {
			block.addChild(
				new Image(
					BASE64_ONE_PIXEL_PNG,
					"image/png",
					{ fallbackColor: text => text },
					{
						maxWidthCells: 1,
						maxHeightCells: 1,
						budget: composer.ui.imageBudget,
						imageKey: key,
					},
					{ widthPx: 10, heightPx: 10 },
				),
			);
		}
		transcript.addChild(block);
		composer.setRuntimeChildren([transcript, new MutableComposerTail()]);

		try {
			composer.start({ playWelcomeIntro: false });
			const output = terminal.writes.join("");
			expect(output.match(/\x1b_Ga=t/g)).toHaveLength(1);
			expect(plainBuffer(terminal).filter(row => row.includes("[Image:"))).toHaveLength(2);
		} finally {
			composer.ui.stop();
			Reflect.set(TERMINAL, "imageProtocol", originalProtocol);
			Reflect.set(TERMINAL, "id", originalTerminalId);
			setCellDimensions(originalCellDimensions);
			setKittyGraphics(originalGraphics);
		}
	});

	it("flushes a roomy finalized transcript before composer shutdown", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		composers.push(composer);
		const transcript = new TranscriptContainer();
		transcript.addChild(new WidthTranscriptBlock(1));
		composer.setRuntimeChildren([transcript, new MutableComposerTail()]);
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);
		expect(transcript.blockStates()).toEqual(["settled"]);

		composer.stop();

		expect(transcript.blockStates()).toEqual(["committed"]);
		expect(plainBuffer(terminal)).toContain("block-1@40");
	});
});
