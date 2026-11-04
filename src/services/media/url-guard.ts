/**
 * SSRF guard for server-side fetches of stored or editor-supplied URLs.
 *
 * Report rendering fetches image URLs on the Worker (report image inlining,
 * media 302 redirects). Those URLs come from admin-authored content and — via
 * result rule sets that copy answer values into image slots — can carry
 * respondent-influenced strings. A probe response in the 2026-10-31 incident
 * tested exactly this (a `169.254.169.254` metadata URL pasted into answer
 * fields). The guard keeps the fetch pointed at public web hosts only:
 *
 *   * http/https schemes only, standard ports only;
 *   * localhost / *.internal / *.local / *.home.arpa names rejected;
 *   * IP-literal hosts rejected when private, loopback, link-local
 *     (169.254.0.0/16 — the cloud metadata range), CGNAT or reserved;
 *   * non-canonical numeric host forms (hex/octal/short IPv4 like
 *     `0x7f.0.0.1`, `127.1`) rejected — they only ever name internal hosts.
 *
 * Workers cannot resolve DNS ahead of `fetch`, so a hostname resolving to an
 * internal address after these checks is out of scope here (Cloudflare's
 * edge resolver cannot reach the requestor's link-local network either).
 * The guard is defense in depth behind escaping, not a sandbox boundary.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "169.254.169.254",
]);

const PRIVATE_HOST_SUFFIXES = [".localhost", ".internal", ".local", ".home.arpa", ".corp", ".lan"];

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return true;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true; // unspecified, loopback
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local fc00::/7
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true; // link-local fe80::/10
  }
  const mappedDotted = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedDotted) return isPrivateIpv4(mappedDotted[1] ?? "");
  // URL normalization rewrites `[::ffff:127.0.0.1]` to the hex form
  // `[::ffff:7f00:1]`; decode the trailing two groups back into the IPv4
  // bytes and classify those.
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4})(?::([0-9a-f]{1,4}))?$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1] ?? "0", 16);
    const low = parseInt(mappedHex[2] ?? "0", 16);
    const octets = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
    return isPrivateIpv4(octets.join("."));
  }
  return false;
}

/**
 * True when `value` is an http(s) URL on a standard port whose host is a
 * public name or a public IP literal. Intentionally strict: this is a gate
 * for machine fetches, not a browser address bar.
 */
export function isFetchablePublicUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.port && url.port !== "80" && url.port !== "443") return false;

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) return false;
  if (BLOCKED_HOSTNAMES.has(hostname)) return false;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return false;

  if (hostname.startsWith("[")) {
    // IPv6 literal, e.g. [::1] or [fd00::1].
    return !isPrivateIpv6(hostname.slice(1, -1));
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return !isPrivateIpv4(hostname);
  }
  // Hex/octal/short/integer numeric forms (`0x7f.1`, `127.1`, `2130706433`,
  // `0x7f000001`) name loopback-style addresses in some resolvers and are
  // never legitimate public hosts — reject instead of normalizing them.
  if (/^[0-9a-fx]+$/.test(hostname.replaceAll(".", ""))) {
    return false;
  }
  return true;
}

/** Throws with a user-facing message when `value` is not a fetchable public URL. */
export function assertFetchablePublicUrl(value: string): void {
  if (!isFetchablePublicUrl(value)) {
    throw new Error("不允许的图片地址：仅支持公网 http(s) 链接");
  }
}
