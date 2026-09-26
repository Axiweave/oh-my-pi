import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { SpaceHoldGesture } from "@oh-my-pi/pi-tui/space-hold";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	cfgModelProfile,
	cfgModelProfiles,
	cfgModelProfileSwitchStyle,
} from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeAll(() => initTheme());
beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
});
afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

function harness(names = ["base", "work", "review"]) {
	const settings = Settings.instance;
	cfgModelProfiles.override(settings, Object.fromEntries(names.map(name => [name, { default: `test/${name}` }])));
	const state = { activeModelProfile: names[0] as string | undefined };
	const overlays: Array<{ title: string; handleInput(key: string): void; renderContent(width: number): string[] }> =
		[];
	const hide = vi.fn();
	const closed: Promise<void>[] = [];
	const showStatus = vi.fn();
	const editor = {
		getText: () => "",
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
		spaceHold: new SpaceHoldGesture(() => {}),
		onCycleModelProfileForward: undefined as undefined | (() => Promise<void>),
		onCycleModelProfileBackward: undefined as undefined | (() => Promise<void>),
	};
	const session = {
		get activeModelProfile() {
			return state.activeModelProfile;
		},
		getPlanModeState: () => ({ enabled: false }),
		applyModelProfile: async (name: string) => {
			if (!names.includes(name)) return undefined;
			state.activeModelProfile = name;
			return { profile: name, model: { provider: "test", id: name }, role: "default" };
		},
		cycleModelProfile: async (direction: "forward" | "backward") => {
			const index = names.indexOf(state.activeModelProfile ?? "");
			const next = (index + (direction === "forward" ? 1 : names.length - 1)) % names.length;
			const profile = names[next]!;
			state.activeModelProfile = profile;
			return { profile, model: { provider: "test", id: profile }, role: "default" };
		},
	};
	const ctx = {
		settings,
		keybindings: { getKeys: () => [] },
		session,
		focusedAgentId: undefined,
		editor,
		editorContainer: { children: [] },
		ui: {
			showOverlay: (panel: (typeof overlays)[number]) => {
				const done = Promise.withResolvers<void>();
				overlays.push(panel);
				closed.push(done.promise);
				return {
					hide: () => {
						hide();
						done.resolve();
					},
				};
			},
			setFocus: vi.fn(),
			addInputListener: vi.fn(),
			addStartListener: vi.fn(),
			terminal: { write: vi.fn() },
			requestRender: vi.fn(),
		},
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus,
		showError: vi.fn(),
		showModelCycleTrack: vi.fn(),
		dictationSpaceHold: vi.fn(),
	} as unknown as InteractiveModeContext;
	const selector = new SelectorController(ctx);
	ctx.showModelProfilePicker = () => selector.showModelProfilePicker();
	const input = new InputController(ctx);
	input.setupKeyHandlers();
	return { input, editor, state, overlays, closed, hide, showStatus, settings };
}

describe("model profile keys", () => {
	it("filters profile names, cancels without a switch, and selects the whole profile", async () => {
		const names = ["base", ...Array.from({ length: 17 }, (_, i) => `profile-${i}`), "work", "review"];
		const h = harness(names);
		await h.editor.onCycleModelProfileForward!();
		const first = h.overlays.at(-1)!;
		expect(first.title).toContain("base");
		expect(first.renderContent(60).join("\n")).toContain("Search profiles:");
		expect(first.renderContent(60).join("\n")).not.toContain("base");
		first.handleInput("r");
		first.handleInput("e");
		expect(first.renderContent(60).join("\n")).toContain("Search profiles: re");
		expect(first.renderContent(60).join("\n")).toContain("review");
		expect(first.renderContent(60).join("\n")).not.toContain("work");
		first.handleInput("\x1b");
		expect(h.state.activeModelProfile).toBe("base");
		expect(h.hide).toHaveBeenCalledTimes(1);

		await h.editor.onCycleModelProfileBackward!();
		const second = h.overlays.at(-1)!;
		for (const key of "work") second.handleInput(key);
		second.handleInput("\r");
		await h.closed[1];
		expect(h.state.activeModelProfile).toBe("work");
		expect(h.hide).toHaveBeenCalledTimes(2);
		expect(cfgModelProfile.get(h.settings)).toBe("");
	});

	it("matches literal terms in order without overlap, regardless of case or surrounding spaces", async () => {
		// Invariant: later terms consume characters after the previous term.
		for (const query of ["sol l", " SOL   L ", "sol-low", "low", "", "l sol", "sol sol", "sol ."]) {
			const matches = !["l sol", "sol sol", "sol ."].includes(query);
			const h = harness(["base", "sol-low", "sol", "sonnet", "luna"]);
			await h.editor.onCycleModelProfileForward!();
			const picker = h.overlays.at(-1)!;
			for (const key of query) picker.handleInput(key);
			const rows = picker.renderContent(60).slice(1).map(line => Bun.stripANSI(line).trimEnd());
			expect(rows.some(line => line.endsWith("sol-low"))).toBe(matches);
			expect(rows.some(line => line.endsWith(" sol"))).toBe(query === "");
			expect(rows.some(line => line.endsWith("sonnet"))).toBe(query === "");
			expect(rows.some(line => line.endsWith("luna"))).toBe(query === "");
			if (query && matches) {
				picker.handleInput("\r");
				await h.closed[0];
				expect(h.state.activeModelProfile).toBe("sol-low");
			} else {
				picker.handleInput("\x1b");
			}
		}
	});

	it("cycles choices only with an empty search field", async () => {
		const h = harness(["base", "sol", "sol-low", "luna"]);
		await h.editor.onCycleModelProfileForward!();
		const first = h.overlays.at(-1)!;
		first.handleInput("\t");
		first.handleInput("\r");
		await h.closed[0];
		expect(h.state.activeModelProfile).toBe("sol-low");

		await h.editor.onCycleModelProfileBackward!();
		const second = h.overlays.at(-1)!;
		second.handleInput("\x1b[Z");
		second.handleInput("\r");
		await h.closed[1];
		expect(h.state.activeModelProfile).toBe("luna");
	});

	it("completes a partial search once, then stops at the exact choice", async () => {
		const h = harness(["base", "sonnet", "sol-low", "sol", "luna"]);
		await h.editor.onCycleModelProfileForward!();
		const first = h.overlays.at(-1)!;
		first.handleInput("s");
		first.handleInput("o");
		first.handleInput("\t");
		expect(first.renderContent(60).join("\n")).toContain("Search profiles: sol");
		expect(first.renderContent(60).join("\n")).toContain("sol-low");
		first.handleInput("\t");
		first.handleInput("\x1b[Z");
		expect(first.renderContent(60)[0]).not.toContain("Search profiles: sol-low");
		first.handleInput("\r");
		await h.closed[0];
		expect(h.state.activeModelProfile).toBe("sol");

		await h.editor.onCycleModelProfileBackward!();
		const second = h.overlays.at(-1)!;
		second.handleInput("l");
		second.handleInput("u");
		second.handleInput("\t");
		await h.closed[1];
		expect(h.state.activeModelProfile).toBe("luna");
	});

	it("narrows literal prefixes through punctuation and restores choices after deletion", async () => {
		const h = harness(["base", "sonnet", "sol-low", "sol"]);
		await h.editor.onCycleModelProfileForward!();
		const picker = h.overlays.at(-1)!;
		for (const key of "so") picker.handleInput(key);
		picker.handleInput("\t");
		picker.handleInput("\t");
		picker.handleInput("\x1b[Z");
		picker.handleInput("-");
		const rows = picker
			.renderContent(60)
			.slice(1)
			.map(line => Bun.stripANSI(line).trimEnd());
		expect(rows.some(line => line.endsWith(" sol"))).toBe(false);
		expect(rows.some(line => line.endsWith("sol-low"))).toBe(true);
		expect(rows.some(line => line.endsWith("sonnet"))).toBe(false);

		picker.handleInput("x");
		expect(picker.renderContent(60).join("\n")).toContain("No matching model profiles");
		picker.handleInput("\t");
		picker.handleInput("\r");
		expect(h.state.activeModelProfile).toBe("base");
		expect(h.hide).not.toHaveBeenCalled();
		picker.handleInput("\x7f");
		picker.handleInput("\x7f");
		expect(
			picker
				.renderContent(60)
				.slice(1)
				.some(line => Bun.stripANSI(line).trimEnd().endsWith(" sol")),
		).toBe(true);
		picker.handleInput("\t");
		picker.handleInput("\x1b[Z");
		expect(picker.renderContent(60)[0]).not.toContain("sol-low");
		picker.handleInput("-");
		picker.handleInput("\t");
		await h.closed[0];
		expect(h.state.activeModelProfile).toBe("sol-low");
	});

	it("keeps the original forward and backward transitions in cycling style", async () => {
		const h = harness();
		cfgModelProfileSwitchStyle.override(h.settings, "cycling");
		await h.editor.onCycleModelProfileForward!();
		expect(h.state.activeModelProfile).toBe("work");
		await h.editor.onCycleModelProfileBackward!();
		expect(h.state.activeModelProfile).toBe("base");
		expect(h.overlays).toHaveLength(0);
	});

	it("does not select a stale profile after a search has no matches", async () => {
		const h = harness(["only"]);
		await h.input.cycleModelProfile();
		const picker = h.overlays.at(-1)!;
		expect(picker.renderContent(60).join("\n")).toContain("No other model profiles");
		for (const key of "missing") picker.handleInput(key);
		expect(picker.renderContent(60).join("\n")).toContain("No matching model profiles");
		picker.handleInput("\r");
		expect(h.state.activeModelProfile).toBe("only");
		picker.handleInput("\x1b");
		expect(h.state.activeModelProfile).toBe("only");
	});

	it("does not open an empty picker when no profiles are configured", async () => {
		const h = harness([]);
		await h.input.cycleModelProfile();
		expect(h.overlays).toHaveLength(0);
		expect(h.showStatus).toHaveBeenCalledWith("No model profiles configured — add `modelProfiles` to your config");
	});
});
