/**
 * Session inbox discovery and transport.
 *
 * Every top-level interactive session publishes one private IPC endpoint under
 * {@link getSessionInboxDir} (owner-only dir, 0600 metadata, per-entry bearer
 * token). A request is one JSON line in, one JSON line out, then the server
 * ends the connection. The shared mechanics live in `ipc/private-registry`;
 * this module owns the inbox metadata shape and the snapshot used to list.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { IpcConnection } from "@oh-my-pi/pi-natives";
import { getSessionInboxDir, isRecord } from "@oh-my-pi/pi-utils";
import {
	type PrivateEndpointPublication,
	publishPrivateEndpoint,
	type QueryResult,
	queryEndpoint,
	scanPrivateRegistry,
} from "../ipc/private-registry";

export const INBOX_VERSION = 1;
/** A request text above this many UTF-8 bytes is refused with `too_large`. */
export const MAX_TEXT_BYTES = 256 * 1024;
/** A reply text is cut to this many UTF-8 bytes. */
export const MAX_REPLY_TEXT_BYTES = 16 * 1024;
/** Server frame cap: the largest text JSON-escaped (≤6 bytes per byte) plus the envelope. */
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
/** Every response is a small status object or a snapshot. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Per-entry deadline while listing. */
const LIST_TIMEOUT_MS = 1_500;
/** A send waits for the target's admission, which can sit behind a compaction or session switch. */
export const SEND_TIMEOUT_MS = 30_000;
/** Longest string any snapshot field is sent with. */
const MAX_FIELD_CHARS = 1024;
const LABEL = "session inbox";
const ENTRY_ID_PATTERN = /^[0-9a-f]{16}$/;

/** Discovery metadata on disk (`<dir>/<entryId>.json`). */
export interface InboxEntry {
	version: number;
	entryId: string;
	pid: number;
	endpoint: string;
	token: string;
	/** `ZMX_SESSION`, or else `omp-<pid>`. */
	address: string;
	/** Address of the session that started this one (`OMP_SPAWN_PARENT`). */
	parent: string | null;
	createdAt: number;
}

/** Live session state, computed by the owning process at query time. */
export interface InboxSnapshot {
	address: string;
	name: string;
	parent: string | null;
	pid: number;
	createdAt: number;
	cwd: string;
	branch: string | null;
	busy: boolean;
	conversationId: string;
}

export interface ReachableSession {
	entry: InboxEntry;
	snapshot: InboxSnapshot;
}

/** The address other sessions use to reach this process. */
export function inboxAddress(env: NodeJS.ProcessEnv = process.env, pid = process.pid): string {
	return env.ZMX_SESSION || `omp-${pid}`;
}

function optionalString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

export function parseInboxEntry(text: string): InboxEntry | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(raw)) return null;
	const { version, entryId, pid, endpoint, token, address, parent, createdAt } = raw;
	if (typeof version !== "number") return null;
	if (typeof entryId !== "string" || !ENTRY_ID_PATTERN.test(entryId)) return null;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
	if (typeof endpoint !== "string" || endpoint.length === 0) return null;
	if (typeof token !== "string" || token.length === 0) return null;
	if (typeof address !== "string" || address.length === 0) return null;
	if (!optionalString(parent)) return null;
	if (typeof createdAt !== "number") return null;
	return { version, entryId, pid, endpoint, token, address, parent, createdAt };
}

function bound(value: string): string {
	return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
}

/** The snapshot as sent on the wire: every free-form string bounded. */
export function boundSnapshot(snapshot: InboxSnapshot): InboxSnapshot {
	return {
		...snapshot,
		address: bound(snapshot.address),
		name: bound(snapshot.name),
		parent: snapshot.parent === null ? null : bound(snapshot.parent),
		cwd: bound(snapshot.cwd),
		branch: snapshot.branch === null ? null : bound(snapshot.branch),
		conversationId: bound(snapshot.conversationId),
	};
}

function parseSnapshot(raw: unknown): InboxSnapshot | null {
	if (!isRecord(raw)) return null;
	const { address, name, parent, pid, createdAt, cwd, branch, busy, conversationId } = raw;
	if (typeof address !== "string" || typeof name !== "string" || typeof cwd !== "string") return null;
	if (!optionalString(parent) || !optionalString(branch)) return null;
	if (typeof pid !== "number" || typeof createdAt !== "number" || typeof busy !== "boolean") return null;
	if (typeof conversationId !== "string") return null;
	return { address, name, parent, pid, createdAt, cwd, branch, busy, conversationId };
}

export interface InboxPublication {
	entry: InboxEntry;
	close(): Promise<void>;
}

/** Publish this process's endpoint; `onConnection` answers each request. */
export async function publishInboxEntry(options: {
	address: string;
	parent: string | null;
	onConnection: (connection: IpcConnection, token: string, onClose: () => void) => void;
	dir?: string;
}): Promise<InboxPublication> {
	let entry: InboxEntry | undefined;
	const publication: PrivateEndpointPublication = await publishPrivateEndpoint({
		dir: options.dir ?? getSessionInboxDir(),
		label: LABEL,
		maxFrameBytes: MAX_FRAME_BYTES,
		metadata: ({ entryId, endpoint, token }) => {
			entry = {
				version: INBOX_VERSION,
				entryId,
				pid: process.pid,
				endpoint,
				token,
				address: options.address,
				parent: options.parent,
				createdAt: Date.now(),
			};
			return entry;
		},
		onConnection: options.onConnection,
	});
	if (!entry) throw new Error("session inbox metadata was not written");
	return { entry, close: () => publication.close() };
}

/** One authenticated request to `entry`. */
export function callInbox(
	entry: InboxEntry,
	request: Record<string, unknown>,
	timeoutMs: number,
): Promise<QueryResult<Record<string, unknown>>> {
	return queryEndpoint(
		entry.endpoint,
		{ v: INBOX_VERSION, token: entry.token, ...request },
		{ timeoutMs, maxResponseBytes: MAX_RESPONSE_BYTES },
	);
}

/** Every live inbox, newest first. Dead entries are pruned; unreachable ones are hidden. */
export async function listInboxEntries(options?: { dir?: string; timeoutMs?: number }): Promise<ReachableSession[]> {
	const timeoutMs = options?.timeoutMs ?? LIST_TIMEOUT_MS;
	const live = await scanPrivateRegistry<InboxEntry, InboxSnapshot>({
		dir: options?.dir ?? getSessionInboxDir(),
		label: LABEL,
		version: INBOX_VERSION,
		parse: parseInboxEntry,
		probe: async entry => {
			const result = await callInbox(entry, { op: "snapshot" }, timeoutMs);
			if (result.status !== "ok") return result;
			const snapshot = parseSnapshot(result.value.snapshot);
			return snapshot ? { status: "ok", value: snapshot } : { status: "skip" };
		},
	});
	return live
		.map(({ meta, value }) => ({ entry: meta, snapshot: value }))
		.sort((a, b) => b.entry.createdAt - a.entry.createdAt || a.entry.entryId.localeCompare(b.entry.entryId));
}

/** Read one entry by ID without querying it; null when it is gone or malformed. */
export async function readInboxEntry(entryId: string, dir: string = getSessionInboxDir()): Promise<InboxEntry | null> {
	if (!ENTRY_ID_PATTERN.test(entryId)) return null;
	try {
		const entry = parseInboxEntry(await fs.promises.readFile(path.join(dir, `${entryId}.json`), "utf8"));
		return entry?.version === INBOX_VERSION && entry.entryId === entryId ? entry : null;
	} catch {
		return null;
	}
}
