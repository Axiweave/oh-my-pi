import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type SlashCommand, slashCommandCapability } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// Git ignore rules must never hide command files: a `*.md` rule in
// .git/info/exclude or .gitignore once made every project command vanish.
describe("slash-command discovery ignores git ignore rules", () => {
	let root = "";
	let home = "";
	let project = "";
	let originalHome: string | undefined;
	let originalClaudeConfigDir: string | undefined;

	beforeEach(async () => {
		clearFsCache();
		clearClaudePluginRootsCache();
		resetSettingsForTest();
		originalHome = process.env.HOME;
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-commands-gitignore-")));
		home = path.join(root, "home");
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
		clearClaudePluginRootsCache();
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
		await removeWithRetries(root);
	});

	// Plugin packages live inside the ignored repo so the `*.md` rules cover them too.
	const registerClaudePlugin = async (pluginPath: string) => {
		const entry = { scope: "user", installPath: pluginPath, version: "1.0.0" };
		const registry = { version: 2, plugins: { "fixture@market": [entry] } };
		await Bun.write(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify(registry));
	};
	const registerOmpExtension = async (pluginPath: string) => {
		await Bun.write(path.join(project, ".omp", "config.yml"), `extensions:\n  - ${pluginPath}\n`);
	};

	for (const [provider, dir, register] of [
		["native", ".omp/commands"],
		["agents", ".agents/commands"],
		["claude", ".claude/commands"],
		["codex", ".codex/commands"],
		["opencode", ".opencode/commands"],
		["claude-plugins", "claude-plugin/commands", registerClaudePlugin],
		["omp-plugins", "omp-extension/commands", registerOmpExtension],
	] as const) {
		test(`${provider} loads ${dir}/deploy.md despite a matching ignore rule`, async () => {
			const file = path.join(project, dir, "deploy.md");
			await Bun.write(file, "Deploy $ARGUMENTS\n");
			await register?.(path.dirname(path.dirname(file)));

			const result = await loadCapability<SlashCommand>(slashCommandCapability.id, {
				cwd: project,
				providers: [provider],
			});

			expect(result.items.map(item => item.path)).toContain(file);
		});
	}
});
