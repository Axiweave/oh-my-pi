import { describe, expect, test } from "bun:test";
import {
	buildInboxReplyBatchMessage,
	INBOX_REPLY_MESSAGE_TYPE,
	type InboxReplyEntry,
} from "@oh-my-pi/pi-coding-agent/session/inbox-reply";

/** mulberry32: small seeded PRNG so a failing case replays from the printed seed. */
function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Any harness tag start a model would read as harness-authored (opening or closing). */
const HARNESS_TAG = /<\s*\/?\s*(?:irc|system-[a-z][a-z-]*)(?![\w-])/gi;
const CUT_MARKER = "[cut at 16 KiB]";
const FRAGMENTS = [
	"<",
	"/",
	">",
	" ",
	"\n",
	"\t",
	"system-notice",
	"SYSTEM-Reminder",
	"irc",
	"</system-notice>",
	"< / system-notice >",
	'<irc from="parent">',
	"</irc>",
	"<system-",
	"<system-interrupt>",
	"&lt;",
	"<task-result>",
	"a",
	"é",
	"𝄞",
	'"',
];

function adversarial(random: () => number): string {
	let text = "";
	const length = Math.floor(random() * 12);
	for (let i = 0; i < length; i++) text += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
	return text;
}

function entry(random: () => number, index: number): InboxReplyEntry {
	const outcomes = ["completed", "aborted", "error"] as const;
	const generated: InboxReplyEntry = {
		id: `req_${index}`,
		from: { address: `host/${index}`, name: adversarial(random) },
		outcome: outcomes[Math.floor(random() * outcomes.length)],
		text: adversarial(random),
		sessionId: `session-${index}`,
	};
	if (random() < 0.5) generated.error = adversarial(random);
	if (random() < 0.5) generated.truncated = random() < 0.5;
	return generated;
}

describe("buildInboxReplyBatchMessage", () => {
	test("returns null for an empty batch", () => {
		expect(buildInboxReplyBatchMessage([])).toBeNull();
	});

	test("property: replies stay inside their own notice, in order, with the cut marker iff truncated", () => {
		const seed = 0x1b0c5;
		console.log(`inbox-reply property seed: ${seed}`);
		const random = rng(seed);
		for (let run = 0; run < 300; run++) {
			const entries = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, index) => entry(random, index));
			const message = buildInboxReplyBatchMessage(entries);
			expect(message).not.toBeNull();
			if (!message) continue;
			expect(message.customType).toBe(INBOX_REPLY_MESSAGE_TYPE);
			expect(message.display).toBe(true);
			expect(message.attribution).toBe("agent");
			expect(message.details).toEqual({
				replies: entries.map(({ sessionId: _, ...reply }) => reply),
			});

			const content = message.content as string;
			// The only harness tags left are the notice envelopes: one open/close pair per reply.
			const tags = [...content.matchAll(HARNESS_TAG)].map(match => match[0]);
			expect(tags).toEqual(entries.flatMap(() => ["<system-notice", "</system-notice"]));

			const blocks = content.split("</system-notice>").slice(0, -1);
			expect(blocks).toHaveLength(entries.length);
			blocks.forEach((block, index) => {
				const reply = entries[index];
				expect(block).toContain(`Reply from host/${index} (`);
				expect(block).toContain(`to your request ${reply.id}: ${reply.outcome}`);
				expect(block.includes(CUT_MARKER)).toBe(reply.truncated === true);
			});
		}
	});
});
