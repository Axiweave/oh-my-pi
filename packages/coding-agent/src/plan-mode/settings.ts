/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// ────────────────────────────────────────────────────────────────────────
// Tasks
// ────────────────────────────────────────────────────────────────────────

// Plan mode
export const cfgPlanEnabled = register({
	id: "plan.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Plan Mode",
		description: "Enable plan mode for read-only exploration and planning before execution",
	},
});

export const cfgPlanDefaultOnStartup = register({
	id: "plan.defaultOnStartup",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Start in Plan Mode",
		description: "Automatically enter plan mode at the start of every new session",
		condition: "planModeEnabled",
	},
});

export const cfgPlanKeybindingWorkflow = register({
	id: "plan.keybindingWorkflow",
	type: "enum",
	values: ["parallel", "debate"] as const,
	default: "parallel",
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Plan Shortcut Workflow",
		description: "Choose whether the plan shortcut enters standard plan or debate mode",
		condition: "planModeEnabled",
		options: [
			{
				value: "parallel",
				label: "Plan",
				description: "Enter standard read-only plan mode",
			},
			{
				value: "debate",
				label: "Debate",
				description: "Require independent plan review before human approval",
			},
		],
	},
});

export const cfgPlanDebateMaxRounds = register({
	id: "plan.debateMaxRounds",
	type: "number",
	default: 3,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Debate Max Rounds",
		description:
			"Distinct plan revisions the reviewer may reject before the unresolved review escalates to human approval",
		condition: "planModeEnabled",
	},
});

export const cfgPlanImplReview = register({
	id: "plan.implReview",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Debate Implementation Review",
		description:
			"After a debate plan is approved, require the independent reviewer to accept the finished implementation",
		condition: "planModeEnabled",
	},
});

export const cfgPlanAutosave = register({
	id: "plan.autosave",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Autosave Plans",
		description: "Automatically save approved plans to disk when plan mode completes",
		condition: "planModeEnabled",
	},
});

export const cfgPlanAutosaveDir = register({
	id: "plan.autosaveDir",
	type: "string",
	default: undefined,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Autosave Directory",
		description:
			"Directory for autosaved plans. Supports ~, absolute, and cwd-relative paths. Empty uses <project>/.omp/plans/.",
		condition: "planAutosaveEnabled",
	},
});
