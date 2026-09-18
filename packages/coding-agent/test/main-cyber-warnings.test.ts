import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const allowed = "anthropic/claude-haiku-4-5";
const excluded = "anthropic/claude-sonnet-4-5";
const modes = ["text", "json", "rpc", "acp"] as const;
type Mode = (typeof modes)[number];

/** ACP wire methods that adopt a persisted transcript (agent-client-protocol `session/*`). */
const acpAdoptOps = ["load", "resume", "fork"] as const;
type AcpAdoptOp = (typeof acpAdoptOps)[number];
const recordedSessionId = "cyber-startup";

interface LaunchOptions {
	resume?: boolean;
	operation?: AcpAdoptOp;
	recordedModel?: string;
	recordedProfile?: string;
	launchModel?: string;
	sessionCount?: number;
}

async function launch(
	mode: Mode,
	configuration: string,
	options: LaunchOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	const {
		resume = false,
		operation = "load",
		recordedModel = excluded,
		recordedProfile,
		launchModel = resume ? undefined : excluded,
		sessionCount = 1,
	} = options;
	using dir = TempDir.createSync("@omp-cyber-startup-");
	const agentDir = path.join(dir.path(), "agent");
	await Bun.write(
		path.join(agentDir, "config.yml"),
		`startup:\n  setupWizard: false\n  checkUpdate: false\nmarketplace:\n  autoUpdate: off\n${configuration}`,
	);
	const sessionFile = path.join(agentDir, "sessions", "probe", "recorded.jsonl");
	if (resume) {
		const timestamp = "2026-09-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			[
				{ type: "session", version: 3, id: recordedSessionId, timestamp, cwd: dir.path() },
				{
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp,
					model: recordedModel,
					role: "default",
					cyber: true,
					...(recordedProfile ? { profile: recordedProfile } : {}),
				},
				{
					type: "message",
					id: "user",
					parentId: "model",
					timestamp,
					message: { role: "user", content: "saved context", timestamp: 1 },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n") + "\n",
		);
	}
	const args = [
		...(mode === "acp" ? ["acp"] : mode === "text" ? ["--print"] : ["--mode", mode]),
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"--no-tools",
		"--no-lsp",
		"--session-dir",
		dir.path(),
		...(resume && mode !== "acp" ? ["--session", sessionFile] : []),
		...(launchModel ? ["--model", launchModel] : []),
	];
	const proc = Bun.spawn([process.execPath, cli, ...args], {
		cwd: dir.path(),
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_PROFILE: "",
			PI_CONFIG_FILES: "",
			ANTHROPIC_API_KEY: "test-key",
			NO_COLOR: "1",
			PI_NO_TITLE: "1",
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		// Bound a leaked child process. Protocol responses, not delays, control completion.
		timeout: 20_000,
	});
	const stderr = new Response(proc.stderr).text();
	const send = (message: object) => {
		proc.stdin.write(`${JSON.stringify(message)}\n`);
		proc.stdin.flush();
	};
	if (mode === "acp") {
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
	} else if (mode === "rpc") {
		send({ id: "state", type: "get_state" });
	} else {
		proc.stdin.end();
	}
	let stdout = "";
	try {
		let buffered = "";
		const decoder = new TextDecoder();
		// ACP requests still awaiting a response; "initialize" fans these out, and
		// stdin closes only once every one of them has resolved.
		const pendingAcpIds = new Set<number>();
		for await (const chunk of proc.stdout) {
			const text = decoder.decode(chunk, { stream: true });
			stdout += text;
			buffered += text;
			let newline: number;
			while ((newline = buffered.indexOf("\n")) >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				if (!line.trim() || mode === "text") continue;
				const frame = JSON.parse(line);
				if (mode === "acp" && frame.id === 1) {
					const method = resume ? `session/${operation}` : "session/new";
					const requestCount = resume ? 1 : sessionCount;
					for (let n = 0; n < requestCount; n++) {
						const id = 2 + n;
						pendingAcpIds.add(id);
						send({
							jsonrpc: "2.0",
							id,
							method,
							params: { cwd: dir.path(), mcpServers: [], ...(resume ? { sessionId: recordedSessionId } : {}) },
						});
					}
				} else if (mode === "acp" && pendingAcpIds.has(frame.id)) {
					expect(frame.error).toBeUndefined();
					pendingAcpIds.delete(frame.id);
					if (pendingAcpIds.size === 0) proc.stdin.end();
				} else if (mode === "rpc" && frame.id === "state") {
					expect(frame.error).toBeUndefined();
					proc.stdin.end();
				}
			}
		}
		return { stdout, stderr: await stderr, code: await proc.exited };
	} finally {
		proc.kill();
		await proc.exited;
	}
}

/** Parse an ACP process's stdout as newline-delimited JSON-RPC frames. */
function parseAcpFrames(stdout: string): Array<{ id?: unknown; result?: unknown; error?: unknown }> {
	return stdout
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
}

// Invariant: each startup substitution reaches diagnostics exactly once, while
// stdout remains response-only text or valid protocol frames. No prompts run.
describe("cyber startup diagnostics", () => {
	for (const mode of modes) {
		it(`${mode} reports the launch replacement and every changed role`, async () => {
			const result = await launch(
				mode,
				`cyberMode: true\ncyberModels: [${allowed}]\nmodelRoles:\n  default: ${allowed}\n  task: ${excluded}\n`,
			);
			expect(result.code).toBe(0);
			const warnings = result.stderr.split("\n").filter(line => /cyber/i.test(line));
			expect(warnings.filter(line => line.includes(excluded) && line.includes(allowed))).toHaveLength(1);
			expect(warnings.filter(line => line.includes("task") && line.includes(allowed))).toHaveLength(1);
			expect(new Set(warnings).size).toBe(warnings.length);
			if (mode === "text") expect(result.stdout).toBe("");
			else {
				const frames = result.stdout
					.trim()
					.split("\n")
					.map(line => JSON.parse(line));
				expect(
					frames.some(frame =>
						mode === "json"
							? frame.type === "session"
							: mode === "rpc"
								? frame.id === "state" && frame.success
								: frame.id === 2 && frame.result,
					),
				).toBe(true);
			}
		}, 30_000);

		it(`${mode} reports a recorded-on resume with configured protection off`, async () => {
			const result = await launch(
				mode,
				`cyberMode: false\ncyberModels: [${allowed}]\nmodelRoles:\n  default: ${allowed}\n`,
				{ resume: true },
			);
			expect(result.code).toBe(0);
			expect(
				result.stderr.split("\n").filter(line => line.includes(excluded) && line.includes(allowed)),
			).toHaveLength(1);
		}, 30_000);

		it(`${mode} reports invalid declaration boundaries without duplicating diagnostics`, async () => {
			for (const declaration of [[], ["missing-provider/no-model"], [allowed, allowed], 42]) {
				const result = await launch(
					mode,
					`cyberMode: true\ncyberModels: ${JSON.stringify(declaration)}\nmodelRoles:\n  default: ${allowed}\n`,
				);
				expect(result.code).toBe(0);
				expect(result.stderr).toContain("cyberModels");
				const warnings = result.stderr.split("\n").filter(line => /cyber/i.test(line));
				expect(new Set(warnings).size).toBe(warnings.length);
			}
		}, 90_000);

		it(`${mode} stays quiet when cyber mode is off`, async () => {
			const result = await launch(mode, `cyberMode: false\ncyberModels: []\nmodelRoles:\n  default: ${excluded}\n`);
			expect(result.code).toBe(0);
			expect(result.stderr).not.toMatch(/cyber/i);
		}, 30_000);
	}

	// Adoption must report the requested transcript, not its temporary session.
	describe("acp session adoption", () => {
		for (const operation of acpAdoptOps) {
			it(`reports each adopted role once via session/${operation} with configured protection on`, async () => {
				const result = await launch(
					"acp",
					`cyberMode: true\ncyberModels: [${allowed}]\nmodelRoles:\n  default: ${allowed}\n  task: ${excluded}\n`,
					{ resume: true, operation },
				);
				expect(result.code).toBe(0);
				const warnings = result.stderr.split("\n").filter(line => /cyber/i.test(line));
				// Both the recorded model and the task role need one report.
				expect(warnings.filter(line => line.includes(excluded) && line.includes(allowed))).toHaveLength(1);
				expect(warnings.filter(line => line.includes("task") && line.includes(allowed))).toHaveLength(1);
				expect(warnings.some(line => /\bdefault\b/.test(line))).toBe(false);
				expect(new Set(warnings).size).toBe(warnings.length);
				const frames = parseAcpFrames(result.stdout);
				expect(frames.some(frame => frame.id === 2 && frame.result)).toBe(true);
			}, 30_000);
		}

		for (const operation of acpAdoptOps) {
			it(`omits stale warnings via session/${operation} once the adopted model and role are already compliant`, async () => {
				const result = await launch(
					"acp",
					`cyberMode: true\ncyberModels: [${allowed}]\nmodelRoles:\n  default: ${allowed}\n  task: ${excluded}\nmodelProfiles:\n  safe:\n    default: ${allowed}\n    task: ${allowed}\n`,
					{ resume: true, operation, recordedModel: allowed, recordedProfile: "safe", launchModel: excluded },
				);
				expect(result.code).toBe(0);
				// The saved profile and model need no substitution, unlike the temporary session.
				const warnings = result.stderr.split("\n").filter(line => /cyber/i.test(line));
				expect(warnings.filter(line => line.includes("task") && line.includes(allowed))).toHaveLength(0);
				expect(warnings.filter(line => line.includes(excluded) && line.includes(allowed))).toHaveLength(0);
				expect(result.stderr).not.toContain(excluded);
				const frames = parseAcpFrames(result.stdout);
				expect(frames.some(frame => frame.id === 2 && frame.result)).toBe(true);
			}, 30_000);
		}

		it("reports the same role/model warning once per session, not deduped across two new sessions in one process", async () => {
			const result = await launch(
				"acp",
				`cyberMode: true\ncyberModels: [${allowed}]\nmodelRoles:\n  default: ${allowed}\n  task: ${excluded}\n`,
				{ sessionCount: 2 },
			);
			expect(result.code).toBe(0);
			const warnings = result.stderr.split("\n").filter(line => /cyber/i.test(line));
			// Independent sessions can legitimately report the same role/model pair.
			expect(warnings.filter(line => line.includes(excluded) && line.includes(allowed))).toHaveLength(2);
			expect(warnings.filter(line => line.includes("task") && line.includes(allowed))).toHaveLength(2);
			const frames = parseAcpFrames(result.stdout);
			expect(frames.filter(frame => (frame.id === 2 || frame.id === 3) && frame.result)).toHaveLength(2);
		}, 30_000);
	});
});
