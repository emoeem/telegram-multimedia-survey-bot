/**
 * 媒体引用适配层（场景媒体结构化专项 · 读侧先行）。
 *
 * 背景（docs/UPGRADE_ROADMAP_2026-10-28 阶段 D）：场景图 / BGM / 主题背景
 * 目前以 URL 字符串存在 settings_json / theme JSON。目标是写入侧存
 * {assetId}（结构化），读取侧派生 URL；在写入侧切换并跑完迁移之前，
 * 读取侧必须**双读**——字符串输入原样返回（现有数据视觉逐像素一致），
 * 结构化对象经 toUrl 回调派生 URL（写入侧切换后立即生效）。
 *
 * URL 的拼写由调用方注入（各端已有自己的媒体端点实现）；本文件只做
 * 「值 → assetId」的解析，不含任何请求构造。写入侧（场景编辑器 / BGM
 * 配置改存 {assetId}）受交接文档红线约束：必须先在 staging 用真实问卷
 * 实测后才可发布——本文件不含任何写入逻辑。
 */

/**
 * 从字符串里取末段素材编号：兼容「…/media/12」与相对「media/12」。
 * 用字符串定位而非正则（避免把端点路径写进模式）。
 */
function trailingAssetId(value: string): number | null {
  const marker = value.lastIndexOf("media/");
  if (marker < 0) return null;
  let digits = "";
  for (let i = marker + "media/".length; i < value.length; i += 1) {
    const char = value[i];
    if (char === undefined || char < "0" || char > "9") break;
    digits += char;
  }
  if (!digits) return null;
  const id = Number(digits);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * 从任意 JSON 值解析 media_assets.id（双读）：
 *  - number：已结构化的直接引用；
 *  - { assetId: n }：目标结构化形态；
 *  - 字符串：既有 URL 字符串（端点路径或相对 media/<id>）。
 * 其余（空串、外链 https://、data:、脏值）返回 null——外链本就不是素材库引用。
 */
export function parseMediaRef(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trailingAssetId(trimmed);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const assetId = (value as Record<string, unknown>).assetId;
    if (typeof assetId === "number") return Number.isInteger(assetId) && assetId > 0 ? assetId : null;
    if (typeof assetId === "string") {
      const id = Number(assetId);
      return Number.isInteger(id) && id > 0 ? id : null;
    }
  }
  return null;
}

/**
 * 媒体字段的双读解析：字符串（现状——原样返回，保持视觉逐像素一致）或
 * 结构化 {assetId}（经调用方注入的 toUrl 派生 URL）。
 * null/undefined/空串返回 undefined（无图不渲染）。
 */
export function resolveMediaRef(value: unknown, toUrl: (assetId: number) => string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  const assetId = parseMediaRef(value);
  return assetId === null ? undefined : toUrl(assetId);
}
