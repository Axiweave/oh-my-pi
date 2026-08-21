/**
 * IDE Provider
 *
 * Loads the active IDE's MCP server from lockfiles written by IDE integrations
 * into `~/.omp/ide` (omp's own convention — fixed home-relative path, NOT
 * XDG-routed, because external tools like the `claude-code-ide.el` Emacs
 * package write it and must agree byte-for-byte with what omp reads). The
 * lockfile declares how to reach the IDE's MCP server; omp spawns or connects
 * to it and receives `selection_changed` notifications.
 *
 * Supported transports: `stdio` (Emacs), `http`/`sse` (VS Code). WebSocket
 * lockfiles are skipped — omp has no WS MCP transport.
 */
import * as path from "node:path";
import { logger, tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readDir, readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { LoadContext, LoadResult } from "../capability/types";
import { createSourceMeta } from "./helpers";

const PROVIDER_ID = "ide";
const DISPLAY_NAME = "IDE";
const PRIORITY = 90;

/** Lockfile shape written by IDE integrations into ~/.claude/ide/. */
interface IdeLockfile {
	ideName?: string;
	transport?: "stdio" | "http" | "sse" | "ws";
	// stdio transport:
	command?: string;
	args?: string[];
	cwd?: string;
	// http/sse transports:
	url?: string;
	port?: number;
}

async function load(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const ideDir = path.join(ctx.home, ".omp", "ide");
	// readDir returns [] when the directory is absent.
	const names = (await readDir(ideDir)).sort();

	for (const name of names) {
		const filePath = path.join(ideDir, name);
		const content = await readFile(filePath);
		if (!content) continue;
		const lockfile = tryParseJson<IdeLockfile>(content);
		if (!lockfile) {
			warnings.push(`Invalid JSON in ${filePath}`);
			continue;
		}

		switch (lockfile.transport) {
			case "stdio":
				if (typeof lockfile.command === "string" && lockfile.command.length > 0) {
					items.push({
						name: "ide",
						transport: "stdio",
						command: lockfile.command,
						args: lockfile.args,
						cwd: lockfile.cwd,
						_source: createSourceMeta(PROVIDER_ID, filePath, "user"),
					});
					return { items, warnings };
				}
				break;
			case "http":
			case "sse": {
				const url = lockfile.url ?? (lockfile.port ? `http://127.0.0.1:${lockfile.port}/mcp` : "");
				if (url.length > 0) {
					items.push({
						name: "ide",
						transport: lockfile.transport,
						url,
						_source: createSourceMeta(PROVIDER_ID, filePath, "user"),
					});
					return { items, warnings };
				}
				break;
			}
			case "ws":
				logger.debug("Skipping unsupported WS IDE lockfile", { path: filePath });
				continue;
			default:
				continue;
		}
	}

	return { items, warnings };
}

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load the IDE MCP server from ~/.claude/ide lockfiles",
	priority: PRIORITY,
	load,
});
