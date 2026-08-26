import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

function ctxWithProfile(
	activeModelProfile: string | undefined,
	profiles: Record<string, Record<string, string>> = { fable: { default: "anthropic/claude-fable-5" } },
): SegmentContext {
	return {
		session: { activeModelProfile, settings: { getModelProfiles: () => profiles } },
	} as unknown as SegmentContext;
}

describe("model_profile status-line segment", () => {
	it("names the installed modelProfiles bundle", () => {
		const rendered = renderSegment("model_profile", ctxWithProfile("fable"));

		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe(theme.icon.package ? `${theme.icon.package} fable` : "fable");
	});

	it("stays hidden until a profile is installed, so footers without profiles are unchanged", () => {
		const rendered = renderSegment("model_profile", ctxWithProfile(undefined));

		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("stays hidden for an empty bundle, which resolves every role through config", () => {
		const rendered = renderSegment("model_profile", ctxWithProfile("base", { base: {} }));

		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});
});
