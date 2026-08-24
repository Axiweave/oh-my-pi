/**
 * IDE selection state.
 *
 * Listens for `selection_changed` notifications from the `ide` MCP server
 * (the active IDE's integration — e.g. the `claude-code-ide.el` Emacs
 * package) and stores the latest selection for injection into the next
 * provider request. Line numbers come from the IDE payload directly
 * (1-based), so `lineEnd` needs no derivation.
 */
import type { MCPManager } from "./manager";

export interface IDESelection {
	lineStart: number;
	lineEnd: number;
	text: string;
	filePath: string;
}

let currentSelection: IDESelection | null = null;
/** Path of the file the cursor is currently in, independent of whether there's a selection. */
let currentFile: string | null = null;

/** The latest IDE selection, or null when no selection is active. */
export function getCurrentIdeSelection(): IDESelection | null {
	return currentSelection;
}

/** The file path backing the latest notification, even when there's no active selection. */
export function getCurrentIdeFile(): string | null {
	return currentFile;
}

/** Clear the stored selection (used by tests and on teardown). */
export function clearIdeSelection(): void {
	currentSelection = null;
	currentFile = null;
}

function applySelectionChanged(params: unknown): void {
	if (typeof params !== "object" || params === null) {
		currentSelection = null;
		currentFile = null;
		return;
	}
	const p = params as {
		selection?: {
			start?: { line?: number; character?: number };
			end?: { line?: number; character?: number };
			isEmpty?: boolean;
		} | null;
		text?: string;
		filePath?: string;
	};
	if (typeof p.filePath === "string") {
		currentFile = p.filePath.length > 0 ? p.filePath : null;
	}
	const sel = p.selection;
	if (!sel || sel.isEmpty === true || typeof sel.start?.line !== "number" || typeof sel.end?.line !== "number") {
		// Emacs `isEmpty: true` and VS Code `selection: null` both mean "no selection".
		currentSelection = null;
		return;
	}
	currentSelection = {
		lineStart: sel.start.line,
		lineEnd: sel.end.line,
		text: p.text ?? "",
		filePath: p.filePath ?? "",
	};
}

/**
 * Register the `selection_changed` listener on an MCP manager.
 * Returns an unsubscribe function.
 */
export function subscribeIdeSelection(manager: MCPManager): () => void {
	return manager.addNotificationListener((serverName, method, params) => {
		if (serverName === "ide" && method === "selection_changed") {
			applySelectionChanged(params);
		}
	});
}
