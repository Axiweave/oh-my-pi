/**
 * `/wt` backing: fork the current checkout into a fresh linked git worktree on
 * a new branch, carrying the uncommitted changes along, so the session can be
 * relocated there without disturbing the original checkout.
 *
 * The worktree is created through the clone-first path (`worktree.clone`,
 * `isolation.backend`) and lands under the agent-managed worktree base
 * (`worktree.base`, default `~/.omp/wt`) next to `github pr_checkout` trees,
 * so `omp worktree list|clear` sees it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IsoBackendKind, VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getWorktreeDir, hashPath, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { formatIsolationBackend, parseIsolationBackend } from "../task/worktree";
import { resolveAvailableWorktreePath } from "../tools/gh-pr-checkout";
import { expandTilde, stripOuterDoubleQuotes } from "../tools/path-utils";

export interface SessionWorktree {
	/** Absolute, realpath'd worktree root. */
	path: string;
	/** Branch checked out in the worktree (created from the source `HEAD`). */
	branch: string;
	/** Backend that cloned the checkout, or undefined for a plain checkout. */
	clonedWith?: IsoBackendKind;
	/** Why the clone fell back to a plain checkout, when it did. */
	cloneError?: string;
}

/** Default `/wt` branch name: `wt/<yyyymmdd-hhmmss>`. */
export function defaultSessionWorktreeBranch(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `wt/${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** One-line confirmation shown after the session moved into `worktree`. */
export function formatSessionWorktreeSummary(worktree: SessionWorktree, sourceCleaned = false): string {
	const how =
		worktree.clonedWith === undefined ? "checked out" : `cloned via ${formatIsolationBackend(worktree.clonedWith)}`;
	const changeStatus = sourceCleaned
		? "uncommitted changes moved, source checkout cleaned"
		: "uncommitted changes carried over";
	return `Moved to worktree ${worktree.path} on branch ${worktree.branch} (${how}, ${changeStatus}).`;
}

/**
 * If `worktree.cleanSource` is enabled, resets and cleans the source checkout.
 * Catches git errors and returns `{ cleaned: true }` on success, or `{ cleaned: false, errorMessage }` on failure.
 */
export async function cleanSourceCheckoutIfConfigured(
	sourceCwd: string,
	settings: Settings,
): Promise<{ cleaned: boolean; errorMessage?: string }> {
	if (!settings.get("worktree.cleanSource")) {
		return { cleaned: false };
	}
	try {
		const repository = vcs.requireGit(sourceCwd);
		await repository.reset("hard", "HEAD");
		await repository.clean({});
		return { cleaned: true };
	} catch (error) {
		logger.warn("failed to clean source checkout after /wt", { cwd: sourceCwd, error });
		return {
			cleaned: false,
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	}
}
/**
 * Create the worktree for `/wt`. Throws with a user-facing message when `cwd`
 * is not a git checkout, `branch` already exists, or git refuses.
 */
export async function createSessionWorktree(cwd: string, settings: Settings, branch: string): Promise<SessionWorktree> {
	try {
		await settings.flush();
	} catch (err) {
		throw new Error(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
	}
	const repository = vcs.git(cwd);
	if (!repository) {
		throw new Error(`Not inside a git repository: ${cwd}`);
	}
	if (!/^[^\s~^:?*[\\]+$/.test(branch) || branch.startsWith("-") || branch.endsWith("/") || branch.includes("..")) {
		throw new Error(`Invalid branch name: ${branch}`);
	}
	const branchRef = `refs/heads/${branch}`;
	if (await repository.refExists(branchRef)) {
		throw new Error(`Branch '${branch}' already exists; pick another name.`);
	}
	const primaryRoot = repository.primaryRoot() ?? repository.info().repoRoot;
	const slug = branch.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
	const basePath = getWorktreeDir(`${slug}-${hashPath(primaryRoot)}`);
	const worktreePath = await resolveAvailableWorktreePath(basePath, await repository.worktrees());
	await fs.mkdir(path.dirname(worktreePath), { recursive: true });

	await repository.createBranch(branch, "HEAD", false);
	const result = await repository.worktreeAdd(worktreePath, branch, {
		detach: false,
		clone: settings.get("worktree.clone"),
		backend: parseIsolationBackend(settings.get("isolation.backend")),
		keepChanges: true,
	});
	return {
		path: await fs.realpath(worktreePath),
		branch,
		clonedWith: result.clonedWith ?? undefined,
		cloneError: result.cloneError ?? undefined,
	};
}

export interface WorktreeDestination {
	path: string;
	label: string;
}

/** Discover the repository that owns `cwd`, or throw when it is outside Git. */
function requireSessionRepository(cwd: string): VcsGitRepo {
	const repository = vcs.git(cwd);
	if (!repository) throw new Error("Worktree selection requires a Git repository.");
	return repository;
}

/** Enumerate `source`'s registered worktree roots, excluding the current checkout. */
async function collectWorktreeDestinations(
	source: VcsGitRepo,
): Promise<{ currentRoot: string; destinations: WorktreeDestination[] }> {
	const currentRoot = await fs.realpath(source.info().repoRoot);
	const destinations: WorktreeDestination[] = [];
	const seen = new Set<string>([currentRoot]);
	for (const entry of await source.worktrees()) {
		let root: string;
		try {
			root = await fs.realpath(entry.path);
			if (!(await fs.stat(root)).isDirectory()) continue;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") continue;
			throw error;
		}
		if (seen.has(root)) continue;
		seen.add(root);
		destinations.push({
			path: root,
			label: entry.detached ? "Detached HEAD" : (entry.branch?.replace(/^refs\/heads\//, "") ?? "Detached HEAD"),
		});
	}
	destinations.sort((a, b) => a.path.localeCompare(b.path));
	return { currentRoot, destinations };
}

/** Discover registered destinations relative to the live session checkout. */
export async function listSessionWorktrees(
	cwd: string,
): Promise<{ currentRoot: string; destinations: WorktreeDestination[] }> {
	return collectWorktreeDestinations(requireSessionRepository(cwd));
}

export function matchesWorktreeDestination(destination: WorktreeDestination, query: string): boolean {
	const search = stripOuterDoubleQuotes(query.trim()).toLowerCase();
	return destination.label.toLowerCase().includes(search) || destination.path.toLowerCase().includes(search);
}

/**
 * Validate a resolved `root` against `source`'s registered worktrees. Shared
 * by the explicit-argument and exact-selection resolvers below; `label` is
 * only used for error text and never re-parsed.
 */
async function validateWorktreeRoot(source: VcsGitRepo, root: string, label: string): Promise<string | undefined> {
	const { currentRoot, destinations } = await collectWorktreeDestinations(source);
	if (root === currentRoot) return undefined;
	if (!destinations.some(destination => destination.path === root)) {
		throw new Error(`Not an available worktree root of this repository: ${label}`);
	}
	const target = vcs.git(root);
	if (
		!target ||
		(await fs.realpath(target.info().repoRoot)) !== root ||
		(await fs.realpath(target.primaryRoot() ?? target.info().repoRoot)) !==
			(await fs.realpath(source.primaryRoot() ?? source.info().repoRoot))
	) {
		throw new Error(`Worktree registration no longer matches the directory: ${label}`);
	}
	return root;
}

/**
 * Parse an explicit `/wtmove <path>` argument (quotes, `~`, relative forms)
 * and validate it. Returns a registered root, or `undefined` when the
 * requested checkout is current. Check the source repository before resolving
 * the target so a missing target cannot hide the repository requirement.
 */
export async function resolveSessionWorktree(cwd: string, input: string): Promise<string | undefined> {
	const unquoted = stripOuterDoubleQuotes(input.trim());
	if (!unquoted) throw new Error("Usage: /wtmove <path>");
	const source = requireSessionRepository(cwd);
	const requested = path.resolve(cwd, expandTilde(unquoted));
	let root: string;
	try {
		root = await fs.realpath(requested);
	} catch {
		throw new Error(`Worktree directory is unavailable: ${requested}`);
	}
	return validateWorktreeRoot(source, root, requested);
}

/**
 * Validate an already-canonical worktree root, such as a picker selection.
 * Unlike {@link resolveSessionWorktree}, `root` is used exactly as given: no
 * trim, quote-stripping, or Unicode-space normalization, so a root that
 * differs from another registered root only by trailing or Unicode
 * whitespace keeps its own identity instead of colliding with it.
 */
export async function resolveSessionWorktreeRoot(cwd: string, root: string): Promise<string | undefined> {
	const source = requireSessionRepository(cwd);
	let realRoot: string;
	try {
		realRoot = await fs.realpath(root);
	} catch {
		throw new Error(`Worktree directory is unavailable: ${root}`);
	}
	return validateWorktreeRoot(source, realRoot, root);
}
