import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import { type InboxHost, type ReplyOutcome, type SendOutcome, utf8Bytes } from "../inbox/host";
import { MAX_TEXT_BYTES, type ReachableSession } from "../inbox/registry";
import sessionInboxDescription from "../prompts/tools/session-inbox.md" with { type: "text" };
import type { ToolSession } from ".";

const sessionInboxSchema = type({
	op: type("'list' | 'send' | 'reply' | 'interrupt'").describe(
		"list reachable sessions, send a message, reply in a thread, or stop a turn",
	),
	"to?": type("string").describe("address; required for send and interrupt"),
	"thread?": type("string").describe("required for reply; refused on other ops"),
	"text?": type("string").describe("required for send and reply"),
	"kind?": type("'message' | 'notification'").describe("send only; default message"),
	"progress?": type("boolean").describe("reply only; default false"),
	"delivery?": type("'steer' | 'after_turn'").describe("message, or reply in a thread you opened; default steer"),
	"level?": type("'nit' | 'concern' | 'blocker'").describe("notification only; default nit"),
});

export type SessionInboxInput = typeof sessionInboxSchema.infer;

function listLine(session: ReachableSession, inbox: InboxHost): string {
	const { entry, snapshot } = session;
	const parts = [entry.address, JSON.stringify(snapshot.name), snapshot.cwd];
	if (snapshot.branch) parts.push(`branch=${snapshot.branch}`);
	parts.push(snapshot.busy ? "busy" : "idle");
	if (entry.parent === inbox.address) parts.push("started-by-you");
	if (inbox.parent !== null && entry.address === inbox.parent) parts.push("started-you");
	return parts.join("  ");
}

function sendText(to: string, kind: "message" | "notification", outcome: SendOutcome): string {
	switch (outcome.status) {
		case "delivered":
		case "queued": {
			const verb = outcome.status === "delivered" ? "Delivered to" : "Queued in";
			let text = `${verb} ${to} (${outcome.conversationId}).`;
			if (outcome.shown) text += " (shown, no turn started)";
			if (kind === "message") text += ` Thread ${outcome.thread}. The answer comes in this thread.`;
			return text;
		}
		case "not_delivered":
			return `Not delivered to ${to}: ${outcome.reason}.`;
		case "gone":
			return `Not delivered to ${to}: the session ended.`;
		case "no_answer":
			return `No answer from ${to} yet; the message may still arrive.`;
	}
}

function replyText(thread: string, outcome: Exclude<ReplyOutcome, { status: "unknown_thread" }>): string {
	switch (outcome.status) {
		case "delivered":
			return `Replied in thread ${thread} to ${outcome.to}.`;
		case "queued":
			return `Queued in thread ${thread} for ${outcome.to}.`;
		case "not_delivered":
			return `Not delivered in thread ${thread}: ${outcome.reason}.`;
		case "gone":
			return `Not delivered in thread ${thread}: the session ended.`;
		case "no_answer":
			return `No answer from ${outcome.to} yet; the reply may still arrive.`;
	}
}

/**
 * Talk to other local omp sessions of this user: list them, open a thread
 * with a message or send a notification (advice, no reply), reply in a
 * thread, or interrupt a turn. Hidden; active in top-level interactive sessions.
 */
export class SessionInboxTool implements AgentTool<typeof sessionInboxSchema> {
	readonly name = "session_inbox";
	readonly approval = "read" as const;
	readonly label = "Session Inbox";
	readonly description = prompt.render(sessionInboxDescription);
	readonly parameters = sessionInboxSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(_toolCallId: string, params: SessionInboxInput): Promise<AgentToolResult> {
		const inbox = this.#session.getSessionInbox?.();
		if (!inbox?.started) throw new ToolError("Session inbox is off.");
		const { op, to, thread, text, kind, progress, delivery, level } = params;
		if (op === "list") {
			if ([to, thread, text, kind, progress, delivery, level].some(value => value !== undefined)) {
				throw new ToolError("op list takes no other fields.");
			}
			const sessions = await inbox.list();
			const lines = sessions.map(session => listLine(session, inbox));
			return { content: [{ type: "text", text: lines.join("\n") || "No other sessions are reachable." }] };
		}
		if (op !== "reply" && thread !== undefined) throw new ToolError("thread is only for op reply.");
		if (op !== "reply" && progress !== undefined) throw new ToolError("progress is only for op reply.");
		if (op === "send" || op === "reply") {
			if (!text?.trim()) throw new ToolError(`op ${op} needs text.`);
			if (utf8Bytes(text) > MAX_TEXT_BYTES) throw new ToolError(`text is over ${MAX_TEXT_BYTES / 1024} KiB.`);
		}
		if (op === "reply") {
			if (!thread) throw new ToolError("op reply needs thread.");
			if ([to, kind, level].some(value => value !== undefined)) {
				throw new ToolError("op reply takes no to, kind, or level.");
			}
			const outcome = await inbox.reply(thread, { text: text as string, progress, delivery });
			if (outcome.status === "unknown_thread") throw new ToolError(`Unknown thread ${thread}.`);
			return { content: [{ type: "text", text: replyText(thread, outcome) }] };
		}
		if (!to) throw new ToolError(`op ${op} needs to.`);
		if (to === inbox.address) throw new ToolError("That is this session's own address.");
		if (op === "interrupt" && [text, kind, delivery, level].some(value => value !== undefined)) {
			throw new ToolError("op interrupt takes only to.");
		}
		const sendKind = kind ?? "message";
		if (op === "send") {
			if (sendKind === "message" && level !== undefined) throw new ToolError("level is only for a notification.");
			if (sendKind === "notification" && delivery !== undefined)
				throw new ToolError("delivery is only for a message.");
		}
		const target = await inbox.lookup(to);
		if (target.status === "none") throw new ToolError(`No reachable session ${to}. Use op "list".`);
		if (target.status === "ambiguous") {
			const lines = target.sessions.map(session => `- ${listLine(session, inbox)} (pid ${session.snapshot.pid})`);
			throw new ToolError(`${to} matches ${target.sessions.length} sessions:\n${lines.join("\n")}`);
		}
		const entry = target.session.entry;
		if (op === "interrupt") {
			const outcome = await inbox.interrupt(entry);
			let result: string;
			if (outcome === "interrupted") result = `Interrupted ${to}.`;
			else if (outcome === "idle") result = `${to} was idle; nothing to interrupt.`;
			else if (outcome === "gone") result = `${to} ended.`;
			else if (outcome === "no_answer") result = `No answer from ${to}.`;
			else result = `Could not interrupt ${to}: ${outcome.error}.`;
			return { content: [{ type: "text", text: result }] };
		}
		const message =
			sendKind === "message"
				? { kind: sendKind, text: text as string, delivery }
				: { kind: sendKind, text: text as string, level };
		const outcome = await inbox.send(entry, message);
		return { content: [{ type: "text", text: sendText(to, sendKind, outcome) }] };
	}
}
