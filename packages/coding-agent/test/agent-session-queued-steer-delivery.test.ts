/**
 * Contract: a custom message steered into a streaming session (the collab-host
 * and skill-prompt path: `promptCustomMessage(..., { streamingBehavior: "steer" })`)
 * is always delivered — never silently stranded in the agent's steering queue.
 *
 * Two regression seams, both observed as "guest messages just disappear" in
 * collab sessions:
 *  1. A steer landing at the run's yield boundary (after the stop-boundary
 *     dequeue) must force another turn instead of stranding.
 *  2. A steer landing while the prompt unwinds (isStreaming stays true through
 *     post-prompt recovery, but the loop is already done) must be drained when
 *     the session settles.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionConfig } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const COLLAB_PROMPT_TYPE = "collab-prompt";

interface SteerHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
}

describe("AgentSession queued steer delivery", () => {
	let tempDir: string;
	let fixtureDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;

	beforeAll(async () => {
		fixtureDir = path.join(os.tmpdir(), `pi-steer-strand-fixture-${Snowflake.next()}`);
		fs.mkdirSync(fixtureDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(fixtureDir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir, "models.yml"));
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-steer-strand-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		removeSyncWithRetries(tempDir);
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(fixtureDir);
	});

	async function createSession(
		responses: MockResponse[],
		commands: Pick<AgentSessionConfig, "slashCommands" | "promptTemplates"> = {},
	): Promise<SteerHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, ...commands });
		return { session, sessionManager, mock };
	}

	function steerCollabPrompt(target: AgentSession, text: string): Promise<boolean> {
		return target.promptCustomMessage(
			{
				customType: COLLAB_PROMPT_TYPE,
				content: text,
				display: true,
				details: { from: "guest" },
				attribution: "user",
			},
			{ streamingBehavior: "steer" },
		);
	}

	function nextUserMessage(target: AgentSession, expected: string): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = target.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "user") return;
			const content = event.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("");
			if (text !== expected) return;
			unsubscribe();
			resolve();
		});
		return promise;
	}

	/** Resolves with the entry text when a collab-prompt entry is persisted. */
	function nextCollabEntry(sessionManager: SessionManager): Promise<string> {
		const { promise, resolve } = Promise.withResolvers<string>();
		sessionManager.onEntryAppended = entry => {
			if (entry.type === "custom_message" && entry.customType === COLLAB_PROMPT_TYPE) {
				resolve(typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content));
			}
		};
		return promise;
	}

	it("delivers a collab steer that lands at the run's yield boundary", async () => {
		const { session, sessionManager, mock } = await createSession([
			{ content: ["host answer"] },
			{ content: ["ack guest"] },
		]);
		const entryAppended = nextCollabEntry(sessionManager);

		let streamingAtInject: boolean | undefined;
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			// The session is still mid-prompt here, so this takes the steer path.
			streamingAtInject = session.isStreaming;
			await steerCollabPrompt(session, "guest steer at yield");
		});

		await session.prompt("hello");

		expect(streamingAtInject).toBe(true);
		expect(await entryAppended).toBe("guest steer at yield");
		expect(mock.calls.length).toBe(2);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("persists an agent-authored steer with its steering marker", async () => {
		const { session, sessionManager } = await createSession([
			{ content: ["host answer"] },
			{ content: ["ack parent"] },
		]);
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			await session.sendUserMessage("parent budget notice", {
				deliverAs: "steer",
				attribution: "agent",
			});
		});

		await session.prompt("hello");

		const entry = sessionManager.getEntries().find(candidate => {
			if (candidate.type !== "message" || candidate.message.role !== "user") return false;
			const content = candidate.message.content;
			return (
				Array.isArray(content) && content.some(part => part.type === "text" && part.text === "parent budget notice")
			);
		});
		if (entry?.type !== "message" || entry.message.role !== "user") {
			throw new Error("Expected persisted parent steer");
		}
		expect(entry.message.attribution).toBe("agent");
		expect(entry.message.steering).toBe(true);
	});

	it("defaults direct user steers and idle prompts to user attribution", async () => {
		const { session } = await createSession([{ content: ["ack user"] }]);

		await session.sendUserMessage("typed normally");
		const promptMessage = session.state.messages.find(candidate => {
			if (candidate.role !== "user") return false;
			const content = candidate.content;
			return (
				content === "typed normally" ||
				(Array.isArray(content) && content.some(part => part.type === "text" && part.text === "typed normally"))
			);
		});
		if (promptMessage?.role !== "user") {
			throw new Error("Expected user prompt in session state");
		}
		expect(promptMessage.attribution).toBe("user");

		await session.steer("user steer");
		const steer = session.agent.popLastSteer();
		if (steer?.role !== "user") throw new Error("Expected queued user steer");
		expect(steer.attribution).toBe("user");
		expect(steer.steering).toBe(true);
	});

	it("preserves explicit agent attribution across queued text-message APIs", async () => {
		const { session } = await createSession([]);

		await session.steer("parent steer", undefined, { attribution: "agent" });
		const steer = session.agent.popLastSteer();
		if (steer?.role !== "user") throw new Error("Expected queued agent-attributed steer");
		expect(steer.attribution).toBe("agent");
		expect(steer.steering).toBe(true);

		await session.followUp("parent follow-up", undefined, { attribution: "agent" });
		const followUp = session.agent.popLastFollowUp();
		if (followUp?.role !== "user") throw new Error("Expected queued agent-attributed follow-up");
		expect(followUp.attribution).toBe("agent");

		await session.sendUserMessage("host steer", { deliverAs: "steer", attribution: "agent" });
		const hostSteer = session.agent.popLastSteer();
		if (hostSteer?.role !== "user") throw new Error("Expected queued host steer");
		expect(hostSteer.attribution).toBe("agent");
	});

	// A queued file command must deliver its instructions, not its invocation.
	it.each(["followUp", "steer"] as const)("expands file commands before %s delivery", async mode => {
		const { session, mock } = await createSession([{ content: ["host answer"] }, { content: ["command answer"] }], {
			slashCommands: [{ name: "speckit.converge", description: "", content: "/review $ARGUMENTS", source: "test" }],
			promptTemplates: [
				{ name: "review", description: "", content: "Review the remaining work: $ARGUMENTS", source: "test" },
			],
		});
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			await session[mode]('/speckit.converge "two words"');
			const queued = session.getQueuedMessages();
			expect(mode === "steer" ? queued.steering : queued.followUp).toEqual(['/speckit.converge "two words"']);
		});

		await session.prompt("hello");
		await session.waitForIdle();

		const message = mock.calls.at(-1)?.context.messages.findLast(message => message.role === "user");
		expect(message?.content).toEqual([{ type: "text", text: "Review the remaining work: two words" }]);

		// The live transcript and session reload must retain the compact invocation.
		for (const messages of [session.state.messages, session.sessionManager.buildSessionContext().messages]) {
			const queued = messages.findLast(message => message.role === "user");
			if (queued?.role !== "user") throw new Error("Expected delivered queued command");
			expect(queued.promptTemplate).toBe("review");
			expect(queued.promptTemplateInput).toBe('/speckit.converge "two words"');
		}
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("keeps a queued command literal when expansion is disabled", async () => {
		const { session, mock } = await createSession([{ content: ["host answer"] }, { content: ["literal answer"] }], {
			slashCommands: [{ name: "literal", description: "", content: "Expanded body", source: "test" }],
			promptTemplates: [{ name: "literal", description: "", content: "Template body", source: "test" }],
		});
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			await session.followUp("/literal", undefined, { expandPromptTemplates: false });
		});

		await session.prompt("hello");
		await session.waitForIdle();

		const message = mock.calls.at(-1)?.context.messages.findLast(message => message.role === "user");
		expect(message?.content).toEqual([{ type: "text", text: "/literal" }]);
		const literal = session.state.messages.findLast(message => message.role === "user");
		if (literal?.role !== "user") throw new Error("Expected literal queued command");
		expect(literal.promptTemplate).toBeUndefined();
		expect(literal.promptTemplateInput).toBeUndefined();
	});

	// Compaction replay must retain both command instructions and attachments while busy.
	it.each(["mixed", "commands-only"] as const)("replays %s compaction commands without losing images", async kind => {
		const { session, mock } = await createSession(
			[{ content: ["host answer"] }, { content: ["queued answer"] }, { content: ["command answer"] }],
			{
				slashCommands: [
					{ name: "speckit.converge", description: "", content: "Review $ARGUMENTS", source: "test" },
				],
			},
		);
		const image: ImageContent = {
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
		};
		const command: CompactionQueuedMessage = {
			text: "/speckit.converge remaining work",
			mode: kind === "mixed" ? "followUp" : "steer",
			images: [image],
		};
		const errors: string[] = [];
		const ctx = {
			session,
			skillCommands: new Map(),
			compactionQueuedMessages:
				kind === "mixed" ? [{ text: "queued plain prompt", mode: "followUp" }, command] : [command],
			isKnownSlashCommand: (text: string) => text.startsWith("/speckit.converge"),
			recordLocalSubmission: () => () => {},
			withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
			updatePendingMessagesDisplay: () => {},
			showError: (error: string) => errors.push(error),
		} as unknown as InteractiveModeContext;
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			await new UiHelpers(ctx).flushCompactionQueue();
		});

		await session.prompt("hello");
		await session.waitForIdle();

		expect(errors).toEqual([]);
		const message = mock.calls.at(-1)?.context.messages.findLast(message => message.role === "user");
		expect(message?.content).toEqual([
			{ type: "text", text: "Review remaining work" },
			expect.objectContaining({ type: "image" }),
		]);
		expect(ctx.compactionQueuedMessages).toEqual([]);
	});

	it("drains a steer stranded in the agent queue when the session settles", async () => {
		const { session, sessionManager, mock } = await createSession([
			{ content: ["host answer"] },
			{ content: ["ack guest"] },
		]);
		const entryAppended = nextCollabEntry(sessionManager);

		// Inject from the wire agent_end subscriber: it fires synchronously while
		// the session settles (#promptInFlightCount just hit 0), after the agent
		// loop's final queue poll — a message queued here is invisible to the run
		// and must be picked up by the settle-time drain.
		const secondRunDone = Promise.withResolvers<void>();
		let agentEnds = 0;
		session.subscribe(event => {
			if (event.type !== "agent_end") return;
			agentEnds++;
			if (agentEnds === 1) {
				session.agent.steer({
					role: "custom",
					customType: COLLAB_PROMPT_TYPE,
					content: "guest steer at settle",
					display: true,
					details: { from: "guest" },
					attribution: "user",
					timestamp: Date.now(),
				});
			} else if (agentEnds === 2) {
				secondRunDone.resolve();
			}
		});

		await session.prompt("hello");
		expect(await entryAppended).toBe("guest steer at settle");
		await secondRunDone.promise;

		expect(mock.calls.length).toBe(2);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("drains steering left after aborting an auto-continued queued turn", async () => {
		const { session, mock } = await createSession([
			{ content: ["initial response"] },
			{ content: ["first queued response"], delayMs: 1_000 },
			{ content: ["second queued response"] },
		]);
		await session.prompt("hello");
		expect(mock.calls.length).toBe(1);

		const firstDelivered = nextUserMessage(session, "first queued");
		await session.steer("first queued");
		await firstDelivered;
		expect(mock.calls.length).toBe(2);

		await session.steer("second queued");
		expect(session.getQueuedMessages().steering).toContain("second queued");

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();

		expect(
			session.agent.state.messages.some(message => message.role === "assistant" && message.stopReason === "aborted"),
		).toBe(true);

		expect(mock.calls.length).toBe(3);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual([]);
	});

	// Invariant: a provider claim cannot disable empty-Enter interruption or lose the pending user message.
	it.each([
		{ focused: false, accepted: false },
		{ focused: false, accepted: true },
		{ focused: true, accepted: false },
		{ focused: true, accepted: true },
	])("interrupts live-claimed steering with empty Enter (%j)", async ({ focused, accepted }) => {
		const { session, mock } = await createSession([
			{ content: ["interrupted response"] },
			{ content: ["ack queued"] },
		]);
		const started = Promise.withResolvers<void>();
		const claimed = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		let first = true;
		session.agent.streamFn = async (model, context, options) => {
			if (first) {
				first = false;
				const live = options?.liveSteering;
				const signal = options?.signal;
				if (!live || !signal) throw new Error("Expected live steering and an abort signal");
				started.resolve();
				await live.wait(signal);
				const claim = await live.claim(signal);
				if (!claim) throw new Error("Expected a pending steering claim");
				if (accepted) claim.accept();
				else claim.reject();
				claimed.resolve(signal);
				await Promise.race([
					release.promise,
					new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })),
				]);
			}
			return mock.stream(model, context, options);
		};
		const editor = new CustomEditor({});
		// The real editor's empty-submit path needs only these host services.
		const ctx = {
			editor,
			session,
			viewSession: session,
			focusedAgentId: focused ? "child" : undefined,
			updatePendingMessagesDisplay() {},
			ui: { requestRender() {} },
		} as unknown as InteractiveModeContext;
		new InputController(ctx).setupEditorSubmitHandler();
		const onSubmit = editor.onSubmit!;
		let submitted = Promise.resolve();
		editor.onSubmit = text => {
			submitted = Promise.resolve(onSubmit(text));
		};
		const run = session.prompt("start");
		try {
			await started.promise;
			await session.steer("123123");
			const signal = await claimed.promise;
			expect(session.getQueuedMessages().steering).toEqual([]);
			editor.handleInput("\r");
			expect(signal.aborted).toBe(true);
			await submitted;
			await run;
			await session.waitForIdle();
			const users = session.messages.filter(message => message.role === "user");
			expect(users.map(message => message.content)).toEqual([
				[{ type: "text", text: "start" }],
				[{ type: "text", text: "123123" }],
			]);
			expect(session.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "ack queued" }],
			});
			expect(session.queuedMessageCount).toBe(0);
		} finally {
			release.resolve();
			await run;
			await session.waitForIdle();
		}
	});

	it("dequeuing an ultrathink prompt mid-stream restores the text and drops its companion notice", async () => {
		const { session } = await createSession([{ content: ["host answer"] }]);
		let queuedShape: string[] | undefined;
		let clearedSteering: unknown;
		let hasQueuedAfterClear: boolean | undefined;
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			// Real path: a magic-keyword prompt steered mid-stream enqueues the hidden
			// notice immediately before the user message.
			await session.prompt("ultrathink fix it", { streamingBehavior: "steer" });
			queuedShape = session.agent.peekSteeringQueue().map(m => (m.role === "custom" ? m.customType : m.role));
			// Alt+Up restore mid-flight: only the user's text returns; the companion
			// notice must not be left orphaned in the queue.
			const cleared = session.clearQueue();
			clearedSteering = cleared.steering;
			hasQueuedAfterClear = session.agent.hasQueuedMessages();
		});

		await session.prompt("hello");

		expect(queuedShape).toEqual(["ultrathink-notice", "user"]);
		expect(clearedSteering).toEqual([{ text: "ultrathink fix it", images: undefined }]);
		expect(hasQueuedAfterClear).toBe(false);
	});

	it("a fresh user prompt delivers queued steer and follow-up work", async () => {
		const { session } = await createSession([{ content: ["one"] }, { content: ["two"] }, { content: ["three"] }]);
		// Queue real pending work before the user's next send.
		session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "queued steer" }],
			steering: true,
			attribution: "user",
			timestamp: Date.now(),
		});
		session.agent.followUp({
			role: "user",
			content: [{ type: "text", text: "queued follow-up" }],
			attribution: "user",
			timestamp: Date.now(),
		});
		expect(session.agent.hasQueuedMessages()).toBe(true);

		await session.prompt("hello");
		await session.waitForIdle();

		// Sending a fresh prompt is the opportunity to drain everything: the steer folds
		// into the new turn and the follow-up runs as its continuation — nothing stranded.
		const userTexts = session.agent.state.messages
			.filter(message => message.role === "user")
			.map(message =>
				typeof message.content === "string"
					? message.content
					: message.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join(""),
			);
		expect(userTexts).toContain("hello");
		expect(userTexts).toContain("queued steer");
		expect(userTexts).toContain("queued follow-up");
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("resumes a queued steer left behind a non-advisor custom transcript tail", async () => {
		const { session } = await createSession([{ content: ["first answer"] }, { content: ["resumed"] }]);
		await session.prompt("first");
		// A non-advisor custom (e.g. a flushed irc:incoming aside) is the literal transcript tail.
		// A queued steer must resume regardless of tail role — Agent.continue injects it via the
		// initial steering poll — so the old advisor-only look-back can no longer strand it.
		const aside = {
			role: "custom" as const,
			customType: "irc:incoming",
			content: "peer pinged you",
			display: true,
			attribution: "agent" as const,
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_start", message: aside });
		session.agent.emitExternalEvent({ type: "message_end", message: aside });

		const delivered = nextUserMessage(session, "resume me");
		await session.steer("resume me");
		await delivered;
		await session.waitForIdle();

		expect(session.agent.peekSteeringQueue()).toEqual([]);
	});
});
