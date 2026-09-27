import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { encodeRgbPng } from "@oh-my-pi/pi-tui/apps/debug/protocol-probe";
import { ensureSupportedImageInput, imageDecodeFailureReason } from "@oh-my-pi/pi-tui/chat/image-loading";
import { blobExtensionForImageMimeType } from "@oh-my-pi/pi-tui/prompt/image-format";
import { parseImageMetadata } from "@oh-my-pi/pi-utils";

function makeTiff(littleEndian: boolean): Buffer {
	const entries = [
		[256, 4, 2], // Width
		[257, 4, 1], // Height
		[258, 3, 8], // Bits per sample
		[259, 3, 1], // No compression
		[262, 3, 1], // Black is zero
		[273, 4, 122], // Strip offset
		[277, 3, 1], // Samples per pixel
		[278, 4, 1], // Rows per strip
		[279, 4, 2], // Strip byte count
	];
	const bytes = Buffer.alloc(124);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	bytes.fill(littleEndian ? 0x49 : 0x4d, 0, 2);
	view.setUint16(2, 42, littleEndian);
	view.setUint32(4, 8, littleEndian);
	view.setUint16(8, entries.length, littleEndian);
	for (const [index, [tag, type, value]] of entries.entries()) {
		const offset = 10 + index * 12;
		view.setUint16(offset, tag, littleEndian);
		view.setUint16(offset + 2, type, littleEndian);
		view.setUint32(offset + 4, 1, littleEndian);
		if (type === 3) view.setUint16(offset + 8, value, littleEndian);
		else view.setUint32(offset + 8, value, littleEndian);
	}
	bytes.set([0, 255], 122);
	return bytes;
}

function image(bytes: Uint8Array, mimeType = "image/tiff"): ImageContent {
	return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType };
}

const png: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/png",
};

describe("verified TIFF image input", () => {
	for (const littleEndian of [true, false]) {
		const byteOrder = littleEndian ? "little-endian" : "big-endian";

		it(`validates and normalizes ${byteOrder} TIFF with its original pixels`, async () => {
			const original = image(makeTiff(littleEndian));
			const originalData = original.data;
			const failure = await imageDecodeFailureReason(original, true);
			const normalized = await ensureSupportedImageInput(original);
			expect(failure).toBeNull();
			expect(normalized?.mimeType).toBe("image/png");
			expect(parseImageMetadata(Buffer.from(normalized!.data, "base64"))).toMatchObject({
				mimeType: "image/png",
				width: 2,
				height: 1,
			});
			expect(await imageDecodeFailureReason(normalized!, true)).toBeNull();
			// Compare both rasters through the same lossless encoder, independent of PNG color type and filters.
			const expected = encodeRgbPng(2, 1, new Uint8Array([0, 0, 0, 255, 255, 255]));
			expect(await new Bun.Image(Buffer.from(normalized!.data, "base64")).webp({ lossless: true }).bytes()).toEqual(
				await new Bun.Image(expected).webp({ lossless: true }).bytes(),
			);
			expect(original.data).toBe(originalData);
			expect(original.mimeType).toBe("image/tiff");
			expect(blobExtensionForImageMimeType(original.mimeType)).toBe("tiff");
		});

		it(`rejects a ${byteOrder} TIFF with a PNG declaration`, async () => {
			expect(await imageDecodeFailureReason(image(makeTiff(littleEndian), "image/png"), true)).not.toBeNull();
		});

		it(`rejects a ${byteOrder} TIFF with missing raster bytes`, async () => {
			const truncated = image(makeTiff(littleEndian).subarray(0, -2));
			expect(await imageDecodeFailureReason(truncated, true)).not.toBeNull();
			expect(await ensureSupportedImageInput(truncated)).toBeNull();
		});

		it(`rejects truncated and corrupt ${byteOrder} TIFF data`, async () => {
			const bytes = makeTiff(littleEndian);
			for (let length = 0; length <= 8; length++) {
				expect(await imageDecodeFailureReason(image(bytes.subarray(0, length)), true)).not.toBeNull();
			}
			new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(4, 0xffffffff, littleEndian);
			expect(await imageDecodeFailureReason(image(bytes), true)).not.toBeNull();
			expect(await ensureSupportedImageInput(image(bytes))).toBeNull();
		});
	}

	it("rejects a PNG with a TIFF declaration and preserves native PNG input", async () => {
		expect(await imageDecodeFailureReason({ ...png, mimeType: "image/tiff" }, true)).not.toBeNull();
		expect(await imageDecodeFailureReason(png, true)).toBeNull();
		expect(await ensureSupportedImageInput(png)).toBe(png);
	});

	it("rejects unknown containers even when they declare TIFF", async () => {
		expect(await imageDecodeFailureReason(image(Buffer.from("not an image")), true)).not.toBeNull();
	});
});
