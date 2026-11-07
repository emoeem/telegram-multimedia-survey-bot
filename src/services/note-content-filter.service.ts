/**
 * 纸条 UGC · 发布前内容过滤（Apple UGC 1.2：先审后投）。
 *
 * 定位：putNote / sendMessage 的**校验阶段**调用——命中即抛
 * `note_filter_rejected`（note-api.ts 映射 422，不落任何行），由「拒绝提交」
 * 达成发布前过滤；审后隐藏层由既有举报阈值（纸条）与管理端处置（消息）承担。
 *
 * 词表以常量起步，**刻意保守**：只收明确违法违规词，宁漏勿错——纸条是匿名
 * 陌生人场景，误伤正常表达比漏过边缘词更伤留存。归一化只做小写化 + 去空白
 * （挡「约 炮」这类零成本变体）；谐音、拆字等规避不在此追，交给举报阈值与
 * 管理复核。若后续需要运营可调，仿 WebSubmitFormConfig.blockedWords 的
 * 「system_settings JSON + 回落默认值」机制挂设置即可，调用方无需改动。
 */

/** 错误码：note-api.ts 据此映射 422。 */
export const NOTE_FILTER_REJECTED = "note_filter_rejected";

/** 给用户的统一文案：不回显命中词（避免把词表当成可探测的口子）。 */
export const NOTE_FILTER_REJECTED_MESSAGE = "内容包含不允许的字词，请修改后再试";

/**
 * 保守敏感词表（小写匹配）。
 * - 色情交易 / 招嫖类；毒品类；赌博类；明确诈骗导流话术。
 * - 不收日常词（如单独的「赌」「粉」「V」）：误伤面不可控。
 */
export const NOTE_BLOCKED_WORDS: readonly string[] = [
  // 色情交易 / 招嫖
  "约炮",
  "嫖娼",
  "嫖资",
  "卖淫",
  "援交",
  "包养",
  "裸聊",
  // 毒品
  "冰毒",
  "海洛因",
  "摇头丸",
  "大麻",
  "k粉",
  "溜冰毒",
  // 赌博
  "六合彩",
  "赌球",
  "赌场",
  "赌博网站",
  "博彩平台",
  // 诈骗 / 导流
  "刷单",
  "兼职返利",
  "点赞返现",
  "带单老师",
  "内部渠道包过",
];

/** 命中返回词表原词（供测试与日志），未命中返回 null。 */
export function findBlockedWord(text: string): string | null {
  // 小写化 + 去全部空白：拉丁词统一大小写，中文词挡空格插花。
  const normalized = String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!normalized) return null;
  for (const word of NOTE_BLOCKED_WORDS) {
    if (normalized.includes(word)) return word;
  }
  return null;
}

/** 纯判定：是否允许发布（putNote / sendMessage 共用）。 */
export function isNoteContentAllowed(text: string): boolean {
  return findBlockedWord(text) === null;
}
