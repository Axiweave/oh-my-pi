import { afterEach, beforeEach } from "bun:test";

/**
 * Neutralize every terminal-multiplexer signal for the calling test file.
 *
 * `isInsideTerminalMultiplexer()` treats `TMUX`, `STY`, `ZELLIJ`,
 * `HERDR_ENV=1`, the `CMUX_*` markers and a `tmux`/`screen` `TERM` as
 * authoritative, and `isMultiplexerSession()` then routes rendering down the
 * path that cannot rebuild scrollback. Tests that assert the destructive
 * full-paint behavior otherwise fail for anyone running the suite inside tmux,
 * screen, Zellij or CMUX. `INSIDE_EMACS` is cleared too: it routes resize
 * transactions down the Emacs silent-park path (no alt-screen borrow), which
 * would otherwise flip for anyone running the suite from an Emacs terminal.
 * Restores whatever was set afterwards.
 */
export function withoutTerminalMultiplexer(): void {
	const KEYS = [
		"TMUX",
		"STY",
		"ZELLIJ",
		"HERDR_ENV",
		"CMUX_WORKSPACE_ID",
		"CMUX_SURFACE_ID",
		"CMUX_REMOTE_TRANSPORT",
		"TERM",
		"INSIDE_EMACS",
	] as const;
	const previous = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of KEYS) {
			previous.set(key, Bun.env[key]);
			delete Bun.env[key];
		}
	});

	afterEach(() => {
		for (const [key, value] of previous) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		previous.clear();
	});
}
