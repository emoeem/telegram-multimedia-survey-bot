/**
 * Card face template ("卡面模板") data model.
 *
 * A template is a fixed 900x1200 canvas: an optional background image/color
 * plus absolutely positioned slots. Text slots bind to identity profile
 * fields (or custom text), image slots bind to the profile photos. The
 * fictional-use disclaimer is NOT a slot — the renderer always draws it, so
 * roleplay documents can never be produced without it.
 */
export const CARD_CANVAS_WIDTH = 900;
export const CARD_CANVAS_HEIGHT = 1200;
export const DEFAULT_DISCLAIMER_TEXT = "虚构证件 · 仅供娱乐";

export const CARD_SLOT_BINDINGS = [
  "name",
  "nickname",
  "age",
  "identity_label",
  "description",
  "card_id",
  "date",
  "custom",
  "front_image",
  "back_image",
] as const;

export type CardSlotBinding = (typeof CARD_SLOT_BINDINGS)[number];

export interface CardSlot {
  id: string;
  kind: "text" | "image";
  binding: CardSlotBinding;
  /** Used when binding === "custom". */
  customText?: string;
  /** Slot box on the 900x1200 canvas, in pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize?: number;
  color?: string;
  fontWeight?: number;
  align?: "left" | "center" | "right";
  fontFamily?: "sans" | "serif";
  /** Multi-line text: line-height multiplier; single-line slots ellipsis. */
  lineHeight?: number;
  fit?: "cover" | "contain";
  radius?: number;
  opacity?: number;
  rotate?: number;
}

export interface CardTemplateDefinition {
  backgroundColor: string;
  slots: CardSlot[];
  disclaimerText: string;
}

const COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;
const MAX_SLOTS = 40;
const MAX_CUSTOM_TEXT = 200;
const MAX_DISCLAIMER = 40;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function color(value: unknown, fallback: string): string {
  return typeof value === "string" && COLOR_PATTERN.test(value) ? value : fallback;
}

function isBinding(value: unknown): value is CardSlotBinding {
  return typeof value === "string" && (CARD_SLOT_BINDINGS as readonly string[]).includes(value);
}

function normalizeSlot(raw: unknown, index: number): CardSlot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const slot = raw as Record<string, unknown>;
  const binding = isBinding(slot.binding) ? slot.binding : "custom";
  const kind: CardSlot["kind"] =
    binding === "front_image" || binding === "back_image" ? "image" : slot.kind === "image" ? "image" : "text";
  return {
    id: typeof slot.id === "string" && slot.id.trim() ? slot.id.slice(0, 40) : `slot-${index + 1}`,
    kind,
    binding,
    ...(typeof slot.customText === "string" && slot.customText.trim()
      ? { customText: slot.customText.slice(0, MAX_CUSTOM_TEXT) }
      : {}),
    x: num(slot.x, 0, -CARD_CANVAS_WIDTH, CARD_CANVAS_WIDTH),
    y: num(slot.y, 0, -CARD_CANVAS_HEIGHT, CARD_CANVAS_HEIGHT),
    w: num(slot.w, 200, 1, CARD_CANVAS_WIDTH * 2),
    h: num(slot.h, 60, 1, CARD_CANVAS_HEIGHT * 2),
    ...(slot.fontSize !== undefined ? { fontSize: num(slot.fontSize, 28, 8, 200) } : {}),
    ...(slot.color !== undefined ? { color: color(slot.color, "#111111") } : {}),
    ...(slot.fontWeight !== undefined ? { fontWeight: num(slot.fontWeight, 400, 100, 900) } : {}),
    ...(slot.align === "left" || slot.align === "center" || slot.align === "right" ? { align: slot.align } : {}),
    ...(slot.fontFamily === "serif" || slot.fontFamily === "sans" ? { fontFamily: slot.fontFamily } : {}),
    ...(slot.lineHeight !== undefined ? { lineHeight: num(slot.lineHeight, 1.4, 0.8, 4) } : {}),
    ...(slot.fit === "contain" || slot.fit === "cover" ? { fit: slot.fit } : {}),
    ...(slot.radius !== undefined ? { radius: num(slot.radius, 0, 0, 400) } : {}),
    ...(slot.opacity !== undefined ? { opacity: num(slot.opacity, 1, 0.05, 1) } : {}),
    ...(slot.rotate !== undefined ? { rotate: num(slot.rotate, 0, -180, 180) } : {}),
  };
}

/** Whitelists a template definition from untrusted JSON (admin input, D1). */
export function normalizeCardTemplateDefinition(raw: unknown): CardTemplateDefinition {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const slots = Array.isArray(source.slots) ? source.slots : [];
  return {
    backgroundColor: color(source.backgroundColor, "#ffffff"),
    slots: slots
      .slice(0, MAX_SLOTS)
      .map((slot, index) => normalizeSlot(slot, index))
      .filter((slot): slot is CardSlot => slot !== null),
    disclaimerText:
      typeof source.disclaimerText === "string" && source.disclaimerText.trim()
        ? source.disclaimerText.trim().slice(0, MAX_DISCLAIMER)
        : DEFAULT_DISCLAIMER_TEXT,
  };
}

/** Sample values so the admin preview renders a realistic card. */
export const CARD_TEMPLATE_SAMPLE_VALUES: Record<
  Exclude<CardSlotBinding, "front_image" | "back_image" | "custom">,
  string
> = {
  name: "王小明",
  nickname: "小明",
  age: "23",
  identity_label: "见习成员",
  description: "这里是自我介绍示例文本，用于预览卡面排版效果。",
  card_id: "NO.20260901",
  date: "2026-09-01",
};
