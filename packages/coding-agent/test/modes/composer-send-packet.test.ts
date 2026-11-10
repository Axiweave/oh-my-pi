import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
} from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { COMPOSER_DEFAULTS, Composer, type SendMode } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

const SEED = 0x24_5e_4d;
const MODES: SendMode[] = ["queue", "guide", "stop", "notice"];

// mulberry32
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The bytes the Intake writes with `zmx send` (contracts/omp-send-packet.md). */
function packet(mode: string, text: string): string {
	return `\x1b_pi:send;${mode}.${Buffer.from(text).toString("base64url")}\x1b\\`;
}

const PIECES = [
	"a",
	" ",
	"\n",
	"\n\n",
	"\r\n",
	"\t",
	"\x1b",
	"\x1b\\",
	"\x00",
	"é",
	"日本",
	"🙂",
	"\u200d",
	"\ufeff",
	"/",
	"+",
];

/** Non-empty text of valid code points: no lone surrogates, which UTF-8 cannot carry. */
function genText(next: () => number, run: number): string {
	// About 64 KiB of UTF-8.
	if (run % 100 === 7) return "🙂x\n".repeat(10_922);
	const parts: string[] = [];
	for (let i = 1 + Math.floor(next() * 40); i > 0; i--) {
		if (next() < 0.7) parts.push(PIECES[Math.floor(next() * PIECES.length)]!);
		else {
			const cp = Math.floor(next() * 0x10ffff);
			parts.push(String.fromCodePoint(cp >= 0xd800 && cp <= 0xdfff ? cp - 0x800 : cp));
		}
	}
	return parts.join("");
}

describe(`composer pi:send packets (seed ${SEED})`, () => {
	let composer: Composer | undefined;

	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		composer?.stop();
		composer = undefined;
	});

	function start() {
		const term = new VirtualTerminal(80, 24);
		composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		composer.editor.setText("my draft");
		const sent: [SendMode, string][] = [];
		const statuses: string[] = [];
		composer.onSend = (mode, text) => sent.push([mode, text]);
		composer.onShowStatus = message => statuses.push(message);
		return { term, sent, statuses, editor: composer.editor };
	}

	it("delivers every encoded text unchanged to onSend and leaves the draft alone", () => {
		const { term, sent, statuses, editor } = start();
		const next = prng(SEED);
		for (let run = 0; run < 300; run++) {
			const mode = MODES[Math.floor(next() * MODES.length)]!;
			const text = genText(next, run);
			term.sendInput(packet(mode, text));
			const got = sent.at(-1);
			expect(sent.length, `seed ${SEED} run ${run}`).toBe(run + 1);
			// Compare without printing 64 KiB on a failure.
			expect(
				got?.[0] === mode && got[1] === text,
				`seed ${SEED} run ${run} ${JSON.stringify(text.slice(0, 80))}`,
			).toBe(true);
		}
		expect(statuses).toEqual([]);
		expect(editor.getText()).toBe("my draft");
	});

	it("holds valid packets that arrive before onSend and delivers each once, in order, when it is set", () => {
		const term = new VirtualTerminal(80, 24);
		composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		const next = prng(SEED);
		const early = Array.from(
			{ length: 12 },
			(_, run) => [MODES[run % MODES.length]!, genText(next, run)] as [SendMode, string],
		);
		for (const [mode, text] of early) term.sendInput(packet(mode, text));
		const sent: [SendMode, string][] = [];
		composer.onSend = (mode, text) => sent.push([mode, text]);
		expect(sent).toEqual(early);
		term.sendInput(packet("guide", "late"));
		composer.onSend = (mode, text) => sent.push([mode, text]);
		expect(sent).toEqual([...early, ["guide", "late"]]);
	});

	it.each([
		["an unknown mode", packet("steer", "x")],
		["an upper-case mode", packet("Queue", "x")],
		["no mode", packet("", "x")],
		["no separator", "\x1b_pi:send;queueeA\x1b\\"],
		["standard base64 /", "\x1b_pi:send;queue.a/8\x1b\\"],
		["standard base64 +", "\x1b_pi:send;queue.a+8\x1b\\"],
		["padding", "\x1b_pi:send;queue.eA==\x1b\\"],
		["a truncated base64 group", "\x1b_pi:send;queue.eHl6e\x1b\\"],
		["bytes that are not UTF-8", `\x1b_pi:send;guide.${Buffer.from([0xc3, 0x28, 0xff]).toString("base64url")}\x1b\\`],
		["empty text", packet("queue", "")],
		["an empty value", "\x1b_pi:send;\x1b\\"],
	])("ignores %s with one status line and no change to the draft", (_case, data) => {
		const { term, sent, statuses, editor } = start();
		term.sendInput(data);
		expect(sent).toEqual([]);
		expect(statuses.length).toBe(1);
		expect(editor.getText()).toBe("my draft");
	});
});

describe("InteractiveMode pi:send handler", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;

	beforeAll(() => {
		initTheme();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/**
	 * An InteractiveMode whose session records prompt/abort/waitForIdle/sendCustomMessage
	 * calls in order. With `holdAbort`, `abort` records its call, then waits for
	 * `releaseAbort`. With `holdIdle`, `waitForIdle` does the same with `releaseIdle`.
	 */
	async function harness(holdAbort = false, holdIdle = false) {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-send-packet-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		const theSession = session;
		const calls: unknown[][] = [];
		const waiters: { count: number; resolve: () => void }[] = [];
		const record = (call: unknown[]) => {
			calls.push(call);
			for (const waiter of waiters) if (calls.length >= waiter.count) waiter.resolve();
		};
		/** Resolves once `count` calls arrived. */
		const settled = (count: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ count, resolve });
			if (calls.length >= count) resolve();
			return promise;
		};
		const abortGate = Promise.withResolvers<void>();
		const idleGate = Promise.withResolvers<void>();
		vi.spyOn(session, "prompt").mockImplementation(async (text, options) => {
			record(["prompt", text, options?.streamingBehavior]);
			return true;
		});
		vi.spyOn(session, "abort").mockImplementation(async options => {
			record(["abort", options?.reason]);
			if (holdAbort) await abortGate.promise;
		});
		vi.spyOn(session, "waitForIdle").mockImplementation(async () => {
			record(["waitForIdle"]);
			if (holdIdle) await idleGate.promise;
		});
		vi.spyOn(session, "sendCustomMessage").mockImplementation(async (message, options) => {
			record(["sendCustomMessage", message, options]);
			return false;
		});
		const showError = vi.spyOn(mode, "showError").mockImplementation(() => {});
		return {
			mode,
			session: theSession,
			calls,
			settled,
			showError,
			releaseAbort: abortGate.resolve,
			releaseIdle: idleGate.resolve,
		};
	}

	const NOTICE = { customType: "intake-notice", content: "n", display: true, attribution: "agent" };

	it("sends a notice as one display-only custom message once the session is idle, with no prompt and no turn", async () => {
		const h = await harness();
		h.mode.ui.injectDebugInput(packet("notice", "n"));
		await h.settled(2);
		for (let i = 0; i < 20; i++) await Promise.resolve();
		// No deliverAs and no triggerTurn: an idle session appends and paints it without a turn.
		expect(h.calls).toEqual([["waitForIdle"], ["sendCustomMessage", NOTICE, undefined]]);
		expect(h.showError).not.toHaveBeenCalled();
	});

	it("keeps arrival order around a notice at an idle session", async () => {
		const h = await harness();
		h.mode.ui.injectDebugInput(packet("queue", "q1"));
		h.mode.ui.injectDebugInput(packet("notice", "n"));
		h.mode.ui.injectDebugInput(packet("queue", "q2"));
		await h.settled(4);
		expect(h.calls).toEqual([
			["prompt", "q1", "followUp"],
			["waitForIdle"],
			["sendCustomMessage", NOTICE, undefined],
			["prompt", "q2", "followUp"],
		]);
	});

	it("holds a notice until a busy session is idle, and a later guide still steers the running turn", async () => {
		const h = await harness(false, true);
		Object.defineProperty(h.session, "isStreaming", { get: () => true, configurable: true });
		h.mode.ui.injectDebugInput(packet("notice", "n"));
		h.mode.ui.injectDebugInput(packet("guide", "g"));
		await h.settled(2);
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(h.calls).toEqual([["waitForIdle"], ["prompt", "g", "steer"]]);
		h.releaseIdle();
		await h.settled(3);
		expect(h.calls.at(-1)).toEqual(["sendCustomMessage", NOTICE, undefined]);
		expect(h.calls.length).toBe(3);
	});

	/** Each `zmx set` argv the spied `ptree.exec` got, decoded to its labels. */
	function zmxSetLabels(exec: { mock: { calls: unknown[][] } }) {
		return exec.mock.calls
			.map(([argv]) => argv as string[])
			.filter(argv => argv[1] === "set")
			.map(argv =>
				Object.fromEntries(
					argv
						.slice(3)
						.map(pair => [pair.split("=")[0], Buffer.from(pair.split("=")[1]!, "base64url").toString()]),
				),
			);
	}

	/** Runs `body` with this process in a zmx session that publishes `cci-state`. */
	async function inPublishingChild(body: () => Promise<void>) {
		const env = { ZMX_SESSION: process.env.ZMX_SESSION, OMP_PUBLISH_STATE: process.env.OMP_PUBLISH_STATE };
		process.env.ZMX_SESSION = "cci-send-startup";
		process.env.OMP_PUBLISH_STATE = "1";
		try {
			await body();
		} finally {
			for (const [key, value] of Object.entries(env)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}

	it("publishes cci-state=idle at turn 0 once at startup when the child has no start prompt", async () => {
		await inPublishingChild(async () => {
			await harness();
			const exec = vi
				.spyOn(ptree, "exec")
				.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, ok: true } as ptree.ExecResult);
			vi.spyOn(vcs, "repo").mockReturnValue(null);
			vi.spyOn(vcs, "git").mockReturnValue(null);
			await mode!.init({ suppressWelcomeIntro: true });
			for (let i = 0; i < 100 && zmxSetLabels(exec).length < 1; i++) await Promise.resolve();
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(zmxSetLabels(exec)).toEqual([{ "cci-state": "idle", "cci-work": "", "cci-turn": "0" }]);
		});
	});

	it("maps queue to followUp, guide to steer, and stop to abort, waitForIdle, then prompt", async () => {
		const h = await harness();
		h.mode.ui.injectDebugInput(packet("queue", "q"));
		h.mode.ui.injectDebugInput(packet("guide", "g"));
		h.mode.ui.injectDebugInput(packet("stop", "s"));
		await h.settled(5);
		expect(h.calls).toEqual([
			["prompt", "q", "followUp"],
			["prompt", "g", "steer"],
			["abort", USER_INTERRUPT_LABEL],
			["waitForIdle"],
			["prompt", "s", undefined],
		]);
		expect(h.showError).not.toHaveBeenCalled();
	});

	it("keeps arrival order: a queue packet right after a stop waits until the late abort and waitForIdle end", async () => {
		const h = await harness(true);
		h.mode.ui.injectDebugInput(packet("stop", "stop text"));
		h.mode.ui.injectDebugInput(packet("queue", "queue text"));
		await h.settled(1);
		// Give an unchained queue prompt every microtask it would need to overtake the stop.
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(h.calls).toEqual([["abort", USER_INTERRUPT_LABEL]]);
		h.releaseAbort();
		await h.settled(4);
		expect(h.calls).toEqual([
			["abort", USER_INTERRUPT_LABEL],
			["waitForIdle"],
			["prompt", "stop text", undefined],
			["prompt", "queue text", "followUp"],
		]);
	});

	it("runs while a dialog is open and leaves the draft alone", async () => {
		const h = await harness();
		h.mode.editor.setText("draft");
		vi.spyOn(h.mode.ui, "hasOverlay").mockReturnValue(true);
		h.mode.ui.injectDebugInput(packet("guide", "while a dialog is open"));
		await h.settled(1);
		expect(h.calls).toEqual([["prompt", "while a dialog is open", "steer"]]);
		expect(h.mode.editor.getText()).toBe("draft");
	});

	it("holds a packet sent during startup until main.ts admits the start prompt, so its turn publishes state", async () => {
		await inPublishingChild(async () => {
			const h = await harness();
			// main.ts sets the gate right after the constructor (runInteractiveMode).
			const startAdmitted = Promise.withResolvers<void>();
			h.mode.spawnStartAdmitted = startAdmitted.promise;
			const listeners: AgentSessionEventListener[] = [];
			const subscribe = h.session.subscribe.bind(h.session);
			vi.spyOn(h.session, "subscribe").mockImplementation(listener => {
				listeners.push(listener);
				return subscribe(listener);
			});
			const exec = vi
				.spyOn(ptree, "exec")
				.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, ok: true } as ptree.ExecResult);
			vi.spyOn(vcs, "repo").mockReturnValue(null);
			vi.spyOn(vcs, "git").mockReturnValue(null);
			h.mode.ui.injectDebugInput(packet("queue", "follow-up"));
			await h.mode.init({ suppressWelcomeIntro: true, spawnStart: true });
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(h.calls).toEqual([]);
			// main.ts submits the start prompt; the stub admits it when it returns.
			await h.session.prompt("start", { streamingBehavior: "steer" });
			startAdmitted.resolve();
			await h.settled(2);
			expect(h.calls).toEqual([
				["prompt", "start", "steer"],
				["prompt", "follow-up", "followUp"],
			]);
			// Each follow-up turn reaches the cci-state subscriber that init set up.
			const turn = [
				{ type: "agent_start" },
				{ type: "message_start", message: { role: "user", content: "follow-up", timestamp: 1 } },
				{ type: "agent_end", messages: [] },
			] as unknown as AgentSessionEvent[];
			for (let n = 0; n < 2; n++) for (const event of turn) for (const listener of listeners) await listener(event);
			for (let i = 0; i < 100 && zmxSetLabels(exec).length < 4; i++) await Promise.resolve();
			// With a start prompt, no idle at startup: cci-turn rides with cci-state=idle, 1 then 2.
			expect(zmxSetLabels(exec)).toEqual([
				{ "cci-state": "working", "cci-work": "follow-up" },
				{ "cci-state": "idle", "cci-work": "", "cci-turn": "1" },
				{ "cci-state": "working", "cci-work": "follow-up" },
				{ "cci-state": "idle", "cci-work": "", "cci-turn": "2" },
			]);
		});
	});

	/** An InteractiveMode on a real session whose model answers through `handler`. */
	async function realHarness(handler: MockHandler, extensionRunner?: unknown) {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-send-packet-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: createMockModel({ handler }).stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner: extensionRunner as never,
		});
		const s = session;
		mode = new InteractiveMode(s, "test");
		const showError = vi.spyOn(mode, "showError").mockImplementation(() => {});
		const promptCalls: string[] = [];
		const finished = new Map<string, PromiseWithResolvers<void>>();
		/** Resolves once a prompt of `text` returns. */
		const promptDone = (text: string) => {
			if (!finished.has(text)) finished.set(text, Promise.withResolvers<void>());
			return finished.get(text)!.promise;
		};
		const prompt = s.prompt.bind(s);
		vi.spyOn(s, "prompt").mockImplementation(async (text, options) => {
			promptCalls.push(text);
			try {
				return await prompt(text, options);
			} finally {
				void promptDone(text);
				finished.get(text)!.resolve();
			}
		});
		/** User texts of the transcript, in order. */
		const userTexts = () =>
			s.messages.flatMap(m =>
				m.role !== "user"
					? []
					: [
							typeof m.content === "string"
								? m.content
								: m.content.map(c => (c.type === "text" ? c.text : "")).join(""),
						],
			);
		return { mode, session: s, modelRegistry, showError, promptCalls, promptDone, userTexts };
	}

	it("sends a follow-up that a stop drops during its turn setup again, before the stop text", async () => {
		const h = await realHarness({ content: ["Done"] });
		// Hold the first follow-up in its turn setup until the stop's abort has started.
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const getApiKey = h.modelRegistry.getApiKey.bind(h.modelRegistry);
		vi.spyOn(h.modelRegistry, "getApiKey").mockImplementationOnce(async (...args) => {
			reached.resolve();
			await release.promise;
			return getApiKey(...args);
		});
		const abort = h.session.abort.bind(h.session);
		vi.spyOn(h.session, "abort").mockImplementation(async options => {
			const done = abort(options);
			release.resolve();
			await done;
		});
		h.mode.editor.setText("");
		h.mode.ui.injectDebugInput(packet("queue", "first"));
		await reached.promise;
		h.mode.ui.injectDebugInput(packet("stop", "second"));
		await h.promptDone("second");
		await h.session.waitForIdle();
		expect(h.promptCalls).toEqual(["first", "first", "second"]);
		expect(h.showError).not.toHaveBeenCalled();
		expect(h.mode.editor.getText()).toBe("");
		expect(h.userTexts()).toEqual(["first", "second"]);
	});

	it("runs a queued follow-up before a later stop's text, each once", async () => {
		const turnRuns = Promise.withResolvers<void>();
		let calls = 0;
		// The first turn runs until the stop aborts it. Later turns answer at once.
		const h = await realHarness(() => {
			if (calls++ > 0) return { content: ["Done"] };
			turnRuns.resolve();
			return { content: ["Slow"], delayMs: 60_000 };
		});
		h.mode.ui.injectDebugInput(packet("queue", "running"));
		await turnRuns.promise;
		h.mode.ui.injectDebugInput(packet("queue", "A"));
		h.mode.ui.injectDebugInput(packet("stop", "B"));
		await h.promptDone("B");
		await h.session.waitForIdle();
		expect(h.userTexts()).toEqual(["running", "A", "B"]);
		expect(h.showError).not.toHaveBeenCalled();
	});

	it("runs a guide that still waits in the steering queue before a later stop's text, each once", async () => {
		const turnRuns = Promise.withResolvers<void>();
		let calls = 0;
		// The first turn runs until the stop aborts it. Later turns answer at once.
		const h = await realHarness(() => {
			if (calls++ > 0) return { content: ["Done"] };
			turnRuns.resolve();
			return { content: ["Slow"], delayMs: 60_000 };
		});
		h.mode.ui.injectDebugInput(packet("queue", "running"));
		await turnRuns.promise;
		h.mode.ui.injectDebugInput(packet("guide", "A"));
		await h.promptDone("A");
		// The slow turn has not taken A from the steering queue.
		expect(h.session.agent.peekSteeringQueue().length).toBe(1);
		h.mode.ui.injectDebugInput(packet("stop", "B"));
		await h.promptDone("B");
		await h.session.waitForIdle();
		expect(h.userTexts()).toEqual(["running", "A", "B"]);
		expect(h.showError).not.toHaveBeenCalled();
	});

	it("keeps arrival order when a stop drops a follow-up in its turn setup while a later guide waits in the steering queue", async () => {
		const h = await realHarness({ content: ["Done"] });
		// Hold the first follow-up in its turn setup until the stop's abort has started. Without
		// the fix, the abort's drain runs the queued guide A before the dropped follow-up is sent again.
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const getApiKey = h.modelRegistry.getApiKey.bind(h.modelRegistry);
		vi.spyOn(h.modelRegistry, "getApiKey").mockImplementationOnce(async (...args) => {
			reached.resolve();
			await release.promise;
			return getApiKey(...args);
		});
		const abort = h.session.abort.bind(h.session);
		vi.spyOn(h.session, "abort").mockImplementation(async options => {
			const done = abort(options);
			release.resolve();
			await done;
		});
		h.mode.ui.injectDebugInput(packet("queue", "first"));
		await reached.promise;
		h.mode.ui.injectDebugInput(packet("guide", "A"));
		await h.promptDone("A");
		expect(h.session.agent.peekSteeringQueue().length).toBe(1);
		h.mode.ui.injectDebugInput(packet("stop", "B"));
		await h.promptDone("B");
		await h.session.waitForIdle();
		expect(h.userTexts()).toEqual(["first", "A", "B"]);
		expect(h.showError).not.toHaveBeenCalled();
	});

	it("sends a follow-up that names an extension command to the agent as text, as the start prompt does", async () => {
		const handler = vi.fn(async () => {});
		// A stand-in runner: it knows one command, has no event handlers, and ignores every other call.
		const runner = new Proxy(
			{},
			{
				get: (_target, key) =>
					key === "then"
						? undefined
						: key === "getCommand"
							? (name: string) => (name === "someext" ? { name, handler } : undefined)
							: key === "hasHandlers"
								? () => false
								: () => undefined,
			},
		);
		const h = await realHarness({ content: ["Done"] }, runner);
		h.mode.ui.injectDebugInput(packet("queue", "/someext arg"));
		await h.promptDone("/someext arg");
		await h.session.waitForIdle();
		expect(handler).not.toHaveBeenCalled();
		expect(h.userTexts()).toEqual(["/someext arg"]);
		expect(h.showError).not.toHaveBeenCalled();
	});
});
