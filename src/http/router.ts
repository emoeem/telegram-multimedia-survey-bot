import type { Env } from "../env";
import { answerCallbackQuery, sendMessage } from "../bot/telegram";
import { handleTelegramUpdate, isTelegramUpdateHandledError } from "../bot/router";
import { ensureTelegramCommandMenu, ensureWebhookAllowsChannelPosts } from "../bot/bootstrap";
import type { BotContext } from "../bot/types";
import { parseTelegramUpdate } from "../bot/update-parser";
import { isWebhookSecretValid } from "../core/security";
import { parseAdminIds } from "../core/admin-ids";
import { isDatabaseCapacityError } from "../db/errors";
import { getSystemSetting } from "../db/repositories/system-settings.repository";
import { CERT_PAGE_REDIRECT_LOCATION, certPageRoute } from "./cert-page";
import { CERT_SHARE_PATH, handleCertShare } from "./cert-share";
import { CERT_DRAW_PATH, handleCertDraw } from "./cert-draw";
import { handleSubmitApiRequest, isSubmitApiPath } from "./submit-api";
import { bareAdminRedirect, homeRedirectLocation, submitPageMetaPath } from "./public-page";
import { handleInternalRenderRequest } from "./internal-render";
import {
  serveHtmlAsset,
  servePublicPageWithMeta,
  serveHtmlAssetWithMeta,
  serveSurveyPageWithShareMeta,
  serveStaticAsset,
} from "./static-pages";
import { guardApiResponse } from "./guard";
import { handleLicenseApiRequest } from "./license-api";
import { handleRemoteApiRequest } from "./remote-api";
import { handleControlApiRequest } from "./control-api";
import { handleAdminApi } from "./admin-api";
import { CERT_CONTENT_SETTING_KEY } from "./admin/cert-content";
import { handleSurveyApiRequest } from "./survey-api";
import { handlePlazaApiRequest } from "./plaza-api";
import { handleNoteApiRequest } from "./note-api";
import { handleMeApiRequest } from "./me-api";
import { handleCoinApiRequest } from "./coin-api";
import { handleShowcaseApiRequest } from "./showcase-api";
import { handleTrialApiRequest } from "./trial-api";
import { handleEmailAuthApiRequest } from "./email-auth-api";
import { handleReportRequest } from "./report-api";
import { handleSharePageRequest } from "./share-api";
import { handleSeriesApiRequest } from "./series-api";
import { createExportJobSender } from "../services/export-job-dispatch.service";
import { checkDeploymentLicense } from "../services/license-client.service";
import { isLicenseCenter } from "../services/deployment-role.service";
import { getSurveyOgImage, loadSurveyShareMeta } from "../services/survey-og-image.service";
import { resolveSubmissionBotUrl } from "../services/contact-links.service";
import { resolvePublicOrigin } from "../services/public-origin.service";
import { rateLimitIpSubject, resolveClientIdentity } from "../services/client-identity.service";
import { runSeriesUpdateNotification } from "../services/series-follow.service";
import { createUpdateDedupStore } from "../services/update-dedup.service";
import { withRequestMetrics } from "../observability/metrics";

/**
 * 连载召回内部端点：只接受 SELF binding 的 HMAC 签名请求。常数时间比较，
 * 验签失败一律 404（不暴露端点存在性）。
 */
async function handleInternalSeriesNotify(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.WEBHOOK_SECRET ?? ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const provided = request.headers.get("x-notify-signature") ?? "";
  const a = encoder.encode(expected);
  const b = encoder.encode(provided);
  const mismatch = a.length !== b.length || [...a].some((byte, index) => byte !== b[index]);
  if (!provided || mismatch) return new Response(null, { status: 404 });
  let payload: { seriesId?: unknown; surveyId?: unknown; chapterTitle?: unknown };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return new Response(null, { status: 404 });
  }
  const seriesId = Number(payload.seriesId);
  const surveyId = Number(payload.surveyId);
  const chapterTitle = typeof payload.chapterTitle === "string" ? payload.chapterTitle.slice(0, 200) : "";
  if (!Number.isInteger(seriesId) || !Number.isInteger(surveyId) || !chapterTitle) {
    return new Response(null, { status: 404 });
  }
  const titleRow = await env.DB.prepare("SELECT title FROM survey_series WHERE id = ? LIMIT 1").bind(seriesId).first<{
    title: string;
  }>();
  if (!titleRow) return Response.json({ ok: true, notified: 0, pushed: 0 });
  const result = await runSeriesUpdateNotification(env, {
    seriesId,
    seriesTitle: titleRow.title,
    surveyId,
    chapterTitle,
  });
  return Response.json({ ok: true, ...result });
}

/**
 * fetch 钩子的全部路由分发。原为 src/index.ts 的 fetch 方法体（拆分见
 * docs/OPTIMIZATION_BACKLOG_2026-11-14.md §D 的 `fetch: route()` 目标形态）。
 */
export async function route(request: Request, env: Env, ctx?: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  // One structured metrics line per request (route/duration/status plus the
  // D1 rows read and KV/queue/Telegram call counts). Instrumented bindings
  // also make the request's own D1 query budget visible in production.
  return withRequestMetrics(request, env, async (env, metrics) => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        environment: env.ENVIRONMENT,
        version: env.APP_VERSION ?? "unknown",
        licenseEnforcement: env.LICENSE_ENFORCEMENT ?? "disabled",
      });
    }

    // 裸域名：后台 SPA 的 basename 是 /admin，React Router 匹配不到 "/"，
    // 直接发 index.html 就是一张纯白页。首页是问卷列表，指过去。
    const homeRedirect = homeRedirectLocation(url.pathname);
    if (homeRedirect) return new Response(null, { status: 302, headers: { Location: homeRedirect } });

    // 后台视图的裸路径（/exports、/settings …）补回 /admin 前缀。
    // 不补的话它们会走 SPA 兜底，然后在 React Router 里静默跳回总览。
    const bareAdmin = bareAdminRedirect(url.pathname);
    if (bareAdmin) return new Response(null, { status: 302, headers: { Location: bareAdmin } });

    // Internal endpoints (queue consumers hand browser renders to a request
    // context); token-authenticated, must be routed before the SPA/API blocks.
    if (url.pathname.startsWith("/internal/")) return handleInternalRenderRequest(request, env, ctx);

    // Admin SPA entry. html_handling="none" means /admin has no directory
    // index, so serve the built index.html explicitly (client-side routing
    // handles every /admin/* view).
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return serveHtmlAsset(env, request, "/index.html");
    }

    if (url.pathname.startsWith("/api/admin/")) return handleAdminApi(request, env);

    // Web survey entry: /s/:id renders the public survey page; the page
    // itself talks to /api/survey/* for the definition and answers.
    const surveyPageMatch = url.pathname.match(/^\/s\/(\d+)$/);
    const ogImageMatch = url.pathname.match(/^\/s\/(\d+)\/og\.png$/);
    if (ogImageMatch) {
      const surveyId = Number(ogImageMatch[1]);
      try {
        const meta = await loadSurveyShareMeta(env.DB, surveyId);
        if (!meta) return new Response("Not Found", { status: 404 });
        const bytes = await getSurveyOgImage(env, meta, resolvePublicOrigin(env, url.origin));
        if (!bytes) return new Response("Not Found", { status: 404 });
        return new Response(bytes, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=600",
          },
        });
      } catch (error) {
        console.error("OG image rendering failed", error);
        return new Response("Rendering unavailable", { status: 503 });
      }
    }
    if (surveyPageMatch) {
      return serveSurveyPageWithShareMeta(env, request, Number(surveyPageMatch[1]));
    }
    if (url.pathname === "/s" || url.pathname.startsWith("/s/")) {
      return servePublicPageWithMeta(env, request, "/s");
    }

    if (url.pathname === "/plaza" || url.pathname.startsWith("/plaza/")) {
      return servePublicPageWithMeta(env, request, "/plaza");
    }

    // Showcase (展示区): the immersive person gallery shares the survey SPA
    // bundle and picks its screen from the pathname.
    if (url.pathname === "/showcase" || url.pathname.startsWith("/showcase/")) {
      return servePublicPageWithMeta(env, request, "/showcase");
    }

    // Web task system player page (/trial) shares the survey SPA bundle; the
    // page itself decides between the survey list and the trial screen.
    if (url.pathname === "/trial" || url.pathname.startsWith("/trial/")) {
      return servePublicPageWithMeta(env, request, "/trial");
    }

    // Email auth pages share the survey SPA bundle as well.
    // "我的" 个人中心 shares the survey SPA bundle as well.
    if (url.pathname === "/me" || url.pathname.startsWith("/me/")) {
      return servePublicPageWithMeta(env, request, "/me");
    }

    // 金币经济三屏（余额/签到/挑战、报告抽卡、投稿中心）与 /me 同属问卷
    // SPA bundle，由路径决定渲染哪一屏。
    if (
      url.pathname === "/coins" ||
      url.pathname.startsWith("/coins/") ||
      url.pathname === "/gacha" ||
      url.pathname.startsWith("/gacha/") ||
      url.pathname === "/submissions" ||
      url.pathname.startsWith("/submissions/")
    ) {
      return servePublicPageWithMeta(
        env,
        request,
        url.pathname.startsWith("/gacha")
          ? "/gacha"
          : url.pathname.startsWith("/submissions")
            ? "/submissions"
            : "/coins",
      );
    }

    // 旧的投稿两条路径已经并进 /submissions 投稿中心（三个页签：账号投稿 /
    // 免登录投稿 / 我的投稿）。这里 302 而不是直接删，是因为 /submit 被配在
    // SUBMISSION_BOT_URL 里、也发进过群和邮件，删掉就是一堆白屏。
    //
    // **相对路径 Location**：这个 Worker 同时挂在 emoe.eu.cc（国内 SNI 阻断）
    // 和 emoemok.top（Vercel 中继）后面，中继改写后 request.url 的 host 永远
    // 是 emoe.eu.cc —— 写绝对地址会把国内用户甩回打不开的域名。与上面 cert
    // 的重定向同一条规则。
    const submitMeta = submitPageMetaPath(url.pathname);
    if (submitMeta) {
      const tab = submitMeta === "/submit/inbox" ? "inbox" : "anon";
      return new Response(null, { status: 302, headers: { Location: `/submissions?tab=${tab}` } });
    }

    // 认证卡生成器：纯前端静态页，构建时由 scripts/sync-cert.mjs 拷进
    // admin/public/cert/。内容包走 /api/cert-content（公开只读）。
    //
    // 路由判定抽在 src/http/cert-page.ts：那里钉住了「重定向必须是相对路径」
    // —— 这个 Worker 同时挂在 emoe.eu.cc（Cloudflare，国内 SNI 阻断）和
    // emoemok.top（Vercel 中继）后面，中继改写后 request.url 的 host 永远是
    // emoe.eu.cc，用绝对地址重定向会把国内用户甩回打不开的域名。
    const certRoute = certPageRoute(url.pathname);
    if (certRoute?.kind === "redirect") {
      // 页面里的脚本/样式是相对路径，/cert 下会被解析成 /app.js，必须带尾斜杠。
      return new Response(null, { status: 302, headers: { Location: CERT_PAGE_REDIRECT_LOCATION } });
    }
    if (certRoute?.kind === "html") {
      /* 走 head 注入：canonical / og:url 与其它公开页同源（PUBLIC_ORIGIN），
       * 从国内域名分享出去才是一条带标题的完整链接。 */
      return serveHtmlAssetWithMeta(env, request, "/cert/index.html", "/cert");
    }

    // 认证卡内容包：公开只读，管理端通过 /api/admin/cert-content 写入。
    if (url.pathname === "/api/cert-content") {
      const raw = await getSystemSetting(env.DB, CERT_CONTENT_SETTING_KEY);
      if (!raw) return Response.json({ ok: true, pack: null });
      try {
        return Response.json({ ok: true, pack: JSON.parse(raw) });
      } catch {
        return Response.json({ ok: true, pack: null });
      }
    }

    // 认证卡「完成制作」时的原图 + 成品同步：GET 探测开关，POST 上传。
    // 目标频道与报告归档频道共用同一条解析链（见 src/http/cert-share.ts），
    // 未带来源标头的跨站表单一律 403。
    if (url.pathname === CERT_SHARE_PATH) {
      return handleCertShare(request, env, {
        // 空串 = 地址未知：处理方会跳过按地址限流（而不是共用一个 "unknown" 桶）。
        clientKey: rateLimitIpSubject(resolveClientIdentity(request, env)) ?? "",
      });
    }

    // 认证卡抽取池：主题内容包指向小游戏区的任务包，前端带 18+ ack 实时抽。
    if (url.pathname === CERT_DRAW_PATH) {
      return handleCertDraw(request, env, {
        clientKey: rateLimitIpSubject(resolveClientIdentity(request, env)) ?? "",
      });
    }

    if (url.pathname === "/series" || url.pathname.startsWith("/series/")) {
      return servePublicPageWithMeta(env, request, "/series");
    }

    // 纸条聊天（0089）：放/抽/对话三页签，与其它公开页共用问卷 SPA。
    if (url.pathname === "/notes" || url.pathname.startsWith("/notes/")) {
      return servePublicPageWithMeta(env, request, "/notes");
    }

    if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
      return servePublicPageWithMeta(env, request, "/auth");
    }

    // 免登录投稿(/api/submit/*):并轨后由本 Worker 直接服务(数据在本站
    // D1,migration 0088;实现见 src/http/submit-api.ts)。历史上这里曾把
    // 请求代理到独立的 submission-bot Worker,该 Worker 已退役。
    //
    // 必须放在 /api/submissions(金币投稿,本站)之前,且 isSubmitApiPath
    // 用的是精确前缀匹配:写成 startsWith("/api/submit") 会把 /api/submissions
    // 一起吞掉。
    if (isSubmitApiPath(url.pathname)) {
      return guardApiResponse(request, env, url, () => handleSubmitApiRequest(request, env, url));
    }

    if (url.pathname.startsWith("/api/me/")) {
      return guardApiResponse(request, env, url, () => handleMeApiRequest(request, env, url));
    }

    // 连载更新召回的内部端点（0084）：SELF binding + HMAC 验签，无会话。
    if (url.pathname === "/internal/series-notify" && request.method === "POST") {
      return handleInternalSeriesNotify(request, env);
    }

    if (url.pathname.startsWith("/api/series")) {
      return guardApiResponse(request, env, url, () => handleSeriesApiRequest(request, env, url));
    }

    if (
      url.pathname.startsWith("/api/coins/") ||
      url.pathname.startsWith("/api/gacha/") ||
      url.pathname.startsWith("/api/submissions")
    ) {
      return guardApiResponse(request, env, url, () => handleCoinApiRequest(request, env, url));
    }

    if (url.pathname.startsWith("/api/plaza/")) {
      return guardApiResponse(request, env, url, () => handlePlazaApiRequest(request, env, url));
    }

    // 纸条聊天（0089）：放/抽/会话/消息/举报 + 管理端下架复核。
    if (url.pathname === "/api/note" || url.pathname.startsWith("/api/note/")) {
      return guardApiResponse(request, env, url, () => handleNoteApiRequest(request, env, url));
    }

    if (url.pathname === "/api/showcase" || url.pathname.startsWith("/api/showcase/")) {
      return guardApiResponse(request, env, url, () => handleShowcaseApiRequest(request, env, url));
    }

    if (url.pathname.startsWith("/api/survey/") || url.pathname === "/api/surveys") {
      return guardApiResponse(request, env, url, () => handleSurveyApiRequest(request, env, url));
    }

    if (url.pathname.startsWith("/api/report/") || url.pathname.startsWith("/report/")) {
      return guardApiResponse(request, env, url, () => handleReportRequest(request, env, url));
    }

    // 报告分享卡（0081）：/r/:token 公开结局卡页 + og.png。公开页不经过
    // guardApiResponse——它只服务分享行快照的白名单投影。
    if (url.pathname === "/r" || url.pathname.startsWith("/r/")) {
      return (await handleSharePageRequest(request, env, url)) ?? servePublicPageWithMeta(env, request, "/plaza");
    }

    // 个人画像分享（0085）：/u/:token 公开画像页 + og.png。
    if (url.pathname === "/u" || url.pathname.startsWith("/u/")) {
      return (await handleSharePageRequest(request, env, url)) ?? servePublicPageWithMeta(env, request, "/plaza");
    }

    if (url.pathname.startsWith("/api/auth/email/")) {
      return guardApiResponse(request, env, url, () => handleEmailAuthApiRequest(request, env, url));
    }

    if (url.pathname.startsWith("/api/trial/")) {
      return guardApiResponse(request, env, url, () => handleTrialApiRequest(request, env, url));
    }

    if (url.pathname.startsWith("/api/control/customer/") || url.pathname.startsWith("/api/control/runner/")) {
      const controlResponse = await handleControlApiRequest(request, env, { isAdmin: false, userId: null });
      if (controlResponse) return controlResponse;
    }
    if (url.pathname.startsWith("/api/control/")) return handleAdminApi(request, env);

    const licenseApiResponse = await handleLicenseApiRequest(
      request,
      env.DB,
      env.LICENSE_ADMIN_TOKEN,
      env.DEPLOYMENT_ROLE,
    );
    if (licenseApiResponse) {
      return licenseApiResponse;
    }

    const remoteApiResponse = await handleRemoteApiRequest(request, env);
    if (remoteApiResponse) {
      return remoteApiResponse;
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

      if (!isWebhookSecretValid(env.WEBHOOK_SECRET, secretHeader)) {
        return new Response("Unauthorized", { status: 403 });
      }

      // 通过 secret 校验后才计 botUpdates：伪造请求（403）不占这个数。
      // 伪造流量本身由 request_metrics 的 status=403 行回答。
      metrics.recordBotUpdate();

      await ensureWebhookAllowsChannelPosts(env, url.origin);

      const deploymentLicense = await checkDeploymentLicense(env);
      if (!deploymentLicense.allowed) {
        console.error("Deployment license rejected", deploymentLicense.code, deploymentLicense.message);
        return Response.json(
          {
            ok: false,
            error: "license_unavailable",
            code: deploymentLicense.code,
          },
          {
            status: 503,
            headers: {
              "Cache-Control": "no-store",
              "Retry-After": "3600",
            },
          },
        );
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      const update = parseTelegramUpdate(body);
      if (!update) {
        return new Response("Bad Request", { status: 400 });
      }

      // Idempotency: Telegram redelivers an update when our answer was slow or
      // lost. Claim it before doing any work so a redelivery of a completed
      // create/answer/submit/publish/export/reward action is skipped instead
      // of running its side effects twice.
      const dedup = createUpdateDedupStore(env.DB);
      if (!(await dedup.claim(update.update_id))) {
        metrics.recordDuplicateUpdate();
        console.info("Duplicate Telegram update skipped", { updateId: update.update_id });
        return Response.json({ ok: true, duplicate: true });
      }

      await ensureTelegramCommandMenu(env);

      console.log("Telegram update received", {
        updateId: update.update_id,
        kind: update.message ? "message" : "callback",
        userId: update.message?.from?.id ?? update.callback_query?.from?.id,
        chatId: update.message?.chat?.id ?? update.callback_query?.message?.chat.id,
      });

      try {
        const context: BotContext = {
          botToken: env.BOT_TOKEN,
          db: env.DB,
          cache: env.CACHE,
          session: env.SESSION,
          builder: env.BUILDER,
          adminIds: parseAdminIds(env.ADMIN_IDS),
          exportQueue: createExportJobSender(env),
          ...(env.BROWSER ? { browser: env.BROWSER } : {}),
          mediaKv: env.MEDIA_KV,
          media: env.MEDIA,
          origin: resolvePublicOrigin(env, url.origin),
          submissionBotUrl: resolveSubmissionBotUrl(env),
          communityGroupUrl: env.COMMUNITY_GROUP_URL || null,
          // Investigation: the BotContext field is consumed only by vendor-only
          // bot surfaces; customer licensing/heartbeat uses Env.LICENSE_SERVER_URL
          // directly in HTTP services. Never advertise a customer Worker as its own
          // license server, because that makes the origin semantically ambiguous.
          licenseServerUrl: isLicenseCenter(env) ? resolvePublicOrigin(env, url.origin) : null,
          surveyCodePepper: env.SURVEY_CODE_PEPPER,
          // Same single source of truth as the web API: only the authorization
          // center may issue licenses or hand out trial accounts.
          licenseAdminEnabled: isLicenseCenter(env),
          ...(env.BROWSER ? { browser: env.BROWSER } : {}),
          webhookSecret: env.WEBHOOK_SECRET,
        };
        await handleTelegramUpdate(update, context);
        await dedup.complete(update.update_id);
        return Response.json({ ok: true });
      } catch (error) {
        console.error("Telegram webhook handler failed", error);
        // Release only defends against an exceptional duplicate delivery path.
        // Failed retries are driven by the 30-minute recovery cron (report-delivery /
        // result-visual / image-generator). We intentionally return 200 below so
        // Telegram stops retrying the user action and cannot execute it twice.
        await dedup.release(update.update_id);
        // The router answers the user itself when a handler fails; only send
        // the generic notice for failures raised before that point.
        if (!isTelegramUpdateHandledError(error)) {
          // A silent failure reads as "the bot is dead" and leaves the chat's
          // loading spinner running, so always answer the user when possible.
          try {
            const callback = update.callback_query;
            const chatId = update.message?.chat?.id ?? callback?.message?.chat.id;
            if (typeof chatId === "number") {
              if (callback) {
                await answerCallbackQuery(env.BOT_TOKEN, callback.id, "服务暂时不可用，请稍后再试");
              }
              await sendMessage(
                env.BOT_TOKEN,
                chatId,
                isDatabaseCapacityError(error)
                  ? "⚠️ 数据库今日查询额度已用尽，暂时无法处理操作，请稍后再试。"
                  : "😥 服务暂时出了点小问题，请稍后再试。",
              );
            }
          } catch (notifyError) {
            console.warn("Telegram failure notice failed", notifyError);
          }
        }
        return Response.json({ ok: false }, { status: 200 });
      }
    }

    // Admin SPA fallback: any path that isn't a known static asset extension
    // and wasn't matched by a business route above should render the admin
    // index.html so React Router handles client-side routing for /surveys,
    // /reports, /settings and friends.
    const ext = url.pathname.split(".").pop()?.toLowerCase();
    const isStaticAsset = Boolean(
      ext &&
      [
        "html",
        "js",
        "mjs",
        "css",
        "map",
        "png",
        "jpg",
        "jpeg",
        "gif",
        "svg",
        "ico",
        "webp",
        "avif",
        "woff",
        "woff2",
        "ttf",
        "eot",
        "otf",
        "txt",
        "webmanifest",
        "json",
      ].includes(ext),
    );
    if (!isStaticAsset) {
      return serveHtmlAsset(env, request, "/index.html");
    }
    return serveStaticAsset(env, request);
  });
}
