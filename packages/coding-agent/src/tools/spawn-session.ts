import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import spawnSessionDescription from "../prompts/tools/spawn-session.md" with { type: "text" };
import type { ToolSession } from ".";

const spawnSessionSchema = type({
	mode: type("'fresh' | 'fork' | 'fork_handoff' | 'handoff_summary' | 'plan'").describe(
		"how the new session starts; plan shows the overview of all tasks",
	),
	"text?": type("string").describe("opening prompt, handoff note, or summary focus"),
	"cwd?": type("string").describe("absolute existing directory for the new session"),
	"new_worktree?": type("boolean").describe("start in a new branch and worktree from the current commit"),
	"branch?": type("string").describe(
		"required with new_worktree: kebab-case topic, issue ID first only if the request names one",
	),
	"model?": type("string").describe("provider/id, only when the request names a different model"),
	"speckit?": type("boolean").describe("start the new session with /speckit.specify; text is the feature description"),
	"tasks?": type("string[]").describe("plan only: one line for each task, 2 or more"),
});

export type SpawnSessionInput = typeof spawnSessionSchema.infer;

export type SpawnRequest = SpawnSessionInput & { signal?: AbortSignal };

/**
 * Creates the Sibling Session and returns the text for the model. Throws with
 * the reason when it refuses or fails. InteractiveMode sets it at startup.
 */
export type SpawnHandler = (request: SpawnRequest) => Promise<string>;

export class SpawnSessionTool implements AgentTool<typeof spawnSessionSchema> {
	readonly name = "spawn_session";
	readonly approval = "read" as const;
	readonly label = "Spawn Session";
	readonly description = prompt.render(spawnSessionDescription);
	readonly parameters = spawnSessionSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	// Parallel calls run one after another, so each task gets its own dialog and setup in request order.
	readonly concurrency = "exclusive" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(_toolCallId: string, params: SpawnSessionInput, signal?: AbortSignal): Promise<AgentToolResult> {
		const handler = this.#session.peekSpawnHandler?.();
		if (!handler) throw new ToolError("Spawning a session needs the interactive TUI.");
		const text = params.text?.trim() ?? "";
		let tasks: string[] | undefined;
		if (params.mode === "plan") {
			const { cwd, new_worktree, branch, model, speckit } = params;
			if (text || [cwd, new_worktree, branch, model, speckit].some(value => value !== undefined)) {
				throw new ToolError("mode plan takes only tasks.");
			}
			tasks = params.tasks?.map(task => task.trim()).filter(Boolean) ?? [];
			if (tasks.length < 2) throw new ToolError("mode plan needs tasks with 2 or more lines.");
		} else if (params.tasks !== undefined) {
			throw new ToolError("tasks needs mode plan.");
		}
		if ((params.mode === "fresh" || params.mode === "fork_handoff") && !text) {
			throw new ToolError(`text is required for mode ${params.mode}.`);
		}
		if (params.mode === "fork" && text) throw new ToolError("text must be empty for mode fork.");
		if (params.speckit && params.mode === "fork") throw new ToolError("speckit needs a mode that starts work.");
		if (params.cwd !== undefined && params.new_worktree) throw new ToolError("Use cwd or new_worktree, not both.");
		if (params.branch !== undefined && !params.new_worktree) throw new ToolError("branch needs new_worktree.");
		if (params.new_worktree && !params.branch?.trim()) throw new ToolError("new_worktree needs branch.");
		if (params.model !== undefined && !/^[^/\s]+\/\S+$/.test(params.model)) {
			throw new ToolError("model must be provider/id.");
		}
		if (params.cwd !== undefined) {
			if (!path.isAbsolute(params.cwd)) throw new ToolError("cwd must be an absolute path.");
			const stat = await fs.stat(params.cwd).catch(() => undefined);
			if (!stat?.isDirectory()) throw new ToolError(`cwd is not an existing directory: ${params.cwd}`);
		}
		try {
			const result = await handler({ ...params, text, tasks, signal });
			return { content: [{ type: "text", text: result }] };
		} catch (error) {
			if (error instanceof ToolError) throw error;
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
	}
}
