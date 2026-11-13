import { describe, expect, it } from "vitest";

import {
  inspectImageStructure,
  isActiveContentMime,
  verifyImageUpload,
  verifyUploadContent,
} from "../../../src/services/media/upload-validation.service";

/** Smallest valid 1x1 PNG (real IHDR/IDAT chunks). */
const VALID_1X1_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);

/** The probe file from the 2026-10-31 incident: PNG magic followed by zeros. */
function fakePng(): Uint8Array {
  const bytes = new Uint8Array(68);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

describe("upload validation service", () => {
  it("flags active-content MIME types", () => {
    for (const mime of ["text/html", "image/svg+xml", "application/xhtml+xml", "application/javascript", "text/xml"]) {
      expect(isActiveContentMime(mime)).toBe(true);
    }
    for (const mime of ["image/png", "image/jpeg", "application/pdf", "text/plain", "application/zip"]) {
      expect(isActiveContentMime(mime)).toBe(false);
    }
  });

  it("rejects HTML bytes declared as a media type", () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const result = verifyUploadContent(html, "image/png");
    expect(result.ok).toBe(false);
  });

  it("accepts a real PNG declared as image/png", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const result = verifyUploadContent(png, "image/png");
    expect(result.ok).toBe(true);
    expect(result.detected?.format).toBe("png");
  });

  it("treats textual bytes as a document (text/plain), not HTML", () => {
    const html = new TextEncoder().encode("<html><body>hello</body></html>");
    const result = verifyUploadContent(html, "application/octet-stream");
    expect(result.ok).toBe(true);
    expect(result.detected?.format).toBe("text");
  });

  it("parses a real PNG's structure and reports its dimensions", () => {
    expect(inspectImageStructure(VALID_1X1_PNG)).toEqual({ width: 1, height: 1 });
  });

  it("rejects the magic-plus-zeros probe PNG structurally", () => {
    // Magic bytes alone pass verifyUploadContent — image-size is what proves
    // the bytes actually decode (the probe has no IHDR/IDAT chunks at all).
    expect(inspectImageStructure(fakePng())).toBeNull();
  });

  it("verifyImageUpload rejects a declared image whose bytes do not parse", () => {
    const contentOk = verifyUploadContent(fakePng(), "image/png");
    expect(contentOk.ok).toBe(true); // magic prefix alone used to pass
    const gated = verifyImageUpload(fakePng(), "image/png");
    expect(gated.ok).toBe(false);
    expect(gated.reason).toContain("图片文件已损坏");
  });

  it("verifyImageUpload passes a real image with dimensions", () => {
    const result = verifyImageUpload(VALID_1X1_PNG, "image/png");
    expect(result.ok).toBe(true);
    expect(result.dimensions).toEqual({ width: 1, height: 1 });
  });

  it("verifyImageUpload does not structurally-check non-image declarations", () => {
    // Documents (including octet-stream) keep the content check only: image-size
    // cannot parse docx/pdf and must not start rejecting legitimate uploads.
    const textual = new TextEncoder().encode("just some notes");
    const result = verifyImageUpload(textual, "application/octet-stream");
    expect(result.ok).toBe(true);
    expect(result.dimensions).toBeUndefined();
  });
});

/** 魔数级 fixture：只用于 verifyUploadContent 的签名判定，不含可解码结构。 */
const JPEG_HEAD = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const MP3_HEAD = Uint8Array.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const WEBM_HEAD = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
const OGG_HEAD = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00]);
const WAV_HEAD = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
const ZIP_HEAD = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

/** 8 字节 PNG 魔数 + 占位字节，签名判定足够（结构校验另见上方 fakePng）。 */
function pngHead(): Uint8Array {
  const bytes = new Uint8Array(12);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

describe("upload validation exact MIME matching", () => {
  it("rejects PNG bytes declared as image/jpeg (same-family mismatch)", () => {
    const result = verifyUploadContent(pngHead(), "image/jpeg");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("png");
  });

  it("rejects JPEG bytes declared as image/png", () => {
    const result = verifyUploadContent(JPEG_HEAD, "image/png");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("jpeg");
  });

  it("rejects MP3 bytes declared as audio/ogg", () => {
    const result = verifyUploadContent(MP3_HEAD, "audio/ogg");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("mp3");
  });

  it("rejects WebM bytes declared as video/mp4", () => {
    const result = verifyUploadContent(WEBM_HEAD, "video/mp4");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("webm");
  });

  it("accepts exact declared/detected MIME matches", () => {
    const png = verifyUploadContent(pngHead(), "image/png");
    expect(png.ok).toBe(true);
    expect(png.detected?.mime).toBe("image/png");
    const jpeg = verifyUploadContent(JPEG_HEAD, "image/jpeg");
    expect(jpeg.ok).toBe(true);
    expect(jpeg.detected?.mime).toBe("image/jpeg");
    const mp3 = verifyUploadContent(MP3_HEAD, "audio/mpeg");
    expect(mp3.ok).toBe(true);
    expect(mp3.detected?.mime).toBe("audio/mpeg");
    const webm = verifyUploadContent(WEBM_HEAD, "video/webm");
    expect(webm.ok).toBe(true);
    expect(webm.detected?.mime).toBe("video/webm");
  });

  it("accepts documented aliases and canonicalizes to the detected MIME", () => {
    const jpgAlias = verifyUploadContent(JPEG_HEAD, "image/jpg");
    expect(jpgAlias.ok).toBe(true);
    expect(jpgAlias.detected?.mime).toBe("image/jpeg");
    const wavAlias = verifyUploadContent(WAV_HEAD, "audio/x-wav");
    expect(wavAlias.ok).toBe(true);
    expect(wavAlias.detected?.mime).toBe("audio/wav");
    const parameterized = verifyUploadContent(OGG_HEAD, "audio/ogg; codecs=opus");
    expect(parameterized.ok).toBe(true);
    expect(parameterized.detected?.mime).toBe("audio/ogg");
  });

  it("keeps the family-level check for container formats and heuristic text", () => {
    // docx/xlsx/jar 本身就是 zip：声明的 OOXML MIME 与 application/zip 不同是合法的，
    // 容器格式不进精确表，否则误杀正常文档上传。
    const docx = verifyUploadContent(
      ZIP_HEAD,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(docx.ok).toBe(true);
    expect(docx.detected?.format).toBe("zip");
    // text 是 looksTextual 启发式而非魔数签名：声明为任意 document MIME 的
    // 纯文本（json/csv/md）都合法，不能按 text/plain 精确卡死。
    const json = verifyUploadContent(new TextEncoder().encode('{"ok":true}'), "application/json");
    expect(json.ok).toBe(true);
  });

  it("keeps the application/octet-stream bypass across families", () => {
    const result = verifyUploadContent(pngHead(), "application/octet-stream");
    expect(result.ok).toBe(true);
  });
});
