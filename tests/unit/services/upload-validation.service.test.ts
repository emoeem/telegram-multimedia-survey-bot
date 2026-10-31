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
