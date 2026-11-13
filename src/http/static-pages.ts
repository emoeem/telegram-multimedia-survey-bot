import type { Env } from "../env";
import { loadSurveyShareMeta } from "../services/survey-og-image.service";
import { resolvePublicOrigin } from "../services/public-origin.service";
import { escapeMetaAttribute, publicPageHead } from "./public-page";

/**
 * Serves an SPA HTML entry without allowing the client or any intermediate
 * cache to keep a stale copy: stale bundles have historically left Telegram
 * WebViews stuck on a blank page after a redeploy.
 */
export async function serveHtmlAsset(
  env: Env,
  request: Request,
  assetPath: string,
  injectHead?: string,
  title?: string,
): Promise<Response> {
  const assetUrl = new URL(assetPath, request.url);
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));
  if (!response.headers.get("content-type")?.includes("text/html")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  if (!injectHead) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  let html = await response.text();
  /* 每个公开页有自己的标题（分享卡片、浏览器标签都要它）。index.html 里那份
   * 是通用的「问卷」，这里直接替换而不是追加第二份 <title>。 */
  if (title) html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`);
  html = html.replace("</head>", `${injectHead}\n</head>`);
  return new Response(html, { status: response.status, headers });
}

/**
 * Content-hashed build output under `/assets/`, as Vite names it
 * (`survey-CM53e1qv.js`): the hash *is* the file's content, so the bytes behind
 * a given URL never change.
 */
const HASHED_ASSET_PATTERN = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

/**
 * Serves a static build asset, with a long cache lifetime for hashed files.
 *
 * The assets binding answers with `cache-control: public, max-age=0,
 * must-revalidate` for everything, so a returning visitor revalidates every
 * chunk — ten round trips before the survey app boots, each of which is
 * hundreds of milliseconds from a mainland mobile link, and any one of them
 * failing leaves the participant on a blank page. A hashed filename cannot go
 * stale, so it is served as immutable instead; unhashed paths (`sw.js`,
 * `manifest.webmanifest`, the icons) deliberately keep the binding's policy so
 * they still update.
 */
export async function serveStaticAsset(env: Env, request: Request): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const pathname = new URL(request.url).pathname;
  if (!response.ok || !pathname.startsWith("/assets/") || !HASHED_ASSET_PATTERN.test(pathname)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** SPA 公开页（/s、/plaza、/submit、/me …）：资源是 /survey.html，由前端按路径切屏。 */
export function servePublicPageWithMeta(env: Env, request: Request, pathname: string): Promise<Response> {
  return serveHtmlAssetWithMeta(env, request, "/survey.html", pathname);
}

/** 独立静态页也要同一套 head 注入。
 *
 * 认证卡生成器（/cert）是 `cert/index.html` 单独一份静态页，不走 SPA；原先
 * 直接 `serveHtmlAsset` 发出去，于是它**没有 canonical、没有 og:url** ——
 * 从国内域名分享出去是一条光秃秃的链接，搜索引擎也会把 Cloudflare 那个
 * 打不开的域名当主域。这里复用的就是 SPA 那几页的 `publicPageHead`，
 * 两边的 canonical 来源完全一致（PUBLIC_ORIGIN → emoemok.top）。 */
export function serveHtmlAssetWithMeta(
  env: Env,
  request: Request,
  assetPath: string,
  pathname: string,
): Promise<Response> {
  const origin = resolvePublicOrigin(env, new URL(request.url).origin);
  const { title, injectHead } = publicPageHead(origin, pathname);
  return serveHtmlAsset(env, request, assetPath, injectHead, title);
}

export async function serveSurveyPageWithShareMeta(env: Env, request: Request, surveyId: number): Promise<Response> {
  let injectHead: string | undefined;
  try {
    const meta = await loadSurveyShareMeta(env.DB, surveyId);
    if (meta) {
      const origin = resolvePublicOrigin(env, new URL(request.url).origin);
      const ogImage = `${origin}/s/${surveyId}/og.png`;
      // r18 卷的 unfurl 文案同样走安全描述：描述本身可能就是限制级内容。
      const description =
        meta.contentRating === "r18"
          ? "该内容为 18+ 内容，确认年龄后即可填写"
          : meta.description?.slice(0, 120) || `${meta.questionCount} 道题，点击立即填写`;
      injectHead = [
        `<meta property="og:type" content="website" />`,
        `<meta property="og:title" content="${escapeMetaAttribute(meta.title)}" />`,
        `<meta property="og:description" content="${escapeMetaAttribute(description)}" />`,
        `<meta property="og:image" content="${ogImage}" />`,
        `<meta property="og:url" content="${origin}/s/${surveyId}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${escapeMetaAttribute(meta.title)}" />`,
        `<meta name="twitter:description" content="${escapeMetaAttribute(description)}" />`,
        `<meta name="twitter:image" content="${ogImage}" />`,
      ].join("\n    ");
    }
  } catch (error) {
    console.warn("Survey share meta injection failed", error);
  }
  return serveHtmlAsset(env, request, "/survey.html", injectHead);
}
