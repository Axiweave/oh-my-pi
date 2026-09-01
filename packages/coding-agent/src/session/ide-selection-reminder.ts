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
import type { Context, Message } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { IDESelection } from "../mcp/ide-selection";
import ideOpenedFileTemplate from "../prompts/system/ide-opened-file.md" with { type: "text" };
import ideSelectionTemplate from "../prompts/system/ide-selection.md" with { type: "text" };

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
 * Stateless first-user-message injector (memoized on the pristine message so
 * the append-only context path sees a stable identity for an unchanged
 * reminder). Formerly `injectDateCwdReminder`; the date/cwd path moved to the
 * stateful `DateCwdReminderInjector`, but the IDE reminder is inherently
 * volatile, so it keeps the stateless prepend.
 */
const injectCache = new WeakMap<Message, { reminder: string; injected: Message }>();

function injectFirstUserReminder(messages: Message[], reminder: string): Message[] {
	const index = messages.findIndex(message => message.role === "user");
	if (index < 0) return messages;
	const first = messages[index]!;
	if (typeof first.content === "string") {
		if (first.content.startsWith(reminder)) return messages;
	} else if (first.content[0]?.type === "text" && first.content[0].text === reminder) {
		return messages;
	}
	const cached = injectCache.get(first);
	if (cached !== undefined && cached.reminder === reminder) {
		const out = messages.slice();
		out[index] = cached.injected;
		return out;
	}
	const content =
		typeof first.content === "string"
			? `${reminder}\n\n${first.content}`
			: ([{ type: "text", text: reminder }, ...first.content] as Message["content"]);
	const injected = { ...first, content } as Message;
	injectCache.set(first, { reminder, injected });
	const out = messages.slice();
	out[index] = injected;
	return out;
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
	const messages = injectFirstUserReminder(context.messages, reminder);
	return messages === context.messages ? context : { ...context, messages };
}
