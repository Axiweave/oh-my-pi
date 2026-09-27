import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	EnhancedPasteController,
	type EnhancedPasteHandlers,
	type PasteImageCommit,
	parseOsc5522Packet,
} from "@oh-my-pi/pi-coding-agent/utils/enhanced-paste";

const ST = "\x1b\\";
const BEL = "\x07";
const OSC = "\x1b]5522;";

function packet(metadata: string, payload?: string): string {
	return `${OSC}${metadata}${payload === undefined ? "" : `;${payload}`}${ST}`;
}

describe("EnhancedPasteController", () => {
	it("requests image data from an OSC 5522 paste event and preserves chunk boundaries", () => {
		const writes: string[] = [];
		const pastedImages: Array<{ data: string; mimeType: string }> = [];
		const statuses: string[] = [];
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: () => statuses.push("unexpected text paste"),
			pasteImage: image => {
				pastedImages.push({ data: image.data, mimeType: image.mimeType });
			},
			showStatus: message => statuses.push(message),
		});

		controller.enable();
		expect(writes).toEqual(["\x1b[?5522h"]);

		const imageMime = Buffer.from("image/png", "utf8").toString("base64");
		const textMime = Buffer.from("text/plain", "utf8").toString("base64");
		const password = Buffer.from("secret123", "utf8").toString("base64");
		controller.handleInput(packet(`type=read:status=OK:pw=${password}`));
		controller.handleInput(packet(`type=read:status=DATA:mime=${textMime}`));
		controller.handleInput(packet(`type=read:status=DATA:mime=${imageMime}`));
		controller.handleInput(packet("type=read:status=DONE"));

		const pasteEventName = Buffer.from("Paste event", "utf8").toString("base64");
		expect(writes.at(-1)).toBe(`${OSC}type=read:pw=${password}:name=${pasteEventName}:mime=${imageMime}${BEL}`);

		controller.handleInput(packet("type=read:status=OK"));
		controller.handleInput(
			packet(`type=read:status=DATA:mime=${imageMime}`, Buffer.from("image-", "utf8").toString("base64")),
		);
		controller.handleInput(
			packet(`type=read:status=DATA:mime=${imageMime}`, Buffer.from("bytes", "utf8").toString("base64")),
		);
		controller.handleInput(packet("type=read:status=DONE"));

		expect(pastedImages).toEqual([
			{
				data: Buffer.from("image-bytes", "utf8").toString("base64"),
				mimeType: "image/png",
			},
		]);
		expect(statuses).toEqual([]);
	});

	it("falls back to text/plain and carries primary-selection location into the read request", () => {
		const writes: string[] = [];
		const pastedText: string[] = [];
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: text => pastedText.push(text),
			pasteImage: () => {
				throw new Error("unexpected image paste");
			},
			showStatus: message => pastedText.push(`status:${message}`),
		});

		const textMime = Buffer.from("text/plain", "utf8").toString("base64");
		const password = Buffer.from("secret456", "utf8").toString("base64");
		const pasteEventName = Buffer.from("Paste event", "utf8").toString("base64");
		expect(controller.handleInput("plain text")).toBe(false);
		controller.handleInput(packet(`type=read:status=OK:loc=primary:pw=${password}`));
		controller.handleInput(packet(`type=read:status=DATA:mime=${textMime}`));
		controller.handleInput(packet("type=read:status=DONE"));

		expect(writes).toEqual([
			`${OSC}type=read:loc=primary:pw=${password}:name=${pasteEventName}:mime=${textMime}${BEL}`,
		]);

		controller.handleInput(packet("type=read:status=OK"));
		controller.handleInput(
			packet(`type=read:status=DATA:mime=${textMime}`, Buffer.from("hello ", "utf8").toString("base64")),
		);
		controller.handleInput(
			packet(`type=read:status=DATA:mime=${textMime}`, Buffer.from("world", "utf8").toString("base64")),
		);
		controller.handleInput(packet("type=read:status=DONE"));

		expect(pastedText).toEqual(["hello world"]);
	});

	it("reports unsupported paste events instead of leaking OSC packets to the editor", () => {
		const statuses: string[] = [];
		const controller = new EnhancedPasteController({
			write: () => {},
			pasteText: () => {},
			pasteImage: () => {},
			showStatus: message => statuses.push(message),
		});

		const htmlMime = Buffer.from("text/html", "utf8").toString("base64");
		expect(controller.handleInput(packet("type=read:status=OK"))).toBe(true);
		expect(controller.handleInput(packet(`type=read:status=DATA:mime=${htmlMime}`))).toBe(true);
		expect(controller.handleInput(packet("type=read:status=DONE"))).toBe(true);

		expect(statuses).toHaveLength(1);
	});

	it("decodes Kitty's dot-listing DATA payload to discover plain-text and request it", () => {
		const writes: string[] = [];
		const pastedText: string[] = [];
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: text => pastedText.push(text),
			pasteImage: () => {
				throw new Error("unexpected image paste");
			},
			showStatus: message => pastedText.push(`status:${message}`),
		});

		const dot = Buffer.from(".", "utf8").toString("base64");
		const textMime = Buffer.from("text/plain", "utf8").toString("base64");
		const password = Buffer.from("secret-token-123", "utf8").toString("base64");
		const pasteEventName = Buffer.from("Paste event", "utf8").toString("base64");

		// Kitty bundles the available MIME types into a single DATA packet
		// whose `mime` field is the literal `.` and whose payload carries a
		// whitespace-separated, base64-encoded list (e.g. "text/plain\n").
		controller.handleInput(packet(`type=read:status=OK:pw=${password}`));
		controller.handleInput(
			packet(
				`type=read:status=DATA:mime=${dot}:pw=${password}`,
				Buffer.from("text/plain\n", "utf8").toString("base64"),
			),
		);
		controller.handleInput(packet(`type=read:status=DONE:pw=${password}`));

		expect(writes.at(-1)).toBe(`${OSC}type=read:pw=${password}:name=${pasteEventName};${textMime}${BEL}`);

		controller.handleInput(packet("type=read:status=OK"));
		controller.handleInput(
			packet(`type=read:status=DATA:mime=${textMime}`, Buffer.from("hello", "utf8").toString("base64")),
		);
		controller.handleInput(
			packet(`type=read:status=DATA:mime=${textMime}`, Buffer.from(" world", "utf8").toString("base64")),
		);
		controller.handleInput(packet("type=read:status=DONE"));

		expect(pastedText).toEqual(["hello world"]);
	});

	it("prefers images when Kitty's dot-listing payload advertises multiple MIME types", () => {
		const writes: string[] = [];
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: () => {
				throw new Error("unexpected text paste");
			},
			pasteImage: () => {},
			showStatus: () => {},
		});

		const dot = Buffer.from(".", "utf8").toString("base64");
		const imageMime = Buffer.from("image/png", "utf8").toString("base64");

		controller.handleInput(packet("type=read:status=OK"));
		controller.handleInput(
			packet(
				`type=read:status=DATA:mime=${dot}`,
				Buffer.from("text/plain image/png text/html\n", "utf8").toString("base64"),
			),
		);
		controller.handleInput(packet("type=read:status=DONE"));

		expect(writes.at(-1)).toBe(`${OSC}type=read;${imageMime}${BEL}`);
	});
});

const VERIFIED_MIME = "application/vnd.ghostel.paste-v1+json";
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);
const PNG_SHA256 = createHash("sha256").update(PNG).digest("hex");
const VERIFIED_MIMES = ["text/plain", VERIFIED_MIME, "image/tiff", "image/png", "image/jpeg"];

function manifest(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		version: 1,
		mime: "image/png",
		bytes: PNG.byteLength,
		sha256: PNG_SHA256,
		remaining_ms: 10_000,
		...overrides,
	});
}

function offer(
	controller: EnhancedPasteController,
	mimes: string[] = VERIFIED_MIMES,
	listing: "dot" | "concrete" = "dot",
): void {
	controller.handleInput(packet("type=read:status=OK:loc=primary:pw=Z3JhbnQ="));
	if (listing === "dot") {
		controller.handleInput(
			packet("type=read:status=DATA:mime=Lg==", Buffer.from(mimes.join(" \n")).toString("base64")),
		);
	} else {
		for (const mime of mimes) {
			controller.handleInput(packet(`type=read:status=DATA:mime=${Buffer.from(mime).toString("base64")}`));
		}
	}
	controller.handleInput(packet("type=read:status=DONE"));
}

describe("verified enhanced image paste", () => {
	let now: number;
	const controllers: EnhancedPasteController[] = [];

	beforeEach(() => {
		vi.useFakeTimers();
		now = 1_000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
	});

	afterEach(() => {
		for (const controller of controllers.splice(0)) controller.cancelPending();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	function receiver(prepare?: EnhancedPasteHandlers["pasteImage"]) {
		const writes: string[] = [];
		const statuses: string[] = [];
		const prepared: ImageContent[] = [];
		const images: ImageContent[] = [];
		const texts: string[] = [];
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			showStatus: message => statuses.push(message),
			pasteText: text => texts.push(text),
			pasteImage: (image, tryCommit) => {
				prepared.push(image);
				if (prepare) return prepare(image, tryCommit);
				if (tryCommit) return tryCommit(() => images.push(image));
				images.push(image);
			},
		});
		controllers.push(controller);

		function start(listing: "dot" | "concrete" = "dot") {
			offer(controller, VERIFIED_MIMES, listing);
			const request = parseOsc5522Packet(writes.at(-1) ?? "");
			const id = request?.metadata.get("id");
			if (!request || !id) throw new Error("The receiver did not request a verified image");
			return { id, request };
		}

		function send(id: string, status: string, mime?: string, payload?: string): void {
			const encodedMime = mime === undefined ? "" : `:mime=${Buffer.from(mime).toString("base64")}`;
			controller.handleInput(packet(`type=read:status=${status}:id=${id}${encodedMime}`, payload));
		}

		function sendManifest(id: string, text = manifest()): void {
			send(id, "DATA", VERIFIED_MIME, Buffer.from(text).toString("base64"));
		}

		function deliver(id: string): void {
			send(id, "OK");
			sendManifest(id);
			send(id, "DATA", "image/png", PNG.toString("base64"));
			send(id, "DONE");
		}

		return { controller, writes, statuses, prepared, images, texts, start, send, sendManifest, deliver };
	}

	it.each(["dot", "concrete"] as const)("requests the manifest and selected image in one %s-listing read", listing => {
		const h = receiver();
		const first = h.start(listing);
		expect(first.id).toMatch(/^ghostel-v1-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
		expect(first.request.metadata.get("type")).toBe("read");
		expect(first.request.metadata.get("loc")).toBe("primary");
		expect(first.request.metadata.get("pw")).toBe("Z3JhbnQ=");
		expect(Buffer.from(first.request.metadata.get("name")!, "base64").toString()).toBe("Paste event");
		expect(first.request.metadata.has("mime")).toBe(false);
		expect(Buffer.from(first.request.payload, "base64").toString()).toBe(`${VERIFIED_MIME} image/png`);
		expect(h.writes).toHaveLength(1);
		h.deliver(first.id);
		const second = h.start(listing);
		expect(second.id).not.toBe(first.id);
		h.deliver(second.id);
		expect(h.images).toEqual([
			{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
			{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
		]);
		expect(h.statuses).toEqual([]);
	});

	it("preserves exact image bytes across every two-packet split, including independent padding", () => {
		for (let split = 1; split < PNG.byteLength; split++) {
			const h = receiver();
			const { id } = h.start();
			h.send(id, "OK");
			h.sendManifest(id);
			h.send(id, "DATA", "image/png", PNG.subarray(0, split).toString("base64"));
			h.send(id, "DATA", "image/png", PNG.subarray(split).toString("base64"));
			expect(h.prepared).toEqual([]);
			h.send(id, "DONE");
			h.send(id, "DONE");
			expect(h.images).toEqual([{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
			expect(h.prepared).toHaveLength(1);
			expect(h.statuses).toEqual([]);
		}
	});

	it.each([
		["unsupported version", { version: 2 }],
		["string version", { version: "1" }],
		["wrong image MIME", { mime: "image/jpeg" }],
		["zero bytes", { bytes: 0 }],
		["negative bytes", { bytes: -1 }],
		["fractional bytes", { bytes: 1.5 }],
		["unsafe bytes", { bytes: Number.MAX_SAFE_INTEGER + 1 }],
		["string bytes", { bytes: String(PNG.byteLength) }],
		["uppercase digest", { sha256: PNG_SHA256.toUpperCase() }],
		["short digest", { sha256: PNG_SHA256.slice(1) }],
		["non-hex digest", { sha256: "z".repeat(64) }],
		["zero budget", { remaining_ms: 0 }],
		["negative budget", { remaining_ms: -1 }],
		["fractional budget", { remaining_ms: 1.5 }],
		["oversized budget", { remaining_ms: 10_001 }],
		["string budget", { remaining_ms: "1000" }],
		["null budget", { remaining_ms: null }],
		["missing field", { sha256: undefined }],
		["extra JSON identity", { id: "not-a-packet-id" }],
	] satisfies Array<[string, Record<string, unknown>]>)("refuses a manifest with %s", (_label, overrides) => {
		const h = receiver();
		const { id } = h.start();
		h.send(id, "OK");
		h.sendManifest(id, manifest(overrides));
		h.send(id, "DATA", "image/png", PNG.toString("base64"));
		h.send(id, "DONE");
		expect(h.prepared).toEqual([]);
		expect(h.images).toEqual([]);
		expect(h.texts).toEqual([]);
		expect(h.writes).toHaveLength(1);
		expect(h.statuses).toHaveLength(1);
	});

	it.each([
		["invalid JSON", "{"],
		["array", "[]"],
		["null", "null"],
		["duplicate key", manifest().replace('"version":1', '"version":2,"version":1')],
		["escaped key", manifest().replace('"mime"', '"m\\u0069me"')],
		["noncanonical number", manifest().replace('"version":1', '"version":1.0')],
		["whitespace", ` ${manifest()}`],
		["byte-order mark", `\uFEFF${manifest()}`],
		["oversized representation", " ".repeat(1025)],
	])("refuses a manifest with %s encoding", (_label, text) => {
		const h = receiver();
		const { id } = h.start();
		h.send(id, "OK");
		h.sendManifest(id, text);
		h.send(id, "DATA", "image/png", PNG.toString("base64"));
		h.send(id, "DONE");
		expect(h.prepared).toEqual([]);
		expect(h.statuses).toHaveLength(1);
	});

	it("refuses invalid UTF-8 before image preparation", () => {
		const h = receiver();
		const { id } = h.start();
		h.send(id, "OK");
		const invalidUtf8 = Buffer.concat([Buffer.from(manifest().slice(0, -1)), Buffer.from([0xff]), Buffer.from("}")]);
		h.send(id, "DATA", VERIFIED_MIME, invalidUtf8.toString("base64"));
		h.send(id, "DONE");
		expect(h.prepared).toEqual([]);
		expect(h.statuses).toHaveLength(1);
	});

	it.each([
		["missing manifest", "image"],
		["missing OK", "manifest"],
		["repeated manifest", "repeat"],
		["manifest after image", "mixed"],
		["unexpected MIME", "mime"],
		["missing image", "empty"],
	] as const)("refuses %s without a legacy retry", (_label, fault) => {
		const h = receiver();
		const { id } = h.start();
		if (fault !== "manifest") h.send(id, "OK");
		if (fault !== "image") h.sendManifest(id);
		if (fault === "repeat") h.sendManifest(id);
		if (fault !== "empty") {
			h.send(id, "DATA", fault === "mime" ? "image/jpeg" : "image/png", PNG.toString("base64"));
		}
		if (fault === "mixed") h.sendManifest(id);
		h.send(id, "DONE");
		expect(h.prepared).toEqual([]);
		expect(h.texts).toEqual([]);
		expect(h.writes).toHaveLength(1);
		expect(h.statuses).toHaveLength(1);
	});

	it.each([
		["short image", { bytes: PNG.byteLength + 1 }],
		["long image", { bytes: PNG.byteLength - 1 }],
		["wrong digest", { sha256: "0".repeat(64) }],
	] satisfies Array<[string, Record<string, unknown>]>)("rejects a complete reply with a %s", (_label, overrides) => {
		const h = receiver();
		const { id } = h.start();
		h.send(id, "OK");
		h.sendManifest(id, manifest(overrides));
		h.send(id, "DATA", "image/png", PNG.toString("base64"));
		h.send(id, "DONE");
		expect(h.prepared).toEqual([]);
		expect(h.statuses).toHaveLength(1);
	});

	it.each(["", "A", "AA", "AA=", "AA==\n", "AA-_", "AB==", "AAAA===="])(
		"rejects noncanonical DATA base64 %j",
		payload => {
			const h = receiver();
			const { id } = h.start();
			h.send(id, "OK");
			h.sendManifest(id);
			h.send(id, "DATA", "image/png", payload);
			h.send(id, "DONE");
			expect(h.prepared).toEqual([]);
			expect(h.statuses).toHaveLength(1);
		},
	);

	it.each(["duplicate-id", "duplicate-status", "duplicate-mime", "invalid-mime", "invalid-field"] as const)(
		"rejects ambiguous or invalid packet metadata: %s",
		fault => {
			const h = receiver();
			const { id } = h.start();
			h.send(id, "OK");
			h.sendManifest(id);
			const encodedMime = Buffer.from("image/png").toString("base64");
			const suffix = {
				"duplicate-id": `:id=${id}`,
				"duplicate-status": ":status=DATA",
				"duplicate-mime": `:mime=${encodedMime}`,
				"invalid-mime": " ",
				"invalid-field": ":invalid",
			}[fault];
			h.controller.handleInput(
				packet(`type=read:status=DATA:id=${id}:mime=${encodedMime}${suffix}`, PNG.toString("base64")),
			);
			h.send(id, "DONE");
			expect(h.prepared).toEqual([]);
			expect(h.statuses).toHaveLength(1);
		},
	);

	it("ignores wrong and missing reply IDs without altering the active image bytes", () => {
		const h = receiver();
		const { id } = h.start();
		h.send(id, "OK");
		h.sendManifest(id);
		for (const wrongId of ["ghostel-v1-inactive", "unrelated-request", ""]) {
			h.send(wrongId, "DATA", "image/png", PNG.toString("base64"));
			h.send(wrongId, "DONE");
			h.send(wrongId, "DENIED");
		}
		h.controller.handleInput(packet("type=read:status=DATA:mime=aW1hZ2UvcG5n", PNG.toString("base64")));
		h.controller.handleInput(packet("type=read:status=DONE"));
		h.controller.handleInput(packet("type=read:status=DENIED"));
		expect(h.statuses).toEqual([]);
		expect(h.prepared).toEqual([]);
		h.send(id, "DATA", "image/png", PNG.toString("base64"));
		h.send(id, "DONE");
		expect(h.images).toEqual([{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
	});

	it("requires a matching DONE after all bytes arrive", () => {
		const h = receiver();
		const { id } = h.start();
		h.send(id, "OK");
		h.sendManifest(id);
		h.send(id, "DATA", "image/png", PNG.toString("base64"));
		h.send("ghostel-v1-other", "DONE");
		expect(h.prepared).toEqual([]);
		h.send(id, "DONE");
		expect(h.images).toHaveLength(1);
	});

	it("rejects a matching terminal failure and consumes its remaining reply", () => {
		const h = receiver();
		const { id } = h.start();
		h.send(id, "OK");
		h.sendManifest(id);
		h.send(id, "DENIED");
		h.send(id, "DATA", "image/png", PNG.toString("base64"));
		h.send(id, "DONE");
		expect(h.prepared).toEqual([]);
		expect(h.statuses).toHaveLength(1);
		h.deliver(h.start().id);
		expect(h.images).toHaveLength(1);
	});

	it("refuses a profile advertisement without a supported image rather than requesting text", () => {
		const h = receiver();
		offer(h.controller, [VERIFIED_MIME, "text/plain"]);
		expect(h.writes).toEqual([]);
		expect(h.texts).toEqual([]);
		expect(h.statuses).toHaveLength(1);
	});

	it("expires a reply that never supplies a manifest under the provisional deadline", () => {
		const h = receiver();
		const { id } = h.start();
		now += 10_000;
		vi.advanceTimersByTime(10_000);
		expect(h.statuses).toHaveLength(1);
		h.deliver(id);
		expect(h.prepared).toEqual([]);
		h.deliver(h.start().id);
		expect(h.images).toHaveLength(1);
		expect(h.statuses).toHaveLength(1);
	});

	it("rejects a matching packet at expiry even when the watchdog has not run", () => {
		const h = receiver();
		const { id } = h.start();
		now += 10_000;
		h.send(id, "OK");
		h.sendManifest(id);
		h.send(id, "DATA", "image/png", PNG.toString("base64"));
		h.send(id, "DONE");
		expect(h.prepared).toEqual([]);
		expect(h.statuses).toHaveLength(1);
	});

	it("refuses a manifest whose shortened deadline already passed", () => {
		const h = receiver();
		const { id } = h.start();
		h.send(id, "OK");
		now += 100;
		h.sendManifest(id, manifest({ remaining_ms: 100 }));
		h.send(id, "DATA", "image/png", PNG.toString("base64"));
		h.send(id, "DONE");
		expect(h.prepared).toEqual([]);
		expect(h.statuses).toHaveLength(1);
	});

	it.each([
		[99, true],
		[100, false],
		[101, false],
	] as const)(
		"checks commit admission at request-start plus %i ms without a timer callback",
		async (elapsed, accepted) => {
			const preparation = Promise.withResolvers<void>();
			const outcome = Promise.withResolvers<boolean>();
			const attached: ImageContent[] = [];
			const h = receiver(async (image, tryCommit) => {
				await preparation.promise;
				const result = tryCommit!(() => attached.push(image));
				outcome.resolve(result);
				return result;
			});
			const { id } = h.start();
			h.send(id, "OK");
			now += 80;
			h.sendManifest(id, manifest({ remaining_ms: 100 }));
			h.send(id, "DATA", "image/png", PNG.toString("base64"));
			h.send(id, "DONE");
			expect(attached).toEqual([]);
			now = 1_000 + elapsed;
			preparation.resolve();
			expect(await outcome.promise).toBe(accepted);
			expect(attached).toEqual(
				accepted ? [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }] : [],
			);
			expect(h.statuses).toHaveLength(accepted ? 0 : 1);
		},
	);

	it("keeps the shortened watchdog active through preparation and rejects late completion", async () => {
		const preparation = Promise.withResolvers<void>();
		const outcome = Promise.withResolvers<boolean>();
		const attached: ImageContent[] = [];
		const h = receiver(async (image, tryCommit) => {
			await preparation.promise;
			const result = tryCommit!(() => attached.push(image));
			outcome.resolve(result);
			return result;
		});
		const { id } = h.start();
		h.send(id, "OK");
		now += 80;
		vi.advanceTimersByTime(80);
		h.sendManifest(id, manifest({ remaining_ms: 100 }));
		h.send(id, "DATA", "image/png", PNG.toString("base64"));
		h.send(id, "DONE");
		now += 20;
		vi.advanceTimersByTime(20);
		expect(h.statuses).toHaveLength(1);
		preparation.resolve();
		expect(await outcome.promise).toBe(false);
		expect(attached).toEqual([]);
		expect(h.statuses).toHaveLength(1);
	});

	it.each(["reading", "preparing"] as const)(
		"refuses a busy notification during %s without replacing the active attempt",
		async stage => {
			const preparation = Promise.withResolvers<void>();
			const outcome = Promise.withResolvers<boolean>();
			const attached: ImageContent[] = [];
			const h = receiver(async (image, tryCommit) => {
				await preparation.promise;
				const result = tryCommit!(() => attached.push(image));
				outcome.resolve(result);
				return result;
			});
			const { id } = h.start();
			if (stage === "preparing") h.deliver(id);
			offer(h.controller);
			expect(h.writes).toHaveLength(1);
			expect(h.statuses).toHaveLength(1);
			if (stage === "reading") h.deliver(id);
			preparation.resolve();
			expect(await outcome.promise).toBe(true);
			expect(attached).toEqual([{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
			expect(h.prepared).toHaveLength(1);
			expect(h.statuses).toHaveLength(1);
		},
	);

	it("consumes commit permission once and ignores duplicate DONE during preparation", async () => {
		let gate: PasteImageCommit | undefined;
		const pending = Promise.withResolvers<boolean>();
		const applied: string[] = [];
		const h = receiver((_image, tryCommit) => {
			gate = tryCommit;
			return pending.promise;
		});
		const { id } = h.start();
		h.deliver(id);
		h.send(id, "DONE");
		expect(h.prepared).toHaveLength(1);
		expect(gate!(() => applied.push("first"))).toBe(true);
		expect(gate!(() => applied.push("second"))).toBe(false);
		pending.resolve(true);
		await pending.promise;
		expect(applied).toEqual(["first"]);
		now += 10_000;
		vi.advanceTimersByTime(10_000);
		expect(h.statuses).toEqual([]);
	});

	it("invalidates preparation when matching image DATA arrives after DONE", async () => {
		let gate: PasteImageCommit | undefined;
		const pending = Promise.withResolvers<boolean>();
		const applied: string[] = [];
		const h = receiver((_image, tryCommit) => {
			gate = tryCommit;
			return pending.promise;
		});
		const { id } = h.start();
		h.deliver(id);
		h.send(id, "DATA", "image/png", PNG.toString("base64"));
		expect(gate!(() => applied.push("late"))).toBe(false);
		pending.resolve(false);
		await pending.promise;
		expect(applied).toEqual([]);
		expect(h.statuses).toHaveLength(1);
	});

	it.each(["cancel", "disable", "enable"] as const)(
		"prevents a prepared image from committing after %s",
		async action => {
			let gate: PasteImageCommit | undefined;
			const pending = Promise.withResolvers<boolean>();
			const applied: string[] = [];
			const h = receiver((_image, tryCommit) => {
				gate = tryCommit;
				return pending.promise;
			});
			const { id } = h.start();
			h.deliver(id);
			if (action === "cancel") h.controller.cancelPending("The Session changed");
			else if (action === "disable") h.controller.disable();
			else h.controller.enable();
			expect(gate!(() => applied.push("canceled"))).toBe(false);
			h.deliver(id);
			pending.resolve(false);
			await pending.promise;
			now += 10_000;
			vi.advanceTimersByTime(10_000);
			expect(applied).toEqual([]);
			expect(h.prepared).toHaveLength(1);
			expect(h.statuses).toHaveLength(1);
		},
	);

	it("isolates a new transfer from old timers, packets, and a rejected preparation", async () => {
		const timerSpy = vi.spyOn(globalThis, "setTimeout");
		const oldPreparation = Promise.withResolvers<boolean>();
		let oldGate: PasteImageCommit | undefined;
		let newGate: PasteImageCommit | undefined;
		const newPreparation = Promise.withResolvers<boolean>();
		const applied: string[] = [];
		const h = receiver((_image, tryCommit) => {
			if (!oldGate) {
				oldGate = tryCommit;
				return oldPreparation.promise;
			}
			newGate = tryCommit;
			return newPreparation.promise;
		});
		const old = h.start();
		h.deliver(old.id);
		const oldTimer = timerSpy.mock.calls.at(-1)![0];
		h.controller.cancelPending("The Session changed");
		now += 10_000;
		const current = h.start();
		h.deliver(current.id);
		if (typeof oldTimer !== "function") throw new Error("The receiver did not schedule a watchdog callback");
		oldTimer();
		h.deliver(old.id);
		h.send(old.id, "DENIED");
		oldPreparation.reject(new Error("The old preparation failed"));
		await oldPreparation.promise.catch(() => {});
		expect(oldGate!(() => applied.push("old"))).toBe(false);
		expect(newGate!(() => applied.push("new"))).toBe(true);
		newPreparation.resolve(true);
		await newPreparation.promise;
		expect(applied).toEqual(["new"]);
		expect(h.prepared).toHaveLength(2);
		expect(h.statuses).toHaveLength(1);
	});

	it("does not let a canceled preparation continuation clear a newer transfer", async () => {
		const oldPreparation = Promise.withResolvers<boolean>();
		const currentPreparation = Promise.withResolvers<boolean>();
		const gates: PasteImageCommit[] = [];
		const applied: string[] = [];
		const h = receiver((_image, tryCommit) => {
			gates.push(tryCommit!);
			return gates.length === 1 ? oldPreparation.promise : currentPreparation.promise;
		});
		h.deliver(h.start().id);
		h.controller.cancelPending();
		h.deliver(h.start().id);
		oldPreparation.resolve(false);
		await oldPreparation.promise;
		expect(gates[0]!(() => applied.push("old"))).toBe(false);
		expect(gates[1]!(() => applied.push("new"))).toBe(true);
		currentPreparation.resolve(true);
		await currentPreparation.promise;
		expect(applied).toEqual(["new"]);
		expect(h.statuses).toEqual([]);
	});

	it.each([true, undefined])(
		"reports an adapter result of %s as failure unless it used the commit gate",
		async result => {
			const returned = Promise.resolve(result);
			const h = receiver(() => returned);
			h.deliver(h.start().id);
			await returned;
			expect(h.images).toEqual([]);
			expect(h.statuses).toHaveLength(1);
			now += 10_000;
			vi.advanceTimersByTime(10_000);
			expect(h.statuses).toHaveLength(1);
		},
	);

	it("lets an explicit adapter refusal own its explanation", async () => {
		const returned = Promise.resolve(false);
		const h = receiver(() => returned);
		h.deliver(h.start().id);
		await returned;
		expect(h.images).toEqual([]);
		now += 10_000;
		vi.advanceTimersByTime(10_000);
		expect(h.statuses).toEqual([]);
	});

	it("reports current preparation rejection once and permits another transfer", async () => {
		const pending = Promise.withResolvers<boolean>();
		const h = receiver(() => pending.promise);
		h.deliver(h.start().id);
		pending.reject(new Error("The image preparation failed"));
		await pending.promise.catch(() => {});
		expect(h.images).toEqual([]);
		expect(h.statuses).toHaveLength(1);
		const next = h.start();
		h.send(next.id, "DENIED");
		expect(h.statuses).toHaveLength(2);
	});

	it("never routes inactive verified IDs into a legacy image receive", () => {
		const h = receiver();
		const old = h.start();
		h.controller.cancelPending();
		h.deliver(old.id);
		offer(h.controller, ["image/png"]);
		for (const suffix of ["", ":id=legacy-request"]) {
			h.controller.handleInput(
				packet(`type=read:status=DATA:id=${old.id}${suffix}:mime=aW1hZ2UvcG5n`, PNG.toString("base64")),
			);
			h.controller.handleInput(packet(`type=read:status=DONE:id=${old.id}${suffix}`));
			h.controller.handleInput(packet(`type=read:status=DENIED:id=${old.id}${suffix}`));
		}
		h.controller.handleInput(packet("type=read:status=OK"));
		h.controller.handleInput(packet("type=read:status=DATA:mime=aW1hZ2UvcG5n", PNG.toString("base64")));
		h.controller.handleInput(packet("type=read:status=DONE"));
		expect(h.images).toEqual([{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
		expect(h.statuses).toEqual([]);
	});

	it("keeps legacy cancellation silent and never attaches its buffered bytes", () => {
		const h = receiver();
		offer(h.controller, ["image/png"]);
		h.controller.handleInput(packet("type=read:status=OK"));
		h.controller.handleInput(packet("type=read:status=DATA:mime=aW1hZ2UvcG5n", PNG.toString("base64")));
		h.controller.cancelPending("The Session changed");
		h.controller.handleInput(packet("type=read:status=DONE"));
		expect(h.images).toEqual([]);
		expect(h.statuses).toEqual([]);
	});

	it.each([1, 10_000])("accepts the inclusive remaining-budget boundary of %i ms", budget => {
		const h = receiver();
		const { id } = h.start();
		h.send(id, "OK");
		h.sendManifest(id, manifest({ remaining_ms: budget }));
		h.send(id, "DATA", "image/png", PNG.toString("base64"));
		h.send(id, "DONE");
		expect(h.images).toEqual([{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
		expect(h.statuses).toEqual([]);
	});

	it.each(["type=write:status=DATA", "status=DATA", "type=read"])(
		"refuses a matching reply with invalid required metadata: %s",
		metadata => {
			const h = receiver();
			const { id } = h.start();
			h.send(id, "OK");
			h.sendManifest(id);
			h.controller.handleInput(packet(`${metadata}:id=${id}:mime=aW1hZ2UvcG5n`, PNG.toString("base64")));
			h.send(id, "DONE");
			expect(h.prepared).toEqual([]);
			expect(h.statuses).toHaveLength(1);
		},
	);

	it("captures the provisional deadline before the request write", () => {
		const prepared: ImageContent[] = [];
		const statuses: string[] = [];
		let requestedId: string | undefined;
		const controller = new EnhancedPasteController({
			write: data => {
				requestedId = parseOsc5522Packet(data)?.metadata.get("id");
				now += 10_000;
				controller.handleInput(packet(`type=read:status=OK:id=${requestedId}`));
			},
			pasteText: () => {},
			pasteImage: image => {
				prepared.push(image);
			},
			showStatus: message => statuses.push(message),
		});
		controllers.push(controller);
		offer(controller);
		expect(requestedId).toStartWith("ghostel-v1-");
		expect(prepared).toEqual([]);
		expect(statuses).toHaveLength(1);
	});

	it("does not expire an active transfer when a watchdog callback runs before its deadline", () => {
		const timerSpy = vi.spyOn(globalThis, "setTimeout");
		const h = receiver();
		const { id } = h.start();
		const callback = timerSpy.mock.calls.at(-1)![0];
		if (typeof callback !== "function") throw new Error("The receiver did not schedule a watchdog callback");
		callback();
		expect(h.statuses).toEqual([]);
		h.deliver(id);
		expect(h.images).toEqual([{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
		now += 10_000;
		vi.advanceTimersByTime(10_000);
		expect(h.statuses).toEqual([]);
	});
});
