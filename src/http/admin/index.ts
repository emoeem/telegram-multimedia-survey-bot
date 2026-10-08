import { getFirstAdminUser, getUserById, getUserByTelegramId } from "../../db/repositories/user.repository";
import { isWebhookSecretValid } from "../../core/security";
import { describeDatabaseError, isDatabaseCapacityError } from "../../db/errors";
import { hasActiveCreatorTrial } from "../../db/repositories/creator-trial.repository";
import type { Env } from "../../index";
import { KVMediaStore } from "../../services/media/temporary-media-store";
import { handleAdminRead } from "./read";
import { handleAdminWrite } from "./write";
import { INIT_DATA_MAX_AGE_SECONDS, hexToBytes } from "./helpers";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  createAdminSessionValue,
  resolveSessionSecret,
  verifyAdminSessionValue,
} from "../../services/admin-session.service";
import { createMediaAsset } from "../../db/repositories/media.repository";
import {
  ADMIN_LOGIN_COOKIE,
  approveAdminLoginRequest,
  consumeAdminLoginRequest,
  createAdminLoginRequest,
  getAdminLoginRequest,
  verifyAdminLoginCookie,
} from "../../services/admin-login.service";
import { consumeAdminMagicLink } from "../../services/admin-magic-link.service";
import { getBotUsername } from "../../bot/telegram";
import { checkAtomicRateLimit, checkRateLimit, rateLimitResponse } from "../../services/rate-limit.service";
import { ADMIN_LOGIN_RATE_LIMIT, ADMIN_LOGIN_RATE_WINDOW_SECONDS } from "../../services/admin-login.service";
import { ADMIN_PASSWORD_SETTING_KEY, verifyAdminPassword } from "../../services/admin-password.service";
import {
  ADMIN_SESSION_EPOCH_KEY,
  getSystemSettingValue,
  loadAdminSessionEpoch,
  saveSystemSetting,
} from "../../services/system-settings.service";
import { handleControlApiRequest } from "../control-api";
import { handleAdminTrashRead, handleAdminTrashWrite } from "./trash";
import {
  configuredDeploymentRole,
  describeDeploymentRoleIssue,
  isLicenseCenter,
  resolveDeploymentRole,
} from "../../services/deployment-role.service";

export async function handleAdminApi(request: Request, env: Env): Promise<Response> {
  try {
    return await routeAdminApi(request, env);
  } catch (error) {
    console.error("Admin API request failed", error);
    return Response.json(
      {
        code: isDatabaseCapacityError(error) ? "database_capacity" : "internal_error",
        message: describeDatabaseError(error),
        requestId: crypto.randomUUID(),
      },
      {
        status: isDatabaseCapacityError(error) ? 503 : 500,
        // Failed admin calls must never be cached by the browser or an
        // intermediate: a stored 5xx used to keep an operator stuck.
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

async function routeAdminApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = crypto.randomUUID();
  const fail = (status: number, code: string, message: string) =>
    // `no-store` on failures too: an edge/intermediary that caches a 401/403
    // would keep telling an already-logged-in admin that they are logged out.
    Response.json({ code, message, requestId }, { status, headers: { "Cache-Control": "no-store" } });

  if (request.method === "POST" && url.pathname === "/api/admin/auth/password") {
    const clientIp =
      request.headers.get("CF-Connecting-IP") ??
      request.headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim() ??
      "unknown";
    const limiter = await checkAtomicRateLimit(
      env.DB,
      env.CACHE,
      "admin-password-login",
      clientIp.slice(0, 100),
      ADMIN_LOGIN_RATE_LIMIT,
      ADMIN_LOGIN_RATE_WINDOW_SECONDS,
    );
    if (!limiter.allowed) return rateLimitResponse(limiter.retryAfterSeconds);
    const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
    const password = typeof body?.password === "string" ? body.password : "";
    const configuredHash = await getSystemSettingValue(env.DB, ADMIN_PASSWORD_SETTING_KEY);
    // Fail closed: a deployment without a configured password must never fall
    // back to a built-in credential. The operator sets the initial hash with
    // `scripts/set-admin-password.mjs` or from the system settings page.
    if (!configuredHash) {
      return fail(
        503,
        "admin_password_not_configured",
        "管理员密码尚未设置，请运行 scripts/set-admin-password.mjs 初始化后再登录。",
      );
    }
    const valid = await verifyAdminPassword(password, configuredHash);
    if (!valid) return fail(401, "invalid_password", "管理员密码错误");
    const adminIds = env.ADMIN_IDS.split(",").map(Number).filter(Number.isFinite);
    const user = adminIds.length ? await getUserByTelegramId(env.DB, adminIds[0]!) : await getFirstAdminUser(env.DB);
    // A fresh deployment has the password hash but no `users` row yet: those are
    // only created when someone messages the bot. Without this hint the very
    // first customer admin sees a bare "没有管理员账号" and cannot tell that the
    // fix is to open the bot and send /start once.
    if (!user || (user.systemRole !== "admin" && !adminIds.includes(user.telegramUserId))) {
      return fail(
        403,
        "admin_access_denied",
        "当前没有可用于管理后台登录的管理员账号。请先用管理员 Telegram 账号向机器人发送 /start 完成注册，再返回此页面登录。",
      );
    }
    const epoch = await loadAdminSessionEpoch(env.DB);
    const session = await createAdminSessionValue(resolveSessionSecret(env), user.id, epoch);
    return new Response(JSON.stringify({ ok: true, redirect: "/admin" }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": `${ADMIN_SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}; Max-Age=${ADMIN_SESSION_TTL_SECONDS}`,
      },
    });
  }

  // Simple Telegram deep-link login. The browser creates a short-lived request;
  // Telegram confirms it through the bot, so no BotFather OAuth configuration is needed.
  if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/admin/auth/telegram/start") {
    const clientIp =
      request.headers.get("CF-Connecting-IP") ??
      request.headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim() ??
      "unknown";
    const limiter = await checkAtomicRateLimit(
      env.DB,
      env.CACHE,
      "admin-login-start",
      clientIp.slice(0, 100),
      ADMIN_LOGIN_RATE_LIMIT,
      ADMIN_LOGIN_RATE_WINDOW_SECONDS,
    );
    if (!limiter.allowed) return rateLimitResponse(limiter.retryAfterSeconds);
    const login = await createAdminLoginRequest(env.CACHE, env.WEBHOOK_SECRET);
    const username = await getBotUsername(env.BOT_TOKEN);
    return Response.json(
      { loginUrl: `https://t.me/${username}?start=admin_login_${login.id}`, expiresIn: 300 },
      {
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": login.cookie.replace("; Secure", url.protocol === "https:" ? "; Secure" : ""),
        },
      },
    );
  }

  if (request.method === "GET" && url.pathname === "/api/admin/auth/telegram/status") {
    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${ADMIN_LOGIN_COOKIE}=`));
    const id = cookie
      ? await verifyAdminLoginCookie(env.WEBHOOK_SECRET, cookie.slice(ADMIN_LOGIN_COOKIE.length + 1))
      : null;
    if (!id) return fail(401, "invalid_login_request", "登录请求已失效，请重新开始登录。");
    const state = await getAdminLoginRequest(env.CACHE, id);
    if (!state) return fail(410, "login_request_expired", "登录请求已过期，请重新开始登录。");
    if (state.status === "cancelled")
      return Response.json({ status: "cancelled" }, { headers: { "Cache-Control": "no-store" } });
    if (state.status !== "approved")
      return Response.json({ status: "pending" }, { headers: { "Cache-Control": "no-store" } });
    if (!state.userId) return fail(401, "invalid_login_request", "登录状态无效，请重新开始登录。");
    const target = await getUserByTelegramId(env.DB, state.userId);
    const adminIds = env.ADMIN_IDS.split(",").map(Number).filter(Number.isFinite);
    if (!target) return fail(403, "admin_access_denied", "该 Telegram 账号没有管理后台权限。");
    // A creator trial opens the panel too; the read/write handlers keep that
    // session scoped to the creator's own surveys.
    const canUseAdminPanel =
      target.systemRole === "admin" ||
      adminIds.includes(target.telegramUserId) ||
      (await hasActiveCreatorTrial(env.DB, target.id));
    if (!canUseAdminPanel) return fail(403, "admin_access_denied", "该 Telegram 账号没有管理后台权限。");
    const consumed = await consumeAdminLoginRequest(env.DB, env.CACHE, id, state.userId);
    if (!consumed) return fail(409, "login_already_used", "这个登录请求已经完成，请重新开始登录。");
    const epoch = await loadAdminSessionEpoch(env.DB);
    const session = await createAdminSessionValue(resolveSessionSecret(env), target.id, epoch);
    return new Response(JSON.stringify({ status: "approved", redirect: "/admin" }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": `${ADMIN_SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}; Max-Age=${ADMIN_SESSION_TTL_SECONDS}`,
      },
    });
  }

  // 一次性免密登录链接：机器人里的「🌐 网页管理后台」按钮点开就是这里。
  // 纯 GET + 302，不需要前端参与，所以 Telegram 内置浏览器 / 微信 / 任何
  // WebView 都能用；兑换失败时回登录页并带上原因，让页面给出人话提示。
  if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/admin/auth/link") {
    const clientIp =
      request.headers.get("CF-Connecting-IP") ??
      request.headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim() ??
      "unknown";
    const limiter = await checkAtomicRateLimit(env.DB, env.CACHE, "admin-magic-link", clientIp.slice(0, 100), 20, 300);
    if (!limiter.allowed) return rateLimitResponse(limiter.retryAfterSeconds);
    const bounce = (reason: string) =>
      new Response(null, {
        status: 302,
        headers: {
          Location: `/admin/login?reason=${reason}`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    const token = url.searchParams.get("t") ?? "";
    const magicUserId = await consumeAdminMagicLink(env.DB, env.CACHE, token);
    if (magicUserId === null) return bounce("link_invalid");
    const magicUser = await getUserById(env.DB, magicUserId);
    if (!magicUser) return bounce("link_invalid");
    // 兑换时再查一次权限：链接还有效但授权已被撤销/到期时不能放行。
    const magicAdminIds = env.ADMIN_IDS.split(",").map(Number).filter(Number.isFinite);
    const allowed =
      magicUser.systemRole === "admin" ||
      magicAdminIds.includes(magicUser.telegramUserId) ||
      (await hasActiveCreatorTrial(env.DB, magicUser.id));
    if (!allowed) return bounce("no_access");
    const magicEpoch = await loadAdminSessionEpoch(env.DB);
    const magicSession = await createAdminSessionValue(resolveSessionSecret(env), magicUser.id, magicEpoch);
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/admin",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Set-Cookie": `${ADMIN_SESSION_COOKIE}=${magicSession}; Path=/; HttpOnly; SameSite=Lax${
          url.protocol === "https:" ? "; Secure" : ""
        }; Max-Age=${ADMIN_SESSION_TTL_SECONDS}`,
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/auth/browser") {
    return new Response(null, { status: 302, headers: { Location: "/admin/login", "Cache-Control": "no-store" } });
  }

  // Logout: bump the session epoch so every previously issued admin session
  // stops verifying (there is no per-session store to revoke them one by one).
  // Only an authenticated admin may trigger it, so a cross-site request can't
  // force every admin to re-login.
  if (request.method === "POST" && url.pathname === "/api/admin/auth/logout") {
    const epoch = await loadAdminSessionEpoch(env.DB);
    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`));
    const sessionUserId = cookie
      ? await verifyAdminSessionValue(resolveSessionSecret(env), cookie.slice(ADMIN_SESSION_COOKIE.length + 1), epoch)
      : null;
    if (sessionUserId !== null) {
      await saveSystemSetting(env.DB, ADMIN_SESSION_EPOCH_KEY, String(epoch + 1), sessionUserId);
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol === "https:" ? "; Secure" : ""}`,
      },
    });
  }

  // Local-development identity spoofing: only honored when the deployment is
  // explicitly in development mode AND the request presents the shared
  // ADMIN_DEV_AUTH_SECRET (constant-time compared). A public deployment must
  // never authenticate on a client-controlled user id header alone.
  const devSpoofedTelegramId =
    env.ENVIRONMENT === "development" &&
    isWebhookSecretValid(env.ADMIN_DEV_AUTH_SECRET, request.headers.get("x-dev-auth-secret"))
      ? Number(request.headers.get("x-telegram-user-id"))
      : NaN;
  const telegramId = (await verifyTelegramWebAppUser(request, env.BOT_TOKEN)) || devSpoofedTelegramId;
  const sessionUserId = await (async () => {
    if (Number.isInteger(telegramId)) return null;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const match = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`));
    if (!match) return null;
    const value = match.slice(ADMIN_SESSION_COOKIE.length + 1);
    const epoch = await loadAdminSessionEpoch(env.DB);
    return verifyAdminSessionValue(resolveSessionSecret(env), value, epoch);
  })();
  const user = Number.isInteger(telegramId)
    ? await getUserByTelegramId(env.DB, telegramId)
    : sessionUserId
      ? await getUserById(env.DB, sessionUserId)
      : null;
  if (!user) return fail(401, "unauthorized", "请先登录管理后台。");
  const adminIds = env.ADMIN_IDS.split(",").map(Number).filter(Number.isFinite);
  const isAdmin = user.systemRole === "admin" || adminIds.includes(user.telegramUserId);
  const json = (body: unknown) => Response.json(body, { headers: { "Cache-Control": "no-store" } });

  // Lets the SPA adapt its navigation to the signed-in role. A creator trial
  // reaches the panel but must only ever see its own survey workspace, so the
  // shell needs to know without probing an admin-only endpoint.
  if (request.method === "GET" && url.pathname === "/api/admin/session") {
    if (!isAdmin && !(await hasActiveCreatorTrial(env.DB, user.id))) {
      return fail(403, "admin_access_denied", "当前账号没有管理后台权限。");
    }
    return json({
      ok: true,
      role: isAdmin ? "admin" : "creator",
      userId: user.id,
      telegramUserId: user.telegramUserId,
      firstName: user.firstName,
    });
  }

  const trashReadResponse = await handleAdminTrashRead(url, env, { user, isAdmin, fail, json });
  if (trashReadResponse) return trashReadResponse;
  if (url.pathname === "/api/admin/trash" && (request.method === "POST" || request.method === "DELETE")) {
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as Record<string, unknown> | null;
    if (!body) return fail(400, "invalid_body", "请求体必须是 JSON 对象");
    const trashWriteResponse = await handleAdminTrashWrite(
      request,
      url,
      env,
      { user, isAdmin, requestId, fail, json },
      body,
    );
    if (trashWriteResponse) return trashWriteResponse;
  }

  if (url.pathname.startsWith("/api/control/")) {
    const controlResponse = await handleControlApiRequest(request, env, { isAdmin, userId: user.id });
    if (controlResponse) return controlResponse;
  }

  // Upload a survey background-music audio file into the media system.
  if (request.method === "POST" && url.pathname === "/api/admin/media/audio") {
    if (!isAdmin && !(await hasActiveCreatorTrial(env.DB, user.id))) {
      return fail(403, "creator_trial_required", "需要有效的创作者权限才能上传背景音乐。");
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return fail(400, "invalid_upload", "请选择音频文件");
    }
    if (!file.type.startsWith("audio/")) {
      return fail(400, "invalid_upload", "仅支持音频文件");
    }
    if (file.size > 20 * 1024 * 1024) {
      return fail(413, "upload_too_large", "背景音乐不能超过 20MB");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const store = new KVMediaStore(env.MEDIA_KV);
    const storageKey = `media:survey-audio:${crypto.randomUUID()}`;
    await store.put({ storageKey, bytes, contentType: file.type });
    const asset = await createMediaAsset(env.DB, {
      scope: "survey",
      mediaType: "audio",
      storageKind: store.kind,
      storageKey,
      mimeType: file.type,
      fileName: file.name,
      fileSize: bytes.byteLength,
      expiresAt: null,
    });
    return json({ mediaAssetId: asset.id, url: `/api/survey/media/${asset.id}` });
  }

  if (request.method === "GET") {
    // Lets the admin SPA hide the vendor-only console on a customer instance.
    // The API refuses those calls regardless, so this is UX, not the boundary.
    if (url.pathname === "/api/admin/deployment") {
      return json({
        role: resolveDeploymentRole(env),
        configuredRole: configuredDeploymentRole(env),
        licenseCenter: isLicenseCenter(env),
        // Actionable text when the console is unavailable for a fixable reason
        // (e.g. a center that forgot LICENSE_ADMIN_TOKEN).
        hint: describeDeploymentRoleIssue(env),
      });
    }
    if (
      url.pathname === "/api/admin/licenses" ||
      url.pathname === "/api/admin/releases" ||
      url.pathname === "/api/admin/trials"
    ) {
      return handleAdminWrite(request, url, env, { user, isAdmin, requestId, fail, json });
    }
    return handleAdminRead(url, env, { user, isAdmin, fail, json });
  }
  if (
    request.method === "POST" ||
    request.method === "PUT" ||
    request.method === "PATCH" ||
    request.method === "DELETE"
  ) {
    return handleAdminWrite(request, url, env, { user, isAdmin, requestId, fail, json });
  }
  return fail(405, "method_not_allowed", "Method not allowed");
}

export interface TelegramWebAppProfile {
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
}

export async function verifyTelegramWebAppProfile(
  request: Request,
  botToken: string,
): Promise<TelegramWebAppProfile | null> {
  const initDataHeader = request.headers.get("x-telegram-init-data");
  if (!initDataHeader || !botToken) return null;
  let initData: string;
  try {
    // The browser sends initData percent-encoded because header values must
    // stay ASCII (Telegram user names routinely contain non-ASCII characters).
    initData = decodeURIComponent(initDataHeader);
  } catch {
    return null;
  }
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const userJson = params.get("user");
  if (!hash || !userJson) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0 || Date.now() / 1000 - authDate > INIT_DATA_MAX_AGE_SECONDS) {
    return null;
  }
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const encoder = new TextEncoder();
  const secretMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const secret = await crypto.subtle.sign("HMAC", secretMaterial, encoder.encode(botToken));
  // Verify with WebCrypto instead of comparing hex strings: the digest check is
  // then constant time, and a malformed length is simply a failed verification.
  const signature = hexToBytes(hash);
  if (!signature) return null;
  const checkKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", checkKey, signature, encoder.encode(dataCheckString));
  if (!valid) return null;
  try {
    const telegramUser = JSON.parse(userJson) as {
      id?: number;
      username?: string;
      first_name?: string;
      last_name?: string;
      language_code?: string;
    };
    if (typeof telegramUser.id !== "number") return null;
    return {
      telegramUserId: telegramUser.id,
      username: telegramUser.username ?? null,
      firstName: telegramUser.first_name ?? null,
      lastName: telegramUser.last_name ?? null,
      languageCode: telegramUser.language_code ?? null,
    };
  } catch {
    return null;
  }
}

export async function verifyTelegramWebAppUser(request: Request, botToken: string): Promise<number> {
  const profile = await verifyTelegramWebAppProfile(request, botToken);
  return profile ? profile.telegramUserId : NaN;
}
