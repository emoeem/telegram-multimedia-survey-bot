import puppeteer from "@cloudflare/puppeteer";
import { RESULT_VISUAL_FONT } from "./result-visual-font";
import type { Env } from "../index";
import { reportThemes, type ReportTheme } from "./report/themes";

/**
 * Open-Graph share cards for published surveys: a 1200x630 PNG rendered by
 * Browser Rendering and cached in KV until the survey content changes.
 * Used by the meta tags injected into /s/:id so Telegram/social shares show
 * a real preview card instead of a bare link.
 */

const OG_CACHE_PREFIX = "og-image:v1";
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

export interface SurveyShareMeta {
  id: number;
  title: string;
  description: string | null;
  questionCount: number;
  coverUrl: string | null;
  updatedAt: string;
  /** oklch/hex primary color from the survey theme, when present. */
  primaryColor: string | null;
}

export async function loadSurveyShareMeta(db: D1Database, surveyId: number): Promise<SurveyShareMeta | null> {
  const row = await db
    .prepare(
      `SELECT s.id, s.title, s.description, s.updated_at, s.settings_json,
              m.url coverUrl,
              (SELECT COUNT(*) FROM survey_questions q WHERE q.survey_id = s.id) questionCount
       FROM surveys s
       LEFT JOIN media_assets m ON m.id = s.cover_media_id
       WHERE s.id = ? AND s.status = 'published'
       LIMIT 1`,
    )
    .bind(surveyId)
    .first<{
      id: number;
      title: string;
      description: string | null;
      updated_at: string;
      settings_json: string | null;
      coverUrl: string | null;
      questionCount: number;
    }>();
  if (!row) return null;

  let primaryColor: string | null = null;
  try {
    const theme = row.settings_json
      ? (JSON.parse(row.settings_json) as { theme?: { primaryColor?: unknown; preset?: unknown } }).theme
      : undefined;
    if (theme && typeof theme.primaryColor === "string") {
      primaryColor = theme.primaryColor;
    } else if (theme && typeof theme.preset === "string") {
      const presetTheme = reportThemes[`daisy-${theme.preset}` as ReportTheme];
      if (presetTheme) primaryColor = presetTheme.colors.primary;
    }
  } catch {
    // Unparseable settings fall back to the default brand color.
  }

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    questionCount: Number(row.questionCount) || 0,
    coverUrl: row.coverUrl,
    updatedAt: row.updated_at,
    primaryColor,
  };
}

function fingerprint(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function bytesToDataUrl(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:font/ttf;base64,${btoa(binary)}`;
}

function buildOgCardHtml(meta: SurveyShareMeta, origin: string): string {
  const title = escapeHtml(meta.title.slice(0, 60));
  const description = meta.description ? escapeHtml(meta.description.slice(0, 90)) : "";
  // ReportSans is the bundled CJK-safe display font used by the report
  // pipeline; Browser Rendering has no system CJK fonts.
  const fontFace = `@font-face{font-family:ReportSans;src:url(${bytesToDataUrl(RESULT_VISUAL_FONT)}) format("truetype");font-weight:400;font-style:normal}`;
  const primary = meta.primaryColor ?? "#4f46e5";
  const cover = meta.coverUrl
    ? `<img class="cover" src="${escapeHtml(new URL(meta.coverUrl, origin).toString())}" onerror="this.remove()" />`
    : "";
  const gradient = `linear-gradient(135deg, ${primary} 0%, color-mix(in srgb, ${primary} 55%, #0f172a) 100%)`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFace}
*{box-sizing:border-box;margin:0;padding:0}
body{width:${OG_WIDTH}px;height:${OG_HEIGHT}px;overflow:hidden;font-family:ReportSans,sans-serif}
.card{position:relative;width:100%;height:100%;background:${gradient};display:flex;flex-direction:column;justify-content:space-between;padding:64px 72px}
${cover ? `.card > .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,14,26,.25),rgba(10,14,26,.86))}.cover{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}` : ""}
.content{position:relative;color:#fff}
.kicker{font-size:26px;letter-spacing:.28em;opacity:.85;font-weight:700}
h1{margin-top:22px;font-size:74px;line-height:1.18;letter-spacing:-.01em;max-width:1000px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.desc{margin-top:20px;font-size:30px;line-height:1.5;opacity:.88;max-width:900px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.foot{position:relative;display:flex;align-items:center;gap:20px;color:#fff}
.pill{padding:12px 26px;border-radius:999px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.35);font-size:27px;font-weight:600}
.brand{margin-left:auto;font-size:24px;opacity:.8}
</style></head>
<body><div class="card">
${cover ? '<div class="shade"></div>' : ""}
${cover}
<div class="content">
  <div class="kicker">问卷 INVITATION</div>
  <h1>${title}</h1>
  ${description ? `<div class="desc">${description}</div>` : ""}
</div>
<div class="foot">
  <span class="pill">${meta.questionCount} 道题 · 约 ${Math.max(1, Math.ceil(meta.questionCount * 0.3))} 分钟</span>
  <span class="brand">点击链接立即填写 →</span>
</div>
</div></body></html>`;
}

/**
 * Returns the cached share card for a survey, rendering one on miss.
 * Returns null when Browser Rendering is unavailable (caller serves a 404
 * and social platforms fall back to plain-text previews).
 */
export async function getSurveyOgImage(
  env: Env,
  meta: SurveyShareMeta,
  origin: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!env.BROWSER) return null;
  const cacheKey = `${OG_CACHE_PREFIX}:${meta.id}:${fingerprint(
    `${meta.updatedAt}|${meta.questionCount}|${meta.title}|${meta.coverUrl ?? ""}|${meta.primaryColor ?? ""}`,
  )}`;
  const cached = await env.CACHE.get(cacheKey, { type: "arrayBuffer" });
  if (cached) return new Uint8Array(cached);

  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: OG_WIDTH, height: OG_HEIGHT });
    await page.setContent(buildOgCardHtml(meta, origin), { waitUntil: "load" });
    await page.evaluate("document.fonts ? document.fonts.ready : Promise.resolve()");
    const shot: unknown = await page.screenshot({ type: "png" });
    const bytes = new Uint8Array(shot instanceof Uint8Array ? shot : (shot as ArrayBuffer));
    // Cache for 7 days; the cache key embeds updatedAt so edits regenerate.
    await env.CACHE.put(cacheKey, bytes.slice().buffer as ArrayBuffer, {
      expirationTtl: 7 * 24 * 60 * 60,
    });
    return bytes;
  } finally {
    await browser.close();
  }
}
