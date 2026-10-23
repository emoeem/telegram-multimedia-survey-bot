/**
 * 免登录投稿的验证题令牌 —— 从 submission-bot 的 web.js 逐行移植。
 *
 * 无状态 HMAC 设计:令牌 = `${expiresAt}.${nonce}.${signature}`,signature 是
 * HMAC(expiresAt.nonce.captchaAnswer)。验证时用提交者声称的答案重算签名,
 * 常量时间比较 —— 不对,是「答案参与签名」:答案错,签名就对不上。这样
 * D1 里不需要挑战记录,验证题接口也没有写入成本。
 *
 * 填表最短用时同样编码在令牌里(issuedAt = expiresAt - TTL):比
 * minFillSeconds 还快的提交判为脚本。
 */

const FORM_TOKEN_TTL_SECONDS = 1800;
/** 填表最短用时:比这还快的提交基本是脚本(也顺手挡住"打开就提交"的误触)。 */
export const MIN_FILL_SECONDS = 3;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomNonce(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(expected: string, actual: string): boolean {
  if (expected.length === 0 || expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}

/** 简单算式验证题:挡住脚本,不追求"证明你是人"。 */
function makeQuestion(): { question: string; answer: string } {
  const a = 2 + Math.floor(Math.random() * 8);
  const b = 2 + Math.floor(Math.random() * 8);
  const plus = Math.random() < 0.6;
  return plus ? { question: `${a} + ${b}`, answer: String(a + b) } : { question: `${a} × ${b}`, answer: String(a * b) };
}

export interface FormToken {
  token: string;
  question: string | null;
  issued_at: number;
  expires_in: number;
}

/** 发放表单令牌;captcha=false 时 question 为 null 且签名不绑定答案。 */
export async function issueFormToken(secret: string, options: { captcha: boolean; now?: number }): Promise<FormToken> {
  const now = options.now ?? nowSeconds();
  const puzzle = options.captcha ? makeQuestion() : null;
  const nonce = randomNonce(8);
  const expiresAt = now + FORM_TOKEN_TTL_SECONDS;
  const signature = await hmacHex(secret, `${expiresAt}.${nonce}.${puzzle ? puzzle.answer : ""}`);
  return {
    token: `${expiresAt}.${nonce}.${signature}`,
    question: puzzle ? puzzle.question : null,
    issued_at: now,
    expires_in: FORM_TOKEN_TTL_SECONDS,
  };
}

export type FormTokenVerification = { ok: true } | { ok: false; reason: "expired" | "too_fast" | "wrong_answer" };

export async function verifyFormToken(
  secret: string,
  token: unknown,
  answer: unknown,
  options: {
    captcha: boolean;
    minFillSeconds?: number;
    now?: number;
  },
): Promise<FormTokenVerification> {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return { ok: false, reason: "expired" };
  const rawExpires = parts[0]!;
  const nonce = parts[1]!;
  const signature = parts[2]!;
  const now = options.now ?? nowSeconds();
  const expiresAt = Number.parseInt(rawExpires, 10);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return { ok: false, reason: "expired" };
  const issuedAt = expiresAt - FORM_TOKEN_TTL_SECONDS;
  const minFillSeconds = options.minFillSeconds ?? MIN_FILL_SECONDS;
  if (minFillSeconds > 0 && now - issuedAt < minFillSeconds) return { ok: false, reason: "too_fast" };
  const expected = await hmacHex(
    secret,
    `${expiresAt}.${nonce}.${
      options.captcha
        ? String(answer ?? "")
            .trim()
            .toLowerCase()
        : ""
    }`,
  );
  if (!safeEqual(expected, signature)) return { ok: false, reason: "wrong_answer" };
  return { ok: true };
}

/** 浏览器身份令牌:只接受我们发出去的随机 hex(移植 normalizeViewer)。 */
export function normalizeViewer(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return /^[a-f0-9]{16,64}$/i.test(value) ? value.toLowerCase() : null;
}

/** 邮箱只要长得像就行(不做真实性验证,通知发不出去不影响投稿)。 */
export function normalizeEmail(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value || value.length > 120) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? value : null;
}
