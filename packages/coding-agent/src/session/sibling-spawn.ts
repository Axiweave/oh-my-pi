/**
 * Sibling Sessions: top-level omp sessions that `/spawn` creates in their own
 * zmx session and `/despawn` ends. zmx labels carry the parent link, the
 * spawned worktree record, and the child's working state; values are
 * `encodeURIComponent` text because labels are separated by spaces.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { writeTerminalSequence } from "@oh-my-pi/pi-tui/terminal";
import { wrapTmuxPassthroughIfNeeded } from "@oh-my-pi/pi-tui/tmux";
import { logger, ptree } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import { quoteOscArg } from "../utils/external-editor";
import type { SessionWorktree } from "./session-worktree";

export type SpawnMode = "fresh" | "fork" | "fork_handoff" | "handoff_summary";

/** zmx label record; keys are fixed ASCII, values are decoded text. */
export type ZmxLabels = Record<string, string>;

/** One `zmx list` row: `name` plus every other `k=v` field, labels decoded. */
export interface ZmxListEntry {
	name: string;
	fields: Record<string, string>;
}

const ZMX_TIMEOUT_MS = 15_000;
const WORK_MAX_CHARS = 80;
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Six random lowercase letters or digits for {@link siblingName}. */
export function randomSiblingSuffix(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => SUFFIX_ALPHABET[byte % 36]).join("");
}

/**
 * `<prefix>omp-<sanitized basename of dir>-<rand>`. The prefix is the text of
 * `parentName` before its first `omp-`, else `cci-`. The basename is sanitized
 * like `claude-code-ide-zmx--sanitize`: lowercased, each run of other
 * characters turned into `-`, outer `-` trimmed.
 */
export function siblingName(parentName: string | undefined, dir: string, rand: string): string {
	const at = parentName?.indexOf("omp-") ?? -1;
	const prefix = parentName !== undefined && at >= 0 ? parentName.slice(0, at) : "cci-";
	const base =
		path
			.basename(dir)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "session";
	return `${prefix}omp-${base}-${rand}`;
}

/**
 * zmx 0.8.1 accepts only `[A-Za-z0-9-_.]` in a label value, so every value is
 * unpadded base64url text.
 */
export function encodeLabelValue(value: string): string {
	return Buffer.from(value).toString("base64url");
}

/** `k=v` pairs separated by spaces, the form `zmx attach --labels` and `zmx set` take. */
export function encodeLabels(record: ZmxLabels): string {
	return Object.entries(record)
		.map(([key, value]) => `${key}=${encodeLabelValue(value)}`)
		.join(" ");
}

/** Parse `zmx list`: one tab-separated `k=v` row per session; `cci-*` values are decoded. */
export function parseZmxList(stdout: string): ZmxListEntry[] {
	const entries: ZmxListEntry[] = [];
	for (const line of stdout.split("\n")) {
		const fields: Record<string, string> = {};
		for (const field of line.trim().replace(/^→ /, "").split("\t")) {
			const eq = field.indexOf("=");
			if (eq <= 0) continue;
			const key = field.slice(0, eq);
			const value = field.slice(eq + 1);
			fields[key] = key.startsWith("cci-") ? Buffer.from(value, "base64url").toString() : value;
		}
		const name = fields.name;
		if (name) entries.push({ name, fields });
	}
	return entries;
}

/** The session directory from zmx's `cwd=file://HOST/PATH` field. */
export function zmxEntryDir(entry: ZmxListEntry): string | undefined {
	const cwd = entry.fields.cwd?.replace(/^file:\/\/[^/]*/, "");
	if (cwd === undefined) return undefined;
	try {
		return decodeURIComponent(cwd);
	} catch {
		return cwd;
	}
}

function zmxFailure(result: ptree.ExecResult): string {
	return (result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`).replaceAll("\n", " ");
}

/**
 * Create B with `zmx attach --labels … NAME …argv`. Without a TTY on stdin zmx
 * creates the session and returns. B must not inherit A's zmx target or Emacs
 * buffer. On failure the half-made session is killed and the error is thrown.
 */
export async function createSibling(options: {
	name: string;
	dir: string;
	argv: string[];
	env: Record<string, string | undefined>;
	labels: ZmxLabels;
}): Promise<void> {
	const { name, dir, argv, env, labels } = options;
	let failure: string | undefined;
	try {
		const result = await ptree.exec(["zmx", "attach", "--labels", encodeLabels(labels), name, ...argv], {
			cwd: dir,
			env: {
				...process.env,
				...env,
				ZMX_SESSION: undefined,
				ZMX_SESSION_PREFIX: undefined,
				EMACS_BUFFER_NAME: undefined,
				OMP_SPAWN_PARENT: labels["cci-parent"],
			},
			allowNonZero: true,
			timeout: ZMX_TIMEOUT_MS,
		});
		if (result.exitCode !== 0) failure = zmxFailure(result);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	if (failure === undefined) return;
	await ptree.exec(["zmx", "kill", name], { allowNonZero: true, timeout: ZMX_TIMEOUT_MS }).catch(() => {});
	throw new Error(`zmx could not create ${name}: ${failure}`);
}

async function listZmx(): Promise<ZmxListEntry[]> {
	const result = await ptree.exec(["zmx", "list"], { allowNonZero: true, timeout: ZMX_TIMEOUT_MS });
	if (result.exitCode !== 0) throw new Error(`zmx list failed: ${zmxFailure(result)}`);
	return parseZmxList(result.stdout);
}

/** The live zmx sessions whose `cci-parent` label is `parentName`. */
export async function listChildren(parentName: string): Promise<ZmxListEntry[]> {
	return (await listZmx()).filter(entry => entry.fields["cci-parent"] === parentName);
}

const ZMX_CMD_WRAPPERS: Record<string, true> = { command: true, exec: true, env: true, nohup: true };

/**
 * The executable of a zmx `cmd=` field: the first word after the wrapper
 * words and `VAR=value` assignments that Emacs also skips when it checks for a
 * known Agent command (`claude-code-ide-zmx-infer-cli-command`).
 */
export function zmxCmdExecutable(cmd: string | undefined): string | undefined {
	return cmd
		?.split(/\s+/)
		.find(word => word !== "" && !ZMX_CMD_WRAPPERS[word] && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
}

/**
 * The executable that started zmx session `name`, or `undefined` when zmx has
 * no such session. B runs it, so Emacs accepts B as the same known Agent
 * command it accepted for A. A source run would otherwise give `bun cli.ts`.
 */
export async function zmxSessionExecutable(name: string): Promise<string | undefined> {
	return zmxCmdExecutable((await listZmx()).find(entry => entry.name === name)?.fields.cmd);
}

export async function killSibling(name: string): Promise<void> {
	const result = await ptree.exec(["zmx", "kill", name], { allowNonZero: true, timeout: ZMX_TIMEOUT_MS });
	if (result.exitCode !== 0) throw new Error(`zmx kill ${name} failed: ${zmxFailure(result)}`);
}

/**
 * The `cci-work` text: the first line of `work` that is not empty and not only
 * a tag (such as the `<file …>` wrapper of an `@file` prompt), trimmed, at most
 * 80 characters.
 */
export function spawnWorkText(work: string | undefined): string {
	const line = work?.split("\n").find(l => l.trim() !== "" && !/^<[^>]*>$/.test(l.trim()));
	return Array.from(line?.trim() ?? "")
		.slice(0, WORK_MAX_CHARS)
		.join("");
}

/**
 * Publish B's working state on its own zmx session for the parent's
 * `/despawn` confirmation (`cci-work` is {@link spawnWorkText}). `idle`
 * removes it. Never rejects: a failure is logged at debug.
 */
export async function publishState(state: "working" | "idle", work?: string): Promise<void> {
	const session = process.env.ZMX_SESSION;
	if (!session) return;
	const text = state === "working" ? spawnWorkText(work) : "";
	try {
		const result = await ptree.exec(
			["zmx", "set", session, ...encodeLabels({ "cci-state": state, "cci-work": text }).split(" ")],
			{ allowNonZero: true, timeout: ZMX_TIMEOUT_MS },
		);
		if (result.exitCode !== 0) logger.debug("zmx set cci-state failed", { session, error: zmxFailure(result) });
	} catch (error) {
		logger.debug("zmx set cci-state failed", { session, error: String(error) });
	}
}

/** Tell the Emacs that shows this session that zmx session `name` exists (OSC 52 `e`). */
export function writeSpawnAnnouncement(name: string): void {
	writeTerminalSequence(
		wrapTmuxPassthroughIfNeeded(
			`\x1b]52;e;${quoteOscArg("claude-code-ide-session-spawn-announce")} ${quoteOscArg(name)}\x1b\\`,
		),
	);
}

/** The spawn window closes after a run with no `spawn_session` and no `ask` call. */
export function spawnWindowShouldClose(messages: readonly AgentMessage[]): boolean {
	return !messages.some(
		message =>
			message.role === "assistant" &&
			message.content.some(
				block => block.type === "toolCall" && (block.name === "spawn_session" || block.name === "ask"),
			),
	);
}

/**
 * B's argv for `mode`: `fresh`/`handoff_summary` start from `@start`, `fork`
 * forks the file, `fork_handoff` forks it and adds `@start`. No prompt text
 * goes on the command line, which `zmx list` prints.
 */
export function spawnArgv(
	base: readonly string[],
	mode: SpawnMode,
	files: { forkFile?: string; startFile?: string },
): string[] {
	const argv = [...base];
	if ((mode === "fork" || mode === "fork_handoff") && files.forkFile) argv.push("--fork", files.forkFile);
	if (mode !== "fork" && files.startFile) argv.push(`@${files.startFile}`);
	return argv;
}

/** Labels that record a worktree the spawn created. */
export function worktreeLabels(wt: SessionWorktree): ZmxLabels {
	return {
		"cci-wt-path": wt.path,
		"cci-wt-branch": wt.branch,
		"cci-wt-base": wt.baseCommit,
		"cci-wt-source": wt.sourceCwd,
	};
}

/** The spawned worktree, only when all four `cci-wt-*` labels are present. */
export function worktreeFromLabels(labels: ZmxLabels): SessionWorktree | undefined {
	const wtPath = labels["cci-wt-path"];
	const branch = labels["cci-wt-branch"];
	const baseCommit = labels["cci-wt-base"];
	const sourceCwd = labels["cci-wt-source"];
	if (wtPath === undefined || branch === undefined || baseCommit === undefined || sourceCwd === undefined) {
		return undefined;
	}
	return { path: wtPath, branch, baseCommit, sourceCwd, keptChanges: true };
}
