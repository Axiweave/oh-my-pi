/**
 * List discovered slash commands (skills, prompt templates, file commands)
 * with the current config applied. Editor integrations use this instead of
 * scanning the skill directories themselves.
 */

import { APP_NAME, getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { initializeWithSettings } from "../capability";
import { commandsHelp as commandHelp } from "../cli/command-help";
import { loadPromptTemplates } from "../config/prompt-templates";
import { Settings } from "../config/settings";
import { setInvocationConfiguredExtensions } from "../discovery/omp-extension-roots";
import { getSkillSlashCommandName, loadSkills } from "../extensibility/skills";
import { loadSlashCommands } from "../extensibility/slash-commands";

interface DiscoveredCommand {
	name: string;
	kind: "skill" | "prompt" | "file";
	description: string;
	source: string;
}

// ponytail: builtin, extension, and MCP prompt commands need a live session; use RPC `get_available_commands` for those.
export async function discoverCommands(cwd: string, configFiles?: string[]): Promise<DiscoveredCommand[]> {
	const agentDir = getAgentDir();
	const settings = await Settings.init({ cwd, agentDir, configFiles });
	initializeWithSettings(settings);
	setInvocationConfiguredExtensions(settings.get("extensions") ?? [], settings.extensionsSourceLevel());

	const skillsSettings = settings.getGroup("skills");
	const disabledExtensions = settings.get("disabledExtensions") ?? [];
	const [skills, prompts, files] = await Promise.all([
		skillsSettings.enabled !== false && skillsSettings.enableSkillCommands
			? loadSkills({ ...skillsSettings, cwd, disabledExtensions }).then(r => r.skills)
			: [],
		loadPromptTemplates({ cwd, agentDir }),
		loadSlashCommands({ cwd }),
	]);

	const out: DiscoveredCommand[] = [];
	const seen = new Set<string>();
	const add = (cmd: DiscoveredCommand) => {
		if (seen.has(cmd.name)) return;
		seen.add(cmd.name);
		out.push(cmd);
	};
	for (const s of skills) {
		add({ name: getSkillSlashCommandName(s), kind: "skill", description: s.description, source: s.filePath });
	}
	for (const p of prompts) add({ name: p.name, kind: "prompt", description: p.description, source: p.source });
	for (const f of files) add({ name: f.name, kind: "file", description: f.description, source: f.source });
	return out;
}

export default class Commands extends Command {
	static description = commandHelp.description;

	static flags = {
		cwd: Flags.string({ description: "Project directory (default: current directory)" }),
		json: Flags.boolean({ description: "Output JSON" }),
		config: Flags.string({
			description: "Load an extra config.yml-style overlay for this run (repeatable)",
			multiple: true,
		}),
	};

	static examples = [
		`# One command name per line, ready for a '/' prefix\n  ${APP_NAME} commands`,
		`# Machine-readable output with kind, description, and source\n  ${APP_NAME} commands --json`,
		`# Discover for another project\n  ${APP_NAME} commands --cwd ~/src/app`,
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Commands);
		const commands = await discoverCommands(flags.cwd ?? getProjectDir(), flags.config);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(commands, null, 2)}\n`);
			return;
		}
		for (const cmd of commands) process.stdout.write(`${cmd.name}\n`);
	}
}
