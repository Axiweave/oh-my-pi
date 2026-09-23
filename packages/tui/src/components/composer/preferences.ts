import type { ComposerStyle } from "./types";

/** Process-wide composer style preferences applied by the host settings hooks. */
export interface ComposerStylePreferences {
	/**
	 * Global override for the claude-style multi-line footer, independent of
	 * the active composer shape's own `footerMode`. `"default"` defers to the
	 * shape.
	 */
	footerMode: "claude3" | "default";
}

/** Current composer style preferences. */
export const composerStylePreferences: ComposerStylePreferences = {
	footerMode: "default",
};

/** Apply host composer style preferences without pulling settings into the renderer. */
export function setComposerStylePreferences(preferences: Partial<ComposerStylePreferences>): void {
	Object.assign(composerStylePreferences, preferences);
}

/** True when `style` or the host preference forces the claude-style multi-line footer. */
export function usesClaudeFooter(style: Pick<ComposerStyle, "footerMode">): boolean {
	return style.footerMode === "claude3" || composerStylePreferences.footerMode === "claude3";
}
