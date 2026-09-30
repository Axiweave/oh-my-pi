import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type SlashCommand, slashCommandCapability } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// Git ignore rules must never hide command files: a `*.md` rule in
// .git/info/exclude or .gitignore once made every project command vanish.
describe("slash-command discovery ignores git ignore rules", () => {
	let root = "";
	let project = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		originalHome = process.env.HOME;
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-commands-gitignore-")));
		const home = path.join(root, "home");
		project = path.join(root, "project");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await fs.mkdir(project, { recursive: true });
		await Bun.$`git init -q ${project}`;
		await Bun.write(path.join(project, ".git", "info", "exclude"), "*.md\n");
		await Bun.write(path.join(project, ".gitignore"), "*.md\n");
	});

	afterEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(root);
	});

	for (const [provider, dir] of [
		["native", ".omp/commands"],
		["agents", ".agents/commands"],
		["claude", ".claude/commands"],
		["codex", ".codex/commands"],
		["opencode", ".opencode/commands"],
	] as const) {
		test(`${provider} loads ${dir}/deploy.md despite a matching ignore rule`, async () => {
			const file = path.join(project, dir, "deploy.md");
			await Bun.write(file, "Deploy $ARGUMENTS\n");

			const result = await loadCapability<SlashCommand>(slashCommandCapability.id, {
				cwd: project,
				providers: [provider],
			});

			expect(result.items.map(item => item.path)).toContain(file);
		});
	}
});
