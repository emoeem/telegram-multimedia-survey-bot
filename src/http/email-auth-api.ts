import type { Env } from "../index";
import { fail, json } from "./survey-api";
import { sendEmail } from "../services/email.service";
import {
  createEmailAccount,
  getEmailAccountByEmail,
  getEmailAccountById,
  markEmailAccountVerified,
  updateEmailAccountPassword,
} from "../db/repositories/email-account.repository";
import {
  createEmailSessionToken,
  hashPassword,
  isValidEmail,
  isValidPassword,
  issueEmailCode,
  verifyEmailCode,
  verifyEmailSessionToken,
  verifyPassword,
} from "../services/email-auth.service";
import { ANONYMOUS_KEY_PATTERN } from "./survey/participant";
import { claimParticipantKey } from "../services/identity-link.service";
import { ensureEmailAccountUser } from "../services/identity-link.service";

/**
 * 登录/注册成功后的自动认领（0082）：请求若携带本浏览器的匿名 key，就把
 * web_* 历史进度并入该邮箱账户的 canonical（绑定了 user 则 user_*，否则
 * email_*），金币随之合并（幂等）。认领失败不阻断登录——进度并入是增值
 * 动作，不是登录的前置条件。
 */
async function autoClaimBrowserProgress(request: Request, env: Env, account: {
  id: number;
  userId: number | null;
}): Promise<void> {
  const key = request.headers.get("x-participant-key");
  if (!key || !ANONYMOUS_KEY_PATTERN.test(key)) return;
  try {
    await claimParticipantKey(env.DB, env.CACHE, {
      participantKey: key,
      canonicalHash: account.userId === null ? `email_${account.id}` : `user_${account.userId}`,
      userId: account.userId,
      method: "email_claim",
    });
  } catch (error) {
    console.warn("email auto-claim failed", { accountId: account.id, error });
  }
}

/**
 * Email + password auth for non-Telegram visitors: register (email code
 * verification), login, password reset, session introspection. Sessions are
 * HMAC tokens kept in localStorage by the web app and sent as the
 * x-email-session header.
 */
export async function handleEmailAuthApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/auth/email/")) return null;
  const db = env.DB;
  const codeStore = env.CACHE;

  const meMatch = request.method === "GET" && url.pathname === "/api/auth/email/me";
  if (meMatch) {
    const session = await resolveEmailSession(request, env);
    if (!session) return fail(401, "unauthorized", "未登录或登录已过期");
    return json({
      email: session.account.email,
      verified: session.account.verifiedAt !== null,
      boundTelegram: session.account.userId !== null,
    });
  }

  if (request.method !== "POST") return fail(405, "method_not_allowed", "不支持的请求方法");

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!isValidEmail(email)) return fail(400, "validation_failed", "邮箱格式不正确");

  if (url.pathname === "/api/auth/email/request-code") {
    const purpose = body?.purpose === "reset" ? "reset" : "register";
    if (!codeStore) return fail(503, "unavailable", "当前部署未启用邮箱验证码");
    const existing = await getEmailAccountByEmail(db, email);
    if (purpose === "register" && existing?.verifiedAt) {
      // Do not reveal whether the address is registered.
      return json({ ok: true });
    }
    if (purpose === "reset" && !existing) return json({ ok: true });
    const code = await issueEmailCode(codeStore, email, purpose);
    const sent = await sendEmail(
      { RESEND_API_KEY: env.RESEND_API_KEY, MAIL_FROM: env.MAIL_FROM },
      email,
      "你的验证码",
      `你的验证码是 ${code}，10 分钟内有效。如果不是你本人操作，请忽略这封邮件。`,
    );
    if (!sent) {
      if (!env.RESEND_API_KEY?.trim() || !env.MAIL_FROM?.trim()) {
        return fail(503, "email_unconfigured", "邮件服务未配置（需要 RESEND_API_KEY 与 MAIL_FROM）");
      }
      // 发信失败不再静默返回 ok——此前 Resend 拒发（域名未验证 / 测试发件域
      // 只能发账号本人）时用户看到「已发送」却永远收不到码（QQ 邮箱反馈的
      // 直接原因之一）。失败原因见 Worker 日志里的 Resend 响应体。
      return fail(502, "email_send_failed", "验证码邮件发送失败。请稍后重试；若持续失败请换一个邮箱，或直接用 Telegram 打开平台（免注册）。");
    }
    // 成功响应带发件人地址：前端提示「把发件人加入白名单」，QQ/163 邮箱
    // 拦截第三方验证码邮件是常态（地址本身在每个邮件的 From 头里，非敏感值）。
    return json({ ok: true, sender: env.MAIL_FROM?.trim() ?? null });
  }

  if (url.pathname === "/api/auth/email/register") {
    const password = typeof body?.password === "string" ? body.password : "";
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!isValidPassword(password)) return fail(400, "validation_failed", "密码至少 8 位");
    if (!codeStore) return fail(503, "unavailable", "当前部署未启用邮箱验证码");
    const existing = await getEmailAccountByEmail(db, email);
    // Verify the code first: request-code never issues a code for an already
    // registered address, so probing `register` without one no longer reveals
    // whether the email is taken (the 409 is only reachable with a valid code).
    const valid = await verifyEmailCode(codeStore, email, "register", code);
    if (!valid) return fail(400, "invalid_code", "验证码错误或已过期");
    if (existing?.verifiedAt) return fail(409, "email_taken", "该邮箱已注册，请直接登录");
    const account =
      existing ?? (await createEmailAccount(db, { email, passwordHash: await hashPassword(password), verified: true }));
    if (!existing) await markEmailAccountVerified(db, account.id);
    else await updateEmailAccountPassword(db, account.id, await hashPassword(password));
    const version = existing ? account.sessionVersion + 1 : account.sessionVersion;
    await ensureEmailAccountUser(env.DB, env.CACHE, account).catch((error) =>
      console.warn("ensure email user failed", { accountId: account.id, error }),
    );
    await autoClaimBrowserProgress(request, env, account);
    return json({ token: await mintSession(env, account.id, version), email: account.email });
  }

  if (url.pathname === "/api/auth/email/login") {
    const password = typeof body?.password === "string" ? body.password : "";
    const account = await getEmailAccountByEmail(db, email);
    // Constant-ish work whether or not the account exists.
    const hash = account?.passwordHash ?? "pbkdf2:100000:AAAA:AAAA";
    const ok = await verifyPassword(password, hash);
    if (!account || !ok || !account.verifiedAt) return fail(401, "invalid_credentials", "邮箱或密码不正确");
    await ensureEmailAccountUser(env.DB, env.CACHE, account).catch((error) =>
      console.warn("ensure email user failed", { accountId: account.id, error }),
    );
    await autoClaimBrowserProgress(request, env, account);
    return json({ token: await mintSession(env, account.id, account.sessionVersion), email: account.email });
  }

  if (url.pathname === "/api/auth/email/reset") {
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!isValidPassword(password)) return fail(400, "validation_failed", "密码至少 8 位");
    if (!codeStore) return fail(503, "unavailable", "当前部署未启用邮箱验证码");
    const account = await getEmailAccountByEmail(db, email);
    if (!account) return fail(400, "invalid_code", "验证码错误或已过期");
    const valid = await verifyEmailCode(codeStore, email, "reset", code);
    if (!valid) return fail(400, "invalid_code", "验证码错误或已过期");
    await updateEmailAccountPassword(db, account.id, await hashPassword(password));
    // updateEmailAccountPassword bumped session_version, so the fresh token
    // must carry the new version (and the old token stops verifying).
    return json({ token: await mintSession(env, account.id, account.sessionVersion + 1), email: account.email });
  }

  return fail(404, "not_found", "接口不存在");
}

async function mintSession(env: Env, accountId: number, version: number): Promise<string> {
  return createEmailSessionToken(env.WEBHOOK_SECRET, accountId, version);
}

interface EmailSession {
  account: { id: number; email: string; userId: number | null; verifiedAt: string | null };
}

export async function resolveEmailSession(request: Request, env: Env): Promise<EmailSession | null> {
  const token = request.headers.get("x-email-session");
  if (!token) return null;
  const parsed = await verifyEmailSessionToken(env.WEBHOOK_SECRET, token);
  if (!parsed) return null;
  const record = await getEmailAccountById(env.DB, parsed.accountId);
  // A password reset bumps session_version, so a token minted before the reset
  // no longer matches and is rejected here.
  if (!record || !record.verifiedAt || record.sessionVersion !== parsed.version) return null;
  return { account: record };
}
