/**
 * `/api/cert/draw` —— 认证卡主题配置了「抽取池」时的服务端实时抽取。
 *
 * 主题内容包里的 draw 段指向小游戏区的一个任务包；生成器点「帮我选/抽取」
 * 时调这里，从包里按权重抽任务条目。包更新后认证卡自动跟着变——内容不复制，
 * 只存 packId 引用。
 *
 * 18+ 门槛：小游戏包内容为成人向，请求必须带 `ack=adult18`（生成器只在
 * 18+ 门禁通过后才会发起调用）；缺 ack 一律 403，抓取器/预览拿不到内容。
 * 限流与 /api/cert/share 同款（按客户端 IP 分桶）。
 */

import { drawTaskItems } from "../services/game-draw.service";
import { checkRateLimit, rateLimitResponse } from "../services/rate-limit.service";

export const CERT_DRAW_PATH = "/api/cert/draw";

const RATE_LIMIT = { limit: 30, windowSeconds: 600 };
const MAX_COUNT = 5;

export interface CertDrawEnv {
  DB: D1Database;
  CACHE?: KVNamespace | null;
}

export async function handleCertDraw(
  request: Request,
  env: CertDrawEnv,
  options: { clientKey: string },
): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ ok: false, code: "method_not_allowed" }, { status: 405 });
  }
  const url = new URL(request.url);
  if (url.searchParams.get("ack") !== "adult18") {
    return Response.json({ ok: false, code: "adult_gate", message: "需要 18+ 确认后才能抽取" }, { status: 403 });
  }
  const packId = Number(url.searchParams.get("packId"));
  if (!Number.isInteger(packId) || packId <= 0) {
    return Response.json({ ok: false, code: "invalid_pack", message: "无效的小游戏包" }, { status: 400 });
  }
  const personaRaw = url.searchParams.get("persona");
  const persona = personaRaw === "male" || personaRaw === "female" ? personaRaw : undefined;
  const countRaw = Number(url.searchParams.get("count") ?? 1);
  const count = Math.min(MAX_COUNT, Math.max(1, Number.isInteger(countRaw) ? countRaw : 1));

  if (env.CACHE && !options.clientKey) {
    // 地址未知：跳过限流而非并桶（同 cert-share，见 rateLimitIpSubject）。
    console.warn("cert-draw 限流已跳过：无法确定调用方地址");
  } else if (env.CACHE) {
    const limited = await checkRateLimit(
      env.CACHE,
      "cert-draw",
      options.clientKey,
      RATE_LIMIT.limit,
      RATE_LIMIT.windowSeconds,
    );
    if (!limited.allowed) return rateLimitResponse(limited.retryAfterSeconds);
  }

  const items = await drawTaskItems(env.DB, packId, {
    ...(persona ? { persona } : {}),
    count,
  });
  if (items === null) {
    return Response.json({ ok: false, code: "not_found", message: "小游戏包不存在" }, { status: 404 });
  }
  return Response.json({ ok: true, items }, { headers: { "cache-control": "no-store" } });
}
