/**
 * 多行问卷链接解析（导入页 URL 区）。
 *
 * 后端 `/api/admin/imports/from-url` 只接受一个 `url`，一次一个问卷；批量导入
 * 因此在客户端拆成逐条请求，这个模块只负责「把一段文本变成干净的 URL 列表」，
 * 不碰网络、不碰 React，好让边界条件能直接用单测钉住。
 *
 * 设计取舍：
 * - **一行一个链接**，不按逗号/空格再切。链接本身可能带查询串，按空格切会把
 *   带空格的标题误拆；逗号在 query 里也合法。行是最不容易出错的边界。
 * - `#` 开头的行当注释跳过，方便把「这批先导前三个」这类备注写在同一处。
 * - 重复链接静默去重而不是报错：批量场景里复制粘贴重复一段太常见，逐条报错
 *   只会把真正的问题（非法域名、格式错）淹掉。
 * - 上限由调用方给，默认 50：每行都会打一次真实的外部抓取，没有上限的列表
 *   等于把一次误粘贴变成一次小型压测。
 */

export const DEFAULT_MAX_IMPORT_LINES = 50;

export interface ParsedImportLine {
  /** 在输入文本里的行号（1 起），用于把结果指回用户看的那一行。 */
  lineNumber: number;
  /** 规范化后的 URL（`new URL().toString()`），去重以此为准。 */
  url: string;
  /** 用户原始写的文本，展示时优先用它，避免规范化把可读性改掉。 */
  raw: string;
}

export interface RejectedImportLine {
  lineNumber: number;
  raw: string;
  reason: string;
}

export interface ParsedImportLines {
  lines: ParsedImportLine[];
  /** 格式不合法、无法尝试导入的行。 */
  rejected: RejectedImportLine[];
  /** 与前面某行重复、已被合并掉的行。 */
  duplicates: RejectedImportLine[];
  /** 输入里一行有效内容都没有（全是空行/注释）。 */
  empty: boolean;
  /** 超过上限而被丢弃的行数（>0 时调用方必须提示用户）。 */
  overflow: number;
}

function normalizeHttpUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // 只有 host 没有路径的链接（`https://forms.office.com`）不是任何一份问卷，
  // 让它进队列只会换来一条后端 422。
  if (!parsed.hostname.includes(".")) return null;
  return parsed.toString();
}

/**
 * 把一段多行文本拆成待导入链接。
 *
 * 不做去空的「宽容」处理之外的事：不猜域名、不补 `https://`。少一层猜测，
 * 用户看到的后端报错就能一一对应到自己写的那一行。
 */
export function parseImportLines(
  input: string,
  options: { maxLines?: number } = {},
): ParsedImportLines {
  const maxLines = options.maxLines ?? DEFAULT_MAX_IMPORT_LINES;
  const lines: ParsedImportLine[] = [];
  const rejected: RejectedImportLine[] = [];
  const duplicates: RejectedImportLine[] = [];
  const seen = new Set<string>();
  let overflow = 0;
  let sawContent = false;

  const rawLines = input.split(/\r?\n/);
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]!.trim();
    if (raw === "" || raw.startsWith("#")) continue;
    sawContent = true;

    const normalized = normalizeHttpUrl(raw);
    if (!normalized) {
      rejected.push({
        lineNumber: index + 1,
        raw,
        reason: "不是有效的 http/https 链接",
      });
      continue;
    }
    if (seen.has(normalized)) {
      duplicates.push({ lineNumber: index + 1, raw, reason: "与本页前面的链接重复" });
      continue;
    }
    // 上限只约束「真正要发请求的行」：被重复/非法挡掉的行不该占名额。
    if (lines.length >= maxLines) {
      overflow += 1;
      continue;
    }
    seen.add(normalized);
    lines.push({ lineNumber: index + 1, url: normalized, raw });
  }

  return { lines, rejected, duplicates, empty: !sawContent, overflow };
}

/** 单条结果的状态机；`importing` 与 `creating` 分开，是为了让进度文案能说清在等什么。 */
export type ImportItemStatus = "pending" | "importing" | "creating" | "imported" | "created" | "failed";

export interface ImportBatchItem {
  url: string;
  raw: string;
  lineNumber: number;
  status: ImportItemStatus;
  title?: string;
  questionCount?: number;
  surveyId?: number;
  error?: string;
  /** 导入成功时带回来的 JSON，供「在编辑器中打开」复用，不再重复抓取。 */
  content?: string;
}

export function summarizeBatch(items: ImportBatchItem[]): {
  total: number;
  imported: number;
  created: number;
  failed: number;
  finished: boolean;
} {
  let imported = 0;
  let created = 0;
  let failed = 0;
  for (const item of items) {
    if (item.status === "failed") failed += 1;
    else if (item.status === "created") created += 1;
    else if (item.status === "imported") imported += 1;
  }
  const finished = items.every(
    (item) => item.status === "imported" || item.status === "created" || item.status === "failed",
  );
  return { total: items.length, imported, created, failed, finished };
}
