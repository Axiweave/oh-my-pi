import { beforeAll, describe, expect, it } from "bun:test";
import { HistorySearchComponent } from "@oh-my-pi/pi-coding-agent/modes/components/history-search";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { HistoryEntry, HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";

beforeAll(async () => {
	await initTheme();
});

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const TEST_CWD = "/projects/current";

function makeEntry(id: number, prompt: string, ageSeconds = 0, cwd = TEST_CWD): HistoryEntry {
	return { id, prompt, created_at: NOW_SECONDS - ageSeconds, cwd };
}

/** Minimal in-memory stand-in matching the two methods the component touches. */
function fakeStorage(entries: HistoryEntry[]): HistoryStorage {
	const tokenize = (q: string) =>
		q
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(Boolean);
	return {
		getRecent: (limit: number, cwd?: string) =>
			entries.filter(entry => cwd === undefined || entry.cwd === cwd).slice(0, limit),
		search: (query: string, limit: number, cwd?: string) => {
			const tokens = tokenize(query);
			return entries
				.filter(
					entry =>
						(cwd === undefined || entry.cwd === cwd) &&
						tokens.every(token => entry.prompt.toLowerCase().includes(token)),
				)
				.slice(0, limit);
		},
	} as unknown as HistoryStorage;
}

function render(component: HistorySearchComponent, width = 80): { raw: string; plain: string } {
	const lines = component.render(width);
	const raw = lines.join("\n");
	return { raw, plain: Bun.stripANSI(raw) };
}

function type(component: HistorySearchComponent, text: string): void {
	for (const char of text) component.handleInput(char);
}

describe("HistorySearchComponent", () => {
	it("paints the selected row with the selectedBg highlight bar and a relative timestamp", () => {
		const component = new HistorySearchComponent(
			fakeStorage([makeEntry(1, "deploy the release"), makeEntry(2, "older prompt", 7200)]),
			TEST_CWD,
			() => {},
			() => {},
		);

		const { raw, plain } = render(component);

		expect(plain).toContain("deploy the release");
		// First (default-selected) row carries the selection background.
		const selectedRow = raw.split("\n").find(line => line.includes("deploy the release"));
		expect(selectedRow).toContain(theme.getBgAnsi("selectedBg"));
		// Fresh entry renders the compact "now" age marker.
		expect(plain).toContain("now");
	});

	it("highlights the matched query tokens within results", () => {
		const component = new HistorySearchComponent(
			fakeStorage([makeEntry(1, "deploy the needle rollback"), makeEntry(2, "routine status update")]),
			TEST_CWD,
			() => {},
			() => {},
		);

		type(component, "needle");

		const { raw, plain } = render(component);
		expect(plain).toContain("deploy the needle rollback");
		expect(plain).not.toContain("routine status update");
		// The matched substring is wrapped in the accent color.
		expect(raw).toContain(theme.fg("accent", "needle"));
	});

	it("distinguishes an empty query from an unmatched query", () => {
		const empty = new HistorySearchComponent(
			fakeStorage([]),
			TEST_CWD,
			() => {},
			() => {},
		);
		expect(render(empty).plain).toContain("No history yet");

		const unmatched = new HistorySearchComponent(
			fakeStorage([makeEntry(1, "deploy the release")]),
			TEST_CWD,
			() => {},
			() => {},
		);
		type(unmatched, "zzzz");
		expect(render(unmatched).plain).toContain("No matching history");
	});

	it("toggles scopes with Tab without changing the query", () => {
		const component = new HistorySearchComponent(
			fakeStorage([
				makeEntry(1, "deploy current service"),
				makeEntry(2, "deploy other service", 0, "/projects/other"),
				makeEntry(3, "unrelated global prompt", 0, "/projects/other"),
			]),
			TEST_CWD,
			() => {},
			() => {},
		);
		type(component, "deploy");

		const local = render(component).plain;
		expect(local).toContain("History (current folder)");
		expect(local).toContain("deploy current service");
		expect(local).not.toContain("deploy other service");
		expect(local).toContain("tab all projects");

		component.handleInput("\t");
		const global = render(component).plain;
		expect(global).toContain("History (all projects)");
		expect(global).toContain("deploy current service");
		expect(global).toContain("deploy other service");
		expect(global).not.toContain("unrelated global prompt");
		expect(global).toContain("tab current folder");

		component.handleInput("\t");
		const localAgain = render(component).plain;
		expect(localAgain).toContain("History (current folder)");
		expect(localAgain).toContain("deploy current service");
		expect(localAgain).not.toContain("deploy other service");
		expect(localAgain).toContain("tab all projects");
	});
});
