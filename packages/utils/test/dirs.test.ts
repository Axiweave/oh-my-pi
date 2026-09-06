import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetProjectDirCacheForTests,
	directoryIsMissing,
	getProjectDir,
	onProjectDirChanged,
	setProjectDir,
} from "@oh-my-pi/pi-utils/dirs";

const originalProjectDir = fs.realpathSync(process.cwd()).replace(/^\/private(?=\/)/, "");

afterEach(() => {
	vi.restoreAllMocks();
	setProjectDir(originalProjectDir);
});
describe("project directory state", () => {
	it("enters an accessible fallback when process.cwd fails", () => {
		__resetProjectDirCacheForTests();
		const originalPwd = process.env.PWD;
		const cwd = spyOn(process, "cwd").mockImplementation(() => {
			throw new Error("cwd unavailable");
		});
		process.env.PWD = os.tmpdir();
		const reported: string[] = [];
		const unsubscribe = onProjectDirChanged(dir => reported.push(dir));
		try {
			getProjectDir();
			cwd.mockRestore();
			expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(getProjectDir()));
			expect(reported).toEqual([getProjectDir()]);
		} finally {
			unsubscribe();
			cwd.mockRestore();
			if (originalPwd === undefined) delete process.env.PWD;
			else process.env.PWD = originalPwd;
		}
	});

	it("treats denied stat as probeable rather than missing", async () => {
		const stat = spyOn(fs.promises, "stat").mockRejectedValue(
			Object.assign(new Error("operation not permitted"), { code: "EACCES" }),
		);
		try {
			expect(await directoryIsMissing(path.join(os.tmpdir(), "blocked"))).toBe(false);
		} finally {
			stat.mockRestore();
		}
	});

	it("keeps the previous directory when chdir fails", () => {
		const chdir = spyOn(process, "chdir").mockImplementation(() => {
			throw new Error("operation not permitted");
		});

		expect(() => setProjectDir("/blocked/project")).toThrow("operation not permitted");
		expect(getProjectDir()).toBe(originalProjectDir);
		chdir.mockRestore();
	});

	it("isolates listener errors after the directory changes", () => {
		const destination = fs.mkdtempSync(path.join(os.tmpdir(), "omp-dir-listener-"));
		const reported: string[] = [];
		const unsubscribeThrowing = onProjectDirChanged(() => {
			throw new Error("listener failed");
		});
		const unsubscribe = onProjectDirChanged(dir => {
			expect(getProjectDir()).toBe(dir);
			reported.push(dir);
		});
		try {
			setProjectDir(destination);
			expect(fs.realpathSync(getProjectDir())).toBe(fs.realpathSync(destination));
			expect(reported).toEqual([getProjectDir()]);
			unsubscribe();
			setProjectDir(originalProjectDir);
			expect(reported).toHaveLength(1);
		} finally {
			unsubscribeThrowing();
			unsubscribe();
			setProjectDir(originalProjectDir);
			fs.rmSync(destination, { recursive: true, force: true });
		}
	});
});
