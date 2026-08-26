import { beforeAll, describe, expect, it, vi } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

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
	const set = vi.fn();
	const setProjectModelProfile = vi.fn();
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
		set,
		setProjectModelProfile,
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
				settings: { getModelProfiles: () => profiles, set, setProjectModelProfile },
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
		expect(h.set).not.toHaveBeenCalled();
		expect(h.setProjectModelProfile).not.toHaveBeenCalled();
	});

	it("activates the plan role when plan mode is on", async () => {
		const h = createRuntime({ planMode: true });

		await executeBuiltinSlashCommand("/model-profile work", h.runtime);

		expect(h.applyModelProfile).toHaveBeenCalledWith("work", "plan");
	});

	it("persists to the global config with the global scope", async () => {
		const h = createRuntime();

		await executeBuiltinSlashCommand("/model-profile work global", h.runtime);

		expect(h.applyModelProfile).toHaveBeenCalledWith("work", "default");
		expect(h.set).toHaveBeenCalledWith("modelProfile", "work");
		expect(h.setProjectModelProfile).not.toHaveBeenCalled();
		expect(h.showStatus).toHaveBeenCalledWith(expect.stringContaining("saved as startup profile (global config)"));
		expect(h.showModelCycleTrack).not.toHaveBeenCalled();
	});

	it("persists to the project config with the project scope", async () => {
		const h = createRuntime();

		await executeBuiltinSlashCommand("/model-profile work project", h.runtime);

		expect(h.setProjectModelProfile).toHaveBeenCalledWith("work");
		expect(h.set).not.toHaveBeenCalled();
	});

	it("rejects an unknown scope with a usage message", async () => {
		const h = createRuntime();

		await executeBuiltinSlashCommand("/model-profile work everywhere", h.runtime);

		expect(h.applyModelProfile).not.toHaveBeenCalled();
		expect(h.set).not.toHaveBeenCalled();
		expect(h.setProjectModelProfile).not.toHaveBeenCalled();
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
