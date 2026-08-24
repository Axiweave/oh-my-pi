import { afterEach, describe, expect, it } from "bun:test";
import {
	clearIdeSelection,
	getCurrentIdeFile,
	getCurrentIdeSelection,
	subscribeIdeSelection,
} from "@oh-my-pi/pi-coding-agent/mcp/ide-selection";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";

/** Minimal stand-in for MCPManager that captures the registered listener. */
function fakeManager(): { manager: MCPManager; fire: (server: string, method: string, params: unknown) => void } {
	let listener: ((server: string, method: string, params: unknown) => void) | undefined;
	const manager = {
		addNotificationListener: (fn: (server: string, method: string, params: unknown) => void) => {
			listener = fn;
			return () => {
				listener = undefined;
			};
		},
	} as unknown as MCPManager;
	return {
		manager,
		fire: (server, method, params) => listener?.(server, method, params),
	};
}

describe("IDE selection listener", () => {
	afterEach(() => {
		clearIdeSelection();
	});

	it("stores an Emacs selection_changed payload with 1-based lines", () => {
		const { manager, fire } = fakeManager();
		const unsubscribe = subscribeIdeSelection(manager);
		fire("ide", "selection_changed", {
			selection: { start: { line: 10, character: 4 }, end: { line: 12, character: 7 }, isEmpty: false },
			text: "abc",
			filePath: "/a/foo.el",
		});
		expect(getCurrentIdeSelection()).toEqual({ lineStart: 10, lineEnd: 12, text: "abc", filePath: "/a/foo.el" });
		unsubscribe();
	});

	it("clears on isEmpty selection (cursor position, no region)", () => {
		const { manager, fire } = fakeManager();
		subscribeIdeSelection(manager);
		fire("ide", "selection_changed", {
			selection: { start: { line: 3, character: 1 }, end: { line: 3, character: 1 }, isEmpty: true },
			text: "",
			filePath: "/a/foo.el",
		});
		expect(getCurrentIdeSelection()).toBeNull();
	});

	it("keeps the current file when the selection is empty (cursor position, no region)", () => {
		const { manager, fire } = fakeManager();
		subscribeIdeSelection(manager);
		fire("ide", "selection_changed", {
			selection: { start: { line: 3, character: 1 }, end: { line: 3, character: 1 }, isEmpty: true },
			text: "",
			filePath: "/a/foo.el",
		});
		expect(getCurrentIdeFile()).toBe("/a/foo.el");
	});

	it("updates the current file as the cursor moves between files, still without a selection", () => {
		const { manager, fire } = fakeManager();
		subscribeIdeSelection(manager);
		fire("ide", "selection_changed", {
			selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 }, isEmpty: true },
			text: "",
			filePath: "/a/foo.el",
		});
		fire("ide", "selection_changed", {
			selection: { start: { line: 5, character: 0 }, end: { line: 5, character: 0 }, isEmpty: true },
			text: "",
			filePath: "/a/bar.el",
		});
		expect(getCurrentIdeFile()).toBe("/a/bar.el");
	});

	it("clears the current file for an empty filePath (no-file buffer)", () => {
		const { manager, fire } = fakeManager();
		subscribeIdeSelection(manager);
		fire("ide", "selection_changed", {
			selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 }, isEmpty: true },
			text: "",
			filePath: "",
		});
		expect(getCurrentIdeFile()).toBeNull();
	});

	it("clears on a null selection (VS Code shape)", () => {
		const { manager, fire } = fakeManager();
		subscribeIdeSelection(manager);
		fire("ide", "selection_changed", { selection: null, text: "", filePath: "/a/foo.el" });
		expect(getCurrentIdeSelection()).toBeNull();
	});

	it("ignores notifications from other servers and methods", () => {
		const { manager, fire } = fakeManager();
		subscribeIdeSelection(manager);
		fire("other", "selection_changed", {
			selection: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 }, isEmpty: false },
			text: "nope",
			filePath: "/a/b.ts",
		});
		expect(getCurrentIdeSelection()).toBeNull();
		fire("ide", "tools/list_changed", {
			selection: { start: { line: 5, character: 0 }, end: { line: 6, character: 0 }, isEmpty: false },
			text: "nope",
			filePath: "/a/b.ts",
		});
		expect(getCurrentIdeSelection()).toBeNull();
	});
});
