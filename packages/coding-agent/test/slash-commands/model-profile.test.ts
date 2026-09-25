import { beforeAll, describe, expect, it, vi } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { cfgModelProfile } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

beforeAll(async () => {
	// The segment track rendered after a session-only switch reads the theme singleton.
	await initTheme(false);
});

function createRuntime(options?: {
	profiles?: Record<string, Record<string, string>>;
	activeModelProfile?: string;
	planMode?: boolean;
}) {
	const profiles = options?.profiles ?? { work: { default: "a/b" }, base: {} };
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const showModelCycleTrack = vi.fn();
	const invalidate = vi.fn();
	const updateEditorBorderColor = vi.fn();
	const settings = Settings.isolated({ modelProfiles: profiles });
	const applyModelProfile = vi.fn(async (name: string, role: string) => ({
		profile: name,
		model: { provider: "a", id: "b" },
		role,
	}));
	return {
		setText,
		showStatus,
		showError,
		showModelCycleTrack,
		invalidate,
		updateEditorBorderColor,
		settings,
		applyModelProfile,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showStatus,
				showError,
				showModelCycleTrack,
				statusLine: { invalidate },
				updateEditorBorderColor,
				focusedAgentId: undefined,
				settings,
				session: {
					activeModelProfile: options?.activeModelProfile,
					getPlanModeState: () => ({ enabled: options?.planMode ?? false }),
					applyModelProfile,
				},
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/model-profile slash command", () => {
	it("applies a named profile for the session and flashes the segment track", async () => {
		const h = createRuntime();

		const handled = await executeBuiltinSlashCommand("/model-profile work", h.runtime);

		expect(handled).toBe(true);
		expect(h.setText).toHaveBeenCalledWith("");
		expect(h.applyModelProfile).toHaveBeenCalledWith("work", "default");
		expect(h.showModelCycleTrack).toHaveBeenCalled();
		expect(cfgModelProfile.get(h.settings)).toBe("");
		expect(cfgModelProfile.provenance(h.settings)).toBe("default");
	});

	it("activates the plan role when plan mode is on", async () => {
		const h = createRuntime({ planMode: true });

		await executeBuiltinSlashCommand("/model-profile work", h.runtime);

		expect(h.applyModelProfile).toHaveBeenCalledWith("work", "plan");
	});

	it("stores the startup profile in the requested settings layer", async () => {
		for (const scope of ["global", "project"] as const) {
			const h = createRuntime();
			await executeBuiltinSlashCommand(`/model-profile work ${scope}`, h.runtime);
			expect(cfgModelProfile.get(h.settings)).toBe("work");
			expect(cfgModelProfile.provenance(h.settings)).toBe(scope);
		}
	});

	it("rejects an unknown scope with a usage message", async () => {
		const h = createRuntime();

		await executeBuiltinSlashCommand("/model-profile work everywhere", h.runtime);

		expect(h.applyModelProfile).not.toHaveBeenCalled();
		expect(cfgModelProfile.get(h.settings)).toBe("");
		expect(cfgModelProfile.provenance(h.settings)).toBe("default");
		expect(h.showStatus).toHaveBeenCalledWith("Usage: /model-profile [name] [global|project]");
	});

	it("rejects an unknown profile name and lists available profiles", async () => {
		const h = createRuntime();

		await executeBuiltinSlashCommand("/model-profile nope", h.runtime);

		expect(h.applyModelProfile).not.toHaveBeenCalled();
		const message = h.showStatus.mock.calls[0][0] as string;
		expect(message).toContain("Unknown model profile: nope");
		expect(message).toContain("work");
	});

	it("shows the active profile and available names on bare invocation", async () => {
		const h = createRuntime({ activeModelProfile: "work" });

		await executeBuiltinSlashCommand("/model-profile", h.runtime);

		expect(h.applyModelProfile).not.toHaveBeenCalled();
		const message = h.showStatus.mock.calls[0][0] as string;
		expect(message).toContain("work");
		expect(message).toContain("base");
	});

	it("reports when no profiles are configured", async () => {
		const h = createRuntime({ profiles: {} });

		await executeBuiltinSlashCommand("/model-profile work", h.runtime);

		expect(h.applyModelProfile).not.toHaveBeenCalled();
		expect(h.showStatus).toHaveBeenCalledWith("No model profiles configured — add `modelProfiles` to your config");
	});
});
