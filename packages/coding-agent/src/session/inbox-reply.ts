import { escapeHarnessTags } from "./harness-tags";
import type { CustomMessage } from "./messages";

export const INBOX_REPLY_MESSAGE_TYPE = "inbox-reply";

/** A thread message to this session, in a thread that this session opened. */
export interface InboxReply {
	thread: string;
	from: { address: string; name: string };
	type: "message" | "progress" | "auto" | "failure";
	text: string;
	/** Only on `failure`. */
	outcome?: "aborted" | "error";
	error?: string;
	/** The peer cut an `auto` text at the reply size cap. */
	truncated?: boolean;
}

/** One reply awaiting injection, stamped with the session it was queued for. */
export interface InboxReplyEntry extends InboxReply {
	sessionId: string;
}

/**
 * Build one model-visible notice per reply. Every peer-authored field is
 * escaped so a reply cannot close its `<system-notice>` or forge a harness block.
 */
export function buildInboxReplyBatchMessage(entries: InboxReplyEntry[]): CustomMessage | null {
	if (entries.length === 0) return null;
	const replies = entries.map(({ sessionId: _, ...reply }) => reply);
	return {
		role: "custom",
		customType: INBOX_REPLY_MESSAGE_TYPE,
		content: replies.map(formatReply).join("\n"),
		display: true,
		attribution: "agent",
		details: { replies },
		timestamp: Date.now(),
	};
}

function kindWord(reply: InboxReply): string {
	switch (reply.type) {
		case "message":
			return "reply";
		case "progress":
			return "progress (the answer follows later)";
		case "auto":
			return "automatic answer (no final reply)";
		case "failure":
			return `failure: ${reply.outcome}${reply.error === undefined ? "" : `: ${reply.error}`}`;
	}
}

function formatReply(reply: InboxReply): string {
	const header = `Thread ${reply.thread}, ${kindWord(reply)} from ${reply.from.address} ("${reply.from.name}"):`;
	// Escape the joined body, not each field: a field ending in `<` followed by the
	// newline and a next field starting with `irc` would otherwise form a tag.
	const lines = ["<system-notice>", escapeHarnessTags(`${header}\n${reply.text}`)];
	if (reply.truncated) lines.push("[cut at 16 KiB]");
	lines.push("Nothing goes back by itself. Reply only when they need an answer.", "</system-notice>");
	return lines.join("\n");
}
