import type { Env } from "../../index";

/**
 * 内容安全审核适配器（需求 7.3 第三层）。
 *
 * 设计原则：
 * - 默认 **disabled**：不伪造任何审核结果，投稿照旧进人工队列。
 * - 只有管理员显式配置了外部服务（`coin_config.moderation` + 环境密钥）才会
 *   调用；调用失败/超时/返回无法解析时一律降级为「需要人工审核」，
 *   绝不因为"服务挂了"而放行内容。
 * - 适配器只回传判定，不改状态；状态推进仍在 submission 服务里做，
 *   保证审核链路单一权威。
 *
 * 目前内置一个通用 HTTP JSON 适配器（可对接任意自建/第三方审核服务）：
 *   POST {endpoint}
 *   Authorization: Bearer {MODERATION_API_KEY}
 *   { "type": "...", "title": "...", "text": "..." , "mediaUrl": "..." }
 * 期望响应：{ "action": "approve" | "review" | "reject", "score"?: number, "reason"?: string }
 * 未知 action 一律按 "review"（人工）处理。
 */

import { loadCoinConfig } from "./config.service";

export type ModerationAction = "approve" | "review" | "reject";

export interface ModerationVerdict {
  /** 是否实际调用了外部服务。false = 未配置/未启用（走人工）。 */
  consulted: boolean;
  action: ModerationAction;
  score: number | null;
  reason: string | null;
}

export interface ModerationInput {
  type: string;
  title: string;
  description?: string | null;
  text?: string | null;
  /** 受权限保护的内容地址（外部服务需要能访问；不传则只审文本）。 */
  mediaUrl?: string | null;
}

export interface ModerationConfig {
  enabled: boolean;
  endpoint: string;
  /** 低于该分数直接拒绝；高于 approveAbove 直接通过；其余人工。 */
  rejectBelow: number;
  approveAbove: number;
  timeoutMs: number;
}

export const MODERATION_DEFAULTS: ModerationConfig = {
  enabled: false,
  endpoint: "",
  rejectBelow: 0.85,
  approveAbove: 0.2,
  timeoutMs: 4000,
};

interface ModerationEnv {
  DB: D1Database;
  /** 第三方审核服务的密钥（可选，Secret）。未配置时 adapter 拒绝启用。 */
  MODERATION_API_KEY?: string | undefined;
}

export async function loadModerationConfig(db: D1Database): Promise<ModerationConfig> {
  // 复用统一配置（单一默认值来源，避免两处漂移）；读取失败按"关闭"处理。
  try {
    const config = await loadCoinConfig(db);
    const parsed = config.moderation ?? MODERATION_DEFAULTS;
    return {
      enabled: parsed.enabled === true,
      endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : "",
      rejectBelow: Number(parsed.rejectBelow ?? MODERATION_DEFAULTS.rejectBelow),
      approveAbove: Number(parsed.approveAbove ?? MODERATION_DEFAULTS.approveAbove),
      timeoutMs: Number(parsed.timeoutMs ?? MODERATION_DEFAULTS.timeoutMs),
    };
  } catch (error) {
    console.warn("moderation config unreadable; staying on manual review", { error });
    return MODERATION_DEFAULTS;
  }
}

/** 未配置时的结论：需要人工审核（而不是"通过"）。 */
function manualOnly(reason: string | null = null): ModerationVerdict {
  return { consulted: false, action: "review", score: null, reason };
}

export async function moderateSubmission(env: ModerationEnv, input: ModerationInput): Promise<ModerationVerdict> {
  const config = await loadModerationConfig(env.DB);
  if (!config.enabled) return manualOnly();
  if (!/^https:\/\//.test(config.endpoint)) {
    return manualOnly("审核服务地址未配置");
  }
  // 没有密钥就说明部署没有真正接入外部服务——宁走人工，不发请求。
  if (!env.MODERATION_API_KEY) return manualOnly("审核服务密钥未配置");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, config.timeoutMs));
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.MODERATION_API_KEY}`,
      },
      body: JSON.stringify({
        type: input.type,
        title: input.title,
        description: input.description ?? "",
        text: input.text ?? "",
        ...(input.mediaUrl ? { mediaUrl: input.mediaUrl } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn("moderation service returned non-OK; falling back to manual", {
        status: response.status,
      });
      return manualOnly(`审核服务异常（HTTP ${response.status}）`);
    }
    const payload = (await response.json().catch(() => null)) as {
      action?: unknown;
      score?: unknown;
      reason?: unknown;
    } | null;
    if (!payload) return manualOnly("审核服务返回无法解析");

    const score = Number.isFinite(Number(payload.score)) ? Number(payload.score) : null;
    let action: ModerationAction = "review";
    if (payload.action === "approve" || payload.action === "reject" || payload.action === "review") {
      action = payload.action;
    }
    // 分数兜底：即使服务只回分数也能给出判定；区间外一律人工。
    if (action === "review" && score !== null) {
      if (score >= config.rejectBelow) action = "reject";
      else if (score <= config.approveAbove) action = "approve";
    }
    return {
      consulted: true,
      action,
      score,
      reason: typeof payload.reason === "string" ? payload.reason.slice(0, 300) : null,
    };
  } catch (error) {
    // 超时、断网、DNS 失败——全部降级人工，绝不放行。
    console.warn("moderation adapter failed; falling back to manual", { error });
    return manualOnly("审核服务不可达，转人工");
  } finally {
    clearTimeout(timer);
  }
}
