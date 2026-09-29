import { beforeAll, describe, expect, it, vi } from "bun:test";
import { isReviewPlanActive } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgReviewUsesPlan } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { buildReviewPlanArgumentCompletions } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const PLAN = "anthropic/claude-opus-4-6";
const REVIEWER = "openai-codex/gpt-5.5";

beforeAll(async () => {
	await initTheme(false);
});

/** A session stub whose switch follows its own `setReviewPlan` calls, over real role settings. */
function createRuntime(options: { enabled?: boolean; plan?: boolean } = {}) {
	const showStatus = vi.fn();
	const roles = Settings.isolated({
		modelRoles: options.plan === false ? { reviewer: REVIEWER } : { plan: PLAN, reviewer: REVIEWER },
	});
	const settings = Settings.isolated({});
	let enabled = options.enabled ?? false;
	const session = {
		get reviewPlan() {
			return enabled;
		},
		get reviewPlanActive() {
			return isReviewPlanActive(enabled, roles);
		},
		settings: roles,
		setReviewPlan: vi.fn((next: boolean) => {
			enabled = next;
		}),
	};
	const ctx = {
		editor: { setText: vi.fn() },
		showStatus,
		showError: vi.fn(),
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		focusedAgentId: undefined,
		ui: { requestRender: vi.fn() },
		settings,
		session,
	} as unknown as InteractiveModeContext;
	return { session, settings, showStatus, runtime: { ctx } };
}

describe("/review-plan slash command", () => {
	it("sets, toggles, and reports the state without saving a session-only switch", async () => {
		const cases: Array<{ command: string; from: boolean; to: boolean }> = [
			{ command: "/review-plan", from: false, to: true },
			{ command: "/review-plan", from: true, to: false },
			{ command: "/review-plan on", from: false, to: true },
			{ command: "/review-plan on", from: true, to: true },
			{ command: "/review-plan off", from: true, to: false },
			{ command: "/review-plan OFF", from: false, to: false },
			{ command: "/review-plan status", from: true, to: true },
			{ command: "/review-plan status", from: false, to: false },
		];
		for (const { command, from, to } of cases) {
			const h = createRuntime({ enabled: from });
			await executeBuiltinSlashCommand(command, h.runtime);
			const label = `${command} from ${from}`;
			expect(h.session.reviewPlan, label).toBe(to);
			// The line must name the model reviews use now, and never the other one.
			const line = h.showStatus.mock.lastCall?.[0] ?? "";
			expect(line, label).toContain(to ? PLAN : REVIEWER);
			expect(line, label).not.toContain(to ? REVIEWER : PLAN);
			expect(cfgReviewUsesPlan.provenance(h.settings), label).toBe("default");
		}
	});

	it("says the switch has no effect while no plan model resolves", async () => {
		const h = createRuntime({ plan: false });
		await executeBuiltinSlashCommand("/review-plan on", h.runtime);
		expect(h.session.reviewPlan).toBe(true);
		expect(h.showStatus.mock.lastCall?.[0]).toContain(REVIEWER);
	});

	it("saves the chosen value only when a scope is named", async () => {
		for (const verb of ["on", "off"] as const) {
			for (const scope of ["global", "project"] as const) {
				const h = createRuntime({ enabled: verb === "off" });
				cfgReviewUsesPlan.set(h.settings, verb === "off");
				await executeBuiltinSlashCommand(`/review-plan ${verb} ${scope}`, h.runtime);
				const label = `${verb} ${scope}`;
				expect(cfgReviewUsesPlan.get(h.settings), label).toBe(verb === "on");
				// Only the named layer takes the write. The global layer keeps the value set above.
				const written = scope === "global" ? h.settings.getGlobalSettings() : h.settings.getProjectSettings();
				const other = scope === "global" ? h.settings.getProjectSettings() : h.settings.getGlobalSettings();
				expect(written.reviewUsesPlan, label).toBe(verb === "on");
				expect(other.reviewUsesPlan, label).toBe(scope === "global" ? undefined : verb === "off");
				expect(h.showStatus.mock.lastCall?.[0], label).toEndWith(`Saved to ${scope} config.`);
			}
		}
	});

	it("rejects malformed arguments and leaves the state unchanged", async () => {
		for (const args of ["maybe", "status global", "on everywhere", "on global extra", "global"]) {
			const h = createRuntime({ enabled: true });
			await executeBuiltinSlashCommand(`/review-plan ${args}`, h.runtime);
			expect(h.session.reviewPlan, args).toBe(true);
			expect(h.session.setReviewPlan, args).not.toHaveBeenCalled();
			expect(h.showStatus.mock.lastCall?.[0], args).toBe("Usage: /review-plan [on|off|status] [global|project]");
		}
	});

	it("completes a save scope after on and off, and nothing after status", () => {
		const complete = buildReviewPlanArgumentCompletions();
		expect(complete("")?.map(item => item.value)).toEqual(["on", "off", "status"]);
		for (const verb of ["on", "off"]) {
			expect(complete(`${verb} `)?.map(item => item.value)).toEqual([`${verb} global`, `${verb} project`]);
			expect(complete(`${verb} p`)?.map(item => item.value)).toEqual([`${verb} project`]);
		}
		expect(complete("status ")).toBeNull();
		expect(complete("on global ")).toBeNull();
	});
});
