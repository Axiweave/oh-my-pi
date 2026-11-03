/**
 * Fork start reminder: a hidden note sent with a CLI fork's first model-bound
 * request. The fork records its facts in a non-context `fork-start` marker; the
 * first accepted prompt pairs that marker with one reminder that names it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import forkStartReminderTemplate from "../prompts/system/fork-start-reminder.md" with { type: "text" };
import type { CustomMessage } from "./messages";
import type { CustomEntry, SessionEntry } from "./session-entries";

export const FORK_START_CUSTOM_TYPE = "fork-start";
export const FORK_START_REMINDER_CUSTOM_TYPE = "fork-start-reminder";

/** Snapshot facts a fork records; `sessionId` is the session that may send the reminder. */
export interface ForkStartFacts {
	sessionId: string;
	unfinished: boolean;
	sharedCwd: boolean;
}

export interface ForkStartReminderDetails {
	markerId: string;
}

function canonicalDir(dir: string): string {
	try {
		return fs.realpathSync(dir);
	} catch {
		return path.resolve(dir);
	}
}

/** Whether the fork works in the source session's recorded directory. */
export function sharesSourceCwd(sourceCwd: string | undefined, targetCwd: string): boolean {
	return sourceCwd !== undefined && canonicalDir(sourceCwd) === canonicalDir(targetCwd);
}

function isMarker(entry: SessionEntry): entry is CustomEntry<ForkStartFacts> {
	return entry.type === "custom" && entry.customType === FORK_START_CUSTOM_TYPE;
}

/** The newest `fork-start` marker on the branch, walking back from the leaf. */
function newestMarker(branch: readonly SessionEntry[]): CustomEntry<ForkStartFacts> | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (isMarker(entry)) return entry;
	}
	return undefined;
}

export function newestForkStartMarkerId(branch: readonly SessionEntry[]): string | undefined {
	return newestMarker(branch)?.id;
}

/**
 * Chat card text for a stored reminder: facts for the header, the reminder's
 * lines for the expanded body. Only this fork's own reminder (it names the
 * branch's newest marker) gets a card; inherited ones return undefined.
 */
export function forkStartReminderCard(
	markerId: string | undefined,
	content: string,
	branch: readonly SessionEntry[],
): { meta: string[]; lines: string[] } | undefined {
	const marker = newestMarker(branch);
	if (markerId === undefined || marker?.id !== markerId) return undefined;
	const meta: string[] = [];
	if (marker.data?.unfinished) meta.push("copied task unfinished");
	if (marker.data?.sharedCwd) meta.push("shared directory");
	const lines = content
		.split("\n")
		.map(line => line.trim())
		.filter(line => line !== "" && line !== "<system-reminder>" && line !== "</system-reminder>");
	return { meta, lines };
}

/**
 * The marker still waiting for its reminder: the newest one on the branch, owned
 * by `sessionId`, that no stored reminder names. Stored entries (not the active
 * context) decide, so compaction cannot bring a sent reminder back.
 */
export function pendingForkStart(
	branch: readonly SessionEntry[],
	entries: readonly SessionEntry[],
	sessionId: string,
): { markerId: string; facts: ForkStartFacts } | undefined {
	const marker = newestMarker(branch);
	if (!marker?.data || marker.data.sessionId !== sessionId) return undefined;
	const sent = entries.some(
		entry =>
			entry.type === "custom_message" &&
			entry.customType === FORK_START_REMINDER_CUSTOM_TYPE &&
			(entry.details as ForkStartReminderDetails | undefined)?.markerId === marker.id,
	);
	return sent ? undefined : { markerId: marker.id, facts: marker.data };
}

export function renderForkStartReminder(
	markerId: string,
	facts: ForkStartFacts,
): CustomMessage<ForkStartReminderDetails> {
	return {
		role: "custom",
		customType: FORK_START_REMINDER_CUSTOM_TYPE,
		content: prompt
			.render(forkStartReminderTemplate, { unfinished: facts.unfinished, sharedCwd: facts.sharedCwd })
			.trim(),
		display: false,
		attribution: "agent",
		details: { markerId },
		timestamp: Date.now(),
	};
}
