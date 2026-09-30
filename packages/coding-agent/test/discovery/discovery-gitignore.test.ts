import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extensionModuleCapability } from "@oh-my-pi/pi-coding-agent/capability/extension-module";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { hookCapability } from "@oh-my-pi/pi-coding-agent/capability/hook";
import { instructionCapability } from "@oh-my-pi/pi-coding-agent/capability/instruction";
import { promptCapability } from "@oh-my-pi/pi-coding-agent/capability/prompt";
import { ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { slashCommandCapability } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { toolCapability } from "@oh-my-pi/pi-coding-agent/capability/tool";
import type { LoadOptions } from "@oh-my-pi/pi-coding-agent/capability/types";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// Git ignore rules must never hide discovered files: a file-level rule such as
// `*.md` or `*.ts` in .git/info/exclude or .gitignore once made project items vanish.
const IGNORE_RULES = "*.md\n*.mdc\n*.ts\n*.js\n*.sh\n";

describe("discovery ignores git ignore rules", () => {
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
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-discovery-gitignore-")));
		home = path.join(root, "home");
		project = path.join(root, "project");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await fs.mkdir(project, { recursive: true });
		await Bun.$`git init -q ${project}`;
		await Bun.write(path.join(project, ".git", "info", "exclude"), IGNORE_RULES);
		await Bun.write(path.join(project, ".gitignore"), IGNORE_RULES);
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

	// Plugin packages live inside the ignored repo so the ignore rules cover them too.
	const registerClaudePlugin = async (pluginPath: string): Promise<LoadOptions<unknown>> => {
		const entry = { scope: "user", installPath: pluginPath, version: "1.0.0" };
		const registry = { version: 2, plugins: { "fixture@market": [entry] } };
		await Bun.write(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify(registry));
		return {};
	};
	// Explicit-only roots keep extension roots from other tests or disk config out of this load.
	const registerOmpExtension = async (pluginPath: string): Promise<LoadOptions<unknown>> => ({
		extensionRoots: { explicit: [pluginPath], mode: "explicit-only", configured: [], configuredLevel: "user" },
	});

	const COMMAND = "Deploy $ARGUMENTS\n";
	const cases: Array<{
		capability: string;
		provider: string;
		file: string;
		content: string;
		register?: (pluginPath: string) => Promise<LoadOptions<unknown>>;
	}> = [
		// Slash commands, for every provider.
		{ capability: slashCommandCapability.id, provider: "native", file: ".omp/commands/deploy.md", content: COMMAND },
		{
			capability: slashCommandCapability.id,
			provider: "agents",
			file: ".agents/commands/deploy.md",
			content: COMMAND,
		},
		{
			capability: slashCommandCapability.id,
			provider: "claude",
			file: ".claude/commands/deploy.md",
			content: COMMAND,
		},
		{ capability: slashCommandCapability.id, provider: "codex", file: ".codex/commands/deploy.md", content: COMMAND },
		{
			capability: slashCommandCapability.id,
			provider: "opencode",
			file: ".opencode/commands/deploy.md",
			content: COMMAND,
		},
		{
			capability: slashCommandCapability.id,
			provider: "claude-plugins",
			file: "claude-plugin/commands/deploy.md",
			content: COMMAND,
			register: registerClaudePlugin,
		},
		{
			capability: slashCommandCapability.id,
			provider: "omp-plugins",
			file: "omp-extension/commands/deploy.md",
			content: COMMAND,
			register: registerOmpExtension,
		},
		// Other file-scanned surfaces.
		{
			capability: ruleCapability.id,
			provider: "native",
			file: ".omp/rules/style.md",
			content: "---\ndescription: Style\n---\nUse tabs.\n",
		},
		{ capability: promptCapability.id, provider: "native", file: ".omp/prompts/review.md", content: "Review it.\n" },
		{
			capability: instructionCapability.id,
			provider: "native",
			file: ".omp/instructions/ts.md",
			content: "---\napplyTo: '**/*.ts'\n---\nUse strict mode.\n",
		},
		{ capability: hookCapability.id, provider: "claude", file: ".claude/hooks/pre/bash.sh", content: "#!/bin/sh\n" },
		{
			capability: toolCapability.id,
			provider: "native",
			file: ".omp/tools/hello.ts",
			content: "export default () => ({});\n",
		},
		{
			capability: extensionModuleCapability.id,
			provider: "native",
			file: ".omp/extensions/hello.ts",
			content: "export default () => {};\n",
		},
	];

	for (const { capability, provider, file: relative, content, register } of cases) {
		test(`${capability}/${provider} loads ${relative} despite a matching ignore rule`, async () => {
			const file = path.join(project, relative);
			await Bun.write(file, content);
			const extra = await register?.(path.dirname(path.dirname(file)));

			const result = await loadCapability<{ path: string }>(capability, {
				...extra,
				cwd: project,
				providers: [provider],
			});

			expect(result.items.map(item => item.path)).toContain(file);
		});
	}
});
