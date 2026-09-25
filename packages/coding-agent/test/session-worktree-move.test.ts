import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { buildWorktreeMoveArgumentCompletions } from "../src/slash-commands/builtin-completions";
import type { TuiSlashCommandRuntime } from "../src/slash-commands/types";
import {
	listSessionWorktrees,
	matchesWorktreeDestination,
	resolveSessionWorktree,
	resolveSessionWorktreeRoot,
} from "../src/session/session-worktree";

// Invariant: selection contains exactly the other available registered roots.
// Resolution preserves repository contents and rejects every non-root destination.
test("worktree selection conserves checkout state and enforces registered-root identity", async () => {
	const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wtmove-")));
	const main = path.join(temp, "main");
	const feature = path.join(temp, "feature space");
	const detached = path.join(temp, "detached");
	const missing = path.join(temp, "missing");
	const unrelated = path.join(temp, "unrelated");
	const git = async (...args: string[]) => {
		const result = await Bun.$`git ${args}`.quiet();
		return result.text();
	};
	try {
		await git("init", main);
		await fs.writeFile(path.join(main, "tracked"), "baseline\n");
		await git("-C", main, "add", "tracked");
		await git(
			"-C",
			main,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-m",
			"fixture",
		);
		expect((await listSessionWorktrees(main)).destinations).toEqual([]);
		await git("-C", main, "worktree", "add", "-b", "FeatureOne", feature);
		expect((await listSessionWorktrees(main)).destinations.map(item => item.path)).toEqual([feature]);
		await git("-C", main, "worktree", "add", "--detach", detached, "HEAD");
		await git("-C", main, "worktree", "add", "--detach", missing, "HEAD");
		await fs.rm(missing, { recursive: true });
		await git("init", unrelated);
		const nested = path.join(main, "nested");
		await fs.mkdir(nested);
		await fs.mkdir(path.join(feature, "nested"));
		await fs.symlink(feature, path.join(temp, "alias"), "dir");
		await fs.writeFile(path.join(main, "tracked"), "dirty source\n");
		await fs.writeFile(path.join(feature, "untracked"), "destination data\n");
		const before = await git("-C", main, "status", "--porcelain");
		const refs = await git("-C", main, "show-ref");
		const { currentRoot, destinations } = await listSessionWorktrees(nested);
		expect(currentRoot).toBe(main);
		expect(destinations.map(item => item.path).sort()).toEqual([detached, feature].sort());
		expect(destinations.find(item => item.path === detached)?.label).toBe("Detached HEAD");
		for (const query of ["featureone", "FEATUREONE", "AtUrEoNe", "feature space"]) {
			expect(destinations.filter(item => matchesWorktreeDestination(item, query)).map(item => item.path)).toEqual([
				feature,
			]);
		}
		expect(destinations.filter(item => matchesWorktreeDestination(item, "absent"))).toEqual([]);
		expect(destinations.filter(item => matchesWorktreeDestination(item, ""))).toEqual(destinations);
		for (const input of [feature, '"../feature space"', path.join(temp, "alias")]) {
			expect(await resolveSessionWorktree(main, input)).toBe(feature);
		}
		expect(await resolveSessionWorktree(nested, main)).toBeUndefined();
		expect((await listSessionWorktrees(feature)).destinations.map(item => item.path).sort()).toEqual(
			[detached, main].sort(),
		);
		for (const input of [unrelated, missing, nested, path.join(feature, "nested"), path.join(main, "tracked")]) {
			await expect(resolveSessionWorktree(main, input)).rejects.toThrow();
		}
		await expect(listSessionWorktrees(temp)).rejects.toThrow("Git repository");
		expect(await git("-C", main, "status", "--porcelain")).toBe(before);
		expect(await git("-C", main, "show-ref")).toBe(refs);
		expect(await fs.readFile(path.join(main, "tracked"), "utf8")).toBe("dirty source\n");
		expect(await fs.readFile(path.join(feature, "untracked"), "utf8")).toBe("destination data\n");
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
});

// Invariant: a picker-confirmed root is validated exactly, with no trim,
// quote-stripping, or Unicode-space normalization, so a root that differs from
// another registered root only by trailing or Unicode whitespace keeps its own
// identity: it never resolves to the other root.
test("picker-confirmed roots keep exact trailing-space and Unicode-space identity", async () => {
	const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wtmove-exact-")));
	const main = path.join(temp, "main");
	const plain = path.join(temp, "one");
	const trailingSpace = path.join(temp, "one ");
	const nbsp = path.join(temp, "one\u00a0");
	const git = async (...args: string[]) => {
		const result = await Bun.$`git ${args}`.quiet();
		return result.text();
	};
	try {
		await git("init", main);
		await fs.writeFile(path.join(main, "tracked"), "baseline\n");
		await git("-C", main, "add", "tracked");
		await git(
			"-C",
			main,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-m",
			"fixture",
		);
		// The native parser must recognize this root before a trimmed-name sibling exists.
		await git("-C", main, "worktree", "add", "--detach", nbsp, "HEAD");
		expect(await resolveSessionWorktreeRoot(main, nbsp)).toBe(nbsp);
		expect(await resolveSessionWorktree(main, `"${nbsp}"`)).toBe(nbsp);
		expect((await listSessionWorktrees(nbsp)).destinations.map(item => item.path)).toEqual([main]);
		await git("-C", main, "worktree", "add", "--detach", plain, "HEAD");
		await git("-C", main, "worktree", "add", "--detach", trailingSpace, "HEAD");
		const destinations = (await listSessionWorktrees(main)).destinations.map(item => item.path).sort();
		expect(destinations).toEqual([nbsp, plain, trailingSpace].sort());
		// Each root resolves to itself, not to a lookalike registered under a
		// trimmed or Unicode-normalized name.
		for (const root of [plain, trailingSpace, nbsp]) {
			expect(await resolveSessionWorktreeRoot(main, root)).toBe(root);
			expect(await resolveSessionWorktree(main, `"${root}"`)).toBe(root);
			const repository = vcs.git(root)!;
			const gitDir = (await git("-C", root, "rev-parse", "--absolute-git-dir")).replace(/\r?\n$/, "");
			expect(repository.info().gitDir).toBe(gitDir);
			expect(await repository.headSha()).toBe((await git("-C", root, "rev-parse", "HEAD")).replace(/\r?\n$/, ""));
		}
		await fs.rm(trailingSpace, { recursive: true });
		await expect(resolveSessionWorktreeRoot(main, trailingSpace)).rejects.toThrow("unavailable");
		expect(await resolveSessionWorktreeRoot(main, plain)).toBe(plain);
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
});

// Invariant: outside a Git checkout, the repository requirement is reported
// before the explicit target is resolved, so both an existing and a missing
// target report the same repository-required error, not a target-specific one.
test("explicit resolution outside a Git checkout reports the repository requirement first", async () => {
	const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wtmove-norepo-")));
	const existingTarget = path.join(temp, "existing-target");
	const missingTarget = path.join(temp, "missing-target");
	try {
		await fs.mkdir(existingTarget);
		await expect(resolveSessionWorktree(temp, existingTarget)).rejects.toThrow("Git repository");
		await expect(resolveSessionWorktree(temp, missingTarget)).rejects.toThrow("Git repository");
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
});

// Invariant: unrelated matches cannot hide the distinguishing parts of sibling paths.
test("mixed-prefix worktree completion keeps siblings distinguishable in the editor", async () => {
	const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wtmove-completion-")));
	const main = path.join(temp, "main");
	const git = async (...args: string[]) => {
		await Bun.$`git ${args}`.quiet();
	};
	try {
		await git("init", main);
		await git(
			"-C",
			main,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--allow-empty",
			"-m",
			"fixture",
		);
		const runtime = { ctx: { sessionManager: { getCwd: () => main } } } as unknown as TuiSlashCommandRuntime;
		const complete = buildWorktreeMoveArgumentCompletions(runtime);
		expect(await complete("")).toBeNull();
		await git("-C", main, "worktree", "add", "--detach", path.join(temp, "other"), "HEAD");
		for (const length of [0, 32, 168]) {
			const roots = ["alpha", "beta"].map(name =>
				path.join(temp, `siblings-${"x".repeat(length)}-${name}${length === 168 ? " " : ""}`),
			);
			for (const root of roots) await git("-C", main, "worktree", "add", "--detach", root, "HEAD");
			const editor = new Editor(defaultEditorTheme);
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider(
					[{ name: "wtmove", description: "Move", getArgumentCompletions: complete }],
					main,
				),
			);
			editor.setText("/wtmove");
			const updated = Promise.withResolvers<void>();
			editor.onAutocompleteUpdate = () => {
				if (editor.isShowingAutocomplete()) updated.resolve();
			};
			editor.handleInput(" ");
			await updated.promise;
			const rendered = Bun.stripANSI(editor.render(80).join("\n"));
			expect(rendered).toContain("alpha");
			expect(rendered).toContain("beta");
			editor.handleInput("\x1b[B");
			editor.handleInput("\t");
			expect(await resolveSessionWorktree(main, editor.getText().slice("/wtmove ".length))).toBe(roots[0]);
			for (const root of roots) await git("-C", main, "worktree", "remove", root);
		}
		await git("-C", main, "worktree", "remove", path.join(temp, "other"));
		// Each selected row must identify a different destination, including after scrolling.
		for (const count of [1, 4, 20]) {
			const groups = ["00", "01", "02", "03", "04", "05", "06", "…", "\u{1d538}", "\u{1d539}"];
			const roots = Array.from({ length: count }, (_, index) =>
				path.join(
					temp,
					`group-${groups[Math.floor(index / 2)]}`,
					`${"shared-".repeat(24)}${index % 2 ? "beta tree " : "alpha\u00a0tree "}`,
				),
			);
			for (const root of roots) await git("-C", main, "worktree", "add", "--detach", root, "HEAD");
			const rows = new Set<string>();
			const accepted = new Set<string>();
			for (let index = 0; index < count; index++) {
				const editor = new Editor(defaultEditorTheme);
				editor.setAutocompleteProvider(
					new CombinedAutocompleteProvider(
						[{ name: "wtmove", description: "Move", getArgumentCompletions: complete }],
						main,
					),
				);
				editor.setText("/wtmove");
				const shown = Promise.withResolvers<void>();
				editor.onAutocompleteUpdate = () => {
					if (editor.isShowingAutocomplete()) shown.resolve();
				};
				editor.handleInput(" ");
				await shown.promise;
				for (let step = 0; step < index; step++) editor.handleInput("\x1b[B");
				const selectedRow = editor
					.render(80)
					.map(line => Bun.stripANSI(line))
					.find(line => line.startsWith("> "));
				expect(selectedRow).toBeDefined();
				rows.add(selectedRow!);
				editor.handleInput("\t");
				const root = await resolveSessionWorktree(main, editor.getText().slice("/wtmove ".length));
				expect(root).toBeDefined();
				accepted.add(root!);
			}
			expect(rows.size).toBe(count);
			expect(accepted).toEqual(new Set(roots));
			for (const root of roots) await git("-C", main, "worktree", "remove", root);
		}
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
});
