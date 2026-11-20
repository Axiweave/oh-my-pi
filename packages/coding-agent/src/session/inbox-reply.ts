import { escapeHarnessTags } from "./harness-tags";
import type { CustomMessage } from "./messages";

export const INBOX_REPLY_MESSAGE_TYPE = "inbox-reply";

/** The answer a peer session sent back for one of this session's inbox requests. */
export interface InboxReply {
	id: string;
	from: { address: string; name: string };
	outcome: "completed" | "aborted" | "error";
	error?: string;
	text: string;
	/** The peer cut `text` at the reply size cap. */
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

function formatReply(reply: InboxReply): string {
	const error = reply.error === undefined ? "" : `: ${reply.error}`;
	const header = `Reply from ${reply.from.address} ("${reply.from.name}") to your request ${reply.id}: ${reply.outcome}${error}`;
	// Escape the joined body, not each field: a field ending in `<` followed by the
	// newline and a next field starting with `irc` would otherwise form a tag.
	const lines = ["<system-notice>", escapeHarnessTags(`${header}\n${reply.text}`)];
	if (reply.truncated) lines.push("[cut at 16 KiB]");
	lines.push("</system-notice>");
	return lines.join("\n");
}
