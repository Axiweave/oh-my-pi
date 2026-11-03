import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { hasUnfinishedTail, SESSION_EXIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import {
	FORK_START_CUSTOM_TYPE,
	FORK_START_REMINDER_CUSTOM_TYPE,
	type ForkStartFacts,
	newestForkStartMarkerId,
	pendingForkStart,
	renderForkStartReminder,
	sharesSourceCwd,
} from "@oh-my-pi/pi-coding-agent/session/fork-start-reminder";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TempDir } from "@oh-my-pi/pi-utils";

const SEED = 0x5eed_f0c5;
const CASES = 400;

/** mulberry32: small seeded PRNG so every generated case can be replayed from SEED. */
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

function pick<T>(next: () => number, items: readonly T[]): T {
	return items[Math.floor(next() * items.length)]!;
}

function int(next: () => number, max: number): number {
	return Math.floor(next() * (max + 1));
}

let nextEntryId = 0;

/** Builds entries with unique ids, each parented to the previous one. */
class Builder {
	readonly entries: SessionEntry[] = [];

	#push(fields: Record<string, unknown>): SessionEntry {
		const entry = {
			id: `e${nextEntryId++}`,
			parentId: this.entries.at(-1)?.id ?? null,
			timestamp: "2026-01-01T00:00:00.000Z",
			...fields,
		} as unknown as SessionEntry;
		this.entries.push(entry);
		return entry;
	}

	message(message: Record<string, unknown>): SessionEntry {
		return this.#push({ type: "message", message: { timestamp: 1, ...message } });
	}

	user(): SessionEntry {
		return this.message({ role: "user", content: "do the thing" });
	}

	developer(): SessionEntry {
		return this.message({ role: "developer", content: "note" });
	}

	assistant(stopReason: string, toolCallId?: string): SessionEntry {
		return this.message({
			role: "assistant",
			content: toolCallId
				? [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "true" } }]
				: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			stopReason,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
	}

	toolResult(toolCallId: string): SessionEntry {
		return this.message({
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
		});
	}

	/** One entry that is not a `message` and is not a session exit. */
	noise(next: () => number): SessionEntry {
		switch (int(next, 3)) {
			case 0:
				return this.#push({ type: "custom", customType: "metadata", data: { n: nextEntryId } });
			case 1:
				return this.#push({ type: "custom_message", customType: "note", content: "hidden", display: false });
			case 2:
				return this.#push({ type: "thinking_level_change", thinkingLevel: "high" });
			default:
				// A non-normal exit never closes a turn, so it counts as noise here.
				return this.exit("fatal");
		}
	}

	exit(kind: "normal" | "fatal"): SessionEntry {
		return this.#push({
			type: "custom",
			customType: SESSION_EXIT_CUSTOM_TYPE,
			data: { reason: "test", kind, recordedAt: "2026-01-01T00:00:00.000Z" },
		});
	}

	marker(sessionId: string): SessionEntry {
		const facts: ForkStartFacts = { sessionId, unfinished: false, sharedCwd: false };
		return this.#push({ type: "custom", customType: FORK_START_CUSTOM_TYPE, data: facts });
	}

	reminder(markerId: string): SessionEntry {
		return this.#push({
			type: "custom_message",
			customType: FORK_START_REMINDER_CUSTOM_TYPE,
			content: "x",
			display: false,
			details: { markerId },
		});
	}
}

const TAIL_KINDS = {
	empty: false,
	completed: false,
	abortedToolResults: false,
	errorToolResults: false,
	userPrompt: true,
	developerPrompt: true,
	toolCalls: true,
	toolResults: true,
} as const;
type TailKind = keyof typeof TAIL_KINDS;

/** A random branch whose last message has the given kind, with noise before, between, and after. */
function branchWithTail(next: () => number, kind: TailKind): Builder {
	const b = new Builder();
	if (kind !== "empty") {
		for (let turn = int(next, 3); turn > 0; turn--) {
			for (let n = int(next, 1); n > 0; n--) b.noise(next);
			b.user();
			b.assistant("stop");
		}
	}
	for (let n = int(next, 2); n > 0; n--) b.noise(next);
	switch (kind) {
		case "empty":
			break;
		case "completed":
			b.user();
			b.assistant("stop");
			break;
		case "userPrompt":
			b.user();
			break;
		case "developerPrompt":
			b.developer();
			break;
		case "toolCalls":
			b.user();
			b.assistant("toolUse", "call-open");
			break;
		case "toolResults":
		case "abortedToolResults":
		case "errorToolResults": {
			const stop = kind === "toolResults" ? "toolUse" : kind === "abortedToolResults" ? "aborted" : "error";
			b.user();
			b.assistant(stop, "call-1");
			if (next() < 0.5) b.noise(next);
			b.toolResult("call-1");
			break;
		}
	}
	return b;
}
function describeCase(caseIndex: number, kind: string, entries: readonly SessionEntry[]): string {
	const shape = entries.map(e => (e.type === "message" ? e.message.role : e.type)).join(",");
	return `seed=${SEED} case=${caseIndex} kind=${kind} entries=[${shape}]`;
}

describe("hasUnfinishedTail (generated, seed printed)", () => {
	const kinds = Object.keys(TAIL_KINDS) as TailKind[];

	it("reports the tail kind's flag, ignores trailing non-message entries, and a reply or normal exit ends the turn", () => {
		console.log(`hasUnfinishedTail property seed: ${SEED}`);
		const next = rng(SEED);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex++) {
			const kind = pick(next, kinds);
			const b = branchWithTail(next, kind);
			const base = [...b.entries];
			const label = describeCase(caseIndex, kind, base);
			expect(hasUnfinishedTail(base), label).toBe(TAIL_KINDS[kind]);

			for (let n = 1 + int(next, 3); n > 0; n--) b.noise(next);
			expect(hasUnfinishedTail(b.entries), `${label} +noise`).toBe(hasUnfinishedTail(base));

			const answered = new Builder();
			answered.entries.push(...b.entries);
			answered.assistant(pick(next, ["stop", "length", "aborted", "error"]));
			for (let n = int(next, 2); n > 0; n--) answered.noise(next);
			expect(hasUnfinishedTail(answered.entries), `${label} +assistant reply`).toBe(false);

			const exited = new Builder();
			exited.entries.push(...b.entries);
			exited.exit("normal");
			expect(hasUnfinishedTail(exited.entries), `${label} +normal exit`).toBe(false);
		}
	});
});

describe("pendingForkStart / newestForkStartMarkerId (generated, seed printed)", () => {
	const OWNERS = ["fork-a", "fork-b"];

	/** Random history of markers, reminders (some naming no marker), noise, and messages. */
	function history(next: () => number): { all: Builder; branch: SessionEntry[] } {
		const all = new Builder();
		const branch: SessionEntry[] = [];
		const markerIds: string[] = [];
		for (let n = int(next, 12); n > 0; n--) {
			let entry: SessionEntry;
			const roll = next();
			if (roll < 0.3) {
				entry = all.marker(pick(next, OWNERS));
				markerIds.push(entry.id);
			} else if (roll < 0.5 && markerIds.length > 0) {
				entry = all.reminder(next() < 0.8 ? pick(next, markerIds) : "no-such-marker");
			} else if (roll < 0.7) {
				entry = all.user();
			} else {
				entry = all.noise(next);
			}
			// Entries off the active branch stay in the stored entries only.
			if (next() < 0.8) branch.push(entry);
		}
		return { all, branch };
	}

	it("returns only the newest branch marker, matches its owner, and stored reminders decide", () => {
		console.log(`pendingForkStart property seed: ${SEED}`);
		const next = rng(SEED);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex++) {
			const { all, branch } = history(next);
			const label = describeCase(caseIndex, "history", all.entries);
			const newest = newestForkStartMarkerId(branch);

			for (const owner of OWNERS) {
				const pending = pendingForkStart(branch, all.entries, owner);
				if (!pending) continue;
				expect(pending.markerId, label).toBe(newest!);
				expect(pending.facts.sessionId, label).toBe(owner);
				// The other owner never gets the same marker.
				expect(
					pendingForkStart(
						branch,
						all.entries,
						OWNERS.find(o => o !== owner)!,
					),
					label,
				).toBeUndefined();
				// A reminder stored only off the branch still counts as sent.
				const sent = new Builder();
				sent.entries.push(...all.entries);
				sent.reminder(pending.markerId);
				expect(pendingForkStart(branch, sent.entries, owner), `${label} +off-branch reminder`).toBeUndefined();
			}

			// A reminder naming any marker other than the newest changes nothing.
			const older = branch.filter(
				e => e.type === "custom" && e.customType === FORK_START_CUSTOM_TYPE && e.id !== newest,
			);
			if (older.length > 0) {
				const extra = new Builder();
				extra.entries.push(...all.entries);
				extra.reminder(pick(next, older).id);
				for (const owner of OWNERS) {
					expect(pendingForkStart(branch, extra.entries, owner), `${label} +old reminder`).toEqual(
						pendingForkStart(branch, all.entries, owner),
					);
				}
			}

			// Trailing non-marker entries never move the newest marker.
			const noisy = new Builder();
			noisy.entries.push(...all.entries);
			const tail = [noisy.noise(next), noisy.user(), noisy.reminder(newest ?? "none")];
			expect(newestForkStartMarkerId([...branch, ...tail]), label).toBe(newest);

			// A fresh marker on the branch is pending for its owner whatever came before.
			const owner = pick(next, OWNERS);
			const fresh = noisy.marker(owner);
			const freshBranch = [...branch, ...tail, fresh];
			expect(newestForkStartMarkerId(freshBranch), label).toBe(fresh.id);
			expect(pendingForkStart(freshBranch, noisy.entries, owner)?.markerId, `${label} +fresh marker`).toBe(fresh.id);
		}
	});

	it("finds nothing on a branch without markers", () => {
		const b = new Builder();
		b.user();
		b.reminder("orphan");
		expect(newestForkStartMarkerId([])).toBeUndefined();
		expect(newestForkStartMarkerId(b.entries)).toBeUndefined();
		expect(pendingForkStart(b.entries, b.entries, "fork-a")).toBeUndefined();
	});
});

describe("renderForkStartReminder", () => {
	const render = (unfinished: boolean, sharedCwd: boolean) =>
		renderForkStartReminder(`marker-${unfinished}-${sharedCwd}`, { sessionId: "s", unfinished, sharedCwd });
	const lines = (unfinished: boolean, sharedCwd: boolean) =>
		(render(unfinished, sharedCwd).content as string).split("\n").filter(line => line.trim() !== "");
	const minus = (a: string[], b: string[]) => a.filter(line => !b.includes(line));

	it("is a hidden system reminder whose details name the marker", () => {
		for (const unfinished of [false, true]) {
			for (const sharedCwd of [false, true]) {
				const message = render(unfinished, sharedCwd);
				expect(message.role).toBe("custom");
				expect(message.customType).toBe(FORK_START_REMINDER_CUSTOM_TYPE);
				expect(message.display).toBe(false);
				expect(message.details).toEqual({ markerId: `marker-${unfinished}-${sharedCwd}` });
				const content = message.content as string;
				expect(content.startsWith("<system-reminder>")).toBe(true);
				expect(content.endsWith("</system-reminder>")).toBe(true);
			}
		}
	});

	it("adds one block per flag, and each flag leaves the other block alone", () => {
		const unfinishedOff = minus(lines(true, false), lines(false, false));
		const unfinishedOn = minus(lines(true, true), lines(false, true));
		const sharedOff = minus(lines(false, true), lines(false, false));
		const sharedOn = minus(lines(true, true), lines(true, false));

		expect(unfinishedOff.length).toBeGreaterThan(0);
		expect(sharedOff.length).toBeGreaterThan(0);
		// Each flag only adds lines; it never removes the base text.
		expect(minus(lines(false, false), lines(true, false))).toEqual([]);
		expect(minus(lines(false, false), lines(false, true))).toEqual([]);
		// The other flag does not change a flag's block.
		expect(unfinishedOn).toEqual(unfinishedOff);
		expect(sharedOn).toEqual(sharedOff);
		expect(unfinishedOff.filter(line => sharedOff.includes(line))).toEqual([]);
		expect(lines(true, true)).toHaveLength(lines(false, false).length + unfinishedOff.length + sharedOff.length);
	});
});

describe("sharesSourceCwd", () => {
	it("matches the same directory through symlinks and falls back for missing paths", () => {
		using tempDir = TempDir.createSync("@omp-fork-start-cwd-");
		const source = path.join(tempDir.path(), "source");
		const other = path.join(tempDir.path(), "other");
		const link = path.join(tempDir.path(), "link");
		fs.mkdirSync(source);
		fs.mkdirSync(other);
		fs.symlinkSync(source, link, "dir");

		expect(sharesSourceCwd(source, source)).toBe(true);
		expect(sharesSourceCwd(source, `${source}${path.sep}.`)).toBe(true);
		expect(sharesSourceCwd(source, link)).toBe(true);
		expect(sharesSourceCwd(link, source)).toBe(true);
		expect(sharesSourceCwd(source, other)).toBe(false);
		expect(sharesSourceCwd(undefined, source)).toBe(false);

		const missing = path.join(tempDir.path(), "missing");
		expect(sharesSourceCwd(missing, missing)).toBe(true);
		expect(sharesSourceCwd(missing, `${missing}${path.sep}`)).toBe(true);
		expect(sharesSourceCwd(source, missing)).toBe(false);
	});
});
