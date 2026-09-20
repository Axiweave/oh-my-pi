import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { installLegacyPiSpecifierShim } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";

// Regression: a canonical `@oh-my-pi/pi-*` specifier *with* a subpath matches the
// shim's own filter, so `resolveCanonicalPiSpecifier` missed the package-root
// override and fell through to `Bun.resolveSync` — which dispatched the shim
// again. Every nested pass prefixed another `file:`, so the resolved path grew
// until the filesystem name limit tripped (`NameTooLong reading "file:file:…"`).
// The model hub is lazy-required through exactly such a specifier, so the
// runaway took interactive rendering down with it.
const CANONICAL_SUBPATH_SPECIFIER = "@oh-my-pi/pi-ai/index.js";
const HOST_IMPORTER_DIR = path.join(import.meta.dir, "..", "..", "src");

describe("legacy pi compat canonical subpath resolution", () => {
	it("resolves a canonical subpath without re-entering the shim", () => {
		let dispatches = 0;
		// Registered before the shim, so it counts every pass Bun makes — including
		// the nested passes a self-resolving handler would trigger.
		Bun.plugin({
			name: "omp:legacy-pi-reentrancy-probe",
			setup(build) {
				build.onResolve({ filter: /^@oh-my-pi\//, namespace: "file" }, () => {
					dispatches += 1;
					return undefined;
				});
			},
		});
		installLegacyPiSpecifierShim();

		const resolved = Bun.resolveSync(CANONICAL_SUBPATH_SPECIFIER, HOST_IMPORTER_DIR);

		// Bun echoes plugin-handled results with a single `file:` scheme, so the
		// path itself is what must exist — a chained `file:file:…` never can.
		expect(fs.existsSync(resolved.replace(/^file:/, ""))).toBe(true);
		expect(dispatches).toBeLessThan(4);
	});
});
