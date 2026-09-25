import { expect, test } from "bun:test";
import { WorktreeSelector } from "../src/overlays/worktree-selector";
import { initTheme } from "../src/theme/theme";

// Invariant: filtering never commits a move; Enter commits only the selected path.
test("worktree overlay receives keyboard input and selects beyond the first page", async () => {
	await initTheme();
	const items = Array.from({ length: 20 }, (_, index) => ({
		path: `/tmp/worktree ${index}`,
		label: `Feature${index}`,
	}));
	const selected: Array<string | undefined> = [];
	const picker = new WorktreeSelector(
		items,
		(item, query) => item.label.toLowerCase().includes(query.toLowerCase()),
		value => selected.push(value),
	);
	for (const key of "fEaTuRe19") picker.handleInput?.(key);
	expect(selected).toEqual([]);
	picker.handleInput?.("\r");
	expect(selected).toEqual(["/tmp/worktree 19"]);
	const cancelled = new WorktreeSelector(
		items,
		() => true,
		value => selected.push(value),
	);
	cancelled.handleInput?.("\x1b");
	expect(selected).toEqual(["/tmp/worktree 19", undefined]);
});

// Invariant: SelectList's own row sanitizer collapses whitespace runs and
// trims ends; distinct raw paths that differ only by consecutive, trailing,
// or Unicode whitespace must still render as distinct rows.
test("worktree overlay renders paths that differ only by whitespace as distinct rows", async () => {
	await initTheme();
	const paths = [
		"/tmp/worktree one",
		"/tmp/worktree  one",
		"/tmp/worktree",
		"/tmp/worktree ",
		"/tmp/worktree\u00a0two",
		"/tmp/worktree\u2002two",
		"/tmp/worktree two",
		"/tmp/worktree·two",
		"/tmp/worktree\x1b",
		"/tmp/worktree\\x1b",
	];
	const rendered = paths.map(path => {
		const picker = new WorktreeSelector(
			[{ path, label: "Detached HEAD" }],
			() => true,
			() => {},
		);
		return Bun.stripANSI(picker.render(80).join("\n"));
	});
	expect(new Set(rendered).size).toBe(paths.length);
});

// Invariant: SelectList's built-in description column needs width > 40 to
// appear at all, so two destinations sharing a label would otherwise render
// identically at 40 columns. The picker's stacked renderer must keep both
// paths visible and keyboard selection/cancellation must keep working there.
test("worktree overlay keeps distinct destination paths visible at 40 columns", async () => {
	await initTheme();
	const items = [
		{ path: "/tmp/prefix/checkout-alpha", label: "Detached HEAD" },
		{ path: "/tmp/prefix/checkout-beta", label: "Detached HEAD" },
	];
	const selected: Array<string | undefined> = [];
	const picker = new WorktreeSelector(
		items,
		() => true,
		value => selected.push(value),
	);
	const text = Bun.stripANSI(picker.getSelectList().render(40).join("\n"));
	expect(text).toContain("checkout-alpha");
	expect(text).toContain("checkout-beta");

	picker.handleInput("\r");
	expect(selected).toEqual(["/tmp/prefix/checkout-alpha"]);
	const cancelled = new WorktreeSelector(
		items,
		() => true,
		value => selected.push(value),
	);
	cancelled.handleInput("\x1b");
	expect(selected).toEqual(["/tmp/prefix/checkout-alpha", undefined]);
});
