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
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { tryRunRpcSkillCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionConfig } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, type CustomMessage, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { tagImageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const COLLAB_PROMPT_TYPE = "collab-prompt";
const IMAGE_SOURCE_PATH = "/tmp/private-project/screenshot.png";
/** A path-pasted image: its source path rides in a hidden `image-attachment` companion. */
const PATH_PASTED_IMAGE = tagImageAttachmentSource(
	{
		type: "image",
		mimeType: "image/png",
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
	},
	IMAGE_SOURCE_PATH,
	"image",
);

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
			convertToLlm,
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
			expect(session.queuedMessageCount).toBe(1);
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

	it("keeps the attachment of a keyword prompt steered mid-stream", async () => {
		const { session } = await createSession([{ content: ["host answer"] }]);
		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
		};
		let queuedUserContent: string[] | undefined;
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			// The mid-stream branch queues before normalization runs: its
			// companion notices must not be mistaken for prepared attachments,
			// or the image never reaches the queued message.
			await session.prompt("ultrathink look at this", { images: [image], streamingBehavior: "steer" });
			const queued = session.agent.peekSteeringQueue();
			const userMessage = queued.find(message => message.role === "user");
			queuedUserContent = Array.isArray(userMessage?.content)
				? userMessage.content.map(part => part.type)
				: undefined;
		});

		await session.prompt("hello");

		expect(queuedUserContent).toEqual(["text", "image"]);
	});

	it("delivers a queued path-pasted image prompt in the same one-at-a-time turn as its source path", async () => {
		const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["image answer"] }]);
		session.agent.setFollowUpMode("one-at-a-time");
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			await session.followUp("What is in [Image #1]?", [PATH_PASTED_IMAGE]);
		});

		await session.prompt("start");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		const delivered = JSON.stringify(mock.calls[1].context.messages);
		expect(delivered).toContain(IMAGE_SOURCE_PATH);
		expect(delivered).toContain("What is in [Image #1]?");
		expect(session.agent.hasQueuedMessages()).toBe(false);
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

	it("delivers an RPC skill through the default steering queue with its invocation intact", async () => {
		const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["skill response"] }]);
		const skillPath = path.join(tempDir, "SKILL.md");
		await Bun.write(skillPath, "---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code.\n");
		const invocation = "/skill:reviewer  focus on risks\nand correctness";
		let queued: { steering: readonly string[]; followUp: readonly string[] } | undefined;
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			await tryRunRpcSkillCommand(
				{
					skillsSettings: { enableSkillCommands: true },
					skills: [
						{
							name: "reviewer",
							description: "Review code",
							filePath: skillPath,
							baseDir: tempDir,
							source: "project",
						},
					],
					promptCustomMessage: session.promptCustomMessage.bind(session),
				},
				invocation,
			);
			queued = session.getQueuedMessages();
		});

		await session.prompt("start");
		await session.waitForIdle();

		expect(queued).toEqual({ steering: [invocation], followUp: [] });
		const delivered = session.messages.filter(
			(message): message is CustomMessage => message.role === "custom" && message.customType === "skill-prompt",
		);
		expect(delivered).toHaveLength(1);
		expect(delivered[0].content).toContain("focus on risks\nand correctness");
		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(mock.calls[1].context.messages)).toContain("Review the supplied code.");
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	describe("removeQueuedMessage", () => {
		for (const kind of ["prompt", "skill"] as const) {
			it(`claims concurrent ${kind} companions atomically in one-at-a-time mode`, async () => {
				const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["kept B"] }]);
				const queue = kind === "prompt" ? "steering" : "followUp";
				const streamingBehavior = kind === "prompt" ? "steer" : "followUp";
				session.agent.setSteeringMode("one-at-a-time");
				session.agent.setFollowUpMode("one-at-a-time");
				const chip = (name: string) =>
					kind === "prompt" ? `ultrathink ${name}` : `/skill:reviewer ultrathink ${name}`;
				const submit = (name: string) =>
					kind === "prompt"
						? session.prompt(chip(name), { streamingBehavior })
						: session.promptCustomMessage(
								{
									customType: "skill-prompt",
									content: `Expanded review context for ${name}`,
									display: true,
									attribution: "user",
									details: { name: "reviewer", args: `ultrathink ${name}` },
								},
								{ streamingBehavior, queueChipText: chip(name) },
							);
				let queued: readonly AgentMessage[] = [];
				let remaining: readonly AgentMessage[] = [];
				let pendingAtFirstRecord: readonly string[] | undefined;
				let removedAfterClaim: boolean | undefined;
				let removed = false;
				let injected = false;
				session.agent.subscribe(event => {
					if (event.type !== "message_start" || event.message !== remaining[0]) return;
					pendingAtFirstRecord = session.getQueuedMessages()[queue];
					removedAfterClaim = session.removeQueuedMessage(chip("keep B"), queue);
				});
				session.agent.setOnBeforeYield(async () => {
					if (injected) return;
					injected = true;
					// Hold the running turn while both real submissions cross their async
					// preprocessing from the same barrier, without serializing either call.
					const release = Promise.withResolvers<void>();
					const first = release.promise.then(() => submit("cancel A"));
					const second = release.promise.then(() => submit("keep B"));
					release.resolve();
					await Promise.all([first, second]);
					queued = [
						...(queue === "steering" ? session.agent.peekSteeringQueue() : session.agent.peekFollowUpQueue()),
					];
					removed = session.removeQueuedMessage(chip("cancel A"), queue);
					remaining = [
						...(queue === "steering" ? session.agent.peekSteeringQueue() : session.agent.peekFollowUpQueue()),
					];
				});

				await session.prompt("start");
				await session.waitForIdle();

				const userRole = kind === "prompt" ? "user" : "skill-prompt";
				expect(queued.map(message => (message.role === "custom" ? message.customType : message.role))).toEqual([
					"ultrathink-notice",
					userRole,
					"ultrathink-notice",
					userRole,
				]);
				expect(removed).toBe(true);
				expect(remaining).toEqual(queued.slice(2));
				expect(pendingAtFirstRecord).toEqual([]);
				expect(removedAfterClaim).toBe(false);
				const notices = session.messages.filter(
					(message): message is CustomMessage =>
						message.role === "custom" && message.customType === "ultrathink-notice",
				);
				expect<readonly AgentMessage[]>(notices).toEqual([queued[2]]);
				expect(mock.calls).toHaveLength(2);
				const delivered = JSON.stringify(mock.calls[1].context.messages);
				expect(delivered).toContain("keep B");
				expect(delivered).not.toContain("cancel A");
				expect(delivered).toContain(JSON.stringify(notices[0].content).slice(1, -1));
				expect(session.agent.hasQueuedMessages()).toBe(false);
			});
		}

		for (const queue of ["steering", "followUp"] as const) {
			it(`prevents delivery of a ${queue} prompt and its hidden companions`, async () => {
				const { session, mock } = await createSession([{ content: ["initial"] }]);
				let injected = false;
				let removed: boolean | undefined;
				session.agent.setOnBeforeYield(async () => {
					if (injected) return;
					injected = true;
					await session.prompt("cancel this ultrathink", {
						streamingBehavior: queue === "steering" ? "steer" : "followUp",
					});
					removed = session.removeQueuedMessage("cancel this ultrathink", queue);
				});

				await session.prompt("start");
				await session.waitForIdle();

				expect(removed).toBe(true);
				expect(session.removeQueuedMessage("cancel this ultrathink", queue)).toBe(false);
				expect(session.agent.hasQueuedMessages()).toBe(false);
				expect(mock.calls).toHaveLength(1);
				expect(session.messages.filter(message => message.role === "user" || message.role === "custom")).toEqual([
					expect.objectContaining({ role: "user", content: [{ type: "text", text: "start" }] }),
				]);
			});

			it(`removes only the first user match and its companions from ${queue}`, async () => {
				const { session } = await createSession([]);
				const internal: AgentMessage = {
					role: "custom",
					customType: "advisor",
					content: "duplicate",
					attribution: "agent",
					display: true,
					timestamp: 1,
				};
				const internalUser: AgentMessage = {
					role: "user",
					content: "duplicate",
					attribution: "agent",
					timestamp: 1,
				};
				const companion: AgentMessage = {
					role: "custom",
					customType: "image-attachment-description",
					content: "hidden",
					attribution: "user",
					display: false,
					timestamp: 2,
				};
				const keyword: AgentMessage = { ...companion, customType: "ultrathink-notice" };
				const video: AgentMessage = { ...companion, customType: "video-attachment" };
				const first: AgentMessage = { role: "user", content: "duplicate", timestamp: 3 };
				const keptCompanion: AgentMessage = { ...companion, timestamp: 4 };
				const duplicate: AgentMessage = { ...first, timestamp: 5 };
				const selected = [internal, internalUser, keyword, video, companion, first, keptCompanion, duplicate];
				const other = [
					{ ...companion, timestamp: 6 },
					{ ...first, timestamp: 7 },
				];
				session.agent.replaceQueues(
					queue === "steering" ? selected : other,
					queue === "followUp" ? selected : other,
				);

				expect(session.getQueuedMessages()[queue]).toEqual(["duplicate", "duplicate"]);
				expect(session.removeQueuedMessage("duplicate", queue)).toBe(true);
				const remaining = [internal, internalUser, keptCompanion, duplicate];
				expect(session.agent.peekSteeringQueue()).toEqual(queue === "steering" ? remaining : other);
				expect(session.agent.peekFollowUpQueue()).toEqual(queue === "followUp" ? remaining : other);
				expect(session.removeQueuedMessage("hidden", queue)).toBe(false);
				expect(session.removeQueuedMessage("absent", queue)).toBe(false);
				expect(session.removeQueuedMessage("duplicate", queue)).toBe(true);
				expect(session.removeQueuedMessage("duplicate", queue)).toBe(false);
				expect(session.agent.peekSteeringQueue()).toEqual(queue === "steering" ? [internal, internalUser] : other);
				expect(session.agent.peekFollowUpQueue()).toEqual(queue === "followUp" ? [internal, internalUser] : other);
				expect(session.getQueuedMessages()[queue]).toEqual([]);
			});
		}

		it("removes a queued path-pasted image prompt together with its private source path", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }]);
			let injected = false;
			let removed: boolean | undefined;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await session.followUp("What is in [Image #1]?", [PATH_PASTED_IMAGE]);
				removed = session.removeQueuedMessage("What is in [Image #1]?", "followUp");
			});

			await session.prompt("start");
			await session.waitForIdle();

			expect(removed).toBe(true);
			expect(session.agent.hasQueuedMessages()).toBe(false);
			expect(mock.calls).toHaveLength(1);
			expect(session.messages.filter(message => message.role === "user" || message.role === "custom")).toEqual([
				expect.objectContaining({ role: "user", content: [{ type: "text", text: "start" }] }),
			]);
		});

		it("matches raw and expanded prompt-template chips without changing surviving work", async () => {
			const { session } = await createSession([], {
				promptTemplates: [{ name: "review", description: "Review", content: "Review $1", source: "(test)" }],
			});
			await session.followUp("/review raw", undefined, { expandPromptTemplates: false });
			await session.followUp("/review expanded");
			await session.followUp("keep");

			expect(session.removeQueuedMessage("/review raw", "followUp")).toBe(true);
			expect(session.removeQueuedMessage("/review expanded", "followUp")).toBe(true);
			expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: ["keep"] });
		});

		it("removes a queued file-based slash command by its raw /cmd invocation", async () => {
			const { session } = await createSession([]);
			session.setSlashCommands([{ name: "cmd", description: "Test", content: "Expanded $1", source: "(test)" }]);

			// #dispatchPrompt's slash-command rewrite only runs on prompt(); force
			// the busy-session queueing branch without a real turn.
			session.agent.state.isStreaming = true;
			try {
				const queued = await session.prompt("/cmd args", { streamingBehavior: "steer" });
				expect(queued).toBe(true);
				// Fork: queue chips show the original command (Collapsed command cards).
				expect(session.getQueuedMessages().steering).toEqual(["/cmd args"]);

				// The caller only ever holds its raw "/cmd args" invocation; removal
				// must still find the slash-command-expanded queued chip.
				expect(session.removeQueuedMessage("/cmd args", "steering")).toBe(true);
				expect(session.getQueuedMessages().steering).toEqual([]);
			} finally {
				session.agent.state.isStreaming = false;
			}
		});

		it("cancels a skill queued through RPC by its original invocation before it reaches the model", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }]);
			const skillPath = path.join(tempDir, "SKILL.md");
			await Bun.write(
				skillPath,
				"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code.\n",
			);
			const invocation = "/skill:reviewer  ultrathink focus on risks\nand correctness";
			let injected = false;
			let removed: boolean | undefined;
			let queued: readonly string[] | undefined;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await tryRunRpcSkillCommand(
					{
						skillsSettings: { enableSkillCommands: true },
						skills: [
							{
								name: "reviewer",
								description: "Review code",
								filePath: skillPath,
								baseDir: tempDir,
								source: "project",
							},
						],
						promptCustomMessage: session.promptCustomMessage.bind(session),
					},
					invocation,
					"followUp",
				);
				queued = session.getQueuedMessages().followUp;
				removed = session.removeQueuedMessage(invocation, "followUp");
			});

			await session.prompt("start");
			await session.waitForIdle();

			expect(queued).toEqual([invocation]);
			expect(removed).toBe(true);
			expect(session.agent.hasQueuedMessages()).toBe(false);
			expect(mock.calls).toHaveLength(1);
			expect(session.messages.filter(message => message.role === "user" || message.role === "custom")).toEqual([
				expect.objectContaining({ role: "user", content: [{ type: "text", text: "start" }] }),
			]);
		});
	});
});
