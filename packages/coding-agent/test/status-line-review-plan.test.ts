import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderSegment } from "@oh-my-pi/pi-tui/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-tui/status-line/types";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { SymbolPreset } from "@oh-my-pi/pi-tui/theme/symbols";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

function ctx(reviewPlanActive: boolean | undefined): SegmentContext {
	return { session: { reviewPlanActive } } as unknown as SegmentContext;
}

describe("review_plan status-line segment", () => {
	it("shows only while reviews actually run on the plan model", () => {
		for (const active of [undefined, false, true]) {
			const rendered = renderSegment("review_plan", ctx(active));
			expect(rendered.visible, `active ${active}`).toBe(active === true);
			expect(rendered.content === "", `active ${active}`).toBe(active !== true);
		}
	});

	it("uses the preset's mark, so an ascii terminal gets text", async () => {
		const presets: Array<{ preset: SymbolPreset; mark: string }> = [
			{ preset: "unicode", mark: "⇄" },
			{ preset: "nerd", mark: "⇄" },
			{ preset: "ascii", mark: "[RP]" },
		];
		try {
			for (const { preset, mark } of presets) {
				await initTheme(false, preset);
				expect(theme.icon.reviewPlan).toBe(mark);
				expect(Bun.stripANSI(renderSegment("review_plan", ctx(true)).content)).toBe(`${mark} Review:Plan`);
			}
		} finally {
			await initTheme();
		}
	});
});
