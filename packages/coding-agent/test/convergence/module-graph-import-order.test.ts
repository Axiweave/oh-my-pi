import { describe, expect, test } from "bun:test";
import { validateModelRoleConfiguration } from "../../src/config/model-roles";
import { Settings } from "../../src/config/settings";

/**
 * The module graph reaches a cycle: `model-roles` imports `cyber-mode`, which
 * imports `model-resolver`, which imports `model-roles`. A module-scope read of
 * a `model-roles` binding anywhere in that cycle lands in the temporal dead
 * zone when this file evaluates first, so the import at the top of this file is
 * the assertion.
 */
describe("model role module graph", () => {
	test("evaluates when model-roles is the entry module", () => {
		const warnings: string[] = [];
		validateModelRoleConfiguration(Settings.isolated({}), undefined, message => warnings.push(message));
		expect(warnings).toEqual([]);
	});

	test("still reports profile and cyber findings through the single entry point", () => {
		const warnings: string[] = [];
		validateModelRoleConfiguration(
			Settings.isolated({ modelProfile: "missing-bundle", cyberModels: ["ghost/model"], cyberMode: true }),
			[],
			message => warnings.push(message),
		);
		expect(warnings).toContain("modelProfile 'missing-bundle' names no bundle in modelProfiles; ignoring it.");
		expect(warnings).toContain("cyberModels entry 'ghost/model' matches no available model; ignoring it.");
	});
});
