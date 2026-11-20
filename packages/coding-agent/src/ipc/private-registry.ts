/**
 * Owner-only local IPC registry primitives shared by the Collab host registry
 * and the session inbox.
 *
 * A registry is a private directory of `<entryId>.json` discovery metadata
 * files, each naming a per-publication IPC endpoint (Unix domain socket on
 * POSIX, named pipe on Windows) and a random bearer token. Publishers write
 * metadata atomically and withdraw it on close or exit; listers probe every
 * entry and prune the ones whose endpoint is provably dead. Endpoints die with
 * their process, so a crash leaves at most stale metadata the next scan removes.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { isEnoent, isFsError } from "@oh-my-pi/pi-utils";

/** Constant-time bearer token comparison; any non-string never matches. */
export function tokenMatches(expected: string, presented: unknown): boolean {
	if (typeof presented !== "string") return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(presented, "utf8");
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * The registry must be a real directory; POSIX also verifies its owner.
 * Both publication and listing check this: listing prunes malformed
 * entries, so following a symlink into an unrelated directory would let a
 * planted link turn a listing into a deletion tool.
 */
export async function assertPrivateDir(dir: string, label: string): Promise<fs.Stats | null> {
	const stat = await fs.promises.lstat(dir);
	if (stat.isSymbolicLink()) throw new Error(`${label} directory is a symlink: ${dir}`);
	if (!stat.isDirectory()) throw new Error(`${label} path is not a directory: ${dir}`);
	if (process.platform === "win32") return null;
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`${label} directory is not owned by the current user: ${dir}`);
	}
	return stat;
}

/**
 * Create the directory with owner-only POSIX permissions. Windows retains
 * the config root's ACL. `mkdir` with a mode leaves an
 * existing directory's permissions alone, so an already-present directory is
 * tightened explicitly; a symlink or a directory owned by another user is
 * refused rather than published into.
 */
export async function ensurePrivateDir(dir: string, label: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await assertPrivateDir(dir, label);
	if (stat && (stat.mode & 0o077) !== 0) await fs.promises.chmod(dir, 0o700);
}

/**
 * Unix files an endpoint leaves on disk: the socket and the native listener's
 * `<socket>.bind.lock`. Endpoint names are unique per publication, so no other
 * binder can contend for that lock and unlinking it is race-free.
 */
export function endpointFiles(endpoint: string): string[] {
	return process.platform === "win32" ? [] : [endpoint, `${endpoint}.bind.lock`];
}

/** Best-effort synchronous unlink; a survivor is pruned by the next scan. */
export function removeFilesSync(files: string[]): void {
	for (const file of files) {
		try {
			fs.rmSync(file, { force: true });
		} catch {
			// Best-effort.
		}
	}
}

/**
 * Remove one stale entry. Artifact names are unique per publication, so the
 * metadata and endpoint observed dead can only belong to that publication;
 * a successor publication lives under different names and is untouched.
 */
export async function pruneEntry(dir: string, name: string, endpoint: string | null): Promise<void> {
	try {
		await fs.promises.rm(path.join(dir, name), { force: true });
		// Only unlink sockets this registry could have created: beside the
		// metadata, or at the exact relocated endpoint this entry's publication
		// derives (under the shared `/tmp/omp-<euid>/`, never another socket there).
		// Resolving first stops a `<dir>/../elsewhere` endpoint from escaping `dir`.
		const ownsEndpoint =
			endpoint !== null &&
			process.platform !== "win32" &&
			(path.resolve(endpoint).startsWith(path.resolve(dir) + path.sep) ||
				endpoint === ipcEndpoint(dir, path.basename(name, ".json")));
		if (ownsEndpoint) {
			for (const file of endpointFiles(endpoint)) await fs.promises.rm(file, { force: true });
		}
	} catch {
		// Best-effort cleanup only (a missing file means someone else already pruned it).
	}
}

export type QueryResult<T> = { status: "ok"; value: T } | { status: "dead" } | { status: "skip"; error?: string };

/**
 * Query one endpoint: connect, send `request` as one JSON line (the caller
 * includes `v`/`token`), read one bounded response line. Only a missing or
 * refused endpoint counts as `dead`; every other failure is a `skip` that
 * says nothing about liveness.
 */
export function queryEndpoint(
	endpoint: string,
	request: object,
	options: { timeoutMs: number; maxResponseBytes: number },
): Promise<QueryResult<Record<string, unknown>>> {
	const { promise, resolve } = Promise.withResolvers<QueryResult<Record<string, unknown>>>();
	let connection: IpcConnection | undefined;
	let settled = false;
	const finish = (result: QueryResult<Record<string, unknown>>): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		connection?.destroy();
		resolve(result);
	};
	const timer = setTimeout(() => finish({ status: "skip", error: "timeout" }), options.timeoutMs);
	const onLine = (line: string): void => {
		let response: unknown;
		try {
			response = JSON.parse(line);
		} catch {
			finish({ status: "skip" });
			return;
		}
		if (typeof response !== "object" || response === null) {
			finish({ status: "skip" });
			return;
		}
		const value = response as Record<string, unknown>;
		if (value.ok !== true) {
			// Authentication failure or structured error: an unrelated endpoint
			// cannot satisfy stale metadata without the matching token.
			finish({ status: "skip", error: typeof value.error === "string" ? value.error : undefined });
			return;
		}
		finish({ status: "ok", value });
	};
	// An oversized response (past `maxFrameBytes`) closes the connection without a frame: skip.
	IpcConnection.connect(endpoint, {
		framing: "lines",
		timeoutMs: options.timeoutMs,
		maxFrameBytes: options.maxResponseBytes,
	}).then(
		conn => {
			if (settled) {
				conn.destroy();
				return;
			}
			connection = conn;
			conn.start(onLine, () => finish({ status: "skip" }));
			conn.send(JSON.stringify(request));
		},
		(err: unknown) => {
			// Endpoints die with their process: a refused or missing socket means
			// the publisher is gone. Any other error (EMFILE, EACCES, ETIMEDOUT, …)
			// says nothing about liveness and must not prune a live entry.
			const code = isFsError(err) ? err.code : undefined;
			finish({ status: code === "ENOENT" || code === "ECONNREFUSED" ? "dead" : "skip" });
		},
	);
	return promise;
}

/** Handle returned by {@link publishPrivateEndpoint}; closing withdraws the entry. */
export interface PrivateEndpointPublication {
	readonly entryId: string;
	readonly endpoint: string;
	readonly token: string;
	close(): Promise<void>;
}

/**
 * Publish a private IPC endpoint into the registry `dir`.
 *
 * Call {@link PrivateEndpointPublication.close} on every teardown path; a
 * process exit hook removes the on-disk state for normal shutdown, and the OS
 * closing the endpoint covers crashes.
 */
export async function publishPrivateEndpoint(options: {
	dir: string;
	label: string;
	maxFrameBytes: number;
	metadata: (ids: { entryId: string; endpoint: string; token: string }) => object;
	onConnection: (connection: IpcConnection, token: string, onClose: () => void) => void;
}): Promise<PrivateEndpointPublication> {
	const { dir } = options;
	await ensurePrivateDir(dir, options.label);

	// Unpredictable per-publication entry ID names the endpoint and the metadata
	// file: PID reuse cannot attach stale metadata to an unrelated process, and a
	// republication never shares artifact names with its predecessor, so a
	// lister pruning the stale entry can never remove the live successor's.
	const entryId = crypto.randomBytes(8).toString("hex");
	const token = crypto.randomBytes(32).toString("hex");
	// `<dir>/<entryId>.sock` on Unix (natively relocated when it would overflow
	// `sun_path`); listers never guess it, the metadata records the endpoint.
	const endpoint = ipcEndpoint(dir, entryId);
	const metaPath = path.join(dir, `${entryId}.json`);

	const liveConnections = new Set<IpcConnection>();
	const server = await IpcServer.listen(
		endpoint,
		{ framing: "lines", maxFrameBytes: options.maxFrameBytes },
		connection => {
			liveConnections.add(connection);
			options.onConnection(connection, token, () => liveConnections.delete(connection));
		},
	);
	try {
		const meta = options.metadata({ entryId, endpoint, token });
		// Write-then-rename so a concurrent scan never observes a partial file
		// (it would classify the entry as malformed and prune it, leaving this
		// endpoint published but undiscoverable). The temp suffix keeps it outside
		// the `*.json` listing filter; the entry ID makes the name unique. Any
		// failure after the exclusive create removes the temp file again.
		const tmpPath = `${metaPath}.tmp`;
		const handle = await fs.promises.open(tmpPath, "wx", 0o600);
		try {
			try {
				await handle.writeFile(JSON.stringify(meta), "utf8");
			} finally {
				await handle.close();
			}
			await fs.promises.rename(tmpPath, metaPath);
		} catch (err) {
			fs.rmSync(tmpPath, { force: true });
			throw err;
		}
	} catch (err) {
		await server.close();
		removeFilesSync(endpointFiles(endpoint));
		throw err;
	}

	// Normal process shutdown without an explicit close still withdraws the entry.
	// The exit hook is synchronous, so it unlinks the socket itself instead of
	// awaiting `server.close()`.
	const removeArtifactsOnExit = (): void => removeFilesSync([metaPath, ...endpointFiles(endpoint)]);
	process.once("exit", removeArtifactsOnExit);

	let closed = false;
	return {
		entryId,
		endpoint,
		token,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			process.off("exit", removeArtifactsOnExit);
			// Sever any lingering clients so no request is answered after withdrawal.
			for (const connection of liveConnections) connection.destroy();
			removeFilesSync([metaPath]);
			// Stops accepting and unlinks the socket file; the bind lock is ours to remove.
			await server.close();
			removeFilesSync(endpointFiles(endpoint));
		},
	};
}

/**
 * List live registry entries: probe every `*.json` metadata file through a
 * bounded worker pool, pruning malformed and provably dead entries
 * best-effort. Unreachable or erroring entries are hidden, not pruned.
 * Returns entries in no particular order.
 */
export async function scanPrivateRegistry<M extends { version: number; pid: number; endpoint: string }, T>(options: {
	dir: string;
	label: string;
	version: number;
	parse: (text: string) => M | null;
	probe: (meta: M) => Promise<QueryResult<T>>;
	concurrency?: number;
}): Promise<Array<{ meta: M; value: T }>> {
	const { dir } = options;
	let names: string[];
	try {
		await assertPrivateDir(dir, options.label);
		names = await fs.promises.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const entries = names.filter(name => name.endsWith(".json")).sort();
	const live: Array<{ meta: M; value: T }> = [];
	const scanEntry = async (name: string): Promise<void> => {
		let text: string;
		try {
			text = await Bun.file(path.join(dir, name)).text();
		} catch {
			return;
		}
		const meta = options.parse(text);
		if (!meta) {
			// Malformed metadata can never become listable; remove it.
			await pruneEntry(dir, name, null);
			return;
		}
		if (meta.version !== options.version) {
			// A different omp version owns this entry. Never show it; prune only
			// once the owning process is gone so newer versions keep their state.
			if (!pidAlive(meta.pid)) await pruneEntry(dir, name, meta.endpoint);
			return;
		}
		const result = await options.probe(meta);
		if (result.status === "ok") live.push({ meta, value: result.value });
		else if (result.status === "dead") await pruneEntry(dir, name, meta.endpoint);
	};
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < entries.length) await scanEntry(entries[next++]);
	};
	await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 8, entries.length) }, worker));
	return live;
}
