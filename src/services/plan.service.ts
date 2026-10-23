/**
 * 部署能力探测（docs/CLOUDFLARE_PLAN_TIERS.md 原则一：「能力必须可探测，
 * 不能靠"我记得我是 Pro"」）。
 *
 * 每一项按量付费资源都有对应的可选绑定/配置；这里把它们归纳成一张能力表和
 * 一个部署档位，供功能在 Pro 路径与 Free 降级路径之间分叉。纯函数、无 IO：
 * 只看绑定/环境变量是否存在，绝不探测网络——错误的"有能力"假设比保守更贵。
 *
 * 双轨不变式（原则二）：任何依赖某项能力的功能，必须同时回答
 * 「Free 部署上它退化成什么」，且降级是换实现而不是砍按钮。
 */

export type PlanTier = "free" | "paid" | "pro";

export interface PlanCapabilities {
  tier: PlanTier;
  /** R2 媒体桶（答卷附件/题目媒体大文件存储）。Free：KV + Telegram file_id。 */
  r2Media: boolean;
  /** Cloudflare Stream 视频直传/转码/播放。Free：视频题型走 KV（20MB 上限）。 */
  streamVideo: boolean;
  /** Cloudflare Images 图片存储与边缘变换。Free：KV blob / TG 频道。 */
  imagesPipeline: boolean;
  /** Browser Rendering（PDF/分享图渲染）。Free：HTML/SVG 降级（既有路径）。 */
  browserRender: boolean;
  /** Queues 异步任务。Free：经 SELF 内部端点在请求上下文同步执行。 */
  asyncQueue: boolean;
  /** Durable Object 原子限流。Free：KV 计数器（既有路径）。 */
  rateLimitDO: boolean;
}

/**
 * plan.service 只依赖这一小切片，不 import 整个 Env：测试可以随手捏对象，
 * Phase C/D 往 Env 加 Stream/Images 配置时这里不需要改结构。
 */
export interface PlanCapabilitySource {
  MEDIA?: unknown;
  EXPORT_QUEUE?: unknown;
  BROWSER?: unknown;
  RATE_LIMIT?: unknown;
  STREAM_ACCOUNT_ID?: string;
  STREAM_API_TOKEN?: string;
  IMAGES_ACCOUNT_ID?: string;
  IMAGES_DELIVERY_HASH?: string;
  CLOUDFLARE_API_TOKEN?: string;
  /** 显式档位声明；与推导结果取更保守的一档（原则：宁可少用能力）。 */
  PLAN_TIER?: string;
}

function hasBinding(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function hasConfig(...values: Array<string | undefined>): boolean {
  return values.every((value) => typeof value === "string" && value.trim().length > 0);
}

/** pro 的最低能力组合：媒体、渲染、队列三条 Pro 主干缺一不可；Stream/Images 不影响档位（只影响各自功能）。 */
const PRO_TIER_REQUIREMENTS: Array<(caps: Omit<PlanCapabilities, "tier">) => boolean> = [
  (caps) => caps.r2Media,
  (caps) => caps.browserRender,
  (caps) => caps.asyncQueue,
];

function deriveTier(caps: Omit<PlanCapabilities, "tier">): PlanTier {
  if (!caps.browserRender && !caps.asyncQueue) return "free";
  return PRO_TIER_REQUIREMENTS.every((check) => check(caps)) ? "pro" : "paid";
}

const TIER_ORDER: Record<PlanTier, number> = { free: 0, paid: 1, pro: 2 };

/**
 * 解析部署能力。`PLAN_TIER` 是部署方的显式声明（比如客户实例想强制最保守
 * 行为），声明与探测取**更低**的一档——声明永远不会凭空解锁探测不到的能力。
 */
export function resolvePlanCapabilities(source: PlanCapabilitySource): PlanCapabilities {
  const withoutTier = {
    r2Media: hasBinding(source.MEDIA),
    streamVideo: hasConfig(source.STREAM_ACCOUNT_ID, source.STREAM_API_TOKEN),
    imagesPipeline:
      hasConfig(source.IMAGES_ACCOUNT_ID, source.IMAGES_DELIVERY_HASH, source.CLOUDFLARE_API_TOKEN),
    browserRender: hasBinding(source.BROWSER),
    asyncQueue: hasBinding(source.EXPORT_QUEUE),
    rateLimitDO: hasBinding(source.RATE_LIMIT),
  };
  const derived = deriveTier(withoutTier);
  const declared = source.PLAN_TIER;
  const tier =
    declared === "free" || declared === "paid" || declared === "pro"
      ? (TIER_ORDER[declared] < TIER_ORDER[derived] ? declared : derived)
      : derived;
  return { ...withoutTier, tier };
}

/** 每项能力在 Free 部署上的等价降级路径（能力面板与文档共用文案）。 */
export const PLAN_FALLBACK_NOTES: Record<keyof Omit<PlanCapabilities, "tier">, string> = {
  r2Media: "媒体回落 KV + Telegram 存储（单文件 20MB）",
  streamVideo: "视频走 KV 直存（单文件 20MB，无转码）",
  imagesPipeline: "图片存 KV / Telegram 频道",
  browserRender: "报告退化为 HTML 页面，分享图退化为纯文字预览",
  asyncQueue: "导出/归档在本请求内同步执行（较慢，不丢功能）",
  rateLimitDO: "限流走 KV 计数器（并发下略宽松）",
};
