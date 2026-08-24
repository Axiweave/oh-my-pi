/**
 * IDE selection reminder injection.
 *
 * Rides the same path as the date/cwd reminder: a `<system-reminder>` block
 * prepended to the first user message of each provider request, keeping the
 * system prompt byte-stable for prompt caching. Reuses the generic
 * first-user-message injector from `date-cwd-reminder.ts`; only the rendered
 * text differs.
 *
 * Mirrors Claude Code's two IDE attachments (`attachments.ts`
 * `getSelectedLinesFromIDE` / `getOpenedFileFromIDE`): a non-empty selection
 * always wins; with no selection but a file open in the IDE (cursor moved,
 * no region), a lighter "user opened file X" reminder fires instead. Claude
 * Code also triggers nested CLAUDE.md loading for the opened file's
 * directory on that path — omp has no per-file nested-memory-file loader to
 * hook into, so that part isn't ported. Like Claude Code, the reminder
 * carries the full IDE-reported path (not a basename) — the model needs to
 * disambiguate same-named files in different directories; UI surfaces (the
 * status line badge) basename it separately for display.
 */
import type { Context } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { IDESelection } from "../mcp/ide-selection";
import ideOpenedFileTemplate from "../prompts/system/ide-opened-file.md" with { type: "text" };
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
			filename: selection.filePath,
			content,
		})
		.trim();
}

/** Renders the "user opened file X" reminder text for a file with no active selection. */
export function renderIdeOpenedFileReminder(filePath: string): string {
	return prompt.render(ideOpenedFileTemplate, { filename: filePath }).trim();
}

/**
 * Prepends an IDE reminder to the first user message of `context`, returning
 * a new context. A non-empty `selection` wins; otherwise `openedFile` (the
 * file currently open with no selection) renders a lighter reminder. Returns
 * the input unchanged when neither is set, or when there is no system
 * prompt or no user message.
 */
export function withIdeSelectionReminder(
	context: Context,
	selection: IDESelection | null,
	openedFile: string | null = null,
): Context {
	if (!selection && !openedFile) return context;
	if (!context.systemPrompt || context.systemPrompt.length === 0) return context;
	if (context.messages.length === 0) return context;
	const reminder = selection ? renderIdeSelectionReminder(selection) : renderIdeOpenedFileReminder(openedFile!);
	const messages = injectDateCwdReminder(context.messages, reminder);
	return messages === context.messages ? context : { ...context, messages };
}
