import { describe, expect, it } from "vitest";

import { assertFetchablePublicUrl, isFetchablePublicUrl } from "../../../src/services/media/url-guard";

describe("url-guard (SSRF)", () => {
  const allowed = [
    "https://example.com/a.png",
    "http://example.com/a.png",
    "https://sub.example-path.io:443/x",
    "http://1.2.3.4/x",
    "https://8.8.8.8/",
    // Trailing-dot FQDN is the same public host.
    "https://example.com./a",
  ];

  it("allows public http(s) URLs", () => {
    for (const url of allowed) expect(isFetchablePublicUrl(url)).toBe(true);
  });

  it("rejects non-http schemes and non-standard ports", () => {
    expect(isFetchablePublicUrl("ftp://example.com/a")).toBe(false);
    expect(isFetchablePublicUrl("file:///etc/passwd")).toBe(false);
    expect(isFetchablePublicUrl("javascript:alert(1)")).toBe(false);
    expect(isFetchablePublicUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isFetchablePublicUrl("https://example.com:8080/a")).toBe(false);
    expect(isFetchablePublicUrl("http://example.com:22/a")).toBe(false);
    expect(isFetchablePublicUrl("not a url")).toBe(false);
  });

  it("rejects loopback / private / link-local IPv4 literals", () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://127.0.0.2:80/",
      "http://10.0.0.1/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://169.254.169.254/", // cloud metadata — the exact probe from the 2026-10-31 incident
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://224.0.0.1/",
      "http://255.255.255.255/",
    ]) {
      expect(isFetchablePublicUrl(url), url).toBe(false);
    }
  });

  it("rejects private IPv6 literals and IPv4-mapped forms", () => {
    for (const url of [
      "http://[::1]/",
      "http://[::]/",
      "http://[fe80::1]/",
      "http://[fd00::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
    ]) {
      expect(isFetchablePublicUrl(url), url).toBe(false);
    }
  });

  it("rejects internal hostnames and numeric address tricks", () => {
    for (const url of [
      "http://localhost/",
      "http://localhost:80/",
      "http://metadata.google.internal/",
      "http://metadata/",
      "http://service.internal/",
      "http://box.local/",
      "http://host.home.arpa/",
      // Hex / octal / short / integer encodings of loopback-style addresses.
      "http://0x7f.0.0.1/",
      "http://0177.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
    ]) {
      expect(isFetchablePublicUrl(url), url).toBe(false);
    }
  });

  it("keeps numeric-looking but legitimate domains fetchable", () => {
    // "123.com" style hosts are rare but real; the guard only rejects forms
    // whose entire character set is numeric/hex (address encodings).
    expect(isFetchablePublicUrl("https://123.com/a")).toBe(true);
    expect(isFetchablePublicUrl("https://a1.example.com/")).toBe(true);
  });

  it("assertFetchablePublicUrl throws with a Chinese user-facing message", () => {
    expect(() => assertFetchablePublicUrl("http://169.254.169.254/")).toThrow("仅支持公网");
    expect(() => assertFetchablePublicUrl("https://example.com/ok.png")).not.toThrow();
  });
});
