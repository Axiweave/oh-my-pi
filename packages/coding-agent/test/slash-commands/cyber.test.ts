import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { CyberModeResult } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

beforeAll(async () => {
	await initTheme(false);
});

/** A session stub whose cyber state follows its own `setCyberMode` calls. */
function createRuntime(options?: {
	enabled?: boolean;
	cyberMode?: boolean;
	allowed?: string[];
	refusal?: CyberModeResult["refusal"];
}) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const invalidate = vi.fn();
	const updateEditorBorderColor = vi.fn();
	const set = vi.fn();
	const setProjectCyberMode = vi.fn();
	const allowed = options?.allowed ?? [];

	let enabled = options?.enabled ?? false;
	const setCyberMode = vi.fn(async (next: boolean): Promise<CyberModeResult> => {
		if (options?.refusal) return { enabled: false, models: [], changes: [], refusal: options.refusal };
		enabled = next;
		return { enabled: next, models: next ? allowed : [], changes: [] };
	});
	const session = {
		get cyberMode() {
			return options?.cyberMode ?? enabled;
		},
		model: { provider: "anthropic", id: "claude-sonnet-5" },
		settings: { getCyberAllowlist: () => (enabled ? { keys: new Set(allowed) } : undefined) },
		setCyberMode,
	};
	return {
		setText,
		showStatus,
		showError,
		invalidate,
		set,
		setProjectCyberMode,
		setCyberMode,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showStatus,
				showError,
				statusLine: { invalidate },
				updateEditorBorderColor,
				focusedAgentId: undefined,
				ui: { requestRender: vi.fn() },
				settings: { set, setProjectCyberMode },
				session,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/cyber slash command", () => {
	it("reports every allowed identity on enable and status without persisting the session switch", async () => {
		const models = ["anthropic/claude-sonnet-5", "anthropic/claude-haiku-4-5", "openai/gpt-6"];
		for (let length = 1; length <= models.length; length++) {
			const allowed = models.slice(0, length);
			const h = createRuntime({ allowed });
			for (const command of ["/cyber on", "/cyber status"]) {
				await executeBuiltinSlashCommand(command, h.runtime);
				expect(h.runtime.ctx.session.cyberMode, `${command}, allowlist length ${length}`).toBe(true);
				const output = h.showStatus.mock.lastCall?.[0];
				for (const model of allowed) expect(output).toContain(model);
			}
			expect(h.set).not.toHaveBeenCalled();
			expect(h.setProjectCyberMode).not.toHaveBeenCalled();
		}
	});

	it("toggles with no argument, from whatever the session is in", async () => {
		const on = createRuntime({ enabled: false });
		await executeBuiltinSlashCommand("/cyber", on.runtime);
		expect(on.setCyberMode).toHaveBeenCalledWith(true);

		const off = createRuntime({ enabled: true });
		await executeBuiltinSlashCommand("/cyber", off.runtime);
		expect(off.setCyberMode).toHaveBeenCalledWith(false);
	});

	it("persists the startup value to the requested scope", async () => {
		const global = createRuntime();
		await executeBuiltinSlashCommand("/cyber on global", global.runtime);
		expect(global.setCyberMode).toHaveBeenCalledWith(true);
		expect(global.set).toHaveBeenCalledWith("cyberMode", true);
		expect(global.setProjectCyberMode).not.toHaveBeenCalled();

		const project = createRuntime();
		await executeBuiltinSlashCommand("/cyber on project", project.runtime);
		expect(project.setProjectCyberMode).toHaveBeenCalledWith(true);
		expect(project.set).not.toHaveBeenCalled();
	});

	it("refuses an argument form the contract does not take, leaving the state alone", async () => {
		for (const args of ["bogus", "on sideways", "off global", "status project"]) {
			const h = createRuntime();
			await executeBuiltinSlashCommand(`/cyber ${args}`, h.runtime);
			expect(h.showStatus).toHaveBeenCalledWith("Usage: /cyber [on|off|status] [global|project]");
			expect(h.setCyberMode).not.toHaveBeenCalled();
		}
	});

	it("names the reason when the configuration cannot support an enable", async () => {
		const empty = createRuntime({ refusal: { reason: "empty" } });
		await executeBuiltinSlashCommand("/cyber on", empty.runtime);
		expect(empty.showStatus).toHaveBeenCalledWith(
			"No cyber-capable models configured — add `cyberModels` to your config.",
		);

		const unresolvable = createRuntime({ refusal: { reason: "unresolvable", entries: ["a/b"] } });
		await executeBuiltinSlashCommand("/cyber on", unresolvable.runtime);
		expect(unresolvable.showStatus).toHaveBeenCalledWith(
			"Cyber mode unavailable: none of a/b resolves to an available model.",
		);
	});
});
