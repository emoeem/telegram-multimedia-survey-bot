import disposableDomainList from "disposable-email-domains";
import { loadSystemSettings } from "./system-settings.service";

/**
 * Disposable email domain detection.
 *
 * Two layers, because the 2026-10-31 probe registered three accounts on
 * `fldubai.com` — a throwaway domain that is NOT in the upstream list:
 *
 *   1. the `disposable-email-domains` dataset (offline, covers the common
 *      throwaway providers);
 *   2. the admin-managed `blocked_email_domains` system setting for
 *     即时处置: a domain observed in an incident goes in there without a
 *      redeploy.
 */

const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set(
  disposableDomainList.map((domain) => domain.trim().toLowerCase()).filter(Boolean),
);

/**
 * Extracts and validates the domain part of an email address. Returns null
 * for anything that does not look like a plain domain (no userinfo tricks,
 * no odd characters) so the caller can fail open on parse errors — syntax
 * validation itself is `isValidEmail`'s job.
 */
export function emailDomainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  const domain = (at >= 0 ? email.slice(at + 1) : email).trim().toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}

/** Parses the admin-managed blocklist setting: whitespace/comma separated domains. */
export function parseBlockedEmailDomains(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,;，；]+/)
    .map((item) => item.trim().toLowerCase().replace(/^@/, ""))
    .filter((item) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(item));
}

/**
 * Domains observed in real incidents, blocked in code so the defense holds
 * even before (or without) the admin setting being written — a code deploy is
 * the one thing every incident response already does. `fldubai.com` hosted the
 * three probe accounts of 2026-10-31 and is not in the upstream dataset.
 */
export const INCIDENT_EMAIL_DOMAINS: readonly string[] = ["fldubai.com"];

export function isDisposableEmailDomain(domain: string, extraBlocked: readonly string[] = []): boolean {
  return extraBlocked.includes(domain) || INCIDENT_EMAIL_DOMAINS.includes(domain) || DISPOSABLE_DOMAINS.has(domain);
}

/**
 * The full registration gate: true when the address's domain is disposable
 * either by dataset or by admin blocklist. Returns false (allow) when the
 * domain cannot be parsed — malformed addresses are rejected upstream.
 */
export function isBlockedEmailAddress(email: string, blockedDomainsSetting: string | null | undefined): boolean {
  const domain = emailDomainOf(email);
  if (!domain) return false;
  return isDisposableEmailDomain(domain, parseBlockedEmailDomains(blockedDomainsSetting));
}

/** User-facing rejection used by every route that gates on this check. */
export const EMAIL_DOMAIN_BLOCKED_MESSAGE = "该邮箱域名不被支持，请使用常见邮箱（QQ / 163 / Gmail 等）注册";

/**
 * Major consumer providers: aggregate registration traffic on these domains
 * is legitimate by definition, so the per-domain throttle in
 * `applyPublicApiRateLimit` must never apply to them. A novel throwaway
 * domain (the `fldubai.com` case) is by contrast throttled to a trickle even
 * before anyone adds it to `blocked_email_domains`.
 */
const MAJOR_EMAIL_PROVIDER_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "foxmail.com",
  "163.com",
  "126.com",
  "sina.com",
  "sina.cn",
  "sohu.com",
  "aliyun.com",
  "139.com",
  "189.cn",
  "yeah.net",
  "qiye.163.com",
  "edu.cn",
]);

/** True when per-domain registration throttling is safe for this domain. */
export function isAggregateProviderDomain(domain: string): boolean {
  return MAJOR_EMAIL_PROVIDER_DOMAINS.has(domain.toLowerCase());
}

/**
 * Reads the admin blocklist setting, degrading to "no dynamic entries" when
 * the read fails: the blocklist is one layer of defense, and a transient D1
 * hiccup must not take the whole email-auth surface down with it. The offline
 * dataset check still applies, and the per-IP/per-email rate limits are
 * unaffected.
 */
export async function loadBlockedEmailDomainsSetting(db: D1Database): Promise<string> {
  try {
    return (await loadSystemSettings(db)).blockedEmailDomains;
  } catch (error) {
    console.warn("blocked_email_domains setting unavailable; skipping dynamic blocklist", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}
