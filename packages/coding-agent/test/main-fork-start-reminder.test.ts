/**
 * `--fork` honors `fork.startReminder`: only an explicit `false` makes a fork
 * without its own `fork-start` marker. The setting never strips what the source
 * already holds, so inherited marker and reminder entries stay in the copy.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import {
	FORK_START_CUSTOM_TYPE,
	FORK_START_REMINDER_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/fork-start-reminder";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir;
let sessionDir: string;
let sourceFile: string;
let sourceId: string;
let inheritedMarkerId: string;
const opened: SessionManager[] = [];

beforeEach(async () => {
	tempDir = TempDir.createSync("@pi-main-fork-start-reminder-");
	setAgentDir(tempDir.join("agent"));
	sessionDir = tempDir.join("sessions");
	// The source is itself a fork that already sent its reminder.
	const source = SessionManager.create(tempDir.path(), sessionDir);
	source.appendMessage({ role: "user", content: "first question", timestamp: 1 });
	inheritedMarkerId = source.appendCustomEntry(FORK_START_CUSTOM_TYPE, {
		sessionId: source.getSessionId(),
		unfinished: false,
		sharedCwd: true,
	});
	source.appendCustomMessageEntry(FORK_START_REMINDER_CUSTOM_TYPE, "inherited reminder", false, {
		markerId: inheritedMarkerId,
	});
	source.appendMessage({ role: "user", content: "second question", timestamp: 2 });
	await source.ensureOnDisk();
	await source.flush();
	sourceFile = source.getSessionFile()!;
	sourceId = source.getSessionId();
	await source.close();
});

afterEach(async () => {
	for (const manager of opened.splice(0)) await manager.close();
	__resetDirsFromEnvForTests();
	tempDir.removeSync();
});

function forkArgs(fork: string): Args {
	return {
		fork,
		sessionDir,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		invalidFlagValues: [],
	};
}

async function fork(source: string, settings: Settings): Promise<SessionManager> {
	const manager = await createSessionManager(forkArgs(source), tempDir.path(), settings);
	if (!manager) throw new Error("Expected --fork to create a session manager");
	opened.push(manager);
	return manager;
}

function markers(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.filter(entry => entry.type === "custom" && entry.customType === FORK_START_CUSTOM_TYPE);
}

const settingCases: Array<[label: string, make: () => Settings, ownMarker: boolean]> = [
	["false", () => Settings.isolated({ "fork.startReminder": false }), false],
	["true", () => Settings.isolated({ "fork.startReminder": true }), true],
	["unset", () => Settings.isolated(), true],
];

describe("createSessionManager --fork and fork.startReminder", () => {
	for (const [sourceKind, sourceArg] of [
		["path", () => sourceFile],
		["session id prefix", () => sourceId.slice(0, 8)],
	] as const) {
		for (const [label, makeSettings, ownMarker] of settingCases) {
			it(`fork by ${sourceKind} with the setting ${label} ${ownMarker ? "adds" : "adds no"} own marker and keeps inherited entries`, async () => {
				const manager = await fork(sourceArg(), makeSettings());
				const entries = manager.getEntries();
				const own = markers(entries).filter(
					entry =>
						entry.type === "custom" &&
						typeof entry.data === "object" &&
						entry.data !== null &&
						"sessionId" in entry.data &&
						entry.data.sessionId === manager.getSessionId(),
				);

				expect(manager.getSessionId()).not.toBe(sourceId);
				expect(own).toHaveLength(ownMarker ? 1 : 0);
				// The inherited marker and its sent reminder are still in the copied history.
				expect(
					entries.filter(
						entry => entry.type === "custom_message" && entry.customType === FORK_START_REMINDER_CUSTOM_TYPE,
					),
				).toHaveLength(1);
				expect(markers(entries).map(entry => entry.id)).toContain(inheritedMarkerId);
				expect(markers(entries)).toHaveLength(ownMarker ? 2 : 1);
			});
		}
	}

	it("leaves the source file unchanged for every setting", async () => {
		const before = await Bun.file(sourceFile).text();
		for (const [, makeSettings] of settingCases) await fork(sourceFile, makeSettings());
		expect(await Bun.file(sourceFile).text()).toBe(before);
	});
});
