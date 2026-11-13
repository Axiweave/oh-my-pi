/**
 * Child `omp` launch shared by `/fork pane|window` and `/spawn`: the parent's
 * configuration flags plus its live profile, model profile, model, thinking
 * level, and prompt-cache key, and the non-secret scope env that pins the
 * child to the parent's config.
 */
import * as path from "node:path";
import { getActiveProfile, getConfigDirName } from "@oh-my-pi/pi-utils/dirs";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { flagConsumesValue, restartArgv } from "./flag-tables";

/**
 * Startup flags the fork child re-supplies from the parent's live state
 * (`--profile`, `--model-profile`, `--model`, `--thinking`, `--prompt-cache-key`) or that would
 * re-point it at a stale scope (`--config`/`--cwd`/`--provider`; the child
 * gets the effective overlays via `PI_CONFIG_FILES` and the session cwd).
 * `--master` is dropped: a child is a session the user steers, not a second master.
 */
const FORK_LAUNCH_OVERRIDES: Readonly<Record<string, true>> = {
	"--config": true,
	"--cwd": true,
	"--master": true,
	"--model": true,
	"--model-profile": true,
	"--profile": true,
	"--prompt-cache-key": true,
	"--provider": true,
	"--thinking": true,
};

function hasForkApiKeyOverride(argv: string[]): boolean {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--api-key" || arg.startsWith("--api-key=")) return true;
		if (flagConsumesValue(arg, argv[i + 1])) i++;
	}
	return false;
}

/**
 * `env` prefix pinning each scope variable for the fork child. Multiplexer
 * servers keep stale environment snapshots, so every variable is pinned:
 * defined values are assigned, absent ones are unset with `-u` (which must
 * precede the assignments) rather than exported as empty strings that
 * `??`-style consumers would treat as a set, relative path.
 */
export function forkScopeEnvCommand(scope: Readonly<Record<string, string | undefined>>): string[] {
	const unset: string[] = [];
	const assignments: string[] = [];
	for (const [name, value] of Object.entries(scope)) {
		if (value) assignments.push(`${name}=${value}`);
		else unset.push("-u", name);
	}
	return ["env", ...unset, ...assignments];
}

export interface ForkChildLaunchOptions {
	session: Pick<AgentSession, "model" | "agent" | "sessionId" | "configuredThinkingLevel" | "activeModelProfile">;
	sessionManager: Pick<SessionManager, "getHeader">;
	settings: Pick<Settings, "getAgentDir" | "getConfigFiles">;
	/** Session file the child forks; appended last as `--fork <file>`. */
	forkSessionFile?: string;
	/** `provider/id` that replaces the `--model` value taken from `session.model`. */
	model?: string;
	/** Parent launch argv (default: this process). */
	argv?: string[];
	/** Parent environment (default: `process.env`). */
	environment?: NodeJS.ProcessEnv;
	getActiveProfile?: () => string | undefined;
	resolveCliEntryCmd?: () => string[];
}

export interface ForkChildLaunch {
	/** Full child command: the CLI entry plus its arguments. */
	argv: string[];
	/** Scope variables; `undefined` means unset in the child. */
	env: Record<string, string | undefined>;
	/** The parent started with `--api-key`, which the child command would expose. */
	apiKeyOverride: boolean;
}

/** Refusal for a parent started with `--api-key`, which a child command line would expose. */
export const FORK_API_KEY_REFUSAL =
	"Cannot open a fork in another terminal when --api-key was supplied at startup; the key cannot be forwarded without exposing it in the multiplexer command. Configure provider credentials in the auth store and retry.";

export function buildForkChildLaunch(options: ForkChildLaunchOptions): ForkChildLaunch {
	const { session, sessionManager, settings } = options;
	const environment = options.environment ?? process.env;
	const childArgs = restartArgv(options.argv ?? process.argv.slice(2), undefined, FORK_LAUNCH_OVERRIDES);
	const apiKeyOverride = hasForkApiKeyOverride(childArgs);
	const activeProfile = (options.getActiveProfile ?? getActiveProfile)();
	if (activeProfile) childArgs.push("--profile", activeProfile);
	// Without it a fresh child installs the config's startup `modelProfile`, so its role layer
	// (and status line) names a different bundle than the model `--model` forwards.
	if (session.activeModelProfile) childArgs.push("--model-profile", session.activeModelProfile);
	const activeModel = session.model;
	const model = options.model ?? (activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined);
	if (model) childArgs.push("--model", model);
	const activeThinkingLevel = session.configuredThinkingLevel();
	if (activeThinkingLevel !== undefined) childArgs.push("--thinking", activeThinkingLevel);
	// Forcing --model/--thinking marks the fork's cache shape as changed, which would
	// drop the inherited key. Automatic candidates travel in the source header;
	// forwarding them as --prompt-cache-key would bypass their model gate.
	if (session.agent.promptCacheKey !== undefined || sessionManager.getHeader()?.taskPromptCacheKey === undefined) {
		childArgs.push("--prompt-cache-key", session.agent.promptCacheKey ?? session.sessionId);
	}
	if (options.forkSessionFile !== undefined) childArgs.push("--fork", options.forkSessionFile);
	// Pin only non-secret scope variables.
	const scope: Record<string, string | undefined> = {
		PI_CODING_AGENT_DIR: settings.getAgentDir(),
		PI_CONFIG_DIR: getConfigDirName(),
		OMP_PROFILE: activeProfile,
		PI_PROFILE: activeProfile,
		PI_CONFIG_FILES: settings.getConfigFiles().join(path.delimiter),
		PI_CODING_AGENT_SESSION_DIR: environment.PI_CODING_AGENT_SESSION_DIR,
		XDG_DATA_HOME: environment.XDG_DATA_HOME,
		XDG_STATE_HOME: environment.XDG_STATE_HOME,
		XDG_CACHE_HOME: environment.XDG_CACHE_HOME,
	};
	const env: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(scope)) env[name] = value || undefined;
	return {
		argv: [...(options.resolveCliEntryCmd ?? resolveCliEntryCmd)(), ...childArgs],
		env,
		apiKeyOverride,
	};
}
