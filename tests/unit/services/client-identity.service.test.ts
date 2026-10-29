import { describe, expect, it } from "vitest";

import {
  RELAY_SECRET_HEADER,
  UNKNOWN_CLIENT_IP,
  isIpLiteral,
  rateLimitIpSubject,
  resolveClientIdentity,
} from "../../../src/services/client-identity.service";

const SECRET = "relay-secret";

function request(headers: Record<string, string>): Request {
  return new Request("https://emoe.eu.cc/api/surveys", { headers });
}

/** What Cloudflare reports as the peer address for every relayed request. */
const RELAY_PEER = { "cf-connecting-ip": "64.29.17.1" };

describe("client identity", () => {
  it("uses the peer address when no relay secret is configured", () => {
    const identity = resolveClientIdentity(request({ ...RELAY_PEER, [RELAY_SECRET_HEADER]: SECRET }), {});
    expect(identity).toEqual({ ip: "64.29.17.1", addressKnown: true, relayed: false });
  });

  it("reports an unknown address when Cloudflare sends no peer header", () => {
    const identity = resolveClientIdentity(request({}), {});
    expect(identity.ip).toBe(UNKNOWN_CLIENT_IP);
    // 关键：地址未知必须是一个**独立信号**。把它当成普通的 "unknown" 字符串去
    // 做限流 key，所有人就共用一个桶（20 次邮件登录/小时后全站 429）。
    expect(identity.addressKnown).toBe(false);
    expect(rateLimitIpSubject(identity)).toBeNull();
  });

  it("address-known identities pass their real address to the limiter", () => {
    const identity = resolveClientIdentity(request(RELAY_PEER), {});
    expect(identity.addressKnown).toBe(true);
    expect(rateLimitIpSubject(identity)).toBe("64.29.17.1");
  });

  it("a relay that forwards a real visitor address counts as known", () => {
    const identity = resolveClientIdentity(
      request({ [RELAY_SECRET_HEADER]: SECRET, "x-relay-client-ip": "203.0.113.9" }),
      { RELAY_SECRET: SECRET },
    );
    expect(identity.addressKnown).toBe(true);
    expect(rateLimitIpSubject(identity)).toBe("203.0.113.9");
  });

  it("ignores forwarded identity headers that arrive without the secret", () => {
    // Anyone can send these; without the secret they must not become the
    // rate-limit subject, or one visitor could rotate fake IPs forever.
    const identity = resolveClientIdentity(
      request({ ...RELAY_PEER, "x-relay-client-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9" }),
      { RELAY_SECRET: SECRET },
    );
    expect(identity.ip).toBe("64.29.17.1");
    expect(identity.relayed).toBe(false);
  });

  it("ignores forwarded identity headers when the secret is wrong", () => {
    const identity = resolveClientIdentity(
      request({ ...RELAY_PEER, [RELAY_SECRET_HEADER]: "not-the-secret", "x-relay-client-ip": "203.0.113.9" }),
      { RELAY_SECRET: SECRET },
    );
    expect(identity.ip).toBe("64.29.17.1");
    expect(identity.relayed).toBe(false);
  });

  it("trusts the forwarded visitor address once the secret matches", () => {
    const identity = resolveClientIdentity(
      request({ ...RELAY_PEER, [RELAY_SECRET_HEADER]: SECRET, "x-relay-client-ip": "203.0.113.9" }),
      { RELAY_SECRET: SECRET },
    );
    expect(identity).toEqual({ ip: "203.0.113.9", addressKnown: true, relayed: true });
  });

  it("reads the header Vercel forwards for a proxied visitor", () => {
    const identity = resolveClientIdentity(
      request({ ...RELAY_PEER, [RELAY_SECRET_HEADER]: SECRET, "x-vercel-proxied-for": "203.0.113.9" }),
      { RELAY_SECRET: SECRET },
    );
    expect(identity).toEqual({ ip: "203.0.113.9", addressKnown: true, relayed: true });
  });

  it("prefers our own header over Vercel's spelling", () => {
    const identity = resolveClientIdentity(
      request({
        ...RELAY_PEER,
        [RELAY_SECRET_HEADER]: SECRET,
        "x-relay-client-ip": "203.0.113.9",
        "x-vercel-proxied-for": "198.51.100.7",
      }),
      { RELAY_SECRET: SECRET },
    );
    expect(identity.ip).toBe("203.0.113.9");
  });

  it("ignores x-real-ip, which Cloudflare rewrites to the peer address", () => {
    // Measured on the live chain: behind the relay Cloudflare overwrites
    // x-real-ip with the address it is connected to (Vercel's egress), so
    // honouring it collapsed every domestic visitor into one bucket.
    const identity = resolveClientIdentity(
      request({ ...RELAY_PEER, [RELAY_SECRET_HEADER]: SECRET, "x-real-ip": "16.162.161.40" }),
      { RELAY_SECRET: SECRET },
    );
    expect(identity.ip).toBe("64.29.17.1");
  });

  it("falls back to the left-most x-forwarded-for entry", () => {
    const identity = resolveClientIdentity(
      request({ ...RELAY_PEER, [RELAY_SECRET_HEADER]: SECRET, "x-forwarded-for": "203.0.113.9, 10.0.0.1" }),
      { RELAY_SECRET: SECRET },
    );
    expect(identity.ip).toBe("203.0.113.9");
  });

  it("keeps the peer address when the forwarded value is not an address", () => {
    for (const forwarded of ["", "attacker.example", "203.0.113.9:443", "[2001:db8::1]"]) {
      const identity = resolveClientIdentity(
        request({ ...RELAY_PEER, [RELAY_SECRET_HEADER]: SECRET, "x-relay-client-ip": forwarded }),
        { RELAY_SECRET: SECRET },
      );
      expect(identity.ip).toBe("64.29.17.1");
    }
  });

  it("accepts IPv6 and trims surrounding whitespace", () => {
    const identity = resolveClientIdentity(
      request({ ...RELAY_PEER, [RELAY_SECRET_HEADER]: SECRET, "x-relay-client-ip": " 2001:db8::1 " }),
      { RELAY_SECRET: SECRET },
    );
    expect(identity.ip).toBe("2001:db8::1");
  });

  it("reports the relay country once the secret matches", () => {
    const identity = resolveClientIdentity(
      request({
        ...RELAY_PEER,
        [RELAY_SECRET_HEADER]: SECRET,
        "x-relay-client-ip": "203.0.113.9",
        "x-vercel-ip-country": "cn",
      }),
      { RELAY_SECRET: SECRET },
    );
    expect(identity.country).toBe("CN");
  });

  it("prefers the relay's own country header and rejects non-country values", () => {
    expect(
      resolveClientIdentity(
        request({
          ...RELAY_PEER,
          [RELAY_SECRET_HEADER]: SECRET,
          "x-relay-country": "jp",
          "x-vercel-ip-country": "cn",
        }),
        { RELAY_SECRET: SECRET },
      ).country,
    ).toBe("JP");
    expect(
      resolveClientIdentity(request({ ...RELAY_PEER, [RELAY_SECRET_HEADER]: SECRET, "x-vercel-ip-country": "CHN" }), {
        RELAY_SECRET: SECRET,
      }).country,
    ).toBeUndefined();
  });

  it("never reports a country without the secret", () => {
    const identity = resolveClientIdentity(request({ ...RELAY_PEER, "x-vercel-ip-country": "CN" }), {
      RELAY_SECRET: SECRET,
    });
    expect(identity.country).toBeUndefined();
  });
});

describe("isIpLiteral", () => {
  it("accepts v4 and v6 addresses", () => {
    expect(isIpLiteral("1.2.3.4")).toBe(true);
    expect(isIpLiteral("255.255.255.255")).toBe(true);
    expect(isIpLiteral("2001:db8::1")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
  });

  it("rejects octets above 255, hostnames, ports and chains", () => {
    expect(isIpLiteral("256.1.1.1")).toBe(false);
    expect(isIpLiteral("1.2.3")).toBe(false);
    expect(isIpLiteral("example.com")).toBe(false);
    expect(isIpLiteral("2001:db8::1.2.3.4:443")).toBe(false);
    expect(isIpLiteral("")).toBe(false);
  });
});
