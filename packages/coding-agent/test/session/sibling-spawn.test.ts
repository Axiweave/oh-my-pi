import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	encodeLabels,
	listChildren,
	parseZmxList,
	siblingName,
	spawnWindowShouldClose,
	takeSpawnStartText,
	worktreeFromLabels,
	type ZmxLabels,
	spawnWorkText,
	zmxCmdExecutable,
} from "@oh-my-pi/pi-coding-agent/session/sibling-spawn";
import { ptree } from "@oh-my-pi/pi-utils";

const SEED = 0x5b_1b_21;
const RUNS = 300;

// mulberry32
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PIECES = [
	"a",
	"Z",
	"7",
	" ",
	"-",
	"_",
	".",
	"/",
	"=",
	"%",
	"\t",
	"é",
	"日本",
	"🙂",
	"omp-",
	"%20",
	"\\",
	'"',
	"\n",
];
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

function gen(next: () => number) {
	const int = (n: number) => Math.floor(next() * n);
	const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
	const text = (max: number) => Array.from({ length: int(max + 1) }, () => pick(PIECES)).join("");
	const suffix = () => Array.from({ length: 6 }, () => pick([...ALNUM])).join("");
	return { int, pick, text, suffix };
}

function assistantCalls(names: string[]): AgentMessage {
	return {
		role: "assistant",
		content: names.map((name, i) => ({ type: "toolCall", id: `call-${i}`, name, arguments: {} })),
	} as unknown as AgentMessage;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe(`sibling-spawn properties (seed ${SEED})`, () => {
	it("names every sibling <prefix>omp-<basename>-<6 alnum>", () => {
		const g = gen(prng(SEED));
		const parents = [undefined, "", "cci-omp-proj-abc123", "no-marker-here", "x omp-y omp-z", "omp-"];
		for (let run = 0; run < RUNS; run++) {
			const parent = run < parents.length ? parents[run] : g.text(6);
			const dir = `/${g.text(4)}/${g.text(8)}`;
			const rand = g.suffix();
			const at = parent?.indexOf("omp-") ?? -1;
			const prefix = parent !== undefined && at >= 0 ? parent.slice(0, at) : "cci-";
			const name = siblingName(parent, dir, rand);
			expect(name, `seed ${SEED} run ${run} parent ${JSON.stringify(parent)} dir ${JSON.stringify(dir)}`).toMatch(
				new RegExp(`^${escapeRegExp(prefix)}omp-[a-z0-9-]+-${rand}$`),
			);
		}
	});

	it("reads back every label written by encodeLabels from a zmx list row", () => {
		const g = gen(prng(SEED + 1));
		for (let run = 0; run < RUNS; run++) {
			const labels: ZmxLabels = {};
			for (let i = g.int(5); i >= 0; i--) labels[`cci-k${i}`] = g.text(10);
			// zmx prints each label as one more tab-separated field after cmd=.
			const encoded = encodeLabels(labels);
			// zmx 0.8.1 rejects any label value outside [A-Za-z0-9-_.].
			for (const pair of encoded.split(" ").filter(Boolean))
				expect(pair, `seed ${SEED} run ${run}`).toMatch(/^cci-k\d=[A-Za-z0-9._-]*$/);
			const row = `→ name=s${run}\tpid=1\tcmd=omp --x\t${encoded.replaceAll(" ", "\t")}`;
			const [entry] = parseZmxList(`${row}\n`);
			const { name: _name, pid: _pid, cmd: _cmd, ...read } = entry!.fields;
			expect(read, `seed ${SEED} run ${run}`).toEqual(labels);
		}
	});

	it("takes the executable of a zmx cmd after any wrappers and assignments, as Emacs does", () => {
		const g = gen(prng(SEED + 7));
		const executables = ["omp", "omp-dev", "/usr/local/bin/omp", "/x/bun"];
		for (let run = 0; run < RUNS; run++) {
			const executable = g.pick(executables);
			const prefix = Array.from({ length: g.int(4) }, () =>
				g.pick(["command", "exec", "env", "nohup", "FOO=1", "A_B=x=y"]),
			);
			const args = Array.from({ length: g.int(3) }, () => g.pick(["--model", "a/b", "env", "X=1", "@f"]));
			const cmd = [...prefix, executable, ...args].join(g.pick([" ", "  "]));
			expect(zmxCmdExecutable(cmd), `seed ${SEED} run ${run} cmd ${JSON.stringify(cmd)}`).toBe(executable);
		}
		expect(zmxCmdExecutable(undefined)).toBeUndefined();
		expect(zmxCmdExecutable("env FOO=1")).toBeUndefined();
	});

	it("lists only the sessions whose cci-parent is this session", async () => {
		const g = gen(prng(SEED + 2));
		const parent = "cci-omp-proj-abc123";
		const others = [undefined, "cci-omp-proj-abc12", `${parent}x`, `x${parent}`, "", "cci-omp-other-zzzzzz"];
		for (let run = 0; run < 50; run++) {
			const rows: string[] = [];
			const expected: string[] = [];
			for (let i = 0; i < 1 + g.int(8); i++) {
				const name = `cci-omp-s${run}-${i}`;
				const owner = g.int(2) === 0 ? parent : g.pick(others);
				if (owner === parent) expected.push(name);
				const labels: ZmxLabels = owner === undefined ? {} : { "cci-parent": owner, "cci-state": "idle" };
				rows.push(`  name=${name}\tclients=0\tcmd=omp\t${encodeLabels(labels).replaceAll(" ", "\t")}`);
			}
			vi.spyOn(ptree, "exec").mockResolvedValue({ stdout: rows.join("\n"), stderr: "", exitCode: 0, ok: true });
			const children = await listChildren(parent);
			expect(
				children.map(child => child.name),
				`seed ${SEED} run ${run}`,
			).toEqual(expected);
		}
	});

	it("closes the spawn window only after a run with no spawn_session and no ask call", () => {
		const g = gen(prng(SEED + 3));
		const other = ["read", "bash", "grep", "edit", "task"];
		expect(spawnWindowShouldClose([])).toBe(true);
		for (let run = 0; run < RUNS; run++) {
			const messages: AgentMessage[] = Array.from({ length: g.int(4) }, () =>
				assistantCalls(Array.from({ length: g.int(3) }, () => g.pick(other))),
			);
			expect(spawnWindowShouldClose(messages), `seed ${SEED} run ${run}`).toBe(true);
			const keep = g.pick(["spawn_session", "ask"]);
			messages.splice(g.int(messages.length + 1), 0, assistantCalls([...other.slice(0, g.int(3)), keep]));
			expect(spawnWindowShouldClose(messages), `seed ${SEED} run ${run}`).toBe(false);
		}
	});

	it("hands B its start text unchanged, once, and leaves no file or variable behind", () => {
		const g = gen(prng(SEED + 4));
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-spawn-start-"));
		const saved = process.env.OMP_SPAWN_START_FILE;
		try {
			for (let run = 0; run < RUNS; run++) {
				const label = `seed ${SEED + 4} run ${run}`;
				const text = g.pick(["", '<file name="/x">', "<system-notice>\n"]) + g.text(40);
				const file = path.join(dir, `start-${run}.md`);
				fs.writeFileSync(file, text);
				process.env.OMP_SPAWN_START_FILE = file;
				expect(takeSpawnStartText(), label).toBe(text);
				expect(process.env.OMP_SPAWN_START_FILE, label).toBeUndefined();
				expect(fs.existsSync(file), label).toBe(false);
				expect(takeSpawnStartText(), label).toBeUndefined();
			}
			// A file that is already gone gives no text and still clears the variable.
			process.env.OMP_SPAWN_START_FILE = path.join(dir, "gone.md");
			expect(takeSpawnStartText()).toBeUndefined();
			expect(process.env.OMP_SPAWN_START_FILE).toBeUndefined();
		} finally {
			if (saved === undefined) delete process.env.OMP_SPAWN_START_FILE;
			else process.env.OMP_SPAWN_START_FILE = saved;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rebuilds a spawned worktree only from the full cci-wt-* label set", () => {
		const g = gen(prng(SEED + 5));
		const keys = ["cci-wt-path", "cci-wt-branch", "cci-wt-base", "cci-wt-source"] as const;
		for (let run = 0; run < RUNS; run++) {
			const full: ZmxLabels = { "cci-parent": "p" };
			for (const key of keys) full[key] = g.text(8);
			const subset: ZmxLabels = { "cci-parent": "p" };
			const kept = keys.filter(() => g.int(2) === 0);
			if (kept.length === keys.length) kept.pop();
			for (const key of kept) subset[key] = full[key]!;
			expect(worktreeFromLabels(subset), `seed ${SEED} run ${run}`).toBeUndefined();
			expect(worktreeFromLabels(full), `seed ${SEED} run ${run}`).toMatchObject({
				path: full["cci-wt-path"],
				branch: full["cci-wt-branch"],
				baseCommit: full["cci-wt-base"],
				sourceCwd: full["cci-wt-source"],
			});
		}
	});

	it("takes cci-work from the first text line after blank and tag-only lines, capped at 80 characters", () => {
		const g = gen(prng(SEED + 8));
		const noise = ["", "   ", "\t", "<system-notice>", '<file name="/tmp/a b.md">', "</file>", "  <x>  "];
		for (let run = 0; run < RUNS; run++) {
			// A text line that is never blank and never only a tag: it starts with a letter.
			const real = `w${g.text(60).replaceAll("\n", "")}`;
			const before = Array.from({ length: g.int(4) }, () => g.pick(noise));
			const after = Array.from({ length: g.int(3) }, () => g.text(10));
			const work = [...before, real, ...after].join("\n");
			const got = spawnWorkText(work);
			const label = `seed ${SEED + 8} run ${run}: ${JSON.stringify(work)}`;
			const line = real.trim();
			const lineChars = Array.from(line).length;
			expect(line.startsWith(got), label).toBe(true);
			expect(Array.from(got).length, label).toBe(Math.min(80, lineChars));
			if (lineChars <= 80) expect(got, label).toBe(line);
			expect(got.includes("\n"), label).toBe(false);
		}
		expect(spawnWorkText(undefined)).toBe("");
		expect(spawnWorkText(noise.join("\n"))).toBe("");
	});
});
