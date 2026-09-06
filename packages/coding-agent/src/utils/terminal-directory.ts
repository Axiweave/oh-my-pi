import * as os from "node:os";
import { isInsideTmux, type Terminal, wrapTmuxPassthrough } from "@oh-my-pi/pi-tui";
import { getProjectDir, isTerminalHeadless, logger, onProjectDirChanged } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

/** Report the active directory while the interactive terminal owns its output. */
export function startTerminalDirectoryReporting(settings: Settings, terminal: Pick<Terminal, "write">): () => void {
	const report = (cwd: string): void => {
		if (!settings.get("terminal.reportCwd") || isTerminalHeadless() || !process.stdout.isTTY) return;
		try {
			const normalizedPath = process.platform === "win32" ? cwd.replaceAll("\\", "/") : cwd;
			const encodedPath = encodeURI(normalizedPath).replaceAll("#", "%23").replaceAll("?", "%3F");
			const uri = `file://${encodeURIComponent(os.hostname())}${normalizedPath.startsWith("/") ? "" : "/"}${encodedPath}`;
			const sequence = `\x1b]7;${uri}\x1b\\`;
			terminal.write(isInsideTmux() ? wrapTmuxPassthrough(sequence) : sequence);
		} catch (error) {
			logger.warn("Could not report the working directory to the terminal.", { error: String(error) });
		}
	};

	report(getProjectDir());
	const unsubscribeDirectory = onProjectDirChanged(report);
	const unsubscribeSettings = settings.onEffectiveChange((path, value) => {
		if (path === "terminal.reportCwd" && value === true) report(getProjectDir());
	});
	return () => {
		unsubscribeDirectory();
		unsubscribeSettings();
	};
}
