import { InternalUrlRouter } from "../internal-urls";
import { recoverConflictUriPrefix } from "../tools/conflict-detect";
import { unwrapHashlineHeaderPath } from "../tools/plan-mode-guard";

/**
 * Master mode session-level state, mirroring {@link ../vibe/state.ts}. The main agent
 * coordinates and never waits on delegated work; {@link masterRefusal} enforces it.
 */
export interface MasterModeState {
	enabled: boolean;
}

/** Custom session entry type that persists the mode (data `{ enabled: boolean }`). */
export const MASTER_MODE_ENTRY = "master-mode";

/** Hidden per-turn message type. Rebuilt each prompt turn while the mode is on; never saved. */
export const MASTER_MODE_CONTEXT_MESSAGE_TYPE = "master-mode-context";

const PREFIX = "Master mode is on.";
const SUFFIX = "Do not retry or route around this block.";

export const MASTER_FILE_CHANGE_REFUSAL = `${PREFIX} You do not change files yourself. Give the change to a subagent with \`task\`. ${SUFFIX}`;
export const MASTER_FOREGROUND_BASH_REFUSAL = `${PREFIX} Run shell commands as a background job: call \`bash\` with \`async: true\`. Give every file change to a subagent with \`task\`. ${SUFFIX}`;
export const MASTER_SERVICE_BASH_REFUSAL = `${PREFIX} A named service call can block. Call \`bash\` with \`async: true\` and no \`name\`. ${SUFFIX}`;
export const MASTER_WAIT_REFUSAL = `${PREFIX} Do not wait. Results of subagents and background jobs arrive by themselves. End your turn after you start the work. ${SUFFIX}`;
export const MASTER_TASK_REFUSAL = `${PREFIX} This \`task\` call would run in the foreground and block you. Use agent types that are not blocking, and keep \`async.enabled\` on. ${SUFFIX}`;

/** Tools the main agent may call as is. `task` may still be refused inside `TaskTool`. */
const ALLOWED_TOOLS: Record<string, true> = {
	task: true,
	read: true,
	grep: true,
	glob: true,
	find: true,
	todo: true,
	ask: true,
	goal: true,
	loop: true,
};

/** True when a `write` call only reaches coordination, reply, sandbox, or job-cancel targets. Any throw means false. */
function isSafeWrite(args: unknown): boolean {
	try {
		const rawPath = (args as { path?: unknown } | null | undefined)?.path;
		if (typeof rawPath !== "string") return false;
		const router = InternalUrlRouter.instance();
		const path = recoverConflictUriPrefix(router.peelWriteSelector(unwrapHashlineHeaderPath(rawPath), "write")).path;
		const target = router.writeTarget(path);
		if (!target) return false;
		const policy = target.spec.write;
		if (!policy) return false;
		return (
			policy.scope === "coordination" ||
			policy.scope === "reply" ||
			policy.scope === "sandbox" ||
			policy.cancels?.(target.url) === true
		);
	} catch {
		return false;
	}
}

/**
 * Guard for the main agent while master mode is on. Returns a refusal text, or `undefined`
 * when the call is allowed. The caller applies it only while the state is on.
 */
export function masterRefusal(toolName: string, args: unknown): string | undefined {
	if (Object.hasOwn(ALLOWED_TOOLS, toolName)) return undefined;
	const record = (args ?? {}) as { async?: unknown; name?: unknown };
	switch (toolName) {
		case "bash":
			if (record.async !== true) return MASTER_FOREGROUND_BASH_REFUSAL;
			if (typeof record.name === "string" && record.name.trim() !== "") return MASTER_SERVICE_BASH_REFUSAL;
			return undefined;
		case "write":
			return isSafeWrite(args) ? undefined : MASTER_FILE_CHANGE_REFUSAL;
		case "edit":
		case "ast_edit":
			return MASTER_FILE_CHANGE_REFUSAL;
		case "wait":
			return MASTER_WAIT_REFUSAL;
		default:
			return `${PREFIX} The tool \`${toolName}\` is not available to the main agent. Give the work to a subagent with \`task\`, or run a check as a background \`bash\` call with \`async: true\`. ${SUFFIX}`;
	}
}
