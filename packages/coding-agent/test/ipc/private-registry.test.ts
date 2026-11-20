import { afterEach, describe, expect, it } from "bun:test";
import * as nodeFs from "node:fs";
import { once } from "node:events";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertPrivateDir,
	type PrivateEndpointPublication,
	pruneEntry,
	publishPrivateEndpoint,
	queryEndpoint,
	scanPrivateRegistry,
	tokenMatches,
} from "@oh-my-pi/pi-coding-agent/ipc/private-registry";
import { type IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";

const LABEL = "test registry";
const QUERY = { timeoutMs: 250, maxResponseBytes: 64 * 1024 };
const cleanupDirs: string[] = [];
const publications: PrivateEndpointPublication[] = [];
const servers: { server: IpcServer; connections: Set<IpcConnection> }[] = [];
const rawServers: net.Server[] = [];

afterEach(async () => {
	for (const pub of publications.splice(0)) await pub.close();
	for (const { server, connections } of servers.splice(0)) {
		for (const connection of connections) connection.destroy();
		await server.close();
	}
	for (const server of rawServers.splice(0)) await once(server.close(), "close");
	for (const dir of cleanupDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-private-registry-"));
	cleanupDirs.push(dir);
	return dir;
}

/** Fixture server answering every line with `reply(line)`; `null` never answers. */
async function serve(endpoint: string, reply: (line: string) => object | null): Promise<void> {
	const connections = new Set<IpcConnection>();
	const server = await IpcServer.listen(endpoint, { framing: "lines" }, connection => {
		connections.add(connection);
		connection.start(
			line => {
				const response = reply(line);
				if (response) connection.send(JSON.stringify(response));
			},
			() => connections.delete(connection),
		);
	});
	servers.push({ server, connections });
}

/** mulberry32: deterministic so a failure reproduces from the printed seed. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Meta {
	version: number;
	pid: number;
	endpoint: string;
	token: string;
}

function parseMeta(text: string): Meta | null {
	try {
		const raw = JSON.parse(text) as Meta;
		return typeof raw.endpoint === "string" && typeof raw.pid === "number" ? raw : null;
	} catch {
		return null;
	}
}

const probe = (meta: Meta) => queryEndpoint(meta.endpoint, { token: meta.token }, QUERY);

describe("tokenMatches", () => {
	it("matches only byte-identical tokens", () => {
		const seed = 0x5eed1234;
		console.log(`tokenMatches seed=${seed}`);
		const next = rng(seed);
		const hex = "0123456789abcdef";
		for (let round = 0; round < 500; round++) {
			const length = 1 + Math.floor(next() * 64);
			const token = Array.from({ length }, () => hex[Math.floor(next() * 16)]).join("");
			expect(tokenMatches(token, token)).toBe(true);
			expect(tokenMatches(token, `${token}`)).toBe(true);
			// Flip one byte at a random position.
			const at = Math.floor(next() * length);
			const flipped = token.slice(0, at) + (token[at] === "a" ? "b" : "a") + token.slice(at + 1);
			expect(tokenMatches(token, flipped)).toBe(false);
			// Any length change.
			expect(tokenMatches(token, token.slice(0, Math.floor(next() * length)))).toBe(false);
			expect(tokenMatches(token, `${token}${hex[Math.floor(next() * 16)]}`)).toBe(false);
		}
		for (const presented of [undefined, null, 1, {}, ["x"]]) expect(tokenMatches("x", presented)).toBe(false);
	});
});

describe("pruneEntry", () => {
	it("never deletes a path outside the registry dir", async () => {
		const dir = await tempDir();
		const outside = await tempDir();
		const victim = path.join(outside, "victim");
		const victimLock = `${victim}.bind.lock`;
		const relocated = ipcEndpoint(dir, "entry");
		for (const endpoint of [victim, `${dir}/../${path.basename(outside)}/victim`, `${dir}x/victim`]) {
			await fs.writeFile(victim, "keep");
			await fs.writeFile(victimLock, "keep");
			await fs.writeFile(path.join(dir, "entry.json"), "{}");
			await pruneEntry(dir, "entry.json", endpoint);
			expect(nodeFs.existsSync(path.join(dir, "entry.json"))).toBe(false);
			expect(await fs.readFile(victim, "utf8")).toBe("keep");
			expect(await fs.readFile(victimLock, "utf8")).toBe("keep");
		}
		// The owned endpoint (beside the metadata or its derived relocation) is removed.
		if (process.platform !== "win32" && relocated.startsWith(dir + path.sep)) {
			await fs.writeFile(relocated, "");
			await fs.writeFile(path.join(dir, "entry.json"), "{}");
			await pruneEntry(dir, "entry.json", relocated);
			expect(nodeFs.existsSync(relocated)).toBe(false);
		}
	});
});

describe("queryEndpoint", () => {
	it("classifies dead, hung, ok and error endpoints", async () => {
		const dir = await tempDir();
		expect(await queryEndpoint(ipcEndpoint(dir, "missing"), {}, QUERY)).toEqual({ status: "dead" });

		const hung = ipcEndpoint(dir, "hung");
		await serve(hung, () => null);
		expect(await queryEndpoint(hung, {}, QUERY)).toEqual({ status: "skip", error: "timeout" });

		const ok = ipcEndpoint(dir, "ok");
		await serve(ok, line => ({ ok: true, echo: JSON.parse(line) }));
		expect(await queryEndpoint(ok, { a: 1 }, QUERY)).toEqual({ status: "ok", value: { ok: true, echo: { a: 1 } } });

		const failing = ipcEndpoint(dir, "failing");
		await serve(failing, () => ({ ok: false, error: "authentication_failed" }));
		expect(await queryEndpoint(failing, {}, QUERY)).toEqual({ status: "skip", error: "authentication_failed" });
	});

	it.skipIf(process.platform === "win32")("classifies a stale socket file with no listener as dead", async () => {
		const endpoint = ipcEndpoint(await tempDir(), "stale");
		// Bun unlinks the socket on close(), so bind in a child and SIGKILL it: no cleanup runs.
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`require("node:net").createServer().listen(${JSON.stringify(endpoint)}, () => console.log("ready"))`,
			],
			{ stdout: "pipe" },
		);
		await child.stdout.getReader().read();
		child.kill("SIGKILL");
		await child.exited;
		// The file must outlive the listener, or this would only re-test ENOENT.
		expect((await fs.lstat(endpoint)).isSocket()).toBe(true);
		expect(await queryEndpoint(endpoint, {}, QUERY)).toEqual({ status: "dead" });
	});

	it.skipIf(process.platform === "win32")("classifies a non-JSON reply and a silent close as skip", async () => {
		const dir = await tempDir();
		const raw = async (name: string, onData: (socket: net.Socket) => void): Promise<string> => {
			const endpoint = ipcEndpoint(dir, name);
			const server = net.createServer(socket => socket.once("data", () => onData(socket)));
			await once(server.listen(endpoint), "listening");
			rawServers.push(server);
			return endpoint;
		};
		const garbage = await raw("garbage", socket => socket.write("not json\n"));
		expect(await queryEndpoint(garbage, {}, QUERY)).toEqual({ status: "skip" });
		const silent = await raw("silent", socket => socket.end());
		expect(await queryEndpoint(silent, {}, QUERY)).toEqual({ status: "skip" });
	});
});

describe("assertPrivateDir", () => {
	it("rejects a symlink and a regular file", async () => {
		const dir = await tempDir();
		expect((await assertPrivateDir(dir, LABEL))?.isDirectory() ?? true).toBe(true);
		const link = path.join(dir, "link");
		await fs.symlink(dir, link);
		await expect(assertPrivateDir(link, LABEL)).rejects.toThrow(`${LABEL} directory is a symlink`);
		const file = path.join(dir, "file");
		await fs.writeFile(file, "");
		await expect(assertPrivateDir(file, LABEL)).rejects.toThrow(`${LABEL} path is not a directory`);
	});
});

describe("publishPrivateEndpoint + scanPrivateRegistry", () => {
	async function publish(dir: string): Promise<PrivateEndpointPublication> {
		const pub = await publishPrivateEndpoint({
			dir,
			label: LABEL,
			maxFrameBytes: 4096,
			metadata: ({ endpoint, token }) => ({ version: 1, pid: process.pid, endpoint, token }),
			onConnection: (connection, token, onClose) =>
				connection.start(line => {
					const ok = tokenMatches(token, JSON.parse(line).token);
					connection.send(JSON.stringify({ ok, error: ok ? undefined : "authentication_failed" }));
					connection.end();
				}, onClose),
		});
		publications.push(pub);
		return pub;
	}
	const scan = (dir: string) => scanPrivateRegistry({ dir, label: LABEL, version: 1, parse: parseMeta, probe });

	it("lists published entries and forgets them after close", async () => {
		const dir = path.join(await tempDir(), "reg");
		expect(await scan(dir)).toEqual([]);
		const pubs = await Promise.all([publish(dir), publish(dir), publish(dir)]);
		const listed = await scan(dir);
		expect(listed.map(e => e.meta.endpoint).sort()).toEqual(pubs.map(p => p.endpoint).sort());
		if (process.platform !== "win32") expect(nodeFs.statSync(dir).mode & 0o777).toBe(0o700);

		const [closed, ...open] = pubs;
		await closed.close();
		await closed.close();
		expect(nodeFs.existsSync(path.join(dir, `${closed.entryId}.json`))).toBe(false);
		expect(nodeFs.existsSync(closed.endpoint)).toBe(false);
		expect(nodeFs.existsSync(`${closed.endpoint}.bind.lock`)).toBe(false);
		expect((await scan(dir)).map(e => e.meta.endpoint).sort()).toEqual(open.map(p => p.endpoint).sort());
	});

	it("prunes stale and malformed entries and hides version mismatches of live pids", async () => {
		const dir = await tempDir();
		const live = await publish(dir);
		await fs.writeFile(
			path.join(dir, "stale.json"),
			JSON.stringify({ version: 1, pid: process.pid, endpoint: ipcEndpoint(dir, "stale"), token: "t" }),
		);
		await fs.writeFile(path.join(dir, "garbage.json"), "not json");
		await fs.writeFile(
			path.join(dir, "future.json"),
			JSON.stringify({ version: 2, pid: process.pid, endpoint: live.endpoint, token: live.token }),
		);
		const listed = await scan(dir);
		expect(listed.map(e => e.meta.endpoint)).toEqual([live.endpoint]);
		const remaining = await fs.readdir(dir);
		expect(remaining).not.toContain("stale.json");
		expect(remaining).not.toContain("garbage.json");
		expect(remaining).toContain("future.json");
		expect(remaining).toContain(`${live.entryId}.json`);
	});
});
