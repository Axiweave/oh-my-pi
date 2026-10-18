import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import { parseLoopArgs } from "../modes/loop-limit";
import loopDescription from "../prompts/tools/loop.md" with { type: "text" };
import type { ToolSession } from ".";

const loopSchema = type({
	op: type("'start' | 'cancel'").describe("loop operation"),
	"prompt?": type("string").describe("prompt repeated on each run"),
	"limit?": type("string").describe("run count or total time"),
	"every?": type("string").describe("time between run starts"),
	"while?": type("string").describe("continue while this command exits 0"),
	"until?": type("string").describe("continue until this command exits 0"),
});

export type LoopToolInput = typeof loopSchema.infer;

export type LoopStartRequest = { op: "start"; args: string; signal?: AbortSignal } | { op: "cancel" };

/** Installed by InteractiveMode only while a `/guided-loop` interview runs; it owns the confirm dialog. */
export type LoopStartHandler = (request: LoopStartRequest) => Promise<"started" | "declined" | "cancelled">;

/**
 * Build the `/loop` arguments for a setup, or throw when `parseLoopArgs` would
 * read them back differently (a prompt starting with `3 `, `--`, or `every 5m`).
 */
export function buildLoopArgs(params: Omit<LoopToolInput, "op">): string {
	const loopPrompt = params.prompt?.trim();
	if (!loopPrompt) throw new ToolError("prompt is required.");
	if (params.while !== undefined && params.until !== undefined) {
		throw new ToolError("Use only one of while or until.");
	}
	const limit = params.limit?.trim();
	const every = params.every?.trim();
	const command = (params.while ?? params.until)?.trim();
	const flag = params.while !== undefined ? "--while" : "--until";
	const args = [
		limit,
		every && `every ${every}`,
		command !== undefined && `${flag} '${command.replaceAll("'", "'\\''")}'`,
		loopPrompt,
	]
		.filter(Boolean)
		.join(" ");
	const parsed = parseLoopArgs(args);
	const same =
		typeof parsed !== "string" &&
		parsed.prompt === loopPrompt &&
		!!parsed.limit === !!limit &&
		(parsed.intervalMs !== undefined) === !!every &&
		parsed.condition?.command === (command || undefined) &&
		(!command || parsed.condition?.until === (flag === "--until"));
	if (!same) {
		const reason =
			typeof parsed === "string"
				? parsed
				: "it reads back as a different setup; the prompt may start with a word that /loop reads as a count, duration, every, or flag";
		throw new ToolError(`This setup does not parse as /loop ${args}: ${reason}. Fix it and call loop again.`);
	}
	return args;
}

export class LoopTool implements AgentTool<typeof loopSchema> {
	readonly name = "loop";
	readonly approval = "read" as const;
	readonly label = "Loop";
	readonly description = prompt.render(loopDescription);
	readonly parameters = loopSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(_toolCallId: string, params: LoopToolInput, signal?: AbortSignal): Promise<AgentToolResult> {
		const args = params.op === "start" ? buildLoopArgs(params) : undefined;
		const handler = this.#session.peekLoopStartHandler?.();
		if (!handler) throw new ToolError("No guided loop interview can confirm this loop.");
		const outcome = await handler(args === undefined ? { op: "cancel" } : { op: "start", args, signal });
		const text =
			outcome === "started"
				? `Loop started: /loop ${args}\nEnd your turn now with no more text.`
				: outcome === "declined"
					? "The user declined this loop. Ask what to change."
					: "Guided loop interview ended. No loop started.";
		return { content: [{ type: "text", text }] };
	}
}
