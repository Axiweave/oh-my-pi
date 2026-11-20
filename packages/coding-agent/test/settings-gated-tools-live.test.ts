import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InboxHost } from "@oh-my-pi/pi-coding-agent/inbox/host";
import { cfgInboxEnabled } from "@oh-my-pi/pi-coding-agent/inbox/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	__resetDirsFromEnvForTests,
	getSessionInboxDir,
	removeSyncWithRetries,
	Snowflake,
	TempDir,
} from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

import { cfgBashEnabled } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { cfgGithubEnabled, cfgGrepEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

// Tool-gating settings (`grep.enabled`, `*.enabled`, ...) must reconcile a live
// session's tools and prompt instead of waiting for the next session.
describe("settings-gated tools in a live session", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];
	const cleanups: Array<() => unknown> = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-settings-gated-tools-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(registryDir, "models.yml"));
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function startSession(
		settings: Settings,
		toolNames?: string[],
		restrictToolNames?: boolean,
	): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			workspaceTree: { rootPath: registryDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			toolNames,
			restrictToolNames,
		});
		sessions.push(session);
		return session;
	}

	/** A started inbox on a private temp registry, attached to `session` as InteractiveMode does. */
	async function attachInbox(session: AgentSession): Promise<InboxHost> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-gated-inbox-"));
		const host = new InboxHost(session, { dir, env: {} });
		cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
		cleanups.push(() => host.stop());
		await host.start();
		session.setSessionInbox(host);
		expect(host.started).toBe(true);
		return host;
	}

	/** Lets the coalesced watch fire, then waits for the reconcile it queued on the registry lock. */
	async function settle(session: AgentSession): Promise<void> {
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
	}

	const GREP_POLICY = "NEVER shell `grep`/`rg`/`awk`";

	it("removes and restores grep in the request tools and system prompt", async () => {
		const settings = Settings.isolated({});
		const session = await startSession(settings);
		expect(session.getActiveToolNames()).toContain("grep");
		expect(session.systemPrompt.join("\n")).toContain(GREP_POLICY);

		cfgGrepEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(session.getToolByName("grep")).toBeUndefined();
		expect(session.systemPrompt.join("\n")).not.toContain(GREP_POLICY);
		expect(session.getActiveToolNames()).toContain("read");

		cfgGrepEnabled.set(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).toContain("grep");
		expect(session.systemPrompt.join("\n")).toContain(GREP_POLICY);
	});

	it("never widens an explicit tool list", async () => {
		const settings = Settings.isolated({ "grep.enabled": false, "github.enabled": false });
		const session = await startSession(settings, ["read", "bash"]);
		const before = session.getActiveToolNames();
		expect(before).not.toContain("grep");

		cfgGrepEnabled.set(settings, true);
		cfgGithubEnabled.set(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).toEqual(before);
		expect(session.getToolByName("grep")).toBeUndefined();

		cfgBashEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(session.getActiveToolNames()).toContain("read");
	});

	it("keeps session_inbox inactive without a running inbox, even when a tool list names it", async () => {
		for (const toolNames of [undefined, ["read", "session_inbox"]]) {
			const session = await startSession(Settings.isolated({ "inbox.enabled": true }), toolNames);
			expect(session.getActiveToolNames(), String(toolNames)).not.toContain("session_inbox");
		}
	});

	it("never activates session_inbox for a subagent, even with a started inbox and a tool list naming it", async () => {
		const settings = Settings.isolated({ "inbox.enabled": true });
		// Control: a top-level session gets the tool once its inbox runs.
		const top = await startSession(settings);
		await attachInbox(top);
		await top.setActiveToolsByName([...top.getActiveToolNames(), "session_inbox"]);
		expect(top.getActiveToolNames()).toContain("session_inbox");

		const sub = await startSession(settings, ["read", "session_inbox"], true);
		await attachInbox(sub);
		await sub.setActiveToolsByName(["read", "session_inbox"]);
		expect(sub.getActiveToolNames()).toContain("read");
		expect(sub.getActiveToolNames()).not.toContain("session_inbox");
		expect(sub.getToolByName("session_inbox")).toBeUndefined();
	});

	it("never activates session_inbox in RPC mode, even with inbox.enabled: true in config", async () => {
		const home = TempDir.createSync("@omp-gated-inbox-rpc-");
		cleanups.push(() => home.remove());
		await Bun.write(path.join(home.path(), ".omp", "agent", "config.yml"), "inbox:\n  enabled: true\n");
		const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
		const proc = Bun.spawn(
			[process.execPath, cliEntry, "--no-title", "--no-lsp", "--no-extensions", "--no-session", "--mode", "rpc"],
			{
				cwd: home.path(),
				env: {
					PATH: process.env.PATH,
					HOME: home.path(),
					TMPDIR: process.env.TMPDIR,
					NO_COLOR: "1",
					ANTHROPIC_API_KEY: "test-key",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		cleanups.push(async () => {
			proc.kill();
			await proc.exited;
		});
		proc.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
		let text = "";
		let state: { dumpTools: Array<{ name: string }> } | undefined;
		for await (const bytes of proc.stdout) {
			text += new TextDecoder().decode(bytes);
			const line = text.split("\n").find(candidate => candidate.includes('"id":"state"'));
			if (!line) continue;
			const frame = JSON.parse(line);
			expect(frame.success, line).toBe(true);
			state = frame.data;
			break;
		}
		if (!state) throw new Error(`no get_state response: ${await new Response(proc.stderr).text()}`);
		const names = state.dumpTools.map(tool => tool.name);
		expect(names).toContain("read");
		expect(names).not.toContain("session_inbox");
		expect(fs.existsSync(path.join(home.path(), ".omp", "run", "session-inbox"))).toBe(false);
	}, 30_000);

	it("keeps session_inbox inactive in the TUI while inbox.enabled is false", async () => {
		// InteractiveMode starts its inbox on the default registry: point that at a temp home.
		const home = TempDir.createSync("@omp-gated-inbox-tui-");
		const homedir = vi.spyOn(os, "homedir").mockReturnValue(home.path());
		__resetDirsFromEnvForTests();
		cleanups.push(() => home.remove());
		cleanups.push(() => {
			homedir.mockRestore();
			__resetDirsFromEnvForTests();
		});
		// Copied from extension-session-modes.test.ts: InteractiveMode needs a theme and the global settings,
		// and init() starts a ProcessTerminal that must stay off the real terminal.
		initTheme();
		await Settings.init({ inMemory: true, cwd: home.path() });
		cleanups.push(() => {
			vi.restoreAllMocks();
			resetSettingsForTest();
		});
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}
		const inboxDir = getSessionInboxDir();
		expect(inboxDir.startsWith(home.path())).toBe(true);
		const entries = () => (fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : []);
		// The inbox sync is a private promise chain over real socket I/O, with no signal to await: poll.
		const until = async (predicate: () => boolean, label: string) => {
			const deadline = Date.now() + 5000;
			while (!predicate()) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
				await Bun.sleep(5);
			}
		};

		// Not an isolated override: overrides win over `set`, and the case toggles the setting live.
		const settings = Settings.isolated({});
		cfgInboxEnabled.set(settings, false);
		const session = await startSession(settings);
		const mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		cleanups.push(() => mode.stop());
		await mode.init();
		const active = () => session.getActiveToolNames().includes("session_inbox");
		expect(active()).toBe(false);
		expect(session.getSessionInbox()).toBeUndefined();

		// Control: the setting really drives the inbox, so the off check below is not vacuous.
		cfgInboxEnabled.set(settings, true);
		await until(() => active() && entries().length > 0, "inbox on");

		cfgInboxEnabled.set(settings, false);
		await until(() => !active() && session.getSessionInbox() === undefined, "inbox off");
		await until(() => entries().length === 0, "inbox entry removed");
	}, 20_000);
});
