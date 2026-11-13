import { imageSize } from "image-size";

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
 *   * when the signature identifies a single format, the declared MIME must
 *     equal the detected one or be one of its documented aliases (see
 *     EXACT_MIME_ALIASES) — family-level agreement alone used to let a PNG
 *     through as image/jpeg;
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
 * Magic-number 可识别格式的精确 MIME 放行表（key = `detectContent` 的
 * `format`，value = 该格式全部等价的声明 MIME）。
 *
 * 此前校验只比较 detected.family 与声明 family：PNG 冒充 image/jpeg、MP3
 * 冒充 audio/ogg 这类同 family 错配照样入库，而存储与响应沿用的还是用户
 * 声明的 MIME —— 后续一切按 MIME 做的渲染/转码决策都建立在错误标签上。
 * 现在声明的完整 MIME 必须与检测 MIME 一致，或属于同格式的等价别名
 * （image/jpg ↔ image/jpeg、audio/x-wav ↔ audio/wav 这类浏览器/平台的
 * 历史写法），才放行。
 *
 * 刻意不进表、维持 family 级检查的 detected 输出：
 *   * zip/rar/7z —— 容器/归档格式：docx/xlsx/jar/apk 本身就是 zip，声明
 *     MIME（如 OOXML 系）与 application/zip 不同是合法的，精确匹配会误杀
 *     正常文档上传；
 *   * text —— `looksTextual` 启发式而非魔数签名，声明为任意 document MIME
 *     的纯文本（json/csv/md）都合法，不能按 text/plain 精确卡死；
 *   * detected === null —— 无法识别，维持既有策略（媒体类拒、文档类放）。
 */
const EXACT_MIME_ALIASES: Record<string, readonly string[]> = {
  jpeg: ["image/jpeg", "image/jpg", "image/pipeg"],
  png: ["image/png", "image/x-png"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  avif: ["image/avif"],
  heic: ["image/heic", "image/heif"],
  bmp: ["image/bmp", "image/x-bmp", "image/x-ms-bmp"],
  tiff: ["image/tiff"],
  webm: ["video/webm"],
  mov: ["video/quicktime"],
  mp4: ["video/mp4"],
  m4a: ["audio/mp4", "audio/x-m4a", "audio/m4a"],
  ogg: ["audio/ogg", "application/ogg"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
  flac: ["audio/flac", "audio/x-flac"],
  mp3: ["audio/mpeg", "audio/mp3", "audio/x-mpeg"],
  aac: ["audio/aac"],
  pdf: ["application/pdf", "application/x-pdf"],
  rtf: ["application/rtf", "text/rtf"],
};

/** 声明 MIME 的可比形式：小写并去掉 `;codecs=...` 之类的参数。 */
function baseMime(mime: string): string {
  const [base] = mime.split(";");
  return (base ?? "").trim().toLowerCase();
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
    // family 通过后还要过精确门：魔数可识别的单格式文件，声明 MIME 必须与
    // 检测 MIME 一致或是等价别名，否则同 family 错配（PNG 冒充 image/jpeg、
    // MP3 冒充 audio/ogg、WebM 冒充 video/mp4）也会像以前那样入库。不在表
    // 中的 detected 输出（容器格式/启发式 text）维持 family 级检查，见
    // EXACT_MIME_ALIASES 的注释。
    const allowed = EXACT_MIME_ALIASES[detected.format];
    if (allowed && !allowed.includes(baseMime(declaredMime))) {
      return {
        ok: false,
        detected,
        reason: `文件内容与声明的类型不符（实际为 ${detected.format}）`,
      };
    }
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

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Parses the image structure far enough to prove the bytes decode as a real
 * image, returning its dimensions. `detectContent` only matches an 8-byte
 * magic prefix, so a probe file (PNG magic + zero bytes) used to pass as
 * `image/png`, land in storage and export archives as a "broken image". The
 * structural parse rejects anything a renderer could not draw anyway.
 *
 * Returns null when the bytes do not parse; callers turn that into a
 * user-facing rejection.
 */
export function inspectImageStructure(bytes: Uint8Array): ImageDimensions | null {
  try {
    const dimensions = imageSize(bytes);
    if (!dimensions.width || !dimensions.height) return null;
    return { width: dimensions.width, height: dimensions.height };
  } catch {
    return null;
  }
}

/** User-facing rejection for declared-image uploads whose bytes do not parse. */
export const INVALID_IMAGE_CONTENT_MESSAGE = "图片文件已损坏或不是有效的图片，请重新选择";

/**
 * Full gate for uploads declared as images: the magic-byte content check plus
 * a structural parse. Non-image declarations pass through unchanged (only the
 * content check applies) so documents and octet-stream uploads keep working.
 */
export function verifyImageUpload(
  bytes: Uint8Array,
  declaredMime: string,
): UploadValidationResult & { dimensions?: ImageDimensions } {
  const content = verifyUploadContent(bytes, declaredMime);
  if (!content.ok) return content;
  if (familyForMime(declaredMime) !== "image") return content;
  const dimensions = inspectImageStructure(bytes);
  if (!dimensions) {
    return { ok: false, detected: content.detected, reason: INVALID_IMAGE_CONTENT_MESSAGE };
  }
  return { ...content, dimensions };
}

/**
 * MIME types that a browser may execute or render as an active document
 * (HTML/SVG/XML/JS). These must never be stored as a client-declared type and
 * must never be served inline: a stored HTML document is served back verbatim
 * from `/api/.../media` and would otherwise run on the application origin.
 */
const ACTIVE_CONTENT_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xml",
  "text/xml",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/vnd.ms-html",
]);

export function isActiveContentMime(mime: string): boolean {
  return ACTIVE_CONTENT_MIME_TYPES.has(mime.toLowerCase());
}
