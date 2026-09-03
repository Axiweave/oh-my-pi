import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | null = null;

async function freshStorage(): Promise<HistoryStorage> {
	tempDir = TempDir.createSync("@omp-history-search-");
	HistoryStorage.close();
	return HistoryStorage.open(tempDir.join("history.db"));
}

async function seed(storage: HistoryStorage, prompts: string[]): Promise<void> {
	const writes = prompts.map(prompt => storage.add(prompt, "/tmp/test"));
	vi.advanceTimersByTime(100);
	await Promise.all(writes);
}

beforeEach(() => {
	HistoryStorage.close();
	vi.useFakeTimers();
});

afterEach(async () => {
	HistoryStorage.close();
	vi.useRealTimers();
	if (tempDir) {
		await Bun.sleep(0);
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("HistoryStorage.search", () => {
	it("matches across punctuation in the query (FTS token alignment)", async () => {
		const storage = await freshStorage();
		await seed(storage, ["run git commit --amend now", "unrelated noise"]);

		// Before the tokenization fix, `git-commit` produced a single FTS phrase
		// `"git-commit"*` which matched nothing because unicode61 indexed the stored
		// prompt as `git` and `commit` separately.
		const results = storage.search("git-commit", 10);
		expect(results.map(r => r.prompt)).toEqual(["run git commit --amend now"]);
	});

	it("falls back to substring matching for infix queries FTS prefix cannot reach", async () => {
		const storage = await freshStorage();
		await seed(storage, ["run git commit later", "totally unrelated text"]);

		// FTS5 `*` is prefix-only — `mit` cannot match `commit` via FTS.
		// Substring fallback must catch it.
		const results = storage.search("mit", 10);
		expect(results.map(r => r.prompt)).toEqual(["run git commit later"]);
	});

	it("AND's substring tokens so multi-word infix queries narrow results", async () => {
		const storage = await freshStorage();
		await seed(storage, [
			"commit and amend the patch",
			"commit only without the other",
			"amend only without the other",
		]);

		// Each token must appear (as substring). `mit` is infix of `commit`, so FTS
		// returns nothing; substring fallback must AND both tokens.
		const results = storage.search("mit amend", 10);
		expect(results.map(r => r.prompt)).toEqual(["commit and amend the patch"]);
	});

	it("returns merged FTS and substring fallback matches by recency", async () => {
		const storage = await freshStorage();
		// Insert oldest -> newest. The newest row is substring-only; it must not
		// be pushed behind older FTS prefix matches in Ctrl+R results.
		await seed(storage, ["commit the changes", "precommit hook fix"]);

		const results = storage.search("commit", 10);
		expect(results.map(r => r.prompt)).toEqual([
			"precommit hook fix", // substring-only (`commit` is infix of `precommit`)
			"commit the changes", // FTS prefix match on token `commit`
		]);
	});

	it("dedupes when FTS and substring both match the same row", async () => {
		const storage = await freshStorage();
		await seed(storage, ["commit the changes"]);

		const results = storage.search("commit", 10);
		expect(results).toHaveLength(1);
		expect(results[0]?.prompt).toBe("commit the changes");
	});

	it("matches case-insensitively for substring fallback", async () => {
		const storage = await freshStorage();
		await seed(storage, ["Recommit The Patch"]);

		const results = storage.search("MIT", 10);
		expect(results.map(r => r.prompt)).toEqual(["Recommit The Patch"]);
	});

	it("returns empty for queries with no alphanumeric characters", async () => {
		const storage = await freshStorage();
		await seed(storage, ["whatever"]);

		expect(storage.search("---", 10)).toEqual([]);
		expect(storage.search("  ", 10)).toEqual([]);
	});

	it("respects the limit after globally sorting merged FTS and substring results", async () => {
		const storage = await freshStorage();
		await seed(storage, ["commit one", "commit two", "precommit three", "precommit four"]);

		const results = storage.search("commit", 2);
		expect(results).toHaveLength(2);
		expect(results.map(r => r.prompt)).toEqual(["precommit four", "precommit three"]);
	});

	it("matches short tokens via the substring fallback", async () => {
		const storage = await freshStorage();
		await seed(storage, ["go run main", "node script"]);

		// Defends short-query (<= 2 char) matching end-to-end.
		const results = storage.search("go", 10);
		expect(results.map(r => r.prompt)).toEqual(["go run main"]);
	});

	it("AND's tokens correctly when one is short and one is an infix", async () => {
		const storage = await freshStorage();
		await seed(storage, ["go commit changes", "go run main", "commit changes"]);

		// `go` matches via FTS, `mit` only matches via substring (infix of commit).
		// Combined: only `go commit changes` satisfies both as substrings.
		const results = storage.search("go mit", 10);
		expect(results.map(r => r.prompt)).toEqual(["go commit changes"]);
	});

	describe("project scope", () => {
		it("returns only prompts associated with the normalized current folder", async () => {
			const storage = await freshStorage();
			await storage.add("current folder prompt", "/projects/current/./");
			await storage.add("other folder prompt", "/projects/other");
			await storage.add("prompt without a folder");

			expect(storage.getRecent(10, "/projects/current")).toEqual([
				expect.objectContaining({
					prompt: "current folder prompt",
					cwd: "/projects/current",
				}),
			]);
		});

		it("keeps prefix and token-AND substring matching inside one folder", async () => {
			const storage = await freshStorage();
			await storage.add("commit and amend current", "/projects/current");
			await storage.add("commit only current", "/projects/current");
			await storage.add("commit and amend other", "/projects/other");

			expect(storage.search("com", 10, "/projects/current").map(entry => entry.prompt)).toEqual([
				"commit only current",
				"commit and amend current",
			]);
			expect(storage.search("mit amend", 10, "/projects/current").map(entry => entry.prompt)).toEqual([
				"commit and amend current",
			]);
		});

		it("uses location recency and retains shared prompts in every folder", async () => {
			const storage = await freshStorage();
			await storage.add("shared prompt", "/projects/a/./", "a-session");
			await storage.add("other local prompt", "/projects/a", "other-session");
			await storage.add("shared prompt", "/projects/b", "b-session");
			if (!tempDir) throw new Error("temporary history directory is unavailable");
			const db = new Database(tempDir.join("history.db"));
			try {
				const update = db.prepare("UPDATE history_locations SET created_at = ? WHERE prompt = ? AND cwd = ?");
				update.run(30, "shared prompt", "/projects/a");
				update.run(20, "other local prompt", "/projects/a");
				update.run(40, "shared prompt", "/projects/b");
			} finally {
				db.close();
			}

			expect(storage.getRecent(1, "/projects/a/../a")).toEqual([
				expect.objectContaining({
					prompt: "shared prompt",
					created_at: 30,
					cwd: "/projects/a",
					sessionId: "a-session",
				}),
			]);
			expect(storage.getRecent(10, "/projects/b").map(entry => entry.prompt)).toEqual(["shared prompt"]);

			const globalShared = storage.getRecent(10).filter(entry => entry.prompt === "shared prompt");
			expect(globalShared).toHaveLength(1);
			expect(globalShared[0]).toMatchObject({
				cwd: "/projects/b",
				sessionId: "b-session",
			});
		});
	});
});
