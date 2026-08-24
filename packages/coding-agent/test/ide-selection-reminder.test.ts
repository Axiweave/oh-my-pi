import { describe, expect, it } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import type { IDESelection } from "@oh-my-pi/pi-coding-agent/mcp/ide-selection";
import {
	renderIdeOpenedFileReminder,
	renderIdeSelectionReminder,
	withIdeSelectionReminder,
} from "@oh-my-pi/pi-coding-agent/session/ide-selection-reminder";

describe("ide-selection-reminder", () => {
	describe("renderIdeSelectionReminder", () => {
		it("renders a system-reminder block with line range, filename and selection text", () => {
			const rendered = renderIdeSelectionReminder({
				lineStart: 42,
				lineEnd: 42,
				text: "hello",
				filePath: "/a/b/foo.el",
			});
			expect(rendered).toContain("<system-reminder>");
			expect(rendered).toContain("The user selected the lines 42 to 42 from foo.el:");
			expect(rendered).toContain("hello");
			expect(rendered).toContain("This may or may not be related to the current task.");
			expect(rendered).toContain("</system-reminder>");
		});

		it("truncates selection text over 2000 chars with the (truncated) suffix", () => {
			const longText = "x".repeat(2500);
			const rendered = renderIdeSelectionReminder({
				lineStart: 1,
				lineEnd: 2,
				text: longText,
				filePath: "/a/b/foo.el",
			});
			expect(rendered).toContain("\n... (truncated)");
			expect(rendered).not.toContain("x".repeat(2001));
			expect(rendered).toContain("x".repeat(2000));
		});
	});

	describe("renderIdeOpenedFileReminder", () => {
		it("renders a system-reminder block naming the basename of the opened file", () => {
			const rendered = renderIdeOpenedFileReminder("/a/b/foo.el");
			expect(rendered).toContain("<system-reminder>");
			expect(rendered).toContain("The user opened the file foo.el in the IDE.");
			expect(rendered).toContain("This may or may not be related to the current task.");
			expect(rendered).toContain("</system-reminder>");
		});
	});

	describe("withIdeSelectionReminder", () => {
		const selection: IDESelection = { lineStart: 3, lineEnd: 4, text: "pick me", filePath: "/a/b/foo.el" };

		it("returns the context unchanged when there is no selection or opened file", () => {
			const context: Context = {
				systemPrompt: ["PROJECT"],
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			};
			expect(withIdeSelectionReminder(context, null)).toBe(context);
			expect(withIdeSelectionReminder(context, null, null)).toBe(context);
		});

		it("prepends the reminder to the first user message without mutating the input", () => {
			const systemPrompt = ["PROJECT"];
			const context: Context = {
				systemPrompt,
				messages: [{ role: "user", content: "do the thing", timestamp: 1 }],
			};

			const out = withIdeSelectionReminder(context, selection);

			expect(out).not.toBe(context);
			expect(context.messages[0]).toEqual({ role: "user", content: "do the thing", timestamp: 1 });
			expect(out.systemPrompt).toBe(systemPrompt);
			expect(out.messages[0]).toEqual({
				role: "user",
				content: `${renderIdeSelectionReminder(selection)}\n\ndo the thing`,
				timestamp: 1,
			});
		});

		it("falls back to the opened-file reminder when there is no selection", () => {
			const systemPrompt = ["PROJECT"];
			const context: Context = {
				systemPrompt,
				messages: [{ role: "user", content: "do the thing", timestamp: 1 }],
			};

			const out = withIdeSelectionReminder(context, null, "/a/b/foo.el");

			expect(out).not.toBe(context);
			expect(out.messages[0]).toEqual({
				role: "user",
				content: `${renderIdeOpenedFileReminder("/a/b/foo.el")}\n\ndo the thing`,
				timestamp: 1,
			});
		});

		it("prefers the selection reminder over the opened-file reminder when both are set", () => {
			const context: Context = {
				systemPrompt: ["PROJECT"],
				messages: [{ role: "user", content: "do the thing", timestamp: 1 }],
			};

			const out = withIdeSelectionReminder(context, selection, "/a/b/foo.el");

			expect(out.messages[0]).toEqual({
				role: "user",
				content: `${renderIdeSelectionReminder(selection)}\n\ndo the thing`,
				timestamp: 1,
			});
		});
	});
});
