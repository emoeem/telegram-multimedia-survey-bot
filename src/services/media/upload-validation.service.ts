/**
 * Upload content validation.
 *
 * Browsers let a caller pick any `Content-Type` for a `File`, so a `.png`
 * upload whose bytes are an HTML document used to be stored and later served
 * from the media endpoint as `image/png`. Depending on the endpoint that could
 * turn into stored XSS or a confusing "broken image". Every upload that is
 * declared as an image, video, audio or PDF is therefore checked against its
 * magic bytes before it reaches storage.
 *
 * The rule is deliberately conservative:
 *   * a known signature that disagrees with the declared kind is rejected;
 *   * an image/video/audio upload with no recognizable signature is rejected;
 *   * an unrecognized document stays allowed (plain text, exotic formats)
 *     unless it carries a signature for a *different* media family.
 */

export type MediaFamily = "image" | "video" | "audio" | "document";

export interface DetectedContent {
  /** Canonical container/format label, e.g. "png", "mp4", "zip". */
  format: string;
  family: MediaFamily;
  mime: string;
}

export interface UploadValidationResult {
  ok: boolean;
  detected: DetectedContent | null;
  reason?: string;
}

function bytesAt(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  return bytes.subarray(offset, offset + length);
}

function ascii(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function matches(bytes: Uint8Array, offset: number, signature: number[]): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

function isIsoBmffBrand(bytes: Uint8Array, brand: string): boolean {
  return bytes.length >= 12 && ascii(bytesAt(bytes, 4, 4)) === "ftyp" && ascii(bytesAt(bytes, 8, 4)) === brand;
}

function looksTextual(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    // Allow tab, LF, CR and printable ASCII / UTF-8 continuation bytes.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1;
  }
  return control / sample.length < 0.02;
}

/**
 * Detects a small set of container formats from their leading bytes. Returns
 * null when no signature matches; callers decide whether that is acceptable.
 */
export function detectContent(bytes: Uint8Array): DetectedContent | null {
  if (bytes.length >= 3 && matches(bytes, 0, [0xff, 0xd8, 0xff])) {
    return { format: "jpeg", family: "image", mime: "image/jpeg" };
  }
  if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { format: "png", family: "image", mime: "image/png" };
  }
  if (ascii(bytesAt(bytes, 0, 4)) === "GIF8") {
    return { format: "gif", family: "image", mime: "image/gif" };
  }
  if (ascii(bytesAt(bytes, 0, 4)) === "RIFF" && ascii(bytesAt(bytes, 8, 4)) === "WEBP") {
    return { format: "webp", family: "image", mime: "image/webp" };
  }
  if (isIsoBmffBrand(bytes, "avif") || isIsoBmffBrand(bytes, "avis")) {
    return { format: "avif", family: "image", mime: "image/avif" };
  }
  if (
    isIsoBmffBrand(bytes, "heic") ||
    isIsoBmffBrand(bytes, "heix") ||
    isIsoBmffBrand(bytes, "hevc") ||
    isIsoBmffBrand(bytes, "mif1")
  ) {
    return { format: "heic", family: "image", mime: "image/heic" };
  }
  if (matches(bytes, 0, [0x42, 0x4d])) {
    return { format: "bmp", family: "image", mime: "image/bmp" };
  }
  if (ascii(bytesAt(bytes, 0, 3)) === "II*" || ascii(bytesAt(bytes, 0, 3)) === "MM\u0000") {
    return { format: "tiff", family: "image", mime: "image/tiff" };
  }

  if (matches(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { format: "webm", family: "video", mime: "video/webm" };
  }
  if (isIsoBmffBrand(bytes, "qt  ")) {
    return { format: "mov", family: "video", mime: "video/quicktime" };
  }
  if (bytes.length >= 12 && ascii(bytesAt(bytes, 4, 4)) === "ftyp") {
    const brand = ascii(bytesAt(bytes, 8, 4)).trim();
    if (brand.startsWith("M4A")) {
      return { format: "m4a", family: "audio", mime: "audio/mp4" };
    }
    return { format: "mp4", family: "video", mime: "video/mp4" };
  }

  if (ascii(bytesAt(bytes, 0, 4)) === "OggS") {
    return { format: "ogg", family: "audio", mime: "audio/ogg" };
  }
  if (ascii(bytesAt(bytes, 0, 4)) === "RIFF" && ascii(bytesAt(bytes, 8, 4)) === "WAVE") {
    return { format: "wav", family: "audio", mime: "audio/wav" };
  }
  if (ascii(bytesAt(bytes, 0, 4)) === "fLaC") {
    return { format: "flac", family: "audio", mime: "audio/flac" };
  }
  if (ascii(bytesAt(bytes, 0, 3)) === "ID3" || matches(bytes, 0, [0xff, 0xfb])) {
    return { format: "mp3", family: "audio", mime: "audio/mpeg" };
  }
  if (matches(bytes, 0, [0xff, 0xf1]) || matches(bytes, 0, [0xff, 0xf9])) {
    return { format: "aac", family: "audio", mime: "audio/aac" };
  }

  if (ascii(bytesAt(bytes, 0, 5)) === "%PDF-") {
    return { format: "pdf", family: "document", mime: "application/pdf" };
  }
  if (matches(bytes, 0, [0x50, 0x4b, 0x03, 0x04]) || matches(bytes, 0, [0x50, 0x4b, 0x05, 0x06])) {
    return { format: "zip", family: "document", mime: "application/zip" };
  }
  if (ascii(bytesAt(bytes, 0, 4)) === "Rar!") {
    return { format: "rar", family: "document", mime: "application/x-rar-compressed" };
  }
  if (matches(bytes, 0, [0x37, 0x7a, 0xbc, 0xaf])) {
    return { format: "7z", family: "document", mime: "application/x-7z-compressed" };
  }
  if (ascii(bytesAt(bytes, 0, 5)) === "{\\rtf") {
    return { format: "rtf", family: "document", mime: "application/rtf" };
  }
  if (looksTextual(bytes)) {
    return { format: "text", family: "document", mime: "text/plain" };
  }
  return null;
}

function familyForMime(mime: string): MediaFamily {
  const normalized = mime.toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Verifies that `bytes` are consistent with the declared MIME type.
 *
 * Returns `ok: false` with a user-facing Chinese reason when the content is
 * clearly a different kind of file, or when a media upload has no recognizable
 * signature at all.
 */
export function verifyUploadContent(bytes: Uint8Array, declaredMime: string): UploadValidationResult {
  const detected = detectContent(bytes);
  const declaredFamily = familyForMime(declaredMime);

  if (!detected) {
    if (declaredFamily === "document") {
      return { ok: true, detected: null };
    }
    return {
      ok: false,
      detected: null,
      reason: "无法识别文件内容，请重新选择有效的图片、视频或音频文件",
    };
  }

  if (detected.family === declaredFamily) {
    return { ok: true, detected };
  }

  // A PDF or ZIP uploaded for a "file" question is a document for both sides;
  // only cross-family mismatches (image bytes declared as video, HTML bytes
  // declared as image, ...) are rejected.
  if (declaredMime.toLowerCase() === "application/octet-stream") {
    return { ok: true, detected };
  }

  return {
    ok: false,
    detected,
    reason: `文件内容与声明的类型不符（实际为 ${detected.format}）`,
  };
}

/** True when the declared MIME is a media kind that must be content-checked. */
export function requiresContentCheck(mime: string): boolean {
  return familyForMime(mime) !== "document";
}
