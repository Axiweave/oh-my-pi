/**
 * Start a Session in its own zmx session for an outside caller, such as the
 * Intake (contracts/omp-launch-session.md). The opening prompt comes on stdin,
 * so `zmx list` never shows it.
 */
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { APP_NAME, postmortem } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { launchSessionHelp as commandHelp } from "../cli/command-help";
import { Settings } from "../config/settings";
import { spawnSession, type ZmxLabels } from "../session/sibling-spawn";

/** Env var overriding the launch deadline (milliseconds); for tests. */
const DEADLINE_MS_ENV = "OMP_LAUNCH_SESSION_DEADLINE_MS";
/**
 * Below the Intake's 30 s start timeout. Over `ssh -T` the Intake's SIGTERM does not
 * reach this process, so the launch stops itself and removes what it made.
 */
const DEADLINE_MS = 25_000;

/** Read the flags and stdin, then start the Session. Throws the refusal reason. */
async function launch(
	flags: { cwd?: string; branch?: string; label?: string[] },
	childArgv: string[],
	signal: AbortSignal,
): Promise<{ name: string; dir: string; branch: string | null }> {
	const { cwd, branch } = flags;
	if (!cwd || !path.isAbsolute(cwd)) throw new Error("--cwd must be an absolute path");
	if (!vcs.git(cwd)) throw new Error(`--cwd is not a Git checkout: ${cwd}`);
	const labels: ZmxLabels = {};
	for (const label of flags.label ?? []) {
		const eq = label.indexOf("=");
		const key = eq < 0 ? label : label.slice(0, eq);
		// Each label becomes one `k=v` word of `zmx attach --labels`.
		if (eq < 0 || !/^cci-[A-Za-z0-9_-]+$/.test(key)) throw new Error(`--label needs a cci-* KEY=VALUE: ${label}`);
		labels[key] = label.slice(eq + 1);
	}
	if (childArgv.length === 0) throw new Error("no omp command after --");
	const text = await Bun.stdin.text();
	if (text.trim() === "") throw new Error("the prompt on stdin is empty");
	const settings = await Settings.init({ cwd });
	return spawnSession({
		dir: cwd,
		branch,
		text,
		argv: childArgv,
		env: {},
		labels,
		publishState: true,
		settings,
		signal,
	});
}

export default class LaunchSession extends Command {
	static description = commandHelp.description;

	static flags = {
		cwd: Flags.string({ description: "Absolute path of the Git checkout the Session starts in" }),
		branch: Flags.string({ description: "Start in a new worktree on this branch (next free -N when taken)" }),
		label: Flags.string({ description: "Add a cci-* zmx label KEY=VALUE (repeatable)", multiple: true }),
		json: Flags.boolean({ description: "Print one JSON line" }),
	};

	static examples = [
		`# Start a Session on a new branch; the prompt comes on stdin\n  echo "Fix ENG-123" | ${APP_NAME} launch-session --cwd ~/src/app --branch eng-123 --label cci-launch=x1 --json -- ${APP_NAME} --auto-approve`,
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(LaunchSession);
		const dashes = this.argv.indexOf("--");
		const childArgv = dashes < 0 ? [] : this.argv.slice(dashes + 1);
		// SIGTERM or SIGHUP (an Intake timeout) or the deadline stops the launch. The exit waits until it removed what it made.
		const stop = new AbortController();
		const deadlineMs = Number(process.env[DEADLINE_MS_ENV]) || DEADLINE_MS;
		const deadline = setTimeout(() => stop.abort(`launch-session timed out after ${deadlineMs} ms`), deadlineMs);
		const launching = launch(flags, childArgv, stop.signal);
		const cancelCleanup = postmortem.register("launch-session", async reason => {
			stop.abort(`launch-session stopped by ${reason.toUpperCase()}`);
			await launching.catch(() => {});
		});
		try {
			const result = await launching;
			process.stdout.write(flags.json ? `${JSON.stringify(result)}\n` : `${result.name}\n`);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (flags.json) process.stdout.write(`${JSON.stringify({ error: reason })}\n`);
			else process.stderr.write(`${reason}\n`);
			process.exitCode = 1;
		} finally {
			clearTimeout(deadline);
			cancelCleanup();
		}
	}
}
