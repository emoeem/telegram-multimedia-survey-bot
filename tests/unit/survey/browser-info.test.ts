import { describe, expect, it } from "vitest";

import { enrichBrowserInfo } from "../../../src/http/survey/participant";
import type { ClientIdentity } from "../../../src/services/client-identity.service";

const DIRECT: ClientIdentity = { ip: "203.0.113.9", addressKnown: true, relayed: false };
const RELAYED: ClientIdentity = { ip: "203.0.113.9", addressKnown: true, relayed: true };
const RELAYED_WITH_COUNTRY: ClientIdentity = { ip: "203.0.113.9", addressKnown: true, relayed: true, country: "CN" };

/** Cloudflare's view of a request that arrived through the relay. */
const RELAY_POP_GEO = { country: "HK", city: "Singapore", timezone: "Asia/Singapore", asn: 16509, colo: "sin1" };

const BROWSER_INFO = JSON.stringify({ timezone: "Asia/Shanghai", language: "zh" });

function requestWithGeo(cf: Record<string, unknown>): Request {
  const request = new Request("https://emoe.eu.cc/api/survey/1/responses", {
    headers: { referer: "https://t.me/tougaojiqirbot" },
  });
  Object.assign(request, { cf });
  return request;
}

function parse(raw: string): Record<string, any> {
  return JSON.parse(raw) as Record<string, any>;
}

describe("enrichBrowserInfo", () => {
  it("keeps the full edge geo for a direct request", () => {
    const info = parse(
      enrichBrowserInfo(BROWSER_INFO, requestWithGeo({ country: "CN", city: "Guangzhou", colo: "AMS" }), DIRECT),
    );
    expect(info.geo).toEqual({ country: "CN", city: "Guangzhou", colo: "AMS" });
    expect(info.viaRelay).toBeUndefined();
    expect(info.envRisk.score).toBe(100);
  });

  it("drops the relay's own POP geo and uses the relay-reported country instead", () => {
    const info = parse(enrichBrowserInfo(BROWSER_INFO, requestWithGeo(RELAY_POP_GEO), RELAYED_WITH_COUNTRY));
    // Filing a Guangdong respondent under HK would also make the consistency
    // check below argue with their browser timezone.
    expect(info.geo).toEqual({ country: "CN" });
    expect(info.viaRelay).toBe(true);
    expect(info.envRisk.score).toBe(100);
  });

  it("records a relayed request with no country as relayed and country-less", () => {
    const info = parse(enrichBrowserInfo(BROWSER_INFO, requestWithGeo(RELAY_POP_GEO), RELAYED));
    expect(info.geo).toBeUndefined();
    expect(info.viaRelay).toBe(true);
    // Without an IP country only the timezone/language pair remains; the check
    // degrades instead of inventing a mismatch.
    expect(info.envRisk.signals).toHaveLength(1);
  });

  it("never lets a client-supplied geo survive", () => {
    const spoofed = JSON.stringify({ timezone: "Asia/Shanghai", language: "zh", geo: { country: "US" } });
    const info = parse(enrichBrowserInfo(spoofed, requestWithGeo(RELAY_POP_GEO), RELAYED));
    expect(info.geo).toBeUndefined();
  });

  it("keeps the browser-provided timezone and language for the risk check", () => {
    const info = parse(enrichBrowserInfo(BROWSER_INFO, requestWithGeo(RELAY_POP_GEO), RELAYED_WITH_COUNTRY));
    expect(info.timezone).toBe("Asia/Shanghai");
    expect(info.language).toBe("zh");
  });
});
