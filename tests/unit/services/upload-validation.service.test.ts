import { describe, expect, it } from "vitest";

import {
  isActiveContentMime,
  verifyUploadContent,
} from "../../../src/services/media/upload-validation.service";

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
});
