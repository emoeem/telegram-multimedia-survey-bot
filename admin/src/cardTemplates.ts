import { api, apiSend, authHeaders } from "./api";

/** Mirrors src/card-template/model.ts (admin bundle is a separate TS project). */
export type CardSlotBinding =
  | "name"
  | "nickname"
  | "age"
  | "identity_label"
  | "description"
  | "card_id"
  | "date"
  | "custom"
  | "front_image"
  | "back_image";

export interface CardSlot {
  id: string;
  kind: "text" | "image";
  binding: CardSlotBinding;
  customText?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize?: number;
  color?: string;
  fontWeight?: number;
  align?: "left" | "center" | "right";
  fontFamily?: "sans" | "serif";
  lineHeight?: number;
  fit?: "cover" | "contain";
  radius?: number;
  opacity?: number;
  rotate?: number;
}

export interface CardTemplate {
  id: number;
  name: string;
  backgroundAssetId: number | null;
  backgroundColor: string;
  canvasWidth: number;
  canvasHeight: number;
  slots: CardSlot[];
  disclaimerText: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const CARD_SLOT_BINDING_LABELS: Record<CardSlotBinding, string> = {
  name: "姓名/代号",
  nickname: "昵称",
  age: "年龄",
  identity_label: "身份标签",
  description: "自我介绍",
  card_id: "卡片编号",
  date: "创建日期",
  custom: "自定义文本",
  front_image: "正面照片",
  back_image: "背面照片",
};

export const CARD_TEMPLATE_SAMPLE_TEXT: Record<string, string> = {
  name: "王小明",
  nickname: "小明",
  age: "23",
  identity_label: "见习成员",
  description: "这里是自我介绍示例文本，用于预览卡面排版效果。",
  card_id: "NO.20260901",
  date: "2026-09-01",
};

export const DEFAULT_DISCLAIMER = "虚构证件 · 仅供娱乐";

export interface CardTemplateDraft {
  name: string;
  backgroundAssetId: number | null;
  backgroundColor: string;
  slots: CardSlot[];
  disclaimerText: string;
  enabled: boolean;
}

export function fetchCardTemplates(): Promise<{ ok: boolean; templates: CardTemplate[] }> {
  return api("/api/admin/card-templates");
}

export function createCardTemplate(draft: CardTemplateDraft): Promise<{ ok: boolean; template: CardTemplate }> {
  return apiSend("POST", "/api/admin/card-templates", draft as unknown as Record<string, unknown>);
}

export function updateCardTemplate(
  id: number,
  draft: Partial<CardTemplateDraft>,
): Promise<{ ok: boolean; template: CardTemplate }> {
  return apiSend("PUT", `/api/admin/card-templates/${id}`, draft as Record<string, unknown>);
}

export function deleteCardTemplate(id: number): Promise<{ ok: boolean }> {
  return apiSend("DELETE", `/api/admin/card-templates/${id}`);
}

export async function uploadCardTemplateBackground(file: File): Promise<number> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/admin/card-templates/background", {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error((data.message as string) || "上传失败");
  return Number(data.mediaAssetId);
}

export async function previewCardTemplate(draft: Omit<CardTemplateDraft, "name" | "enabled">): Promise<Blob> {
  const response = await fetch("/api/admin/card-templates/preview", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((data.message as string) || "预览失败");
  }
  return response.blob();
}

let slotSeq = 0;
export function newSlotId(): string {
  slotSeq += 1;
  return `slot-${Date.now().toString(36)}-${slotSeq}`;
}

export interface CardTemplatePreset {
  key: string;
  label: string;
  description: string;
  draft: CardTemplateDraft;
}

/** Built-in starting layouts; the admin replaces the background/colors freely. */
export const CARD_TEMPLATE_PRESETS: CardTemplatePreset[] = [
  {
    key: "moments",
    label: "朋友圈截图风",
    description: "白底社媒动态样式：头像 + 昵称 + 正文 + 大图",
    draft: {
      name: "朋友圈截图风",
      backgroundAssetId: null,
      backgroundColor: "#ffffff",
      disclaimerText: DEFAULT_DISCLAIMER,
      enabled: true,
      slots: [
        { id: "p-avatar", kind: "image", binding: "front_image", x: 56, y: 72, w: 96, h: 96, radius: 12 },
        {
          id: "p-nick",
          kind: "text",
          binding: "nickname",
          x: 172,
          y: 80,
          w: 520,
          h: 46,
          fontSize: 34,
          fontWeight: 600,
          color: "#576b95",
        },
        {
          id: "p-desc",
          kind: "text",
          binding: "description",
          x: 172,
          y: 132,
          w: 672,
          h: 140,
          fontSize: 29,
          color: "#1a1a1a",
          lineHeight: 1.45,
        },
        { id: "p-photo", kind: "image", binding: "front_image", x: 172, y: 292, w: 620, h: 620, radius: 6 },
        { id: "p-name", kind: "text", binding: "name", x: 56, y: 30, w: 400, h: 36, fontSize: 24, color: "#999999" },
        { id: "p-date", kind: "text", binding: "date", x: 172, y: 936, w: 300, h: 36, fontSize: 24, color: "#999999" },
        {
          id: "p-label",
          kind: "text",
          binding: "identity_label",
          x: 480,
          y: 936,
          w: 360,
          h: 36,
          fontSize: 24,
          color: "#999999",
          align: "right",
        },
      ],
    },
  },
  {
    key: "cover",
    label: "杂志封面风",
    description: "整版照片封面：大标题 + 标签 + 刊号",
    draft: {
      name: "杂志封面风",
      backgroundAssetId: null,
      backgroundColor: "#000000",
      disclaimerText: DEFAULT_DISCLAIMER,
      enabled: true,
      slots: [
        {
          id: "p-photo",
          kind: "image",
          binding: "front_image",
          x: 0,
          y: 0,
          w: 900,
          h: 1200,
          fit: "cover",
          opacity: 0.92,
        },
        {
          id: "p-title",
          kind: "text",
          binding: "name",
          x: 44,
          y: 56,
          w: 720,
          h: 120,
          fontSize: 92,
          fontWeight: 800,
          color: "#ffffff",
        },
        {
          id: "p-label",
          kind: "text",
          binding: "identity_label",
          x: 48,
          y: 196,
          w: 500,
          h: 54,
          fontSize: 32,
          fontWeight: 600,
          color: "#ffd54a",
        },
        {
          id: "p-kicker",
          kind: "text",
          binding: "custom",
          customText: "WEEKLY SPECIAL ISSUE",
          x: 48,
          y: 1040,
          w: 560,
          h: 40,
          fontSize: 24,
          color: "#ffffff",
        },
        {
          id: "p-id",
          kind: "text",
          binding: "card_id",
          x: 560,
          y: 1100,
          w: 300,
          h: 40,
          fontSize: 26,
          color: "#ffffff",
          align: "right",
        },
        { id: "p-date", kind: "text", binding: "date", x: 48, y: 1100, w: 300, h: 40, fontSize: 26, color: "#ffffff" },
      ],
    },
  },
  {
    key: "student-id",
    label: "学生证风",
    description: "证件横栏布局：照片 + 字段表 + 底部说明",
    draft: {
      name: "学生证风",
      backgroundAssetId: null,
      backgroundColor: "#f5f0e6",
      disclaimerText: DEFAULT_DISCLAIMER,
      enabled: true,
      slots: [
        {
          id: "p-band",
          kind: "text",
          binding: "custom",
          customText: "MEMBERSHIP · 学员证",
          x: 60,
          y: 48,
          w: 780,
          h: 72,
          fontSize: 46,
          fontWeight: 700,
          color: "#8b1a1a",
          fontFamily: "serif",
          align: "center",
        },
        { id: "p-photo", kind: "image", binding: "front_image", x: 70, y: 180, w: 320, h: 420, radius: 6 },
        {
          id: "p-l-name",
          kind: "text",
          binding: "custom",
          customText: "姓名",
          x: 440,
          y: 204,
          w: 120,
          h: 40,
          fontSize: 26,
          color: "#777766",
        },
        {
          id: "p-name",
          kind: "text",
          binding: "name",
          x: 570,
          y: 198,
          w: 270,
          h: 50,
          fontSize: 34,
          fontWeight: 600,
          color: "#222211",
        },
        {
          id: "p-l-nick",
          kind: "text",
          binding: "custom",
          customText: "昵称",
          x: 440,
          y: 270,
          w: 120,
          h: 40,
          fontSize: 26,
          color: "#777766",
        },
        {
          id: "p-nick",
          kind: "text",
          binding: "nickname",
          x: 570,
          y: 266,
          w: 270,
          h: 44,
          fontSize: 30,
          color: "#222211",
        },
        {
          id: "p-l-age",
          kind: "text",
          binding: "custom",
          customText: "年龄",
          x: 440,
          y: 332,
          w: 120,
          h: 40,
          fontSize: 26,
          color: "#777766",
        },
        { id: "p-age", kind: "text", binding: "age", x: 570, y: 328, w: 270, h: 44, fontSize: 30, color: "#222211" },
        {
          id: "p-l-id",
          kind: "text",
          binding: "custom",
          customText: "编号",
          x: 440,
          y: 394,
          w: 120,
          h: 40,
          fontSize: 26,
          color: "#777766",
        },
        { id: "p-id", kind: "text", binding: "card_id", x: 570, y: 390, w: 270, h: 44, fontSize: 30, color: "#222211" },
        {
          id: "p-l-date",
          kind: "text",
          binding: "custom",
          customText: "签发日期",
          x: 440,
          y: 456,
          w: 140,
          h: 40,
          fontSize: 26,
          color: "#777766",
        },
        { id: "p-date", kind: "text", binding: "date", x: 590, y: 452, w: 250, h: 44, fontSize: 30, color: "#222211" },
        {
          id: "p-label",
          kind: "text",
          binding: "identity_label",
          x: 440,
          y: 528,
          w: 400,
          h: 48,
          fontSize: 30,
          fontWeight: 600,
          color: "#8b1a1a",
        },
        {
          id: "p-desc",
          kind: "text",
          binding: "description",
          x: 70,
          y: 660,
          w: 760,
          h: 300,
          fontSize: 27,
          color: "#333322",
          lineHeight: 1.6,
        },
      ],
    },
  },
  {
    key: "certificate",
    label: "认证证书风",
    description: "居中证书排版：标题 + 正文 + 署名 + 编号",
    draft: {
      name: "认证证书风",
      backgroundAssetId: null,
      backgroundColor: "#fdfbf5",
      disclaimerText: DEFAULT_DISCLAIMER,
      enabled: true,
      slots: [
        {
          id: "p-title",
          kind: "text",
          binding: "custom",
          customText: "认 证 证 书",
          x: 150,
          y: 110,
          w: 600,
          h: 96,
          fontSize: 76,
          fontWeight: 700,
          color: "#8a6d3b",
          fontFamily: "serif",
          align: "center",
        },
        {
          id: "p-sub",
          kind: "text",
          binding: "custom",
          customText: "CERTIFICATE OF ROLEPLAY",
          x: 150,
          y: 220,
          w: 600,
          h: 36,
          fontSize: 22,
          color: "#b09b6a",
          align: "center",
        },
        {
          id: "p-desc",
          kind: "text",
          binding: "description",
          x: 150,
          y: 330,
          w: 600,
          h: 300,
          fontSize: 30,
          color: "#333333",
          fontFamily: "serif",
          align: "center",
          lineHeight: 1.8,
        },
        { id: "p-photo", kind: "image", binding: "front_image", x: 370, y: 660, w: 160, h: 160, radius: 80 },
        {
          id: "p-name",
          kind: "text",
          binding: "name",
          x: 250,
          y: 850,
          w: 400,
          h: 64,
          fontSize: 42,
          fontWeight: 600,
          color: "#222222",
          align: "center",
        },
        {
          id: "p-label",
          kind: "text",
          binding: "identity_label",
          x: 250,
          y: 924,
          w: 400,
          h: 44,
          fontSize: 28,
          color: "#8a6d3b",
          align: "center",
        },
        { id: "p-id", kind: "text", binding: "card_id", x: 80, y: 1060, w: 320, h: 36, fontSize: 22, color: "#888888" },
        {
          id: "p-date",
          kind: "text",
          binding: "date",
          x: 520,
          y: 1060,
          w: 300,
          h: 36,
          fontSize: 22,
          color: "#888888",
          align: "right",
        },
      ],
    },
  },
];
