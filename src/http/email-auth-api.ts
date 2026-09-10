import type { Env } from "../index";
import { fail, json } from "./survey-api";
import { sendEmail } from "../services/email.service";
import { checkRateLimit } from "../services/rate-limit.service";
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

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const limitKey = `${ip}:${email}`;
  const rate = await (codeStore
    ? checkRateLimit(codeStore, "email-auth", limitKey, 10, 3600)
    : Promise.resolve({ allowed: true, retryAfterSeconds: 0 }));
  if (!rate.allowed) {
    return Response.json(
      { code: "rate_limited", message: `操作太频繁，请 ${Math.ceil(rate.retryAfterSeconds / 60)} 分钟后再试` },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

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
    if (!sent && !env.RESEND_API_KEY?.trim()) {
      return fail(503, "email_unconfigured", "邮件服务未配置（需要 RESEND_API_KEY 与 MAIL_FROM）");
    }
    return json({ ok: true });
  }

  if (url.pathname === "/api/auth/email/register") {
    const password = typeof body?.password === "string" ? body.password : "";
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!isValidPassword(password)) return fail(400, "validation_failed", "密码至少 8 位");
    if (!codeStore) return fail(503, "unavailable", "当前部署未启用邮箱验证码");
    const existing = await getEmailAccountByEmail(db, email);
    if (existing?.verifiedAt) return fail(409, "email_taken", "该邮箱已注册，请直接登录");
    const valid = await verifyEmailCode(codeStore, email, "register", code);
    if (!valid) return fail(400, "invalid_code", "验证码错误或已过期");
    const account =
      existing ?? (await createEmailAccount(db, { email, passwordHash: await hashPassword(password), verified: true }));
    if (!existing) await markEmailAccountVerified(db, account.id);
    else await updateEmailAccountPassword(db, account.id, await hashPassword(password));
    return json({ token: await mintSession(env, account.id), email: account.email });
  }

  if (url.pathname === "/api/auth/email/login") {
    const password = typeof body?.password === "string" ? body.password : "";
    const account = await getEmailAccountByEmail(db, email);
    // Constant-ish work whether or not the account exists.
    const hash = account?.passwordHash ?? "pbkdf2:100000:AAAA:AAAA";
    const ok = await verifyPassword(password, hash);
    if (!account || !ok || !account.verifiedAt) return fail(401, "invalid_credentials", "邮箱或密码不正确");
    return json({ token: await mintSession(env, account.id), email: account.email });
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
    return json({ token: await mintSession(env, account.id), email: account.email });
  }

  return fail(404, "not_found", "接口不存在");
}

async function mintSession(env: Env, accountId: number): Promise<string> {
  return createEmailSessionToken(env.WEBHOOK_SECRET, accountId);
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
  if (!record || !record.verifiedAt) return null;
  return { account: record };
}
