import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

describe("IDE MCP server discovery", () => {
	let root = "";
	let home = "";
	let project = "";
	let originalHome: string | undefined;
	let originalClaudeConfigDir: string | undefined;

	beforeEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		originalHome = process.env.HOME;
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ide-discovery-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
	});

	afterEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (originalClaudeConfigDir === undefined) {
			delete process.env.CLAUDE_CONFIG_DIR;
		} else {
			process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
		}
		await removeWithRetries(root);
	});

	test("emits a stdio ide server from the Emacs lockfile", async () => {
		await writeFile(
			path.join(home, ".omp", "ide", "emacs.json"),
			JSON.stringify({
				ideName: "Emacs",
				transport: "stdio",
				command: "emacsclient",
				args: ["--socket-name", "server"],
			}),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd: project, providers: ["ide"] });
		expect(result.items).toEqual([
			{
				name: "ide",
				transport: "stdio",
				command: "emacsclient",
				args: ["--socket-name", "server"],
				_source: expect.objectContaining({ provider: "ide", level: "user" }),
			},
		]);
	});

	test("reloads an updated IDE lockfile at the same path", async () => {
		const lockfilePath = path.join(home, ".omp", "ide", "emacs.json");
		await writeFile(
			lockfilePath,
			JSON.stringify({ ideName: "Emacs", transport: "sse", url: "http://127.0.0.1:1001/mcp" }),
		);

		const first = await loadCapability<MCPServer>(mcpCapability.id, { cwd: project, providers: ["ide"] });
		expect(first.items[0]?.url).toBe("http://127.0.0.1:1001/mcp");

		await writeFile(
			lockfilePath,
			JSON.stringify({ ideName: "Emacs", transport: "sse", url: "http://127.0.0.1:1002/mcp" }),
		);

		const second = await loadCapability<MCPServer>(mcpCapability.id, { cwd: project, providers: ["ide"] });
		expect(second.items[0]?.url).toBe("http://127.0.0.1:1002/mcp");
	});

	test("prefers a live IDE owner over dead and PID-less owners", async () => {
		vi.spyOn(process, "kill").mockImplementation(pid => {
			if (pid === 101) {
				const error = new Error("No such process") as NodeJS.ErrnoException;
				error.code = "ESRCH";
				throw error;
			}
			return true;
		});
		await writeFile(
			path.join(home, ".omp", "ide", "a-dead.json"),
			JSON.stringify({ pid: 101, transport: "sse", url: "http://127.0.0.1:1001/mcp" }),
		);
		await writeFile(
			path.join(home, ".omp", "ide", "b-pidless.json"),
			JSON.stringify({ transport: "sse", url: "http://127.0.0.1:1002/mcp" }),
		);
		await writeFile(
			path.join(home, ".omp", "ide", "c-live.json"),
			JSON.stringify({ pid: 303, transport: "sse", url: "http://127.0.0.1:1003/mcp" }),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd: project, providers: ["ide"] });
		expect(result.items[0]?.url).toBe("http://127.0.0.1:1003/mcp");
	});

	test("keeps PID-less IDE servers eligible behind unsupported live servers", async () => {
		vi.spyOn(process, "kill").mockReturnValue(true);
		await writeFile(
			path.join(home, ".omp", "ide", "a-websocket.json"),
			JSON.stringify({ pid: 101, transport: "ws", url: "ws://127.0.0.1:1001" }),
		);
		await writeFile(
			path.join(home, ".omp", "ide", "b-sse.json"),
			JSON.stringify({ transport: "sse", url: "http://127.0.0.1:1002/mcp" }),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd: project, providers: ["ide"] });
		expect(result.items[0]?.url).toBe("http://127.0.0.1:1002/mcp");
	});
	test("skips ws-only lockfiles and emits no server", async () => {
		await writeFile(
			path.join(home, ".omp", "ide", "emacs.lock"),
			JSON.stringify({ ideName: "Emacs", transport: "ws", port: 4567 }),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd: project, providers: ["ide"] });
		expect(result.items).toEqual([]);
	});
});
