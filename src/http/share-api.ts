import type { Env } from "../index";
import { fail } from "./api-response";
import { getActiveShareByToken, type ReportShareRow } from "../services/report-share.service";
import { getActiveProfileShareByToken, type ProfileShareRow } from "../services/profile-share.service";
import { getResultProfileByResponseId } from "../db/repositories/result-profile.repository";
import { deserializeResultProfile } from "../services/result-engine.service";
import puppeteer from "@cloudflare/puppeteer";
import { RESULT_VISUAL_FONT } from "../services/result-visual-font";

/**
 * 报告分享卡的公开面（0081）：`/r/:token` 结局卡页 + `/r/:token/og.png`。
 *
 * 白名单投影是这里的硬约束——公开页只渲染分享行里的快照字段（结局名/卷名）
 * 与结果快照的 title/subtitle/tags，**任何答案原文、长文本回答与 stats 数值
 * 都不读取、不出口**。r18 问卷只有 teaser 形态：结果标题替换为中性文案，
 * tags/subtitle 不出现。
 *
 * 卡片是文字排版（渐变底 + CJK 内嵌字体），不放答卷照片——参与者上传的
 * response-scope 媒体有独立的授权链路，公开页不碰它。
 */

const OG_CACHE_PREFIX = "share-og:v1";
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

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

interface ShareCardView {
  /** 结局标题。r18 → 中性 teaser 文案。 */
  title: string;
  /** r18 为 null：副标题与 tags 都可能暗示内容。 */
  subtitle: string | null;
  tags: string[];
  /** 朋友互测默契得分（P2），r18 teaser 不带。 */
  agreement: { score: number; total: number } | null;
  surveyTitle: string;
  completedAt: string | null;
  adult: boolean;
  surveyUrl: string;
}

const R18_TEASER_TITLE = "达成隐藏结局";

/**
 * 安全投影。只读取结果快照的展示字段；结果行缺失（理论不可达：分享创建时
 * 必有 profile）时退回分享行的创建时刻快照。
 */
async function buildShareCardView(env: Env, share: ReportShareRow): Promise<ShareCardView | null> {
  const adult = share.contentRating === "r18";
  const surveyTitle = share.surveyTitle ?? `问卷 #${share.surveyId}`;

  let resultTitle = share.resultTitle;
  let subtitle: string | null = null;
  let tags: string[] = [];
  let agreement: { score: number; total: number } | null = null;
  const profileRow = await getResultProfileByResponseId(env.DB, share.responseId);
  if (profileRow) {
    try {
      const snapshot = deserializeResultProfile(profileRow);
      resultTitle = snapshot.title ?? resultTitle;
      subtitle = typeof snapshot.subtitle === "string" ? snapshot.subtitle : null;
      tags = Array.isArray(snapshot.tags)
        ? snapshot.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 3)
        : [];
      // 朋友互测（P2）：默契得分是计算值不是原始答案，可以公开。
      const raw = (snapshot.metadata as { agreement?: unknown }).agreement;
      if (
        raw &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        Number.isFinite(Number((raw as { score?: unknown }).score)) &&
        Number.isFinite(Number((raw as { total?: unknown }).total)) &&
        Number((raw as { total?: unknown }).total) > 0
      ) {
        agreement = { score: Number((raw as { score?: unknown }).score), total: Number((raw as { total?: unknown }).total) };
      }
    } catch {
      // 反序列化失败时退回分享行快照，公开页不能因为一次脏数据 500。
    }
  }
  if (!resultTitle) resultTitle = "已完成";

  const response = await env.DB.prepare(`SELECT completed_at FROM survey_responses WHERE id = ? LIMIT 1`)
    .bind(share.responseId)
    .first<{ completed_at: string | null }>();

  return {
    title: adult ? R18_TEASER_TITLE : resultTitle,
    subtitle: adult ? null : subtitle,
    tags: adult ? [] : tags,
    agreement: adult ? null : agreement,
    surveyTitle,
    completedAt: response?.completed_at ?? null,
    adult,
    surveyUrl: `/s/${share.surveyId}`,
  };
}

const CARD_FONT_FACE = `@font-face{font-family:ReportSans;src:url(${bytesToDataUrl(RESULT_VISUAL_FONT)}) format("truetype");font-weight:400;font-style:normal}`;

function cardTheme(view: ShareCardView): { background: string; foreground: string; accent: string } {
  if (view.adult) return { background: "linear-gradient(135deg,#1f2937 0%,#0f172a 100%)", foreground: "#f9fafb", accent: "#f87171" };
  return { background: "linear-gradient(135deg,#4f46e5 0%,#7c3aed 55%,#0f172a 100%)", foreground: "#ffffff", accent: "#ffffff" };
}

/** 与问卷 OG 卡同一尺寸语言；也是 /r/:token 页内展示的封面。 */
function buildShareCardHtml(view: ShareCardView): string {
  const { background, foreground, accent } = cardTheme(view);
  const tags = view.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const date = view.completedAt ? new Date(view.completedAt).toLocaleDateString("zh-CN") : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${CARD_FONT_FACE}
*{box-sizing:border-box;margin:0;padding:0}
body{width:${OG_WIDTH}px;height:${OG_HEIGHT}px;overflow:hidden;font-family:ReportSans,sans-serif}
.card{width:100%;height:100%;background:${background};color:${foreground};display:flex;flex-direction:column;justify-content:space-between;padding:64px 72px}
.kicker{font-size:26px;letter-spacing:.3em;opacity:.85;font-weight:700;display:flex;align-items:center;gap:24px}
.badge{padding:8px 20px;border-radius:999px;background:#dc2626;border:1px solid #fca5a5;letter-spacing:.12em;font-size:24px}
h1{margin-top:26px;font-size:84px;line-height:1.15;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.subtitle{margin-top:18px;font-size:32px;opacity:.9;overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}
.tags{margin-top:26px;display:flex;gap:16px;flex-wrap:wrap}
.tag{padding:10px 24px;border-radius:999px;border:1px solid ${accent};opacity:.95;font-size:26px}
.foot{display:flex;align-items:flex-end;justify-content:space-between;gap:24px}
.survey{font-size:30px;font-weight:600;overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}
.cta{padding:16px 34px;border-radius:999px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.4);font-size:28px;font-weight:700;white-space:nowrap}
.date{font-size:24px;opacity:.75}
</style></head><body><div class="card">
<div>
  <div class="kicker">结局卡 ENDING ${view.adult ? '<span class="badge">18+</span>' : ""}</div>
  <h1>${escapeHtml(view.title.slice(0, 24))}</h1>
  ${view.subtitle ? `<div class="subtitle">${escapeHtml(view.subtitle.slice(0, 40))}</div>` : ""}
  ${view.agreement ? `<div class="subtitle">默契 ${view.agreement.score}/${view.agreement.total}</div>` : ""}
  ${tags ? `<div class="tags">${tags}</div>` : ""}
</div>
<div class="foot">
  <div style="min-width:0">
    <div class="survey">来自《${escapeHtml(view.surveyTitle.slice(0, 30))}》</div>
    ${date ? `<div class="date">${escapeHtml(date)} 达成</div>` : ""}
  </div>
  <span class="cta">我也测测 →</span>
</div>
</div></body></html>`;
}

/** 公开页（手机优先的竖版展示 + OG meta + CTA）。 */
function buildSharePageHtml(view: ShareCardView, ogUrl: string, origin: string): string {
  const { background, foreground, accent } = cardTheme(view);
  const tags = view.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const date = view.completedAt ? new Date(view.completedAt).toLocaleDateString("zh-CN") : "";
  const desc = view.adult ? "一份 18+ 互动问卷的结局卡。" : `我在《${view.surveyTitle}》达成了「${view.title}」。`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(view.title)} · 结局卡</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta property="og:type" content="website" />
<meta property="og:title" content="${escapeHtml(view.title)}" />
<meta property="og:description" content="${escapeHtml(desc)}" />
<meta property="og:image" content="${escapeHtml(ogUrl)}" />
<meta property="og:url" content="${escapeHtml(origin + "/r/")}"/>
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(view.title)}" />
<meta name="twitter:description" content="${escapeHtml(desc)}" />
<meta name="twitter:image" content="${escapeHtml(ogUrl)}" />
<style>
${CARD_FONT_FACE}
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100dvh;font-family:ReportSans,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:20px}
.card{width:100%;max-width:420px;aspect-ratio:1200/630;background:${background};color:${foreground};border-radius:24px;padding:36px 32px;display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 24px 60px rgba(0,0,0,.45)}
.kicker{font-size:13px;letter-spacing:.3em;opacity:.85;font-weight:700;display:flex;align-items:center;gap:12px}
.badge{padding:4px 12px;border-radius:999px;background:#dc2626;border:1px solid #fca5a5;letter-spacing:.12em;font-size:12px}
h1{margin-top:14px;font-size:clamp(26px,8vw,38px);line-height:1.2;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.subtitle{margin-top:10px;font-size:16px;opacity:.9}
.tags{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap}
.tag{padding:5px 13px;border-radius:999px;border:1px solid ${accent};opacity:.95;font-size:13px}
.foot{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}
.survey{font-size:15px;font-weight:600}
.date{font-size:12px;opacity:.75;margin-top:3px}
.actions{width:100%;max-width:420px;display:flex;flex-direction:column;gap:10px}
.btn{display:block;text-align:center;padding:14px 24px;border-radius:999px;font-weight:700;text-decoration:none;font-size:16px}
.primary{background:#6366f1;color:#fff}
.ghost{color:#94a3b8;font-size:13px;text-align:center}
</style></head><body>
<div class="card">
  <div>
    <div class="kicker">结局卡 ENDING ${view.adult ? '<span class="badge">18+</span>' : ""}</div>
    <h1>${escapeHtml(view.title)}</h1>
    ${view.subtitle ? `<div class="subtitle">${escapeHtml(view.subtitle)}</div>` : ""}
    ${view.agreement ? `<div class="subtitle">默契 ${view.agreement.score}/${view.agreement.total}</div>` : ""}
    ${tags ? `<div class="tags">${tags}</div>` : ""}
  </div>
  <div class="foot">
    <div style="min-width:0">
      <div class="survey">来自《${escapeHtml(view.surveyTitle)}》</div>
      ${date ? `<div class="date">${escapeHtml(date)} 达成</div>` : ""}
    </div>
  </div>
</div>
<div class="actions">
  <a class="btn primary" href="${escapeHtml(view.surveyUrl)}">我也测测 →</a>
  <div class="ghost">结局卡由答卷生成，不包含任何答案内容</div>
</div>
</body></html>`;
}

function shareOgCacheKey(share: ReportShareRow, view: ShareCardView): string {
  const fingerprint = `${share.updatedAt}|${view.title}|${view.surveyTitle}|${view.adult ? "r18" : "all"}`;
  let hash = 5381;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash = ((hash << 5) + hash + fingerprint.charCodeAt(index)) | 0;
  }
  return `${OG_CACHE_PREFIX}:${share.token}:${(hash >>> 0).toString(36)}`;
}

/**
 * OG 图：KV 缓存优先（同问卷 OG 卡的 7 天约定），未命中且 BROWSER 可用时渲染
 * 一次并写回。无 BROWSER 绑定（本地开发）返回 null，社交平台退化为纯文字预览。
 */
async function getOrRenderShareOg(env: Env, share: ReportShareRow, view: ShareCardView): Promise<ArrayBuffer | null> {
  const cacheKey = shareOgCacheKey(share, view);
  try {
    const cached = await env.CACHE.get(cacheKey, { type: "arrayBuffer" });
    if (cached) return cached;
  } catch {
    // 缓存读失败按未命中处理。
  }
  if (!env.BROWSER) return null;
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: OG_WIDTH, height: OG_HEIGHT });
    await page.setContent(buildShareCardHtml(view), { waitUntil: "load" });
    await page.evaluate("document.fonts ? document.fonts.ready : Promise.resolve()");
    const shot: unknown = await page.screenshot({ type: "png" });
    const bytes = shot instanceof Uint8Array ? shot : new Uint8Array(shot as ArrayBuffer);
    const buffer = bytes.slice().buffer as ArrayBuffer;
    await env.CACHE.put(cacheKey, buffer, { expirationTtl: 7 * 24 * 3600 });
    return buffer;
  } finally {
    await browser.close();
  }
}

function htmlResponse(html: string, cacheControl: string, status = 200): Response {
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": cacheControl } });
}

export async function handleSharePageRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const ogMatch = url.pathname.match(/^\/r\/([A-Za-z0-9_-]+)\/og\.png$/);
  const pageMatch = ogMatch ? null : url.pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/);
  const profileOgMatch = url.pathname.match(/^\/u\/([A-Za-z0-9_-]+)\/og\.png$/);
  const profileMatch = profileOgMatch ? null : url.pathname.match(/^\/u\/([A-Za-z0-9_-]+)$/);
  const token = ogMatch?.[1] ?? pageMatch?.[1] ?? profileOgMatch?.[1] ?? profileMatch?.[1];
  if (!token) return null;

  if (profileOgMatch || profileMatch) {
    return serveProfileSharePage(env, url, token, Boolean(profileOgMatch));
  }

  const share = await getActiveShareByToken(env.DB, token);
  if (!share) {
    // 404 而不是 200：撤销后的链接对爬虫与平台预览应当立刻表现为失效页。
    return htmlResponse(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>分享不存在</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;font:15px/1.7 -apple-system,'PingFang SC',sans-serif"><main style="text-align:center;padding:0 24px"><p style="font-size:2.5rem;margin:0">🃏</p><h1 style="font-size:1.1rem;margin:.8rem 0">这张结局卡不存在或已被作者撤销</h1><a href="/s" style="color:#818cf8">去看看其他问卷 →</a></main></body></html>`,
      "no-store",
      404,
    );
  }
  const view = await buildShareCardView(env, share);
  if (!view) return fail(404, "share_unavailable", "分享内容不可用");

  if (ogMatch) {
    const png = await getOrRenderShareOg(env, share, view);
    if (!png) return fail(404, "og_unavailable", "分享卡图片暂不可用");
    return new Response(png, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
    });
  }

  // 浏览量：一次轻量 D1 写。分享页本身高频命中时这是可接受的开销，
  // 作者侧"被看了多少次"是最直接的正反馈。
  await env.DB.prepare(`UPDATE report_shares SET view_count = view_count + 1 WHERE id = ?`)
    .bind(share.id)
    .run()
    .catch(() => undefined);

  const origin = new URL(request.url).origin;
  return htmlResponse(buildSharePageHtml(view, `${origin}/r/${share.token}/og.png`, origin), "public, max-age=60");
}

// ---- 个人画像（Wrapped，0085）----

function escapeMeta(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 画像卡文字内容（页面与 OG 渲染共用）。 */
function profileStats(profile: ProfileShareRow): Array<{ label: string; value: string }> {
  const snapshot = profile.snapshot;
  const since = snapshot.since ? new Date(snapshot.since).toLocaleDateString("zh-CN") : null;
  const stats: Array<{ label: string; value: string }> = [
    { label: "完成问卷", value: String(snapshot.completedSurveys) },
    { label: "收集结局", value: String(snapshot.endingsCollected) },
    { label: "成就徽章", value: String(snapshot.achievements) },
    { label: "挑战最高分", value: String(snapshot.trialBestScore) },
  ];
  void since;
  return stats;
}

function buildProfileCardHtml(profile: ProfileShareRow): string {
  const name = profile.displayName || "一位匿名旅行者";
  const stats = profileStats(profile)
    .map(
      (stat) =>
        `<div class="stat"><div class="num">${escapeMeta(stat.value)}</div><div class="lbl">${escapeMeta(stat.label)}</div></div>`,
    )
    .join("");
  const since = profile.snapshot.since ? new Date(profile.snapshot.since).toLocaleDateString("zh-CN") : "—";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${CARD_FONT_FACE}
*{box-sizing:border-box;margin:0;padding:0}
body{width:${OG_WIDTH}px;height:${OG_HEIGHT}px;overflow:hidden;font-family:ReportSans,sans-serif}
.card{width:100%;height:100%;background:linear-gradient(160deg,#312e81 0%,#1e1b4b 55%,#0f172a 100%);color:#eef2ff;display:flex;flex-direction:column;justify-content:space-between;padding:64px 72px}
.kicker{font-size:26px;letter-spacing:.3em;opacity:.85;font-weight:700}
h1{margin-top:22px;font-size:64px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:28px;margin-top:36px}
.stat .num{font-size:56px;font-weight:800;color:#c7d2fe}
.stat .lbl{margin-top:8px;font-size:24px;opacity:.8}
.foot{display:flex;align-items:flex-end;justify-content:space-between}
.since{font-size:24px;opacity:.75}
.cta{padding:14px 32px;border-radius:999px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.4);font-size:26px;font-weight:700;white-space:nowrap}
</style></head><body><div class="card">
<div>
  <div class="kicker">个人画像 PROFILE</div>
  <h1>${escapeMeta(name.slice(0, 16))} 的答卷足迹</h1>
  <div class="grid">${stats}</div>
</div>
<div class="foot">
  <div class="since">自 ${escapeMeta(since)} 起</div>
  <span class="cta">来测测 →</span>
</div>
</div></body></html>`;
}

function buildProfilePageHtml(profile: ProfileShareRow, ogUrl: string, origin: string): string {
  const name = profile.displayName || "一位匿名旅行者";
  const stats = profileStats(profile)
    .map((stat) => `<div class="stat"><div class="num">${escapeMeta(stat.value)}</div><div class="lbl">${escapeMeta(stat.label)}</div></div>`)
    .join("");
  const since = profile.snapshot.since ? new Date(profile.snapshot.since).toLocaleDateString("zh-CN") : "—";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeMeta(name)} 的答卷足迹 · 个人画像</title>
<meta name="description" content="完成 ${profile.snapshot.completedSurveys} 份问卷，收集 ${profile.snapshot.endingsCollected} 个结局。">
<meta property="og:type" content="website" />
<meta property="og:title" content="${escapeMeta(name)} 的答卷足迹" />
<meta property="og:description" content="完成 ${profile.snapshot.completedSurveys} 份问卷，收集 ${profile.snapshot.endingsCollected} 个结局。" />
<meta property="og:image" content="${escapeMeta(ogUrl)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${escapeMeta(ogUrl)}" />
<style>
${CARD_FONT_FACE}
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100dvh;font-family:ReportSans,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:20px}
.card{width:100%;max-width:420px;background:linear-gradient(160deg,#312e81 0%,#1e1b4b 55%,#0f172a 100%);color:#eef2ff;border-radius:24px;padding:32px 28px;box-shadow:0 24px 60px rgba(0,0,0,.45)}
.kicker{font-size:12px;letter-spacing:.3em;opacity:.85;font-weight:700}
h1{margin-top:12px;font-size:clamp(20px,6vw,28px)}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;margin-top:22px}
.stat .num{font-size:34px;font-weight:800;color:#c7d2fe}
.stat .lbl{margin-top:4px;font-size:13px;opacity:.8}
.since{margin-top:20px;font-size:12px;opacity:.75}
.actions{width:100%;max-width:420px}
.btn{display:block;text-align:center;padding:14px 24px;border-radius:999px;font-weight:700;text-decoration:none;font-size:16px;background:#6366f1;color:#fff}
</style></head><body>
<div class="card">
  <div class="kicker">个人画像 PROFILE</div>
  <h1>${escapeMeta(name.slice(0, 16))} 的答卷足迹</h1>
  <div class="grid">${stats}</div>
  <div class="since">自 ${escapeMeta(since)} 起 · 数据由答卷聚合，不含答案内容</div>
</div>
<div class="actions"><a class="btn" href="/s">我也测测 →</a></div>
</body></html>`;
}

async function serveProfileSharePage(env: Env, url: URL, token: string, isOg: boolean): Promise<Response> {
  const profile = await getActiveProfileShareByToken(env.DB, token);
  if (!profile) {
    return htmlResponse(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>画像不存在</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;font:15px/1.7 -apple-system,'PingFang SC',sans-serif"><main style="text-align:center;padding:0 24px"><p style="font-size:2.5rem;margin:0">🌌</p><h1 style="font-size:1.1rem;margin:.8rem 0">这份个人画像不存在或已撤销</h1><a href="/s" style="color:#818cf8">去看看其他问卷 →</a></main></body></html>`,
      "no-store",
      404,
    );
  }
  const base = url.origin;
  const ogUrl = `${base}/u/${profile.token}/og.png`;
  if (isOg) {
    const png = await getOrRenderProfileOg(env, profile);
    if (!png) return fail(404, "og_unavailable", "画像图片暂不可用");
    return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
  }
  await env.DB.prepare("UPDATE profile_shares SET view_count = view_count + 1 WHERE id = ?").bind(profile.id).run().catch(() => undefined);
  return htmlResponse(buildProfilePageHtml(profile, ogUrl, base), "public, max-age=60");
}

function getOrRenderProfileOg(env: Env, profile: ProfileShareRow): Promise<ArrayBuffer | null> {
  const cacheKey = `profile-og:v1:${profile.token}:${fingerprintToken(profile.updatedAt)}`;
  return getOrRenderOgGeneric(env, cacheKey, () => buildProfileCardHtml(profile));
}

function fingerprintToken(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** OG 渲染的通用形态（结局卡与画像共用同一条 KV+Browser Rendering 管线）。 */
async function getOrRenderOgGeneric(
  env: Env,
  cacheKey: string,
  buildHtml: () => string,
): Promise<ArrayBuffer | null> {
  try {
    const cached = await env.CACHE.get(cacheKey, { type: "arrayBuffer" });
    if (cached) return cached;
  } catch {
    // 缓存读失败按未命中处理。
  }
  if (!env.BROWSER) return null;
  const puppeteer = (await import("@cloudflare/puppeteer")).default;
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: OG_WIDTH, height: OG_HEIGHT });
    await page.setContent(buildHtml(), { waitUntil: "load" });
    await page.evaluate("document.fonts ? document.fonts.ready : Promise.resolve()");
    const shot: unknown = await page.screenshot({ type: "png" });
    const bytes = shot instanceof Uint8Array ? shot : new Uint8Array(shot as ArrayBuffer);
    const buffer = bytes.slice().buffer as ArrayBuffer;
    await env.CACHE.put(cacheKey, buffer, { expirationTtl: 7 * 24 * 3600 });
    return buffer;
  } finally {
    await browser.close();
  }
}
