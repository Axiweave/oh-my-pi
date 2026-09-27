import { describe, expect, it, vi } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

describe("TUI start listeners", () => {
	it("fires registered hooks on initial start and restart", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		let starts = 0;
		tui.addStartListener(() => {
			starts++;
		});

		try {
			tui.start();
			expect(starts).toBe(1);

			tui.stop();
			tui.start();
			expect(starts).toBe(2);
		} finally {
			tui.stop();
		}
	});

	it("notifies late subscribers only while the terminal is started", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		let activeStarts = 0;
		let stoppedStarts = 0;
		try {
			tui.start();
			const unsubscribe = tui.addStartListener(() => activeStarts++);
			expect(activeStarts).toBe(1);
			tui.stop();
			tui.addStartListener(() => stoppedStarts++);
			expect(stoppedStarts).toBe(0);
			tui.start();
			expect([activeStarts, stoppedStarts]).toEqual([2, 1]);
			unsubscribe();
			tui.stop();
			tui.start();
			expect([activeStarts, stoppedStarts]).toEqual([2, 2]);
		} finally {
			tui.stop();
		}
	});
});

describe("TUI stop listeners", () => {
	it("cancels work before terminal handoff and removes disposed hooks across restart", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		let pending = false;
		const cancellations: boolean[] = [];
		const terminalStops: boolean[] = [];
		const stop = terminal.stop.bind(terminal);
		const stopSpy = vi.spyOn(terminal, "stop").mockImplementation(() => {
			terminalStops.push(pending);
			stop();
		});
		const unsubscribe = tui.addStopListener(() => {
			cancellations.push(pending);
			pending = false;
		});
		try {
			tui.start();
			pending = true;
			tui.stop();
			expect(cancellations).toEqual([true]);
			expect(terminalStops).toEqual([false]);

			tui.start();
			pending = true;
			unsubscribe();
			tui.stop();
			expect(cancellations).toEqual([true]);
			expect(terminalStops).toEqual([false, true]);
		} finally {
			unsubscribe();
			tui.stop();
			stopSpy.mockRestore();
		}
	});
});
