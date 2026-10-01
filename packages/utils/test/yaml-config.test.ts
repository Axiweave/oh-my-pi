import { describe, expect, it } from "bun:test";
import { parseYamlConfig, stringifyYamlConfig } from "../src/yaml-config";

const SOURCE = `# header
symbolPreset: nerd # inline
modelProfiles:
  # profiles
  sol-low:
    default: openai-codex/gpt-6.1-sol:low  # main
    plan: openai-codex/gpt-6.1-sol:max

  opus:
    default: anthropic/claude-opus-5.5:high
task:
  agentModelOverrides:
    reviewer: "@reviewer"
`;

const PATHS = [
	["symbolPreset"],
	["modelProfiles", "opus", "default"],
	["modelProfiles", "sol-low"],
	["task"],
	["added"],
];

describe("stringifyYamlConfig with source", () => {
	it("returns the source byte for byte when no value changed", () => {
		expect(stringifyYamlConfig(parseYamlConfig(SOURCE), SOURCE)).toBe(SOURCE);
	});

	it("round-trips every edit and keeps comments of untouched nodes", () => {
		const seed = 42;
		let state = seed;
		const random = () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
		for (let i = 0; i < 1000; i++) {
			const value = parseYamlConfig(SOURCE) as Record<string, any>;
			const path = PATHS[Math.floor(random() * PATHS.length)]!;
			const roll = random();
			const next =
				roll < 0.3
					? undefined
					: roll < 0.6
						? { n: i, s: "a: b # not a comment" }
						: roll < 0.8
							? ["x", true, null]
							: `v#${i}`;
			let parent = value;
			for (const segment of path.slice(0, -1)) parent = parent[segment];
			parent[path.at(-1)!] = next;

			const out = stringifyYamlConfig(value, SOURCE);
			const context = `seed=${seed} iteration=${i} path=${path.join(".")}`;
			expect(parseYamlConfig(out), context).toEqual(JSON.parse(JSON.stringify(value)));
			expect(out, context).toContain("# header");
			if (path[0] !== "modelProfiles") expect(out, context).toContain("# profiles");
			if (path.join(".") !== "modelProfiles.sol-low") expect(out, context).toContain("# main");
		}
	});
	it("keeps the header comment when every key is deleted", () => {
		const out = stringifyYamlConfig({}, SOURCE);
		expect(parseYamlConfig(out)).toEqual({});
		expect(out).toContain("# header");
	});

	it("writes a changed repeated key once, so the new value wins on the next load", () => {
		const source = "a: 1\nb: 2\na: 3 # last\n";
		const out = stringifyYamlConfig({ a: 9, b: 2 }, source);
		expect(parseYamlConfig(out)).toEqual({ a: 9, b: 2 });
		expect(out.match(/^a:/gm)).toHaveLength(1);
		expect(out).toContain("# last");
	});

	it("falls back to a fresh dump when the source is not valid YAML", () => {
		expect(parseYamlConfig(stringifyYamlConfig({ a: 1 }, "bad: [\n"))).toEqual({ a: 1 });
	});
});

describe("parseYamlConfig", () => {
	it("matches Bun on repeated keys and merge keys", () => {
		for (const source of ["a: 1\na: 2\n", "x: &x {a: 1}\ny:\n  <<: *x\n  b: 2\n"]) {
			expect(parseYamlConfig(source)).toEqual(Bun.YAML.parse(source));
		}
	});
});
