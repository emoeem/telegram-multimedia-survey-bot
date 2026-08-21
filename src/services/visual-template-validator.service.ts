import {
  VISUAL_TEMPLATE_SCHEMA_VERSION,
  type TemplateBackground,
  type TemplateCondition,
  type TemplateVariable,
  type VisualReportSection,
  type VisualElementType,
  type VisualTemplateDefinition,
  type VisualTemplateElement,
} from "../visual-template/schema";

const elementTypes = new Set<VisualElementType>([
  "text", "image", "shape", "rectangle", "circle", "line", "badge", "tag",
  "progress_bar", "stat", "stat_group", "rating", "divider", "icon", "qr_code", "radar_chart",
]);
const conditionOperators = new Set([
  "equals", "not_equals", "exists", "not_exists", "greater_than", "less_than",
  "greater_or_equal", "less_or_equal", "contains", "not_contains", "in", "not_in",
]);
const variableTypes = new Set([
  "text", "long_text", "number", "integer", "decimal", "percentage", "score", "rating",
  "boolean", "enum", "tags", "image", "color", "date", "datetime", "url", "list", "object",
  "stats", "image_map",
]);
const allowedRootPaths = new Set(["title", "subtitle", "resultType", "fields", "stats", "tags", "images", "metadata"]);
const forbiddenSegments = new Set(["__proto__", "constructor", "prototype"]);
const staticColors = new Set(["transparent", "black", "white", "red", "green", "blue", "gray", "grey"]);
const reportSectionTypes = new Set(["section", "summary", "table", "gallery", "status_grid", "metrics"]);

export class VisualTemplateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisualTemplateValidationError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fail(message: string): never {
  throw new VisualTemplateValidationError(message);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} 必须是非空文本`);
  return value;
}

function finite(value: unknown, label: string, min?: number, max?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} 必须是有限数字`);
  if (min !== undefined && value < min) fail(`${label} 不能小于 ${min}`);
  if (max !== undefined && value > max) fail(`${label} 不能大于 ${max}`);
  return value;
}

function expressionPath(value: string, label: string): string {
  const match = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
  if (!match?.[1]) fail(`${label} 必须是 {{result.*}} 变量`);
  return resultPath(match[1], label);
}

function resultPath(path: string, label: string): string {
  const segments = path.split(".");
  if (segments[0] !== "result" || segments.length < 2 ||
    segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment) || forbiddenSegments.has(segment)) ||
    !allowedRootPaths.has(segments[1] ?? "")) {
    fail(`${label} 不是允许的 ResultProfile 路径`);
  }
  return path;
}

function color(value: unknown, label: string, variables: Set<string>): void {
  const candidate = text(value, label);
  if (candidate.startsWith("{{")) {
    assertVariable(expressionPath(candidate, label), variables, label);
    return;
  }
  const valid = /^#[0-9a-fA-F]{3,8}$/.test(candidate) ||
    /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(candidate) ||
    staticColors.has(candidate.toLowerCase());
  if (!valid) fail(`${label} 不是合法颜色`);
}

function assertVariable(path: string, variables: Set<string>, label: string): void {
  if (!variables.has(path)) fail(`${label} 引用了未声明变量 ${path}`);
}

function textReferences(value: unknown, variables: Set<string>, label: string): void {
  if (typeof value !== "string") return;
  const matcher = /\{\{\s*([^{}]+?)\s*\}\}/g;
  for (const match of value.matchAll(matcher)) {
    const path = resultPath(match[1] ?? "", label);
    assertVariable(path, variables, label);
  }
  if (value.includes("{{") && ![...value.matchAll(matcher)].length) fail(`${label} 包含无效变量表达式`);
}

function condition(value: unknown, variables: Set<string>, label: string): TemplateCondition {
  if (!record(value)) fail(`${label} 必须是条件对象`);
  const path = resultPath(text(value.path, `${label}.path`), `${label}.path`);
  assertVariable(path, variables, `${label}.path`);
  const operator = text(value.operator, `${label}.operator`);
  if (!conditionOperators.has(operator)) fail(`${label}.operator 不受支持`);
  if ("value" in value && !(
    typeof value.value === "string" || typeof value.value === "number" || typeof value.value === "boolean" ||
    Array.isArray(value.value) && value.value.every((entry) => typeof entry === "string" || typeof entry === "number")
  )) fail(`${label}.value 类型无效`);
  return value as unknown as TemplateCondition;
}

function background(value: unknown, variables: Set<string>): TemplateBackground {
  if (!record(value)) fail("background 必须是对象");
  const type = text(value.type, "background.type");
  if (type === "solid") {
    color(value.color, "background.color", variables);
  } else if (type === "gradient") {
    color(value.from, "background.from", variables);
    color(value.to, "background.to", variables);
    if (value.angle !== undefined) finite(value.angle, "background.angle", -360, 360);
  } else if (type === "image") {
    const source = expressionPath(text(value.source, "background.source"), "background.source");
    assertVariable(source, variables, "background.source");
    if (value.fit !== undefined && !["cover", "contain", "stretch"].includes(String(value.fit))) fail("background.fit 不受支持");
    if (value.opacity !== undefined) finite(value.opacity, "background.opacity", 0, 1);
  } else if (type === "telegram_asset") {
    if (!Number.isInteger(value.assetId) || (value.assetId as number) <= 0) {
      fail("background.assetId 必须是有效媒体编号");
    }
    if (value.fit !== undefined && !["cover", "contain", "stretch"].includes(String(value.fit))) fail("background.fit 不受支持");
    if (value.opacity !== undefined) finite(value.opacity, "background.opacity", 0, 1);
  } else {
    fail("background.type 不受支持");
  }
  return value as unknown as TemplateBackground;
}

function element(value: unknown, variables: Set<string>, ids: Set<string>, index: number): VisualTemplateElement {
  const label = `elements[${index}]`;
  if (!record(value)) fail(`${label} 必须是对象`);
  const id = text(value.id, `${label}.id`);
  if (!/^[A-Za-z0-9_-]+$/.test(id) || forbiddenSegments.has(id)) fail(`${label}.id 无效`);
  if (ids.has(id)) fail(`${label}.id 重复`);
  ids.add(id);
  const type = text(value.type, `${label}.type`);
  if (!elementTypes.has(type as VisualElementType)) fail(`${label}.type 不受支持`);
  for (const key of ["x", "y", "rotation", "letterSpacing", "lineHeight", "gap", "strokeWidth", "radius"] as const) {
    if (value[key] !== undefined) finite(value[key], `${label}.${key}`, -10_000, 10_000);
  }
  for (const key of ["width", "height", "fontSize"] as const) {
    if (value[key] !== undefined) finite(value[key], `${label}.${key}`, 0.01, 10_000);
  }
  if (value.zIndex !== undefined &&
    (typeof value.zIndex !== "number" || !Number.isInteger(value.zIndex) || Math.abs(value.zIndex) > 10_000)) fail(`${label}.zIndex 无效`);
  if (value.opacity !== undefined) finite(value.opacity, `${label}.opacity`, 0, 1);
  if (value.maxLines !== undefined &&
    (typeof value.maxLines !== "number" || !Number.isInteger(value.maxLines) || value.maxLines <= 0 || value.maxLines > 100)) fail(`${label}.maxLines 无效`);
  if (value.color !== undefined) color(value.color, `${label}.color`, variables);
  if (value.fill !== undefined) color(value.fill, `${label}.fill`, variables);
  if (value.stroke !== undefined) color(value.stroke, `${label}.stroke`, variables);
  if (value.visibleIf !== undefined) condition(value.visibleIf, variables, `${label}.visibleIf`);
  textReferences(value.value, variables, `${label}.value`);
  if (value.source !== undefined) {
    const path = expressionPath(text(value.source, `${label}.source`), `${label}.source`);
    assertVariable(path, variables, `${label}.source`);
  }
  if (value.max !== undefined && typeof value.max === "string") {
    const path = expressionPath(value.max, `${label}.max`);
    assertVariable(path, variables, `${label}.max`);
  }
  if (type === "text" && typeof value.value !== "string") fail(`${label}.value 是必填文字`);
  if (type === "image" && typeof value.source !== "string") fail(`${label}.source 是必填图片变量`);
  if (["tag", "progress_bar", "stat", "stat_group", "rating", "qr_code", "radar_chart"].includes(type) &&
    typeof value.source !== "string" && typeof value.value !== "string") fail(`${label} 缺少数据变量`);
  if (value.fit !== undefined && !["cover", "contain", "stretch"].includes(String(value.fit))) fail(`${label}.fit 不受支持`);
  if (value.shape !== undefined && !["rectangle", "rounded", "circle", "hexagon"].includes(String(value.shape))) fail(`${label}.shape 不受支持`);
  return value as unknown as VisualTemplateElement;
}

function variables(value: unknown): TemplateVariable[] {
  if (!Array.isArray(value)) fail("variables 必须是数组");
  const paths = new Set<string>();
  return value.map((entry, index) => {
    const label = `variables[${index}]`;
    if (!record(entry)) fail(`${label} 必须是对象`);
    const path = resultPath(text(entry.path, `${label}.path`), `${label}.path`);
    if (paths.has(path)) fail(`${label}.path 重复`);
    paths.add(path);
    text(entry.label, `${label}.label`);
    if (typeof entry.type !== "string" || !variableTypes.has(entry.type)) fail(`${label}.type 不受支持`);
    if (entry.required !== undefined && typeof entry.required !== "boolean") fail(`${label}.required 必须为 boolean`);
    return entry as unknown as TemplateVariable;
  });
}

function reportSection(value: unknown, variables: Set<string>, ids: Set<string>, index: number): VisualReportSection {
  const label = `sections[${index}]`;
  if (!record(value)) fail(`${label} 必须是对象`);
  const id = text(value.id, `${label}.id`);
  if (!/^[A-Za-z0-9_-]+$/.test(id) || forbiddenSegments.has(id) || ids.has(id)) fail(`${label}.id 无效或重复`);
  ids.add(id);
  const type = text(value.type, `${label}.type`);
  if (!reportSectionTypes.has(type)) fail(`${label}.type 不受支持`);
  for (const key of ["title", "subtitle"] as const) textReferences(value[key], variables, `${label}.${key}`);
  for (const key of ["label", "value"] as const) {
    const candidate = value[key];
    if (typeof candidate !== "string") continue;
    for (const match of candidate.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      const path = match[1] ?? "";
      if (/^[A-Za-z0-9_-]+$/.test(path)) continue;
      const result = resultPath(path, `${label}.${key}`);
      assertVariable(result, variables, `${label}.${key}`);
    }
  }
  if (value.source !== undefined) {
    const path = expressionPath(text(value.source, `${label}.source`), `${label}.source`);
    assertVariable(path, variables, `${label}.source`);
  }
  if (["summary", "table", "gallery", "status_grid", "metrics"].includes(type) && value.source === undefined) {
    fail(`${label}.source 是必填数据变量`);
  }
  if (value.max !== undefined && typeof value.max === "string") {
    const path = expressionPath(value.max, `${label}.max`);
    assertVariable(path, variables, `${label}.max`);
  }
  if (value.columns !== undefined && (!Number.isInteger(value.columns) || (value.columns as number) < 1 || (value.columns as number) > 4)) fail(`${label}.columns 无效`);
  for (const key of ["gap", "itemHeight", "imageHeight", "fontSize", "radius"] as const) {
    if (value[key] !== undefined) finite(value[key], `${label}.${key}`, 0, 10_000);
  }
  for (const key of ["color", "fill", "background"] as const) if (value[key] !== undefined) color(value[key], `${label}.${key}`, variables);
  if (value.visibleIf !== undefined) condition(value.visibleIf, variables, `${label}.visibleIf`);
  return value as unknown as VisualReportSection;
}

export function parseVisualTemplateDefinition(input: string): VisualTemplateDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    fail("模板必须是有效 JSON");
  }
  if (!record(parsed)) fail("模板根节点必须是对象");
  if (parsed.schemaVersion !== VISUAL_TEMPLATE_SCHEMA_VERSION) fail("不支持的模板 schema 版本");
  finite(parsed.width, "width", 1, 4096);
  if (parsed.height !== "auto") finite(parsed.height, "height", 1, 16_384);
  if (parsed.format !== "png") fail("第一版仅支持 PNG 模板");
  const templateVariables = variables(parsed.variables);
  const paths = new Set(templateVariables.map((variable) => variable.path));
  background(parsed.background, paths);
  if (!Array.isArray(parsed.elements) || parsed.elements.length > 100) fail("elements 必须是最多 100 项的数组");
  const ids = new Set<string>();
  parsed.elements.forEach((entry, index) => element(entry, paths, ids, index));
  if (parsed.report !== undefined) {
    if (!record(parsed.report)) fail("report 必须是对象");
    for (const key of ["paddingX", "paddingTop", "paddingBottom", "sectionGap"] as const) {
      if (parsed.report[key] !== undefined) finite(parsed.report[key], `report.${key}`, 0, 2_000);
    }
    if (parsed.report.readability !== undefined) {
      if (!record(parsed.report.readability)) fail("report.readability 必须是对象");
      const readability = parsed.report.readability;
      if (readability.mode !== undefined && !["auto", "light", "dark"].includes(String(readability.mode))) {
        fail("report.readability.mode 不受支持");
      }
      for (const key of ["textColor", "itemBackground"] as const) {
        if (readability[key] !== undefined) color(readability[key], `report.readability.${key}`, paths);
      }
      for (const key of ["overlay", "card"] as const) {
        const layer = readability[key];
        if (layer === undefined) continue;
        if (!record(layer)) fail(`report.readability.${key} 必须是对象`);
        color(layer.color, `report.readability.${key}.color`, paths);
        finite(layer.opacity, `report.readability.${key}.opacity`, 0, 1);
        if (key === "card" && layer.radius !== undefined) finite(layer.radius, "report.readability.card.radius", 0, 2_000);
        if (key === "card" && layer.inset !== undefined) finite(layer.inset, "report.readability.card.inset", 0, 2_000);
      }
    }
  }
  if (parsed.sections !== undefined) {
    if (!Array.isArray(parsed.sections) || parsed.sections.length > 50) fail("sections 必须是最多 50 项的数组");
    const sectionIds = new Set<string>();
    parsed.sections.forEach((entry, index) => reportSection(entry, paths, sectionIds, index));
  }
  if (parsed.height === "auto" && !parsed.sections?.length) fail("height 为 auto 时至少需要一个 section");
  return parsed as unknown as VisualTemplateDefinition;
}
