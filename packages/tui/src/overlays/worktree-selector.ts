import {
	Ellipsis,
	padding,
	type SelectItem,
	SelectList,
	type SelectListRenderItemContext,
	type SgrMouseEvent,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../index";
import { getSelectListTheme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";

/** A worktree destination candidate: full path plus a branch or detached-state label. */
export interface WorktreeDestinationItem {
	path: string;
	label: string;
}

/** Case-insensitive substring predicate matching a destination against a query. */
export type WorktreeDestinationMatcher = (item: WorktreeDestinationItem, query: string) => boolean;

const MAX_VISIBLE = 10;

/** Escape ambiguous whitespace and controls without changing the selected path. */
export function formatWorktreePathForDisplay(rawPath: string): string {
	return JSON.stringify(rawPath)
		.slice(1, -1)
		.replace(/^ +| +$| {2,}|[^\S ]|[\u007f-\u009f]/gu, run => {
			let escaped = "";
			for (const character of run) {
				escaped += `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
			}
			return escaped;
		});
}

/**
 * Stacked row renderer: destination label on the first line, the full
 * escaped path wrapped underneath. Unlike `SelectList`'s built-in
 * description column (which needs `width > 40` to appear at all), this
 * keeps the path visible at any picker width, including the 40-column case.
 */
function renderDestinationRows(context: SelectListRenderItemContext): string[] {
	const { item, selected, width, theme } = context;
	const cursor = theme.symbols?.cursor ?? ">";
	const prefix = selected ? `${cursor} ` : padding(visibleWidth(cursor) + 1);
	const indent = padding(visibleWidth(prefix));
	const labelWidth = Math.max(1, width - visibleWidth(prefix));
	const pathWidth = Math.max(1, width - visibleWidth(indent));
	const labelRow = `${prefix}${truncateToWidth(item.label, labelWidth, Ellipsis.Omit)}`;
	const pathLines = wrapTextWithAnsi(item.description ?? "", pathWidth);
	const rows = [labelRow, ...(pathLines.length > 0 ? pathLines : [""]).map(line => `${indent}${line}`)];
	return selected ? rows.map(row => theme.selectedText(row)) : [rows[0]!, ...rows.slice(1).map(theme.description)];
}

/**
 * Searchable overlay listing existing worktree roots (`/wtmove`). Enter
 * confirms the highlighted destination path, Escape cancels with `undefined`.
 * Filtering uses the caller-supplied `matches` predicate against the branch
 * label or full path; it never selects on its own.
 */
export class WorktreeSelector extends OverlayPanel {
	#selectList: SelectList;

	constructor(
		items: readonly WorktreeDestinationItem[],
		matches: WorktreeDestinationMatcher,
		done: (path: string | undefined) => void,
	) {
		super("Move to Worktree");

		const byPath = new Map(items.map(item => [item.path, item]));
		const selectItems: SelectItem[] = items.map(item => ({
			value: item.path,
			label: item.label,
			description: formatWorktreePathForDisplay(item.path),
		}));

		this.#selectList = new SelectList(selectItems, MAX_VISIBLE, getSelectListTheme(), {
			search: "always",
			renderItem: renderDestinationRows,
			measureItem: context => renderDestinationRows(context).length,
			emptyText: "No other worktrees found",
			noMatchText: "No matching worktrees",
			filterItems: (candidates, query) => {
				if (!query.trim()) return candidates;
				return candidates.filter(candidate => {
					const source = byPath.get(candidate.value);
					return source !== undefined && matches(source, query);
				});
			},
		});

		this.#selectList.onSelect = item => done(item.value);
		this.#selectList.onCancel = () => done(undefined);

		this.addChild(this.#selectList);
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
