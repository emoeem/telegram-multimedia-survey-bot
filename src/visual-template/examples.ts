import type { VisualTemplateDefinition } from "./schema";

/**
 * Built-in examples demonstrate distinct ResultProfile layouts. They are
 * ordinary template definitions, so production rendering never branches on a
 * template type or on application-specific field names.
 */
export const characterCardExampleTemplate: VisualTemplateDefinition = {
  schemaVersion: 1,
  width: 1080,
  height: 1350,
  format: "png",
  background: { type: "gradient", from: "#111827", to: "#6d28d9", angle: 35 },
  variables: [
    { path: "result.fields.name", label: "名称", type: "text", required: true },
    { path: "result.fields.title", label: "称号", type: "text" },
    { path: "result.fields.role", label: "身份", type: "text" },
    { path: "result.fields.level", label: "等级", type: "integer" },
    { path: "result.fields.rarity", label: "稀有度", type: "enum" },
    { path: "result.fields.description", label: "描述", type: "long_text" },
    { path: "result.images.avatar", label: "角色图", type: "image" },
    { path: "result.tags", label: "标签", type: "tags" },
    { path: "result.stats", label: "自定义属性", type: "stats" },
  ],
  elements: [
    { id: "avatar", type: "image", source: "{{result.images.avatar}}", x: 540, y: 90, width: 450, height: 600, fit: "cover", shape: "rounded", radius: 36, zIndex: 1 },
    { id: "name", type: "text", value: "{{result.fields.name}}", x: 80, y: 120, width: 420, fontSize: 70, fontWeight: "bold", color: "#ffffff", maxLines: 1, overflow: "ellipsis", zIndex: 2 },
    { id: "title", type: "text", value: "{{result.fields.title}}", x: 80, y: 225, width: 420, fontSize: 34, color: "#ddd6fe", maxLines: 1, overflow: "ellipsis", zIndex: 2 },
    { id: "role", type: "badge", value: "{{result.fields.role}}", x: 80, y: 300, width: 420, fontSize: 28, color: "#fef3c7", zIndex: 2 },
    { id: "level", type: "text", value: "LEVEL {{result.fields.level}}", x: 80, y: 370, width: 420, fontSize: 28, color: "#ffffff", zIndex: 2 },
    { id: "rarity", type: "badge", value: "{{result.fields.rarity}}", x: 80, y: 430, width: 420, fontSize: 40, fontWeight: "bold", color: "#fde68a", visibleIf: { path: "result.fields.rarity", operator: "exists" }, zIndex: 2 },
    { id: "tags", type: "tag", value: "{{result.tags}}", x: 80, y: 525, width: 420, fontSize: 25, color: "#e9d5ff", maxLines: 2, overflow: "ellipsis", zIndex: 2 },
    { id: "stats", type: "stat_group", source: "{{result.stats}}", x: 80, y: 745, width: 920, height: 330, color: "#ffffff", fill: "#a78bfa", zIndex: 2 },
    { id: "description", type: "text", value: "{{result.fields.description}}", x: 80, y: 1120, width: 920, fontSize: 28, lineHeight: 1.4, maxLines: 4, overflow: "ellipsis", color: "#f5f3ff", zIndex: 2 },
  ],
};

export const personalityResultExampleTemplate: VisualTemplateDefinition = {
  schemaVersion: 1,
  width: 1080,
  height: 1350,
  format: "png",
  background: { type: "solid", color: "#ecfeff" },
  variables: [
    { path: "result.fields.name", label: "名称", type: "text" },
    { path: "result.fields.personality", label: "人格类型", type: "enum", required: true },
    { path: "result.fields.summary", label: "结果摘要", type: "long_text", required: true },
    { path: "result.fields.traits", label: "特性", type: "tags" },
    { path: "result.images.portrait", label: "插图", type: "image" },
  ],
  elements: [
    { id: "border", type: "rectangle", x: 40, y: 40, width: 1000, height: 1270, radius: 42, fill: "#ffffff", stroke: "#99f6e4", strokeWidth: 5, zIndex: 1 },
    { id: "portrait", type: "image", source: "{{result.images.portrait}}", x: 390, y: 115, width: 300, height: 300, fit: "cover", shape: "circle", zIndex: 2 },
    { id: "name", type: "text", value: "{{result.fields.name}}", x: 120, y: 470, width: 840, fontSize: 34, align: "center", color: "#0f766e", zIndex: 2 },
    { id: "personality", type: "text", value: "{{result.fields.personality}}", x: 120, y: 535, width: 840, fontSize: 68, fontWeight: "bold", align: "center", color: "#134e4a", maxLines: 2, overflow: "ellipsis", zIndex: 2 },
    { id: "traits", type: "tag", value: "{{result.fields.traits}}", x: 120, y: 710, width: 840, fontSize: 30, align: "center", maxLines: 2, overflow: "ellipsis", color: "#0f766e", zIndex: 2 },
    { id: "summary", type: "text", value: "{{result.fields.summary}}", x: 120, y: 845, width: 840, fontSize: 34, lineHeight: 1.5, maxLines: 7, overflow: "ellipsis", color: "#334155", zIndex: 2 },
  ],
};

export const customResultPosterExampleTemplate: VisualTemplateDefinition = {
  schemaVersion: 1,
  width: 1200,
  height: 630,
  format: "png",
  background: { type: "gradient", from: "#fef3c7", to: "#fb7185", angle: 25 },
  variables: [
    { path: "result.fields.name", label: "名称", type: "text" },
    { path: "result.fields.category", label: "分类", type: "enum", required: true },
    { path: "result.fields.relationship", label: "关系", type: "text" },
    { path: "result.fields.special_label", label: "特别标签", type: "text" },
    { path: "result.fields.special_trait", label: "特别特性", type: "text" },
    { path: "result.fields.description", label: "结果说明", type: "long_text" },
    { path: "result.images.cover", label: "封面图", type: "image" },
  ],
  elements: [
    { id: "cover", type: "image", source: "{{result.images.cover}}", x: 790, y: 55, width: 355, height: 520, fit: "cover", shape: "rounded", radius: 30, zIndex: 1 },
    { id: "category", type: "badge", value: "{{result.fields.category}}", x: 65, y: 70, width: 650, fontSize: 32, fontWeight: "bold", color: "#9f1239", zIndex: 2 },
    { id: "name", type: "text", value: "{{result.fields.name}}", x: 65, y: 135, width: 650, fontSize: 62, fontWeight: "bold", color: "#4c0519", maxLines: 1, overflow: "ellipsis", zIndex: 2 },
    { id: "relationship", type: "text", value: "{{result.fields.relationship}}", x: 65, y: 225, width: 650, fontSize: 32, color: "#881337", maxLines: 1, overflow: "ellipsis", zIndex: 2 },
    { id: "special-label", type: "badge", value: "{{result.fields.special_label}}", x: 65, y: 285, width: 650, fontSize: 28, color: "#9f1239", zIndex: 2 },
    { id: "special-trait", type: "text", value: "{{result.fields.special_trait}}", x: 65, y: 340, width: 650, fontSize: 30, color: "#4c0519", maxLines: 2, overflow: "ellipsis", zIndex: 2 },
    { id: "description", type: "text", value: "{{result.fields.description}}", x: 65, y: 435, width: 650, fontSize: 25, lineHeight: 1.35, maxLines: 4, overflow: "ellipsis", color: "#4c0519", zIndex: 2 },
  ],
};

export const completionResultExampleTemplate: VisualTemplateDefinition = {
  schemaVersion: 1,
  width: 1080,
  height: 1350,
  format: "png",
  background: { type: "gradient", from: "#0f172a", to: "#0f766e", angle: 35 },
  variables: [
    { path: "result.title", label: "结果标题", type: "text", required: true },
    { path: "result.subtitle", label: "结果副标题", type: "text" },
    { path: "result.tags", label: "标签", type: "tags" },
  ],
  elements: [
    { id: "eyebrow", type: "text", value: "QUESTIONNAIRE RESULT", x: 100, y: 150, width: 880, fontSize: 34, align: "center", color: "#99f6e4", zIndex: 1 },
    { id: "title", type: "text", value: "{{result.title}}", x: 100, y: 360, width: 880, fontSize: 76, fontWeight: "bold", align: "center", color: "#ffffff", maxLines: 3, overflow: "ellipsis", zIndex: 1 },
    { id: "subtitle", type: "text", value: "{{result.subtitle}}", x: 120, y: 690, width: 840, fontSize: 34, align: "center", color: "#ccfbf1", maxLines: 3, overflow: "ellipsis", zIndex: 1 },
    { id: "tags", type: "tag", value: "{{result.tags}}", x: 120, y: 930, width: 840, fontSize: 30, align: "center", color: "#ffffff", maxLines: 2, overflow: "ellipsis", zIndex: 1 },
    { id: "footer", type: "text", value: "已完成 · 感谢参与", x: 120, y: 1170, width: 840, fontSize: 30, align: "center", color: "#99f6e4", zIndex: 1 },
  ],
};

/** A long-form report: every repeated block is driven by an array, not fixed coordinates. */
export const visualReportExampleTemplate: VisualTemplateDefinition = {
  schemaVersion: 1,
  width: 1080,
  height: "auto",
  format: "png",
  background: { type: "solid", color: "#fff7ed" },
  report: { paddingX: 64, paddingTop: 250, paddingBottom: 96, sectionGap: 56 },
  variables: [
    { path: "result.title", label: "报告标题", type: "text", required: true },
    { path: "result.subtitle", label: "报告副标题", type: "text" },
    { path: "result.metadata.profile", label: "基础信息", type: "list" },
    { path: "result.metadata.gallery", label: "图片记录", type: "list" },
    { path: "result.metadata.status", label: "状态检查", type: "list" },
    { path: "result.stats", label: "量化指标", type: "stats" },
    { path: "result.metadata.summary", label: "总结", type: "long_text" },
  ],
  elements: [
    { id: "report-title", type: "text", value: "{{result.title}}", x: 64, y: 72, width: 952, fontSize: 62, fontWeight: "bold", color: "#7c2d12", maxLines: 2, overflow: "ellipsis" },
    { id: "report-subtitle", type: "text", value: "{{result.subtitle}}", x: 64, y: 160, width: 952, fontSize: 28, color: "#9a3412", maxLines: 2, overflow: "ellipsis" },
  ],
  sections: [
    { id: "basic", type: "table", title: "01. 基础概况 / BASIC PROFILE", source: "{{result.metadata.profile}}", columns: 2, label: "{{label}}", value: "{{value}}", color: "#431407", fill: "#fdba74" },
    { id: "gallery", type: "gallery", title: "02. 视觉记录 / PHOTO GALLERY", source: "{{result.metadata.gallery}}", columns: 2, gap: 20, imageHeight: 260, radius: 20, color: "#431407", fill: "#fdba74" },
    { id: "status", type: "status_grid", title: "03. 状态检查 / STATUS CHECK", source: "{{result.metadata.status}}", columns: 3, label: "{{name}}", itemHeight: 64, color: "#431407", background: "#ffedd5", fill: "#fdba74" },
    { id: "metrics", type: "metrics", title: "04. 量化指标 / QUANTITATIVE METRICS", source: "{{result.stats}}", columns: 2, label: "{{label}}", itemHeight: 88, gap: 26, color: "#431407", fill: "#ea580c" },
    { id: "summary", type: "summary", title: "05. 总结 / SUMMARY", source: "{{result.metadata.summary}}", fontSize: 30, color: "#431407", fill: "#fdba74" },
  ],
};

/** Alternative long-report palettes share the same data contract and layout. */
export const midnightReportExampleTemplate: VisualTemplateDefinition = {
  schemaVersion: 1,
  width: visualReportExampleTemplate.width,
  height: "auto",
  format: "png",
  background: { type: "gradient", from: "#050816", to: "#172554", angle: 135 },
  report: {
    paddingX: 64,
    paddingTop: 250,
    paddingBottom: 96,
    sectionGap: 56,
    readability: {
      overlay: { color: "#020617", opacity: 0.18 },
      card: { color: "#0b1228", opacity: 0.92, radius: 34, inset: 28 },
      textColor: "#e0f2fe",
      itemBackground: "#111d3a",
    },
  },
  variables: visualReportExampleTemplate.variables,
  elements: [
    { id: "neon-cyan", type: "rectangle", x: 64, y: 62, width: 380, height: 8, radius: 4, fill: "#22d3ee" },
    { id: "neon-pink", type: "rectangle", x: 444, y: 62, width: 160, height: 8, radius: 4, fill: "#f472b6" },
    { id: "report-title", type: "text", value: "{{result.title}}", x: 64, y: 92, width: 952, fontSize: 62, fontWeight: "bold", color: "#f8fafc", maxLines: 2, overflow: "ellipsis" },
    { id: "report-subtitle", type: "text", value: "IDENTITY // NEON ARCHIVE", x: 64, y: 180, width: 952, fontSize: 28, color: "#67e8f9", maxLines: 2, overflow: "ellipsis", letterSpacing: 2 },
  ],
  sections: visualReportExampleTemplate.sections!.map((section) => ({
    ...section,
    color: "#e0f2fe",
    fill: section.type === "metrics" ? "#f472b6" : "#22d3ee",
    ...(section.type === "status_grid" ? { background: "#111d3a" } : {}),
  })),
};

export const roseReportExampleTemplate: VisualTemplateDefinition = {
  schemaVersion: 1,
  width: visualReportExampleTemplate.width,
  height: "auto",
  format: "png",
  background: { type: "gradient", from: "#352014", to: "#a66a2c", angle: 45 },
  report: {
    paddingX: 64,
    paddingTop: 250,
    paddingBottom: 96,
    sectionGap: 56,
    readability: {
      overlay: { color: "#2a160d", opacity: 0.16 },
      card: { color: "#f7e6bf", opacity: 0.95, radius: 18, inset: 34 },
      textColor: "#3b2115",
      itemBackground: "#f1d39b",
    },
  },
  variables: visualReportExampleTemplate.variables,
  elements: [
    { id: "gold-frame", type: "rectangle", x: 58, y: 56, width: 964, height: 150, radius: 12, fill: "#00000000", stroke: "#b8863b", strokeWidth: 4 },
    { id: "report-title", type: "text", value: "{{result.title}}", x: 88, y: 88, width: 904, fontSize: 58, fontWeight: "bold", color: "#3b2115", maxLines: 2, overflow: "ellipsis", align: "center" },
    { id: "report-subtitle", type: "text", value: "✦ PERSONAL DOSSIER ✦", x: 88, y: 188, width: 904, fontSize: 25, color: "#8b5a2b", maxLines: 2, overflow: "ellipsis", align: "center", letterSpacing: 3 },
  ],
  sections: visualReportExampleTemplate.sections!.map((section) => ({
    ...section,
    color: "#3b2115",
    fill: "#b77932",
    ...(section.type === "status_grid" ? { background: "#f1d39b" } : {}),
  })),
};

export const resultVisualExampleTemplates = [
  completionResultExampleTemplate,
  characterCardExampleTemplate,
  personalityResultExampleTemplate,
  customResultPosterExampleTemplate,
  visualReportExampleTemplate,
  midnightReportExampleTemplate,
  roseReportExampleTemplate,
] as const;
