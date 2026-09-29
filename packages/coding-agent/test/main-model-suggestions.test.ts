import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const approved = "anthropic/claude-haiku-4-5";
const excluded = "anthropic/claude-sonnet-4-5";

/** Launch headless with a selector that resolves to nothing; return the "Did you mean" list. */
async function suggestionsFor(
	configuration: string,
	extraArgs: string[] = [],
): Promise<{ code: number; suggestions: string[] }> {
	using dir = TempDir.createSync("@omp-model-suggestions-");
	const agentDir = path.join(dir.path(), "agent");
	await Bun.write(
		path.join(agentDir, "config.yml"),
		`startup:\n  setupWizard: false\n  checkUpdate: false\nmarketplace:\n  autoUpdate: off\n${configuration}`,
	);
	const proc = Bun.spawn(
		[
			process.execPath,
			cli,
			"--print",
			"--no-extensions",
			"--no-session",
			...extraArgs,
			"--model",
			"anthropc/claude",
			"hi",
		],
		{
			cwd: dir.path(),
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_PROFILE: "",
				PI_CONFIG_FILES: "",
				ANTHROPIC_API_KEY: "test-key",
				NO_COLOR: "1",
				PI_NO_TITLE: "1",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// Bound a leaked child process; the launch fails before any model call.
			timeout: 20_000,
		},
	);
	const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	const lines = stderr.split("\n");
	const start = lines.indexOf("Did you mean:");
	const suggestions = [];
	for (let i = start + 1; start >= 0 && lines[i]?.startsWith("  "); i++) suggestions.push(lines[i]!.trim());
	return { code, suggestions };
}

describe("headless launch model suggestions", () => {
	it("suggests only models that enabledModels and the cyber allowlist both admit", async () => {
		const result = await suggestionsFor(
			`enabledModels:\n  - ${approved}\n  - ${excluded}\ncyberMode: true\ncyberModels:\n  - ${approved}\n`,
		);
		expect(result.code).toBe(1);
		expect(result.suggestions).toEqual([approved]);
	});

	it("suggests nothing when enabledModels leaves out every approved model", async () => {
		const result = await suggestionsFor(
			`enabledModels:\n  - ${excluded}\ncyberMode: true\ncyberModels:\n  - ${approved}\n`,
		);
		expect(result.code).toBe(1);
		expect(result.suggestions).toEqual([]);
	});

	it("limits suggestions to enabledModels without cyber mode", async () => {
		const result = await suggestionsFor(`enabledModels:\n  - ${approved}\n  - ${excluded}\n`);
		expect(result.code).toBe(1);
		expect(result.suggestions.toSorted()).toEqual([approved, excluded]);
	});

	it("lets an explicit --models scope replace enabledModels", async () => {
		const result = await suggestionsFor(`enabledModels:\n  - ${approved}\n  - ${excluded}\n`, ["--models", approved]);
		expect(result.code).toBe(1);
		expect(result.suggestions).toEqual([approved]);
	});
});
