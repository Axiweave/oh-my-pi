import type { ImageContent } from "@oh-my-pi/pi-ai";

const OSC5522_PREFIX = "\x1b]5522;";
const OSC_TERMINATOR_ST = "\x1b\\";
const OSC_TERMINATOR_BEL = "\x07";
const PASTE_EVENT_NAME_BASE64 = Buffer.from("Paste event", "utf8").toString("base64");

const IMAGE_MIME_PRIORITY = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/tiff"] as const;
const TEXT_MIME_TYPE = "text/plain";
/** Kitty's "give me the list of available MIME types" sentinel — see `TARGETS_MIME` in `kitty/clipboard.py`. */
const MIME_LISTING_TARGET = ".";
const VERIFIED_PASTE_MIME = "application/vnd.ghostel.paste-v1+json";
const VERIFIED_ID_PREFIX = "ghostel-v1-";
const VERIFIED_TIMEOUT_MS = 10_000;
const MAX_MANIFEST_BYTES = 1024;
const manifestDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type PasteReadKind = "image" | "text";

export interface Osc5522Packet {
	metadata: Map<string, string>;
	payload: string;
	invalidMetadata?: boolean;
	hasVerifiedId?: boolean;
}

interface PasteListingState {
	phase: "listing";
	mimes: string[];
	kittyDotPayload?: true;
	pw?: string;
	loc?: string;
}

interface PasteReadState {
	phase: "reading";
	kind: PasteReadKind;
	mimeType: string;
	chunks: string[];
}

interface VerifiedPasteManifest {
	bytes: number;
	sha256: string;
	remaining_ms: number;
}

interface VerifiedPasteState {
	phase: "verified";
	stage: "awaiting-ok" | "manifest" | "image" | "preparing" | "committing";
	id: string;
	mimeType: string;
	startedAt: number;
	deadline: number;
	timer?: NodeJS.Timeout;
	manifest?: VerifiedPasteManifest;
	chunks: Buffer[];
	bytes: number;
	hash: Bun.CryptoHasher;
	checkTarget?: () => void;
}

type PasteState = PasteListingState | PasteReadState | VerifiedPasteState;

/** Admit synchronous editor mutations once, after all image preparation finishes. */
export type PasteImageCommit = (apply: () => void) => boolean;

export interface EnhancedPasteHandlers {
	write(data: string): void;
	pasteText(text: string): void;
	pasteImage(image: ImageContent, tryCommit?: PasteImageCommit): boolean | void | Promise<boolean | void>;
	/** Capture destination identity before a verified read, then validate it at commit. */
	captureImageTarget?(): () => void;
	showStatus(message: string): void;
}

export function isOsc5522Packet(data: string): boolean {
	return data.startsWith(OSC5522_PREFIX) && (data.endsWith(OSC_TERMINATOR_ST) || data.endsWith(OSC_TERMINATOR_BEL));
}

function decodeBase64Utf8(value: string): string | undefined {
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		return undefined;
	}
}

function decodeVerifiedBase64(value: string): Buffer | undefined {
	if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
		return undefined;
	}
	const bytes = Buffer.from(value, "base64");
	return bytes.toString("base64") === value ? bytes : undefined;
}

function parseVerifiedManifest(bytes: Buffer, mimeType: string): VerifiedPasteManifest | undefined {
	if (bytes.byteLength > MAX_MANIFEST_BYTES) return undefined;
	try {
		const text = manifestDecoder.decode(bytes);
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const manifest = value as Record<string, unknown>;
		if (
			Object.keys(manifest).length !== 5 ||
			manifest.version !== 1 ||
			manifest.mime !== mimeType ||
			typeof manifest.bytes !== "number" ||
			!Number.isSafeInteger(manifest.bytes) ||
			manifest.bytes <= 0 ||
			typeof manifest.sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(manifest.sha256) ||
			typeof manifest.remaining_ms !== "number" ||
			!Number.isInteger(manifest.remaining_ms) ||
			manifest.remaining_ms < 1 ||
			manifest.remaining_ms > VERIFIED_TIMEOUT_MS
		) {
			return undefined;
		}
		// The private profile uses canonical compact JSON, which also excludes duplicate keys.
		if (JSON.stringify(manifest) !== text) return undefined;
		return { bytes: manifest.bytes, sha256: manifest.sha256, remaining_ms: manifest.remaining_ms };
	} catch {
		return undefined;
	}
}

function parseMetadata(raw: string): Pick<Osc5522Packet, "metadata" | "invalidMetadata" | "hasVerifiedId"> {
	const metadata = new Map<string, string>();
	let invalidMetadata = false;
	let hasVerifiedId = false;
	for (const part of raw.split(":")) {
		const eq = part.indexOf("=");
		if (eq <= 0) {
			invalidMetadata = true;
			continue;
		}
		const key = part.slice(0, eq);
		if (metadata.has(key)) invalidMetadata = true;
		const value = part.slice(eq + 1);
		if (key === "id" && value.startsWith(VERIFIED_ID_PREFIX)) hasVerifiedId = true;
		metadata.set(key, value);
	}
	return { metadata, invalidMetadata, hasVerifiedId };
}

export function parseOsc5522Packet(data: string): Osc5522Packet | undefined {
	if (!isOsc5522Packet(data)) return undefined;
	const bodyEnd = data.endsWith(OSC_TERMINATOR_BEL) ? data.length - 1 : data.length - OSC_TERMINATOR_ST.length;
	const body = data.slice(OSC5522_PREFIX.length, bodyEnd);
	const separator = body.indexOf(";");
	const metadataRaw = separator === -1 ? body : body.slice(0, separator);
	const payload = separator === -1 ? "" : body.slice(separator + 1);
	return { ...parseMetadata(metadataRaw), payload };
}

function choosePasteMime(mimes: readonly string[]): { kind: PasteReadKind; mimeType: string } | undefined {
	for (const mimeType of IMAGE_MIME_PRIORITY) {
		if (mimes.includes(mimeType)) return { kind: "image", mimeType };
	}
	return mimes.includes(TEXT_MIME_TYPE) ? { kind: "text", mimeType: TEXT_MIME_TYPE } : undefined;
}

export class EnhancedPasteController {
	#state: PasteState | undefined;
	#handlers: EnhancedPasteHandlers;

	constructor(handlers: EnhancedPasteHandlers) {
		this.#handlers = handlers;
	}

	enable(): void {
		this.cancelPending("Image paste canceled because the terminal restarted");
		this.#handlers.write("\x1b[?5522h");
	}

	disable(): void {
		this.cancelPending("Image paste canceled because the terminal stopped");
		this.#handlers.write("\x1b[?5522l");
	}

	/** Cancel uncommitted work. Only a verified attempt owns the optional status. */
	cancelPending(message?: string): void {
		const state = this.#state;
		if (state?.phase === "verified") {
			this.#finishVerified(state, state.stage === "committing" ? undefined : message);
		} else {
			this.#state = undefined;
		}
	}

	handleInput(data: string): boolean {
		const packet = parseOsc5522Packet(data);
		if (!packet) return false;
		void this.#handlePacket(packet);
		return true;
	}

	async #handlePacket(packet: Osc5522Packet): Promise<void> {
		const type = packet.metadata.get("type");
		const status = packet.metadata.get("status");
		const id = packet.metadata.get("id");
		const state = this.#state;
		if (state?.phase === "verified") {
			if (id !== state.id) {
				if (type === "read" && !id && !packet.hasVerifiedId && status === "OK") {
					this.#handlers.showStatus("Image paste is busy. Wait for the active paste to finish");
				}
				return;
			}
			try {
				await this.#handleVerifiedPacket(state, packet);
			} catch {
				this.#finishVerified(state, "Image paste verification failed");
			}
			return;
		}
		// A canceled or unknown verified reply must never become a legacy paste.
		if (packet.hasVerifiedId) return;
		if (type !== "read") return;
		if (status === "OK") {
			this.#handleOk(packet);
			return;
		}
		if (status === "DATA") {
			this.#handleData(packet);
			return;
		}
		if (status === "DONE") {
			await this.#handleDone();
			return;
		}
		if (status) {
			this.#state = undefined;
			this.#handlers.showStatus(`Enhanced paste failed: ${status}`);
		}
	}

	#handleOk(packet: Osc5522Packet): void {
		if (this.#state?.phase === "reading") return;
		const loc = packet.metadata.get("loc");
		this.#state = {
			phase: "listing",
			mimes: [],
			pw: packet.metadata.get("pw"),
			loc: loc === "primary" ? loc : undefined,
		};
	}

	#handleData(packet: Osc5522Packet): void {
		const state = this.#state;
		if (!state) return;
		if (state.phase === "verified") return;
		const encodedMime = packet.metadata.get("mime");
		if (!encodedMime) return;
		const mimeType = decodeBase64Utf8(encodedMime);
		if (!mimeType) return;

		if (state.phase === "listing") {
			// Kitty (as of writing) implements the "list available MIME types"
			// response shape by sending a single DATA packet with `mime="."` and
			// the available types packed into the payload as a whitespace-
			// separated list (see `fulfill_read_request` in
			// kovidgoyal/kitty:kitty/clipboard.py). The 5522-mode ancillary
			// spec instead encodes each type as its own DATA packet with an
			// empty payload. Support both — fall through to the per-packet
			// form when the dot sentinel has no payload, or when the packet
			// already names a concrete MIME type.
			if (mimeType === MIME_LISTING_TARGET) {
				if (!packet.payload) return;
				const listing = decodeBase64Utf8(packet.payload);
				if (!listing) return;
				state.kittyDotPayload = true;
				for (const candidate of listing.split(/\s+/)) {
					if (candidate && candidate !== MIME_LISTING_TARGET) state.mimes.push(candidate);
				}
				return;
			}
			state.mimes.push(mimeType);
			return;
		}

		if (state.mimeType === mimeType && packet.payload) {
			state.chunks.push(packet.payload);
		}
	}

	async #handleDone(): Promise<void> {
		const state = this.#state;
		if (!state) return;
		if (state.phase === "verified") return;
		if (state.phase === "listing") {
			this.#finishListing(state);
			return;
		}
		this.#state = undefined;
		const bytes = Buffer.concat(state.chunks.map(chunk => Buffer.from(chunk, "base64")));
		if (bytes.byteLength === 0) {
			this.#handlers.showStatus("Clipboard paste was empty");
			return;
		}
		if (state.kind === "text") {
			this.#handlers.pasteText(bytes.toString("utf8"));
			return;
		}
		await this.#handlers.pasteImage({
			type: "image",
			data: bytes.toString("base64"),
			mimeType: state.mimeType,
		});
	}

	#finishListing(state: PasteListingState): void {
		const selected = choosePasteMime(state.mimes);
		if (state.mimes.includes(VERIFIED_PASTE_MIME)) {
			if (selected?.kind === "image") {
				this.#startVerified(state, selected.mimeType);
			} else {
				this.#state = undefined;
				this.#handlers.showStatus("Verified image paste has no supported image data");
			}
			return;
		}
		if (!selected) {
			this.#state = undefined;
			this.#handlers.showStatus("Clipboard paste has no supported text or image data");
			return;
		}

		this.#state = {
			phase: "reading",
			kind: selected.kind,
			mimeType: selected.mimeType,
			chunks: [],
		};

		const encodedMime = Buffer.from(selected.mimeType, "utf8").toString("base64");
		const metadata = ["type=read"];
		if (state.loc) metadata.push(`loc=${state.loc}`);
		if (state.pw) {
			metadata.push(`pw=${state.pw}`, `name=${PASTE_EVENT_NAME_BASE64}`);
		}
		if (state.kittyDotPayload) {
			this.#handlers.write(`${OSC5522_PREFIX}${metadata.join(":")};${encodedMime}${OSC_TERMINATOR_BEL}`);
			return;
		}
		metadata.push(`mime=${encodedMime}`);
		this.#handlers.write(`${OSC5522_PREFIX}${metadata.join(":")}${OSC_TERMINATOR_BEL}`);
	}

	#startVerified(listing: PasteListingState, mimeType: string): void {
		const id = `${VERIFIED_ID_PREFIX}${crypto.randomUUID()}`;
		const metadata = ["type=read", `id=${id}`];
		if (listing.loc) metadata.push(`loc=${listing.loc}`);
		if (listing.pw) metadata.push(`pw=${listing.pw}`, `name=${PASTE_EVENT_NAME_BASE64}`);
		const payload = Buffer.from(`${VERIFIED_PASTE_MIME} ${mimeType}`, "utf8").toString("base64");
		const startedAt = performance.now();
		const state: VerifiedPasteState = {
			phase: "verified",
			stage: "awaiting-ok",
			id,
			mimeType,
			startedAt,
			deadline: startedAt + VERIFIED_TIMEOUT_MS,
			chunks: [],
			bytes: 0,
			hash: new Bun.CryptoHasher("sha256"),
		};
		this.#state = state;
		this.#armVerifiedTimer(state);
		try {
			state.checkTarget = this.#handlers.captureImageTarget?.();
			this.#handlers.write(`${OSC5522_PREFIX}${metadata.join(":")};${payload}${OSC_TERMINATOR_BEL}`);
		} catch {
			this.#finishVerified(state, "Image paste request failed");
		}
	}

	#finishVerified(state: VerifiedPasteState, message?: string): void {
		if (this.#state !== state) return;
		clearTimeout(state.timer);
		state.chunks = [];
		this.#state = undefined;
		if (message) this.#handlers.showStatus(message);
	}

	#checkVerifiedDeadline(state: VerifiedPasteState): boolean {
		if (this.#state !== state) return false;
		if (performance.now() < state.deadline) return true;
		this.#finishVerified(state, "Image paste expired. Paste the image again");
		return false;
	}

	#armVerifiedTimer(state: VerifiedPasteState): void {
		clearTimeout(state.timer);
		state.timer = setTimeout(
			() => {
				if (this.#checkVerifiedDeadline(state)) this.#armVerifiedTimer(state);
			},
			Math.max(0, state.deadline - performance.now()),
		);
	}

	async #handleVerifiedPacket(state: VerifiedPasteState, packet: Osc5522Packet): Promise<void> {
		if (!this.#checkVerifiedDeadline(state)) return;
		if (packet.invalidMetadata || packet.metadata.get("type") !== "read") {
			this.#finishVerified(state, "Image paste response metadata was invalid");
			return;
		}
		const status = packet.metadata.get("status");
		if (status === "DATA") {
			this.#handleVerifiedData(state, packet);
			return;
		}
		if (packet.payload || packet.metadata.has("mime")) {
			this.#finishVerified(state, "Image paste response was invalid");
			return;
		}
		if (status === "OK" && state.stage === "awaiting-ok") {
			state.stage = "manifest";
			return;
		}
		if (status !== "DONE") {
			this.#finishVerified(state, "Image paste failed at the terminal");
			return;
		}
		if (state.stage === "preparing" || state.stage === "committing") return;
		if (
			state.stage !== "image" ||
			!state.manifest ||
			state.bytes !== state.manifest.bytes ||
			state.hash.digest("hex") !== state.manifest.sha256
		) {
			this.#finishVerified(state, "Image paste was incomplete or failed verification");
			return;
		}
		state.stage = "preparing";
		const image: ImageContent = {
			type: "image",
			data: Buffer.concat(state.chunks, state.bytes).toString("base64"),
			mimeType: state.mimeType,
		};
		state.chunks = [];
		try {
			const result = await this.#handlers.pasteImage(image, apply => {
				if (state.stage !== "preparing" || !this.#checkVerifiedDeadline(state)) return false;
				state.checkTarget?.();
				state.stage = "committing";
				try {
					apply();
					return true;
				} catch {
					this.#finishVerified(state, "Image paste failed during attachment");
					return false;
				} finally {
					this.#finishVerified(state);
				}
			});
			this.#finishVerified(state, result === false ? undefined : "Image paste did not commit");
		} catch (error) {
			this.#finishVerified(
				state,
				error instanceof Error
					? `Image paste preparation failed: ${error.message}`
					: "Image paste preparation failed",
			);
		}
	}

	#handleVerifiedData(state: VerifiedPasteState, packet: Osc5522Packet): void {
		const mimeType = decodeVerifiedBase64(packet.metadata.get("mime") ?? "")?.toString("utf8");
		if (
			(mimeType !== VERIFIED_PASTE_MIME && mimeType !== state.mimeType) ||
			(mimeType === VERIFIED_PASTE_MIME &&
				(state.stage !== "manifest" || packet.payload.length > Math.ceil(MAX_MANIFEST_BYTES / 3) * 4)) ||
			(mimeType === state.mimeType && state.stage !== "image")
		) {
			this.#finishVerified(state, "Image paste contained an unexpected representation");
			return;
		}
		const bytes = decodeVerifiedBase64(packet.payload);
		if (!bytes) {
			this.#finishVerified(state, "Image paste contained invalid base64 data");
			return;
		}
		if (mimeType === VERIFIED_PASTE_MIME) {
			const manifest = parseVerifiedManifest(bytes, state.mimeType);
			if (!manifest) {
				this.#finishVerified(state, "Image paste manifest was invalid");
				return;
			}
			state.manifest = manifest;
			state.deadline = Math.min(state.deadline, state.startedAt + manifest.remaining_ms);
			if (!this.#checkVerifiedDeadline(state)) return;
			this.#armVerifiedTimer(state);
			state.stage = "image";
			return;
		}
		if (!state.manifest || bytes.byteLength > state.manifest.bytes - state.bytes) {
			this.#finishVerified(state, "Image paste exceeded its declared byte count");
			return;
		}
		state.bytes += bytes.byteLength;
		state.hash.update(bytes);
		state.chunks.push(bytes);
	}
}
