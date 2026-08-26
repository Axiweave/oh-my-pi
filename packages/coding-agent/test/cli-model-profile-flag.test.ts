import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { extractProfileFlags } from "@oh-my-pi/pi-coding-agent/cli/profile-bootstrap";

describe("parseArgs — --model-profile flag", () => {
	it("parses a bundle name in both spellings", () => {
		expect(parseArgs(["--model-profile", "fable"]).modelProfile).toBe("fable");
		expect(parseArgs(["--model-profile=fable"]).modelProfile).toBe("fable");
	});

	it("stays distinct from the isolated-profile --profile flag", () => {
		const result = parseArgs(["--profile", "work", "--model-profile", "fable", "hello"]);
		expect(result.profile).toBe("work");
		expect(result.modelProfile).toBe("fable");
		expect(result.messages).toEqual(["hello"]);
	});

	it("is not stolen by the profile bootstrap", () => {
		// The bootstrap runs before the launch parser and strips `--profile`; a
		// prefix match there would send the bundle name to profile isolation and
		// drop it from argv entirely.
		const boot = extractProfileFlags(["--model-profile", "fable", "hello"]);
		expect(boot.profile).toBeUndefined();
		expect(boot.argv).toEqual(["--model-profile", "fable", "hello"]);
	});
});
