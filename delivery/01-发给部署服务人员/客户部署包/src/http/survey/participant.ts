import type { Env } from "../../index";
import { verifyTelegramWebAppProfile } from "../admin-api";
import { verifySurveyParticipantToken } from "../../services/participant-session.service";
import { getUserById, getUserByTelegramId, upsertUser } from "../../db/repositories/user.repository";
import { getEmailAccountById } from "../../db/repositories/email-account.repository";
import { verifyEmailSessionToken } from "../../services/email-auth.service";
import { getParticipantLink, participantHashForKey } from "../../db/repositories/participant-link.repository";
import { fail } from "../api-response";

export const ANONYMOUS_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface Participant {
  kind: "telegram" | "anonymous" | "email";
  dbUserId: number | null;
  telegramUserId: number | null;
  participantKey: string | null;
  participantHash: string;
}

/**
 * Resolves who is answering, in priority order: Telegram Mini App initData,
 * the participant session token minted for browser sessions, the email
 * session, then the anonymous browser key.
 *
 * Every branch returns a `Response` instead of throwing when identity is
 * missing or invalid so the caller can surface the exact 401 to the client.
 */
export async function resolveParticipant(request: Request, env: Env): Promise<Participant | Response> {
  const initDataHeader = request.headers.get("x-telegram-init-data");
  if (initDataHeader) {
    const profile = await verifyTelegramWebAppProfile(request, env.BOT_TOKEN);
    if (!profile || profile.telegramUserId <= 0) {
      return fail(401, "invalid_identity", "Telegram 身份验证失败");
    }
    await upsertUser(env.DB, {
      telegramUserId: profile.telegramUserId,
      username: profile.username,
      firstName: profile.firstName,
      lastName: profile.lastName,
      languageCode: profile.languageCode,
      systemRole: "participant",
    });
    const user = await getUserByTelegramId(env.DB, profile.telegramUserId);
    if (!user) {
      return fail(500, "identity_lookup_failed", "无法创建用户身份");
    }
    return {
      kind: "telegram",
      dbUserId: user.id,
      telegramUserId: profile.telegramUserId,
      participantKey: null,
      participantHash: `user_${user.id}`,
    };
  }

  const participantToken = request.headers.get("x-participant-token");
  if (participantToken) {
    const profile = await verifySurveyParticipantToken(env.WEBHOOK_SECRET, participantToken);
    if (!profile || profile.telegramUserId <= 0) {
      return fail(401, "invalid_identity", "登录状态已失效，请重新从 Telegram 打开问卷。");
    }
    await upsertUser(env.DB, {
      telegramUserId: profile.telegramUserId,
      username: profile.username,
      firstName: profile.firstName,
      lastName: profile.lastName,
      languageCode: profile.languageCode,
      systemRole: "participant",
    });
    const user = await getUserByTelegramId(env.DB, profile.telegramUserId);
    if (!user) {
      return fail(500, "identity_lookup_failed", "无法创建用户身份");
    }
    return {
      kind: "telegram",
      dbUserId: user.id,
      telegramUserId: profile.telegramUserId,
      participantKey: null,
      participantHash: `user_${user.id}`,
    };
  }

  const emailSession = request.headers.get("x-email-session");
  if (emailSession) {
    const parsed = await verifyEmailSessionToken(env.WEBHOOK_SECRET, emailSession);
    const account = parsed ? await getEmailAccountById(env.DB, parsed.accountId) : null;
    if (!account || !account.verifiedAt) {
      return fail(401, "invalid_identity", "邮箱登录状态已失效，请重新登录。");
    }
    return {
      kind: "email",
      dbUserId: account.userId,
      telegramUserId: null,
      participantKey: null,
      participantHash: `email_${account.id}`,
    };
  }

  const participantKey = request.headers.get("x-participant-key");
  if (!participantKey || !ANONYMOUS_KEY_PATTERN.test(participantKey)) {
    return fail(401, "identity_required", "缺少答卷者身份标识");
  }
  // A participant who opted in from the completion page (link_<key> deep link)
  // keeps their browser participant hash for resume/continuity, but every
  // response is attached to the real Telegram user.
  const linked = await getParticipantLink(env.DB, participantKey);
  if (linked) {
    const user = await getUserById(env.DB, linked.userId);
    if (user) {
      return {
        kind: "telegram",
        dbUserId: user.id,
        telegramUserId: user.telegramUserId,
        participantKey,
        participantHash: participantHashForKey(participantKey),
      };
    }
  }
  return {
    kind: "anonymous",
    dbUserId: null,
    telegramUserId: null,
    participantKey,
    participantHash: participantHashForKey(participantKey),
  };
}

export function sanitizeHeader(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

/**
 * Merges Cloudflare request geo metadata and referrer into the client-provided
 * browser info JSON so anonymous web responses show more useful context.
 */
export function enrichBrowserInfo(raw: string | null, request: Request): string {
  let info: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        info = parsed as Record<string, unknown>;
      }
    } catch {
      info = { raw };
    }
  }
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf ?? {};
  const geo: Record<string, string> = {};
  for (const key of ["country", "region", "regionCode", "city", "postalCode", "metroCode", "timezone", "asn", "colo"]) {
    const value = cf[key];
    if (value !== undefined && value !== null && value !== "") {
      geo[key] = String(value);
    }
  }
  if (Object.keys(geo).length) info.geo = geo;
  if (!info.referrer) {
    const referer = request.headers.get("referer") ?? request.headers.get("referrer");
    if (referer) info.referrer = referer.replace(/[\r\n]/g, "").slice(0, 500);
  }
  const acceptLanguage = request.headers.get("accept-language");
  if (acceptLanguage) info.acceptLanguage = acceptLanguage.slice(0, 200);
  const secChUa = request.headers.get("sec-ch-ua");
  if (secChUa) info.secChUa = secChUa.slice(0, 200);

  // Environment consistency: compare IP-derived country against the browser's
  // timezone and language. This never proves real location, but mismatches are
  // a useful proxy/VPN/geo-inconsistency signal.
  const ipCountry = geo.country;
  const timezone = typeof info.timezone === "string" ? info.timezone : "";
  const language = typeof info.language === "string" ? info.language : "";
  const signals = envConsistencySignals(ipCountry, timezone, language);
  if (signals.length > 0 || ipCountry) {
    const matched = signals.filter((signal) => signal.includes("一致")).length;
    const total = signals.length;
    info.envRisk = {
      score: total ? Math.round((matched / total) * 100) : null,
      signals,
    };
  }
  return JSON.stringify(info).slice(0, 16384);
}

const TZ_COUNTRY: Record<string, string> = {
  "Asia/Shanghai": "CN",
  "Asia/Tokyo": "JP",
  "Asia/Seoul": "KR",
  "Asia/Hong_Kong": "HK",
  "Asia/Taipei": "TW",
  "Asia/Singapore": "SG",
  "Europe/London": "GB",
  "Europe/Paris": "FR",
  "Europe/Berlin": "DE",
  "Europe/Madrid": "ES",
  "Europe/Rome": "IT",
  "Europe/Amsterdam": "NL",
  "Europe/Brussels": "BE",
  "Europe/Vienna": "AT",
  "Europe/Zurich": "CH",
  "Europe/Stockholm": "SE",
  "Europe/Oslo": "NO",
  "Europe/Copenhagen": "DK",
  "Europe/Helsinki": "FI",
  "Europe/Warsaw": "PL",
  "Europe/Prague": "CZ",
  "Europe/Budapest": "HU",
  "Europe/Bucharest": "RO",
  "Europe/Athens": "GR",
  "Europe/Lisbon": "PT",
  "Europe/Moscow": "RU",
  "Europe/Istanbul": "TR",
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Los_Angeles": "US",
  "America/Denver": "US",
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "America/Sao_Paulo": "BR",
  "America/Mexico_City": "MX",
  "Australia/Sydney": "AU",
  "Australia/Melbourne": "AU",
  "Pacific/Auckland": "NZ",
  "Asia/Kolkata": "IN",
  "Asia/Karachi": "PK",
  "Asia/Dhaka": "BD",
  "Asia/Bangkok": "TH",
  "Asia/Jakarta": "ID",
  "Asia/Kuala_Lumpur": "MY",
  "Asia/Manila": "PH",
  "Asia/Ho_Chi_Minh": "VN",
  "Asia/Dubai": "AE",
  "Asia/Tehran": "IR",
  "Asia/Jerusalem": "IL",
  "Asia/Colombo": "LK",
};

const LANG_COUNTRY: Record<string, string> = {
  zh: "CN",
  "zh-tw": "TW",
  "zh-hk": "HK",
  ja: "JP",
  ko: "KR",
  en: "US",
  de: "DE",
  fr: "FR",
  es: "ES",
  it: "IT",
  pt: "PT",
  ru: "RU",
  th: "TH",
  vi: "VN",
  id: "ID",
  ms: "MY",
  ar: "AE",
  tr: "TR",
  nl: "NL",
  pl: "PL",
  sv: "SE",
  cs: "CZ",
  hu: "HU",
  ro: "RO",
  fi: "FI",
  da: "DK",
  no: "NO",
  el: "GR",
  he: "IL",
  hi: "IN",
  ur: "PK",
  bn: "BD",
  ta: "IN",
  uk: "UA",
  fa: "IR",
};

export function envConsistencySignals(ipCountry: string | undefined, timezone: string, language: string): string[] {
  const tzCountry = TZ_COUNTRY[timezone];
  const langCountry = LANG_COUNTRY[language.split("-")[0]?.toLowerCase() ?? ""];
  const signals: string[] = [];
  if (ipCountry && tzCountry) {
    signals.push(ipCountry === tzCountry ? "IP 国家与时区一致" : "IP 国家与时区不一致");
  }
  if (ipCountry && langCountry) {
    signals.push(ipCountry === langCountry ? "IP 国家与浏览器语言一致" : "IP 国家与浏览器语言不一致");
  }
  if (tzCountry && langCountry) {
    signals.push(tzCountry === langCountry ? "时区与浏览器语言一致" : "时区与浏览器语言不一致");
  }
  return signals;
}
