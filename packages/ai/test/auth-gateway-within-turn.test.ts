import { describe, expect, test } from "bun:test";
import { isWithinTurn } from "../src/auth-gateway/server";

const cases: Array<[name: string, last: unknown, expected: boolean]> = [
	[
		"Anthropic tool_result",
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
		true,
	],
	[
		"Anthropic tool_result plus text",
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "t1", content: "ok" },
				{ type: "text", text: "now do X" },
			],
		},
		false,
	],
	["OpenAI Chat tool", { role: "tool", tool_call_id: "t1", content: "ok" }, true],
	["Responses function_call_output", { type: "function_call_output", call_id: "t1", output: "ok" }, true],
	["pi-native toolResult", { role: "toolResult", toolCallId: "t1", content: [] }, true],
	["user text", { role: "user", content: "hello" }, false],
	["assistant", { role: "assistant", content: [{ type: "text", text: "hi" }] }, false],
];

const prefixPool: unknown[] = [
	...cases.map(([, last]) => last),
	{ role: "system", content: "sys" },
	{ type: "function_call", call_id: "t1", name: "f", arguments: "{}" },
];

describe("isWithinTurn", () => {
	test.each(cases)("%s", (_name, last, expected) => {
		expect(isWithinTurn([last])).toBe(expected);
	});

	test("empty list", () => {
		expect(isWithinTurn([])).toBe(false);
	});

	test("only the last item decides, whatever history precedes it", () => {
		const seed = 0x5eed;
		let state = seed;
		const next = (n: number) => {
			state = (Math.imul(state, 1103515245) + 12345) >>> 0;
			return state % n;
		};
		for (let run = 0; run < 200; run++) {
			const prefix = Array.from({ length: next(6) }, () => prefixPool[next(prefixPool.length)]);
			const [name, last, expected] = cases[next(cases.length)]!;
			if (isWithinTurn([...prefix, last]) !== expected) {
				throw new Error(`seed=${seed} run=${run} case=${name} prefix=${JSON.stringify(prefix)}`);
			}
		}
	});
});
