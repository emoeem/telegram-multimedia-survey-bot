import type { ReportViewModel } from "./model";

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const GRADIENT_SVG = (from: string, to: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="800" height="600" fill="url(#g)"/></svg>`;

/**
 * Canned report data used by the Template Editor live preview and the
 * Playwright visual QA fixtures, so both always exercise the same shapes.
 */
export const reportPreviewViewModel: ReportViewModel = {
  hero: {
    title: "堕落游戏 · 身份报告",
    subtitle: "参与者 #188 · 完成于 2026-08-23 14:00",
    avatar: svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#e54d9b"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><circle cx="80" cy="80" r="78" fill="url(#a)"/><text x="80" y="96" font-size="46" text-anchor="middle" fill="#fff" font-family="sans-serif">堕</text></svg>`,
    ),
    coverImage: svgDataUri(GRADIENT_SVG("#2a0a1f", "#0d0716")),
    tags: ["身份档案", "深度问卷", "2026"],
  },
  scores: [
    { key: "obedience", label: "服从度", value: 86, max: 100, percentage: 86, level: "高" },
    { key: "desire", label: "欲望指数", value: 74, max: 100, percentage: 74, level: "较高" },
    { key: "rebellion", label: "反抗倾向", value: 38, max: 100, percentage: 38, level: "低" },
    { key: "trust", label: "信任值", value: 61, max: 100, percentage: 61, level: "中" },
  ],
  charts: {
    radar: [
      { label: "服从", value: 86 },
      { label: "欲望", value: 74 },
      { label: "反叛", value: 38 },
      { label: "信任", value: 61 },
      { label: "幻想", value: 79 },
    ],
    bars: [],
  },
  tags: ["堕落", "游戏", "深度"],
  insights: [
    {
      id: "i1",
      sourceId: "q1",
      title: "开局反应",
      text: "面对突如其来的束缚，参与者表现出较高的服从倾向，但同时也保留了试探性反抗的空间。",
      tags: ["服从度 86%"],
    },
    {
      id: "i2",
      sourceId: "q4",
      title: "欲望表达",
      text: "在身份转换类题目中，参与者更倾向于选择循序渐进的情节推进，而非直接进入极端场景。",
    },
  ],
  quotes: [
    {
      id: "q1",
      sourceId: "q7",
      title: "参与者自述",
      text: "“比起命令，更让人兴奋的是被慢慢驯化的过程。”",
    },
  ],
  gallery: [
    {
      url: svgDataUri(GRADIENT_SVG("#7c3aed", "#e54d9b")),
      caption: "第一幕 · 初见",
      questionTitle: "场景选择",
    },
    {
      url: svgDataUri(GRADIENT_SVG("#0ea5e9", "#7c3aed")),
      caption: "第二幕 · 驯化",
      questionTitle: "场景选择",
    },
    {
      url: svgDataUri(GRADIENT_SVG("#f59e0b", "#ef4444")),
      caption: "第三幕 · 沉沦",
      questionTitle: "场景选择",
    },
  ],
  summary:
    "综合来看，参与者对「支配-服从」关系持有较高的接受度，偏好渐进式情节与明确的仪式感，适合作为深层次角色扮演问卷的核心画像。",
  profile: [
    { id: "p1", sourceId: "q1", label: "姓名/代号", value: "暮色蔷薇" },
    { id: "p2", sourceId: "q2", label: "年龄区间", value: "25-30" },
    { id: "p3", sourceId: "q3", label: "角色定位", value: "被驯化的母狗" },
    { id: "p4", sourceId: "q4", label: "开局偏好", value: "温柔引导型" },
    { id: "p5", sourceId: "q5", label: "服从程度", value: "高（主动配合）" },
    { id: "p6", sourceId: "q6", label: "幻想场景", value: "封闭房间、项圈、锁链、仪式感" },
    { id: "p7", sourceId: "q7", label: "自我评价", value: "“表面端庄，内心渴望被支配”" },
    { id: "p8", sourceId: "q8", label: "备注", value: "该参与者明确表示愿意接收后续深度问卷。" },
  ],
  contentStats: {
    answerCount: 13,
    imageCount: 3,
    longTextCount: 4,
    scoreCount: 4,
  },
  meta: {
    surveyTitle: "堕落游戏",
    submittedAt: "2026-08-23 14:00",
    reportId: "#188",
  },
};
