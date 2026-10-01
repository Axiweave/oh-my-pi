/**
 * Reasoning-level criteria by how open-ended a problem is. Shared by the `auto`
 * classifier questions and the task tool's per-spawn `effort` guidance, so a
 * level name means the same thing in both places.
 */
export const LEVEL_CRITERIA: Record<"low" | "medium" | "high" | "xhigh", string> = {
	low: "One obvious solution, mechanically applied: target, mapping, or fix given.",
	medium: "A few candidates in a localized area, or one small trap: which line breaks a test, one boundary case.",
	high: "Several viable designs or candidate causes: API shape, policy choice, a known cause whose fix needs a design choice.",
	xhigh: "Open cause of flaky, concurrent, or stale behavior; solutions that are easy to get subtly wrong (races, invariants, cross-version compatibility).",
};

export const MAX_CRITERION =
	"Meets xhigh and at least one of: no reproduction to work from, irreversible or data-loss operation, or a live cutover that must stay correct while running. xhigh is required; difficulty alone is insufficient.";
