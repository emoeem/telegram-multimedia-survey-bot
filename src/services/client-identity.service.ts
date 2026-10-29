import { isSharedSecretValid } from "../core/security";

/**
 * Who is really calling, and whether a trusted relay vouched for it.
 *
 * The Worker is normally the outermost hop, so Cloudflare's `CF-Connecting-IP`
 * *is* the caller. A mainland-China deployment adds a second, China-reachable
 * hop in front of it (see `cn-relay/` and docs/CN_ACCESS_VERCEL_RELAY.md)
 * because Cloudflare's own POPs are reached from China over long, lossy
 * routes. From Cloudflare's point of view every visitor behind that relay
 * becomes the relay's single address, which collapses the per-IP rate limits
 * into one shared bucket and records the relay's country as the respondent's.
 *
 * The relay therefore proves itself with a shared secret header. Only while
 * that secret matches do we believe the visitor identity headers it forwards:
 * trusting them unconditionally would let anyone spoof the address and walk
 * straight past the limiters.
 */

/** Header the relay uses to prove it is the relay. Clients cannot set it: the relay overwrites it. */
export const RELAY_SECRET_HEADER = "x-relay-token";
/**
 * Single-value visitor IP headers, in order of trust.
 *
 * Measured on the live chain rather than taken from either platform's docs.
 * Vercel forwards the visitor in `x-vercel-proxied-for` (which it overwrites, so
 * a client cannot forge it). Our own `x-relay-client-ip` is first so a
 * self-hosted Caddy/nginx relay has a header Cloudflare leaves alone.
 *
 * `x-real-ip` is deliberately **not** read: Cloudflare overwrites it with the
 * address it is connected to, so behind the relay it holds Vercel's egress
 * address rather than the visitor's — reading it silently collapsed every
 * domestic visitor into a single rate-limit bucket.
 */
export const RELAY_CLIENT_IP_HEADERS = ["x-relay-client-ip", "x-vercel-proxied-for"] as const;
/** Chain whose left-most entry is the original visitor. */
export const RELAY_CLIENT_IP_CHAIN_HEADER = "x-forwarded-for";
/** Country of the visitor as computed by the relay: ours first, then Vercel's own geo header. */
export const RELAY_COUNTRY_HEADERS = ["x-relay-country", "x-vercel-ip-country"] as const;
/** Cloudflare request geo fields that describe the relay rather than the visitor. */
export const RELAY_OBSCURED_GEO_KEYS = [
  "region",
  "regionCode",
  "city",
  "postalCode",
  "metroCode",
  "timezone",
  "asn",
  "colo",
] as const;
/** Sentinel the rate limiters already use for "no address available". */
export const UNKNOWN_CLIENT_IP = "unknown";

export interface ClientIdentityEnv {
  RELAY_SECRET?: string;
}

export interface ClientIdentity {
  /** Best-known public address of the caller, or `UNKNOWN_CLIENT_IP`. */
  ip: string;
  /**
   * False when no address could be determined at all (`ip` is then the
   * `UNKNOWN_CLIENT_IP` sentinel, not a real value).
   *
   * Callers that key a rate limiter by address MUST check this. Using the
   * sentinel as a plain string collapses every such caller into ONE bucket:
   * with `cf-connecting-ip` missing — a non-Cloudflare deployment, a local dev
   * run, a relay that strips the header — all visitors share the `unknown`
   * subject, so the per-address limit (e.g. 20 email logins/hour) is really a
   * global limit, and 20 people can lock the whole site out.
   */
  addressKnown: boolean;
  /** True only when the request carried a valid relay secret. */
  relayed: boolean;
  /** Set only when the trusted relay reported a country. */
  country?: string;
}

const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV6_PATTERN = /^[0-9a-f:]+$/i;

/**
 * Loose syntax check before a forwarded value becomes a rate-limit subject or a
 * stored record: it rejects hostnames, ports, chains and empty strings without
 * pulling in a full IP parser.
 */
export function isIpLiteral(value: string): boolean {
  if (IPV4_PATTERN.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255);
  }
  return value.includes(":") && IPV6_PATTERN.test(value);
}

function headerValue(request: Request, name: string): string {
  return request.headers.get(name)?.trim() ?? "";
}

/**
 * The visitor address as reported by the relay, or "" when it forwarded nothing
 * usable. A value that is not an IP literal is ignored rather than turned into
 * a rate-limit subject.
 */
function relayedClientIp(request: Request): string {
  for (const header of RELAY_CLIENT_IP_HEADERS) {
    const value = headerValue(request, header);
    if (isIpLiteral(value)) return value;
  }
  const chainOrigin = headerValue(request, RELAY_CLIENT_IP_CHAIN_HEADER).split(",", 1)[0]?.trim() ?? "";
  return isIpLiteral(chainOrigin) ? chainOrigin : "";
}

function relayCountry(request: Request): string | undefined {
  for (const header of RELAY_COUNTRY_HEADERS) {
    const value = headerValue(request, header);
    if (/^[a-z]{2}$/i.test(value)) return value.toUpperCase();
  }
  return undefined;
}

export function resolveClientIdentity(request: Request, env: ClientIdentityEnv): ClientIdentity {
  const peer = headerValue(request, "cf-connecting-ip");
  const peerIp = peer || UNKNOWN_CLIENT_IP;
  const relayed = isSharedSecretValid(env.RELAY_SECRET, request.headers.get(RELAY_SECRET_HEADER));
  if (!relayed) {
    return { ip: peerIp, addressKnown: peer.length > 0, relayed: false };
  }

  const forwarded = relayedClientIp(request);
  const ip = forwarded || peerIp;
  const addressKnown = forwarded.length > 0 || peer.length > 0;
  const country = relayCountry(request);
  return country ? { ip, addressKnown, relayed: true, country } : { ip, addressKnown, relayed: true };
}

/**
 * The subject to hand to an address-keyed rate limiter, or `null` when there is
 * no real address to key on.
 *
 * Chosen policy: **skip the limiter and log, do not pool**. The alternative —
 * keeping the `unknown` bucket — turns per-address limits into a site-wide one,
 * which is a far worse failure than a missing limit on a deployment that cannot
 * even see caller addresses (see `UNKNOWN_CLIENT_IP`). Callers pass `null`
 * through and warn once per request; a limit that silently blocks everyone is
 * not a limit.
 */
export function rateLimitIpSubject(identity: Pick<ClientIdentity, "ip" | "addressKnown">): string | null {
  return identity.addressKnown ? identity.ip : null;
}
