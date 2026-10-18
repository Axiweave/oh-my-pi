import { describe, expect, it } from "bun:test";
import { parseLoopArgs } from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type LoopStartHandler, type LoopStartRequest, LoopTool } from "@oh-my-pi/pi-coding-agent/tools/loop";

function createTool(handler?: LoopStartHandler) {
	const requests: LoopStartRequest[] = [];
	const session = {
		peekLoopStartHandler: () =>
			handler &&
			(async (request: LoopStartRequest) => {
				requests.push(request);
				return handler(request);
			}),
	} as unknown as ToolSession;
	return { tool: new LoopTool(session), requests };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => part.text ?? "").join("");
}

/** mulberry32: small seeded PRNG so failures replay from the printed seed. */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const COMMANDS = ["bun test", "test -f 'a b'", `echo "it's" && true`, "gh run view --exit-status"];
const PLAIN_PROMPTS = ["Fix the failing tests.", "Check the deploy status.\nThen report back."];
const HAZARDS = { limit: "3 checks then stop", flag: "-- run the checks", every: "every 5m look again" } as const;
type Hazard = keyof typeof HAZARDS;

interface Setup {
	prompt: string;
	hazard?: Hazard;
	limit?: string;
	every?: string;
	while?: string;
	until?: string;
}

function genSetup(next: () => number): Setup {
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
	const setup: Setup = { prompt: "" };
	const limitKind = pick(["none", "count", "duration"] as const);
	if (limitKind === "count") setup.limit = String(1 + Math.floor(next() * 99));
	if (limitKind === "duration") setup.limit = pick(["30m", "2h", "90 minutes"]);
	const every = pick([undefined, "15m", "1h30m", "45s"]);
	if (every) setup.every = every;
	const condition = pick(["none", "while", "until"] as const);
	if (condition !== "none") setup[condition] = pick(COMMANDS);
	if (next() < 0.5) {
		setup.prompt = pick(PLAIN_PROMPTS);
	} else {
		setup.hazard = pick(Object.keys(HAZARDS) as Hazard[]);
		setup.prompt = HAZARDS[setup.hazard];
	}
	return setup;
}

/** True when a field slot the parser reads before the prompt is still open for this hazard prefix. */
function hazardIsAmbiguous(setup: Setup): boolean {
	const condition = setup.while !== undefined || setup.until !== undefined;
	switch (setup.hazard) {
		case "limit":
			return !setup.limit && !setup.every && !condition;
		case "every":
			return !condition;
		case "flag":
			return true;
		default:
			return false;
	}
}

describe("LoopTool round trip", () => {
	it("every accepted setup reads back the same through /loop and the slash parser", async () => {
		const seed = 0x10_0b_5e_ed;
		const next = rng(seed);
		const { tool, requests } = createTool(async () => "started");
		let accepted = 0;
		let rejected = 0;
		for (let i = 0; i < 300; i++) {
			const setup = genSetup(next);
			const where = `seed=${seed} case=${i} setup=${JSON.stringify(setup)}`;
			const before = requests.length;
			let error: unknown;
			try {
				await tool.execute(`call-${i}`, { op: "start", ...setup });
			} catch (err) {
				error = err;
			}

			if (setup.hazard && hazardIsAmbiguous(setup)) {
				expect(error, `hazard prompt accepted: ${where}`).toBeDefined();
			}
			if (!setup.hazard) {
				expect(error, `plain prompt rejected: ${where} error=${String(error)}`).toBeUndefined();
			}

			if (error) {
				rejected++;
				expect(
					error instanceof Error && error.message.startsWith("This setup does not parse as /loop"),
					where,
				).toBe(true);
				expect(requests.length, where).toBe(before);
				continue;
			}

			accepted++;
			expect(requests.length, where).toBe(before + 1);
			const request = requests.at(-1);
			if (request?.op !== "start") throw new Error(`handler did not get a start request: ${where}`);
			const args = request.args;
			const parsed = parseLoopArgs(args);
			if (typeof parsed === "string") throw new Error(`accepted args fail to parse: ${where} args=${args}`);
			const command = setup.while ?? setup.until;
			expect(parsed.prompt, where).toBe(setup.prompt.trim());
			expect(parsed.limit !== undefined, where).toBe(setup.limit !== undefined);
			expect(parsed.intervalMs !== undefined, where).toBe(setup.every !== undefined);
			expect(parsed.condition?.command, where).toBe(command);
			if (command !== undefined) expect(parsed.condition?.until, where).toBe(setup.until !== undefined);

			const slash = parseSlashCommand(`/loop ${args}`);
			expect(slash?.name, where).toBe("loop");
			expect(parseLoopArgs(slash!.args), where).toEqual(parsed);
		}
		// Guard against a generator that never reaches one of the branches.
		expect(accepted).toBeGreaterThan(50);
		expect(rejected).toBeGreaterThan(20);
	});
});

describe("LoopTool boundaries", () => {
	it("rejects a blank prompt", async () => {
		const { tool } = createTool(async () => "started");
		await expect(tool.execute("c", { op: "start", prompt: "   " })).rejects.toThrow("prompt is required.");
	});

	it("rejects while and until together", async () => {
		const { tool } = createTool(async () => "started");
		await expect(tool.execute("c", { op: "start", prompt: "go", while: "true", until: "false" })).rejects.toThrow(
			"Use only one of while or until.",
		);
	});

	it("fails without an installed handler", async () => {
		const { tool } = createTool();
		await expect(tool.execute("c", { op: "start", prompt: "go" })).rejects.toThrow(
			"No guided loop interview can confirm this loop.",
		);
	});

	it("reports a declined loop", async () => {
		const { tool } = createTool(async () => "declined");
		const result = await tool.execute("c", { op: "start", prompt: "go" });
		expect(textOf(result)).toBe("The user declined this loop. Ask what to change.");
	});

	it("reports a started loop with its args and passes the signal", async () => {
		const { tool, requests } = createTool(async () => "started");
		const signal = new AbortController().signal;
		const result = await tool.execute("c", { op: "start", prompt: "go", limit: "3", while: "bun test" }, signal);
		const args = "3 --while 'bun test' go";
		expect(textOf(result)).toBe(`Loop started: /loop ${args}\nEnd your turn now with no more text.`);
		expect(requests).toEqual([{ op: "start", args, signal }]);
		const [request] = requests;
		expect(request?.op === "start" && request.signal).toBe(signal);
	});

	it("sends cancel to the handler", async () => {
		const { tool, requests } = createTool(async () => "cancelled");
		const result = await tool.execute("c", { op: "cancel" });
		expect(textOf(result)).toBe("Guided loop interview ended. No loop started.");
		expect(requests).toEqual([{ op: "cancel" }]);
	});
});
