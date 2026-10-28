import type { ConfigIssue, PropField } from "./types";

/**
 * 属性 Schema 的纯函数层：默认值 / 归一化 / 校验。
 *
 * 归一化是安全边界——task_packs.settings_json 是管理员可写的 JSON，插件
 * 渲染前必须经过白名单式收敛（只留 Schema 声明的键、越界值夹取、类型不对
 * 回落默认值），否则任何插件都要自己防脏数据。
 */

function cloneDefault(field: PropField): unknown {
  switch (field.kind) {
    case "text":
    case "textarea":
    case "select":
      return field.default;
    case "number":
      return field.default;
    case "boolean":
      return field.default;
    case "media":
      return null;
    case "list":
      return [];
  }
}

/** 按 Schema 生成一份默认配置（新包/新题目用）。 */
export function defaultConfig(fields: readonly PropField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field.key] = cloneDefault(field);
  return out;
}

function clampNumber(field: Extract<PropField, { kind: "number" }>, raw: unknown): number {
  const parsed = Number(raw);
  const base = Number.isFinite(parsed) ? parsed : field.default;
  const bounded = Math.min(
    field.max ?? Number.POSITIVE_INFINITY,
    Math.max(field.min ?? Number.NEGATIVE_INFINITY, base),
  );
  return field.integer ? Math.round(bounded) : bounded;
}

/** 白名单式归一化：只保留 Schema 声明的键。 */
export function normalizeConfig(fields: readonly PropField[], raw: unknown): Record<string, unknown> {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = input[field.key];
    switch (field.kind) {
      case "text":
      case "textarea":
        out[field.key] = typeof value === "string" ? value.slice(0, field.maxLength ?? 5000) : field.default;
        break;
      case "number":
        out[field.key] = clampNumber(field, value);
        break;
      case "boolean":
        out[field.key] = typeof value === "boolean" ? value : field.default;
        break;
      case "select":
        out[field.key] = field.options.some((option) => option.value === value) ? value : field.default;
        break;
      case "media": {
        const id = Number(value);
        out[field.key] = Number.isInteger(id) && id > 0 ? id : null;
        break;
      }
      case "list": {
        // 先过滤掉非对象项再截断：反过来会让一条脏数据白占一个名额。
        const items = Array.isArray(value)
          ? value
              .filter(
                (item): item is Record<string, unknown> =>
                  Boolean(item) && typeof item === "object" && !Array.isArray(item),
              )
              .slice(0, field.maxItems)
          : [];
        out[field.key] = items.map((item) => normalizeConfig(field.itemFields, item));
        break;
      }
    }
  }
  return out;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** 把一行原始数据取成可读标签，用于错误信息定位（如"第 2 张卡"）。 */
function labelOf(field: PropField, item: Record<string, unknown>, index: number): string {
  if (field.kind !== "list") return `「${field.label}」`;
  try {
    const label = field.itemLabel(item, index);
    return label || `「${field.label}」第 ${index + 1} 项`;
  } catch {
    return `「${field.label}」第 ${index + 1} 项`;
  }
}

/** 递归校验：必填、列表数量、子字段。只返回结构性问题。 */
export function validateWithSchema(fields: readonly PropField[], config: Record<string, unknown>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const field of fields) {
    const value = config[field.key];
    if (field.required && isEmpty(value)) {
      issues.push({ key: field.key, message: `「${field.label}」不能为空`, severity: "error" });
      continue;
    }
    if (field.kind === "list") {
      const items = Array.isArray(value) ? value : [];
      if (field.required && items.length === 0) {
        issues.push({ key: field.key, message: `「${field.label}」至少需要 1 项`, severity: "error" });
      }
      if (items.length > field.maxItems) {
        issues.push({
          key: field.key,
          message: `「${field.label}」最多 ${field.maxItems} 项（当前 ${items.length}）`,
          severity: "error",
        });
      }
      items.forEach((item, index) => {
        for (const child of validateWithSchema(field.itemFields, item)) {
          issues.push({
            key: field.key,
            message: `${labelOf(field, item, index)}：${child.message}`,
            severity: child.severity,
          });
        }
      });
    }
  }
  return issues;
}

/** 配置里标了 collects 的字段名——导出/建卷时判断"哪些配置属于作答数据"。 */
export function collectedFields(fields: readonly PropField[]): string[] {
  return fields.filter((field) => field.collects).map((field) => field.key);
}
