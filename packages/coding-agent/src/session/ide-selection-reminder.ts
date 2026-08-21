/**
 * IDE selection reminder injection.
 *
 * Rides the same path as the date/cwd reminder: a `<system-reminder>` block
 * prepended to the first user message of each provider request, keeping the
 * system prompt byte-stable for prompt caching. Reuses the generic
 * first-user-message injector from `date-cwd-reminder.ts`; only the rendered
 * text differs.
 */
import * as path from "node:path";
import type { Context } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { IDESelection } from "../mcp/ide-selection";
import ideSelectionTemplate from "../prompts/system/ide-selection.md" with { type: "text" };
import { injectDateCwdReminder } from "./date-cwd-reminder";

const MAX_SELECTION_LENGTH = 2000;

/** Renders the selection reminder text (content truncated to 2000 chars). */
export function renderIdeSelectionReminder(selection: IDESelection): string {
	const content =
		selection.text.length > MAX_SELECTION_LENGTH
			? `${selection.text.slice(0, MAX_SELECTION_LENGTH)}\n... (truncated)`
			: selection.text;
	return prompt
		.render(ideSelectionTemplate, {
			lineStart: selection.lineStart,
			lineEnd: selection.lineEnd,
			filename: path.basename(selection.filePath),
			content,
		})
		.trim();
}

/**
 * Prepends the IDE selection reminder to the first user message of `context`,
 * returning a new context. Returns the input unchanged when there is no
 * selection, no system prompt, or no user message.
 */
export function withIdeSelectionReminder(context: Context, selection: IDESelection | null): Context {
	if (!selection) return context;
	if (!context.systemPrompt || context.systemPrompt.length === 0) return context;
	if (context.messages.length === 0) return context;
	const reminder = renderIdeSelectionReminder(selection);
	const messages = injectDateCwdReminder(context.messages, reminder);
	return messages === context.messages ? context : { ...context, messages };
}
