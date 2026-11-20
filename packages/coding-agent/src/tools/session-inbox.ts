import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import { type InboxHost, type SendOutcome, utf8Bytes } from "../inbox/host";
import { MAX_TEXT_BYTES, type ReachableSession } from "../inbox/registry";
import sessionInboxDescription from "../prompts/tools/session-inbox.md" with { type: "text" };
import type { ToolSession } from ".";

const sessionInboxSchema = type({
	op: type("'list' | 'send' | 'interrupt'").describe("list reachable sessions, send a message, or stop a turn"),
	"to?": type("string").describe("target address from list; required for send and interrupt"),
	"text?": type("string").describe("message text; required for send"),
	"kind?": type("'request' | 'notification'").describe(
		"send only; request (default) gets the target's answer back, notification is advice with no reply",
	),
	"delivery?": type("'steer' | 'after_turn'").describe(
		"request only; steer (default) enters the current turn, after_turn waits for it to end",
	),
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

function sendText(to: string, kind: "request" | "notification", outcome: SendOutcome): string {
	switch (outcome.status) {
		case "delivered":
		case "queued": {
			const verb = outcome.status === "delivered" ? "Delivered to" : "Queued in";
			let text = `${verb} ${to} (${outcome.conversationId}).`;
			if (outcome.shown) text += " (shown, no turn started)";
			if (kind === "request") text += " Its reply arrives by itself when its turn ends.";
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

/**
 * Talk to other local omp sessions of this user: list them, send a request
 * (its answer comes back by itself) or a notification (advice, no reply), or
 * interrupt a turn. Hidden; active in top-level interactive sessions.
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
		const { op, to, text, kind, delivery, level } = params;
		if (op === "list") {
			if ([to, text, kind, delivery, level].some(value => value !== undefined)) {
				throw new ToolError("op list takes no other fields.");
			}
			const sessions = await inbox.list();
			const lines = sessions.map(session => listLine(session, inbox));
			return { content: [{ type: "text", text: lines.join("\n") || "No other sessions are reachable." }] };
		}
		if (!to) throw new ToolError(`op ${op} needs to.`);
		if (to === inbox.address) throw new ToolError("That is this session's own address.");
		if (op === "interrupt" && [text, kind, delivery, level].some(value => value !== undefined)) {
			throw new ToolError("op interrupt takes only to.");
		}
		const sendKind = kind ?? "request";
		if (op === "send") {
			if (!text?.trim()) throw new ToolError("op send needs text.");
			if (sendKind === "request" && level !== undefined) throw new ToolError("level is only for a notification.");
			if (sendKind === "notification" && delivery !== undefined)
				throw new ToolError("delivery is only for a request.");
			if (utf8Bytes(text) > MAX_TEXT_BYTES) throw new ToolError(`text is over ${MAX_TEXT_BYTES / 1024} KiB.`);
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
		const outcome = await inbox.send(entry, { kind: sendKind, text: text as string, delivery, level });
		return { content: [{ type: "text", text: sendText(to, sendKind, outcome) }] };
	}
}
