import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const cli = path.resolve(import.meta.dir, "../../src/cli.ts");
const SEED = 0x24_1a_0c;

// mulberry32
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PIECES = ["a", "Z", "7", " ", "\n", "\t", "é", "日本", "🙂", '"', "'", "$HOME", "`x`", "\\", "--", "=", "/"];

describe.skipIf(process.platform === "win32")(`omp launch-session (seed ${SEED})`, () => {
	let root: string;
	let repo: string;
	let zmxDir: string;

	beforeAll(async () => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-launch-session-")));
		repo = path.join(root, "repo");
		zmxDir = path.join(root, "zmx");
		fs.mkdirSync(path.join(root, "bin"));
		fs.mkdirSync(zmxDir);
		await $`git init -q ${repo}`.quiet();
		await $`git -C ${repo} -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit --allow-empty -qm init`.quiet();
		await $`git -C ${repo} branch eng-1`.quiet();
		// Fake zmx: records each call, the attach argv and env, and takes the start file like the child does.
		// With ZMX_HOLD, attach records the start file path and hangs, so a test can stop the launch mid-way.
		const zmx = path.join(root, "bin", "zmx");
		fs.writeFileSync(
			zmx,
			`#!/bin/sh
echo "$1" >> "$ZMX_DIR/calls"
if [ "$1" = attach ] && [ -n "$ZMX_HOLD" ]; then
  printf '%s' "$OMP_SPAWN_START_FILE" > "$ZMX_DIR/start-file"
  exec sleep 30
fi
if [ "$1" = attach ]; then
  printf '%s\\n' "$@" > "$ZMX_DIR/argv"
  printf '%s' "$OMP_PUBLISH_STATE" > "$ZMX_DIR/publish"
  cat "$OMP_SPAWN_START_FILE" > "$ZMX_DIR/start" && rm -f "$OMP_SPAWN_START_FILE"
fi
exit 0
`,
		);
		fs.chmodSync(zmx, 0o755);
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function spawn(args: string[], stdin: string, env: Record<string, string> = {}) {
		for (const file of fs.readdirSync(zmxDir)) fs.rmSync(path.join(zmxDir, file));
		return Bun.spawn([process.execPath, cli, "launch-session", ...args], {
			stdin: new TextEncoder().encode(stdin),
			stdout: "pipe",
			stderr: "pipe",
			env: {
				HOME: root,
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				OMP_WORKTREE_DIR: path.join(root, "wt"),
				// No `ww` on PATH: the worktree takes the native path under OMP_WORKTREE_DIR.
				PATH: `${path.join(root, "bin")}:/usr/bin:/bin`,
				ZMX_DIR: zmxDir,
				...env,
			},
		});
	}

	function zmxCalls(): string {
		const file = path.join(zmxDir, "calls");
		return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	}

	async function launch(args: string[], stdin: string) {
		const proc = spawn(args, stdin);
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return { stdout, exitCode, calls: zmxCalls() };
	}

	it("prints one JSON line with name, dir, and branch, and hands the prompt and labels to the child", async () => {
		const next = prng(SEED);
		const text = (n: number) => Array.from({ length: n }, () => PIECES[Math.floor(next() * PIECES.length)]).join("");
		for (let run = 0; run < 4; run++) {
			const at = `seed ${SEED} run ${run}`;
			const prompt = `x${text(30)}`;
			const launchId = text(12);
			const branch = run % 2 === 0 ? undefined : "eng-1";
			const args = ["--cwd", repo, ...(branch ? ["--branch", branch] : []), "--label", `cci-launch=${launchId}`];
			const { stdout, exitCode } = await launch([...args, "--json", "--", "omp", "--auto-approve"], prompt);
			expect(exitCode, at).toBe(0);
			const lines = stdout.split("\n");
			expect(lines.length, at).toBe(2);
			expect(lines[1], at).toBe("");
			const result = JSON.parse(lines[0]!);
			expect(Object.keys(result).sort(), at).toEqual(["branch", "dir", "name"]);
			// eng-1 is taken, so the Session gets eng-1-2, then eng-1-3, ...
			expect(result.branch, at).toBe(branch ? `eng-1-${(run + 1) / 2 + 1}` : null);
			const argv = fs.readFileSync(path.join(zmxDir, "argv"), "utf8").split("\n").slice(0, -1);
			expect(argv.slice(-3), at).toEqual([result.name, "omp", "--auto-approve"]);
			const labels = Object.fromEntries(
				argv[2]!
					.split(" ")
					.map(pair => [pair.split("=")[0], Buffer.from(pair.split("=")[1]!, "base64url").toString()]),
			);
			expect(labels["cci-launch"], at).toBe(launchId);
			expect(labels["cci-parent"], at).toBeUndefined();
			expect(fs.readFileSync(path.join(zmxDir, "publish"), "utf8"), at).toBe("1");
			expect(fs.readFileSync(path.join(zmxDir, "start"), "utf8"), at).toBe(prompt);
		}
		// The taken branch still points at its old commit and has no worktree of its own.
		expect((await $`git -C ${repo} worktree list`.text()).includes("[eng-1]")).toBe(false);
	});

	it.each([
		["a missing --cwd", () => ["--json", "--", "omp"], "go"],
		["a relative --cwd", () => ["--cwd", "repo", "--json", "--", "omp"], "go"],
		["a --cwd that is not a Git checkout", () => ["--cwd", path.join(root, "bin"), "--json", "--", "omp"], "go"],
		["a label key without cci-", () => ["--cwd", repo, "--label", "launch=1", "--json", "--", "omp"], "go"],
		["a label without =", () => ["--cwd", repo, "--label", "cci-launch", "--json", "--", "omp"], "go"],
		["an empty prompt", () => ["--cwd", repo, "--json", "--", "omp"], " \n\t"],
		["an empty CHILD_ARGV", () => ["--cwd", repo, "--json", "--"], "go"],
	] as const)("refuses %s with one {error} line, exit 1, and no zmx call", async (_case, args, stdin) => {
		const { stdout, exitCode, calls } = await launch([...args()], stdin);
		expect(exitCode).toBe(1);
		const lines = stdout.split("\n");
		expect(lines.length).toBe(2);
		const result = JSON.parse(lines[0]!);
		expect(Object.keys(result)).toEqual(["error"]);
		expect(typeof result.error).toBe("string");
		expect(calls).toBe("");
	});

	it.each([
		["SIGTERM", 143],
		["SIGHUP", 129],
	] as const)(
		"on %s mid-launch removes the zmx session, worktree, branch, and start file within the grace",
		async (signal, code) => {
			const branch = `stop-${signal.toLowerCase()}`;
			const proc = spawn(["--cwd", repo, "--branch", branch, "--json", "--", "omp"], "go", { ZMX_HOLD: "1" });
			const startFileRecord = path.join(zmxDir, "start-file");
			// The fake zmx writes this once the worktree and start file exist and attach hangs. It is a
			// separate process, so poll its file: fake timers cannot drive it.
			while (!fs.existsSync(startFileRecord)) await Bun.sleep(20);
			const startFile = fs.readFileSync(startFileRecord, "utf8");
			expect(fs.existsSync(startFile)).toBe(true);
			expect(await $`git -C ${repo} branch --list ${branch}`.text()).not.toBe("");
			const killedAt = Date.now();
			proc.kill(signal);
			const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			// The Intake sends SIGKILL 5 s after SIGTERM.
			expect(Date.now() - killedAt).toBeLessThan(5000);
			expect(exitCode).toBe(code);
			expect(JSON.parse(stdout.split("\n")[0]!).error).toContain(`stopped by ${signal}`);
			expect(zmxCalls()).toBe("attach\nkill\n");
			expect(fs.existsSync(startFile)).toBe(false);
			expect(await $`git -C ${repo} branch --list ${branch}`.text()).toBe("");
			expect((await $`git -C ${repo} worktree list`.text()).includes(`[${branch}]`)).toBe(false);
		},
	);

	it("at its deadline removes the zmx session, worktree, branch, and start file, then prints the error", async () => {
		const branch = "stop-deadline";
		// OMP_LAUNCH_SESSION_DEADLINE_MS shortens the 25 s deadline. Attach hangs, so only the deadline ends it.
		const proc = spawn(["--cwd", repo, "--branch", branch, "--json", "--", "omp"], "go", {
			ZMX_HOLD: "1",
			OMP_LAUNCH_SESSION_DEADLINE_MS: "2000",
		});
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exitCode).toBe(1);
		expect(JSON.parse(stdout.split("\n")[0]!).error).toContain("launch-session timed out after 2000 ms");
		expect(zmxCalls()).toBe("attach\nkill\n");
		expect(fs.existsSync(fs.readFileSync(path.join(zmxDir, "start-file"), "utf8"))).toBe(false);
		expect(await $`git -C ${repo} branch --list ${branch}`.text()).toBe("");
		expect((await $`git -C ${repo} worktree list`.text()).includes(`[${branch}]`)).toBe(false);
	}, 15_000);
});
