import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseArgs, validateMasterLaunch } from "@oh-my-pi/pi-coding-agent/cli/args";
import { CliUsageError } from "@oh-my-pi/pi-coding-agent/cli/usage-error";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
const MESSAGE = "--master requires an interactive terminal (not --print or --mode).";

async function launch(args: string[]): Promise<{ exitCode: number; stderr: string }> {
	using dir = TempDir.createSync("@omp-master-flag-");
	const proc = Bun.spawn([process.execPath, cliEntry, "--no-session", ...args], {
		cwd: dir.path(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	return { exitCode, stderr };
}

describe("--master launch option", () => {
	it("parses as a valueless flag and leaves the prompt alone", () => {
		const args = parseArgs(["--master", "do it"]);
		expect(args.master).toBe(true);
		expect(args.messages).toEqual(["do it"]);
		expect(parseArgs(["do it"]).master).toBeUndefined();
	});

	it("validateMasterLaunch rejects only a non-interactive launch with the flag", () => {
		expect(() => validateMasterLaunch(parseArgs(["--master"]), true)).not.toThrow();
		expect(() => validateMasterLaunch(parseArgs([]), false)).not.toThrow();
		expect(() => validateMasterLaunch(parseArgs(["--master"]), false)).toThrow(new CliUsageError(MESSAGE));
	});

	for (const modeArgs of [
		["-p", "hi"],
		["--mode", "rpc"],
		["--mode", "acp"],
	]) {
		it(`exits 2 with the usage message for ${modeArgs.join(" ")}`, async () => {
			const result = await launch(["--master", ...modeArgs]);
			expect(result.exitCode, result.stderr).toBe(2);
			expect(result.stderr).toContain(MESSAGE);
		}, 30_000);
	}
});
