import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { startTerminalDirectoryReporting } from "@oh-my-pi/pi-coding-agent/utils/terminal-directory";
import { getProjectDir, logger, setProjectDir, setTerminalHeadless } from "@oh-my-pi/pi-utils";

let originalDirectory: string;
let previousHeadless: boolean;
let ttyDescriptor: PropertyDescriptor | undefined;
let previousTmux: string | undefined;
let root: string;
let source: string;
let destination: string;
let output: string[];
let disposers: Array<() => void>;

beforeEach(() => {
	originalDirectory = getProjectDir();
	previousHeadless = setTerminalHeadless(false);
	ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	previousTmux = process.env.TMUX;
	delete process.env.TMUX;
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-terminal-directory-"));
	source = path.join(root, "source");
	destination = path.join(root, process.platform === "win32" ? "destination" : "a #?% café\x07\x1b");
	fs.mkdirSync(source);
	fs.mkdirSync(destination);
	setProjectDir(source);
	source = getProjectDir();
	output = [];
	disposers = [];
});

afterEach(() => {
	for (const dispose of disposers) dispose();
	vi.restoreAllMocks();
	setProjectDir(originalDirectory);
	setTerminalHeadless(previousHeadless);
	if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
	else Reflect.deleteProperty(process.stdout, "isTTY");
	if (previousTmux === undefined) delete process.env.TMUX;
	else process.env.TMUX = previousTmux;
	fs.rmSync(root, { recursive: true, force: true });
});

function start(settings = Settings.isolated({ "terminal.reportCwd": true })): () => void {
	const dispose = startTerminalDirectoryReporting(settings, { write: value => output.push(value) });
	disposers.push(dispose);
	return dispose;
}

function decodeReport(sequence: string): string {
	expect(sequence.startsWith("\x1b]7;file://")).toBe(true);
	expect(sequence.endsWith("\x1b\\")).toBe(true);
	const payload = sequence.slice(4, -2);
	expect(payload).not.toMatch(/[\x00-\x1f\x7f]/);
	const uri = new URL(payload);
	expect(decodeURIComponent(uri.hostname)).toBe(os.hostname().toLowerCase());
	return decodeURIComponent(uri.pathname);
}

function protocolPath(cwd: string): string {
	return process.platform === "win32" ? `/${cwd.replaceAll("\\", "/")}` : cwd;
}

describe("terminal directory reporting", () => {
	it("emits nothing without an explicit opt-in", () => {
		for (const settings of [Settings.isolated(), Settings.isolated({ "terminal.reportCwd": false })]) {
			const dispose = start(settings);
			setProjectDir(destination);
			dispose();
		}
		expect(output).toEqual([]);
	});

	it("reports startup and preserves special characters after a successful change", () => {
		start();
		setProjectDir(destination);
		expect(output.map(decodeReport)).toEqual([protocolPath(source), protocolPath(getProjectDir())]);
	});

	it("passes the complete report through tmux without changing its directory", () => {
		process.env.TMUX = "/tmp/omp-terminal-test,1,0";
		start();
		setProjectDir(destination);
		const decoded = output.map(sequence => {
			expect(sequence.startsWith("\x1bPtmux;")).toBe(true);
			expect(sequence.endsWith("\x1b\\")).toBe(true);
			return decodeReport(sequence.slice(7, -2).replaceAll("\x1b\x1b", "\x1b"));
		});
		expect(decoded).toEqual([protocolPath(source), protocolPath(getProjectDir())]);
	});

	it("does not report a failed change and reports a later restoration", () => {
		start();
		setProjectDir(destination);
		const beforeFailure = [...output];
		expect(() => setProjectDir(path.join(root, "missing"))).toThrow();
		expect(output).toEqual(beforeFailure);
		setProjectDir(source);
		expect(output.map(decodeReport)).toEqual([
			protocolPath(source),
			decodeReport(beforeFailure[1]),
			protocolPath(source),
		]);
	});

	it("applies live enable and disable transitions", () => {
		const settings = Settings.isolated();
		start(settings);
		settings.set("terminal.reportCwd", true);
		expect(output.map(decodeReport)).toEqual([protocolPath(source)]);
		settings.set("terminal.reportCwd", false);
		setProjectDir(destination);
		expect(output).toHaveLength(1);
		settings.set("terminal.reportCwd", true);
		expect(output.map(decodeReport)).toEqual([protocolPath(source), protocolPath(getProjectDir())]);
	});

	it("removes both subscriptions on disposal", () => {
		const settings = Settings.isolated({ "terminal.reportCwd": true });
		const dispose = start(settings);
		dispose();
		setProjectDir(destination);
		settings.set("terminal.reportCwd", false);
		settings.set("terminal.reportCwd", true);
		expect(output.map(decodeReport)).toEqual([protocolPath(source)]);
	});

	it("suppresses reports to non-TTY output", () => {
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
		start();
		setProjectDir(destination);
		expect(output).toEqual([]);
	});

	it("suppresses reports in headless mode", () => {
		setTerminalHeadless(true);
		start();
		setProjectDir(destination);
		expect(output).toEqual([]);
	});

	it("keeps a successful directory change when the terminal write fails", () => {
		spyOn(logger, "warn").mockImplementation(() => {});
		disposers.push(
			startTerminalDirectoryReporting(Settings.isolated({ "terminal.reportCwd": true }), {
				write: () => {
					throw new Error("terminal closed");
				},
			}),
		);
		setProjectDir(destination);
		expect(fs.realpathSync(getProjectDir())).toBe(fs.realpathSync(destination));
	});
});
