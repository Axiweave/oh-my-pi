//! Portable TIFF validation and PNG conversion for image attachments.

use std::io::Cursor;

use image::{DynamicImage, ImageFormat, ImageReader};
use napi::{Error, Result, bindgen_prelude::Uint8Array};
use napi_derive::napi;

use crate::task;

/// Decode the complete TIFF raster without allocating a PNG output.
///
/// # Errors
/// Rejects unsupported, invalid, truncated, or oversized TIFF images.
#[napi(js_name = "validateTiffImage")]
pub fn validate_tiff_image(bytes: Uint8Array) -> task::Promise<()> {
	// Snapshot JS-owned bytes before the worker starts to prevent concurrent
	// mutation.
	let bytes = bytes.to_vec();
	task::blocking("tiff.validate", (), move |_| decode_tiff(&bytes).map(drop))
}

/// Decode TIFF bytes and encode PNG at the original dimensions.
///
/// # Errors
/// Rejects TIFF decode failures and PNG encoding failures with their causes.
#[napi(js_name = "decodeTiffToPng")]
pub fn decode_tiff_to_png(bytes: Uint8Array) -> task::Promise<Uint8Array> {
	let bytes = bytes.to_vec();
	task::blocking("tiff.to_png", (), move |_| tiff_to_png(&bytes).map(Uint8Array::from))
}

fn decode_tiff(bytes: &[u8]) -> Result<DynamicImage> {
	// An explicit format prevents a mislabeled PNG or JPEG from passing TIFF
	// validation. ImageReader retains the default decoder allocation limits and
	// reads the full raster.
	ImageReader::with_format(Cursor::new(bytes), ImageFormat::Tiff)
		.decode()
		.map_err(|error| Error::from_reason(format!("Failed to decode TIFF image: {error}")))
}

fn tiff_to_png(bytes: &[u8]) -> Result<Vec<u8>> {
	let image = decode_tiff(bytes)?;
	let mut png = Cursor::new(Vec::new());
	image
		.write_to(&mut png, ImageFormat::Png)
		.map_err(|error| {
			Error::from_reason(format!("Failed to encode TIFF image as PNG: {error}"))
		})?;
	Ok(png.into_inner())
}

#[cfg(test)]
mod tests {
	use super::*;

	const PIXEL_OFFSET: usize = 8 + 2 + 9 * 12 + 4;
	const PIXELS: [u16; 6] = [0, 0x1234, 0xffff, 0x8000, 0x00ff, 0xff00];

	fn put_u16(bytes: &mut [u8], offset: usize, value: u16, little_endian: bool) {
		let encoded = if little_endian {
			value.to_le_bytes()
		} else {
			value.to_be_bytes()
		};
		bytes[offset..offset + 2].copy_from_slice(&encoded);
	}

	fn put_u32(bytes: &mut [u8], offset: usize, value: u32, little_endian: bool) {
		let encoded = if little_endian {
			value.to_le_bytes()
		} else {
			value.to_be_bytes()
		};
		bytes[offset..offset + 4].copy_from_slice(&encoded);
	}

	fn tiff_raster(little_endian: bool) -> Vec<u8> {
		let mut bytes = vec![0; PIXEL_OFFSET + PIXELS.len() * 2];
		bytes[..2].copy_from_slice(if little_endian { b"II" } else { b"MM" });
		put_u16(&mut bytes, 2, 42, little_endian);
		put_u32(&mut bytes, 4, 8, little_endian);
		let tags = [
			(256, 4, 3),                         // Width
			(257, 4, 2),                         // Height
			(258, 3, 16),                        // Bits per sample
			(259, 3, 1),                         // No compression
			(262, 3, 1),                         // Black is zero
			(273, 4, PIXEL_OFFSET as u32),       // Strip offset
			(277, 3, 1),                         // Samples per pixel
			(278, 4, 2),                         // Rows per strip
			(279, 4, (PIXELS.len() * 2) as u32), // Strip byte count
		];
		put_u16(&mut bytes, 8, tags.len() as u16, little_endian);
		for (index, (tag, field_type, value)) in tags.into_iter().enumerate() {
			let offset = 10 + index * 12;
			put_u16(&mut bytes, offset, tag, little_endian);
			put_u16(&mut bytes, offset + 2, field_type, little_endian);
			put_u32(&mut bytes, offset + 4, 1, little_endian);
			if field_type == 3 {
				put_u16(&mut bytes, offset + 8, value as u16, little_endian);
			} else {
				put_u32(&mut bytes, offset + 8, value, little_endian);
			}
		}
		for (index, pixel) in PIXELS.into_iter().enumerate() {
			put_u16(&mut bytes, PIXEL_OFFSET + index * 2, pixel, little_endian);
		}
		bytes
	}

	#[test]
	fn preserves_dimensions_and_pixels_in_both_byte_orders() {
		for little_endian in [true, false] {
			let bytes = tiff_raster(little_endian);
			let decoded = decode_tiff(&bytes).expect("valid TIFF must decode");
			assert_eq!((decoded.width(), decoded.height()), (3, 2));
			assert_eq!(decoded.to_luma16().as_raw().as_slice(), PIXELS);
			let png = tiff_to_png(&bytes).expect("valid TIFF must convert");
			let decoded_png = image::load_from_memory_with_format(&png, ImageFormat::Png)
				.expect("converted image must be PNG");
			assert_eq!((decoded_png.width(), decoded_png.height()), (3, 2));
			assert_eq!(decoded_png.to_luma16().as_raw().as_slice(), PIXELS);
		}
	}

	#[test]
	fn rejects_missing_or_truncated_raster_in_both_byte_orders() {
		for little_endian in [true, false] {
			let bytes = tiff_raster(little_endian);
			for length in [0, 4, 8, PIXEL_OFFSET, bytes.len() - 1] {
				assert!(decode_tiff(&bytes[..length]).is_err(), "accepted {length} bytes");
				assert!(tiff_to_png(&bytes[..length]).is_err(), "converted {length} bytes");
			}
			let mut missing_strip = bytes;
			// Replace StripOffsets with an unknown tag, leaving dimensions and
			// pixels intact.
			put_u16(&mut missing_strip, 10 + 5 * 12, 65000, little_endian);
			assert!(decode_tiff(&missing_strip).is_err());
			assert!(tiff_to_png(&missing_strip).is_err());
		}
	}

	#[test]
	fn rejects_non_tiff_even_when_another_decoder_accepts_it() {
		let png = tiff_to_png(&tiff_raster(true)).expect("valid TIFF must convert");
		assert!(decode_tiff(&png).is_err());
		assert!(tiff_to_png(&png).is_err());
		assert!(decode_tiff(b"not an image").is_err());
	}
}
