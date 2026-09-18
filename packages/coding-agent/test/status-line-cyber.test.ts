import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/symbols";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

function ctxWithCyber(cyberMode: boolean): SegmentContext {
	return { session: { cyberMode } } as unknown as SegmentContext;
}

describe("cyber status-line segment", () => {
	it("marks the session while the allowlist is in force", () => {
		const rendered = renderSegment("cyber", ctxWithCyber(true));

		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe(theme.icon.cyber ? `${theme.icon.cyber} Cyber` : "Cyber");
	});

	it("stays hidden while cyber mode is off, so unprotected footers are unchanged", () => {
		const rendered = renderSegment("cyber", ctxWithCyber(false));

		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("falls back to a text mark on every symbol preset that cannot render the glyph", async () => {
		// The mark comes from the preset tables, not from the segment: a hardcoded
		// emoji would still print crossed swords in an `ascii` terminal.
		const presets: Array<{ preset: SymbolPreset; mark: string }> = [
			{ preset: "unicode", mark: "⚔️" },
			{ preset: "nerd", mark: "⚔️" },
			{ preset: "ascii", mark: "[C]" },
		];

		try {
			for (const { preset, mark } of presets) {
				await initTheme(false, preset);
				const rendered = renderSegment("cyber", ctxWithCyber(true));

				expect(theme.icon.cyber).toBe(mark);
				expect(Bun.stripANSI(rendered.content)).toBe(`${mark} Cyber`);
			}
		} finally {
			await initTheme();
		}
	});
});
