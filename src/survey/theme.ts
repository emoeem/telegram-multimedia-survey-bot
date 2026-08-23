/**
 * SurveyTheme — the Phase-3 visual theme system for the Web Survey.
 *
 * Themes are stored in surveys.settings_json (imported via
 * settings.theme) and normalized here so the public survey endpoint only
 * ever emits safe, known tokens. The survey UI maps them onto CSS custom
 * properties; surveys without a theme keep the platform default look.
 */

export interface SurveyTheme {
  /** Reference to a DaisyUI theme id (see SURVEY_THEME_PRESETS). */
  preset?: string;
  background?: {
    color?: string;
    /** CSS background-image value (data:image or absolute URL only). */
    image?: string;
    /** CSS background-position (whitelisted). */
    position?: string;
    /** CSS background-size (whitelisted). */
    size?: string;
  };
  overlay?: {
    color?: string;
    /** 0..1 */
    opacity?: number;
    /** px blur, 0..40 */
    blur?: number;
  };
  primaryColor?: string;
  secondaryColor?: string;
  card?: {
    background?: string;
    border?: string;
    /** px radius, 0..32 */
    radius?: number;
    glass?: boolean;
  };
  text?: {
    heading?: string;
    body?: string;
    muted?: string;
  };
  button?: {
    /** px radius, 0..32 */
    radius?: number;
  };
}

/**
 * Ready-made survey themes sourced from the DaisyUI theme library
 * (daisyui/theme/<id>.css). Only these ids are accepted anywhere.
 */
export const SURVEY_THEME_PRESETS = [
  { id: "light", name: "明亮" },
  { id: "dark", name: "暗色" },
  { id: "night", name: "深蓝夜" },
  { id: "luxury", name: "黑金奢华" },
  { id: "retro", name: "复古纸张" },
  { id: "cupcake", name: "粉彩" },
  { id: "synthwave", name: "霓虹" },
  { id: "black", name: "纯黑" },
] as const;

const PRESET_IDS = new Set<string>(SURVEY_THEME_PRESETS.map((preset) => preset.id));

const COLOR_RE =
  /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\)|transparent)$/;

const BACKGROUND_POSITIONS = new Set([
  "left top",
  "left center",
  "left bottom",
  "center top",
  "center",
  "center center",
  "center bottom",
  "right top",
  "right center",
  "right bottom",
]);

const BACKGROUND_SIZES = new Set(["cover", "contain", "auto", "100% 100%"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return COLOR_RE.test(trimmed) ? trimmed : undefined;
}

function safeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function safeImage(value: unknown): string | undefined {
  const image = safeString(value, 4000);
  if (!image) return undefined;
  return image.startsWith("data:image/") ||
    image.startsWith("https://") ||
    image.startsWith("/")
    ? image
    : undefined;
}

function safePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function safeRadius(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(0, value));
}

/**
 * Returns a sanitized theme with only known, safe tokens. Returns null when
 * the input contains no usable token so callers can fall back to defaults.
 */
export function normalizeSurveyTheme(value: unknown): SurveyTheme | null {
  if (!isRecord(value)) return null;
  const theme: SurveyTheme = {};

  const preset = safeString(value.preset, 40);
  if (preset && PRESET_IDS.has(preset)) theme.preset = preset;

  if (isRecord(value.background)) {
    const color = safeColor(value.background.color);
    const image = safeImage(value.background.image);
    const position = safeString(value.background.position, 40);
    const size = safeString(value.background.size, 40);
    const background: NonNullable<SurveyTheme["background"]> = {};
    if (color) background.color = color;
    if (image) background.image = image;
    if (position && BACKGROUND_POSITIONS.has(position)) {
      background.position = position;
    }
    if (size && BACKGROUND_SIZES.has(size)) background.size = size;
    if (Object.keys(background).length) theme.background = background;
  }

  if (isRecord(value.overlay)) {
    const color = safeColor(value.overlay.color);
    const opacity = safePercent(value.overlay.opacity);
    const blur = safeRadius(value.overlay.blur, 40);
    const overlay: NonNullable<SurveyTheme["overlay"]> = {};
    if (color) overlay.color = color;
    if (opacity !== undefined) overlay.opacity = opacity;
    if (blur !== undefined) overlay.blur = blur;
    if (Object.keys(overlay).length) theme.overlay = overlay;
  }

  const primaryColor = safeColor(value.primaryColor);
  if (primaryColor) theme.primaryColor = primaryColor;
  const secondaryColor = safeColor(value.secondaryColor);
  if (secondaryColor) theme.secondaryColor = secondaryColor;

  if (isRecord(value.card)) {
    const card: NonNullable<SurveyTheme["card"]> = {};
    const background = safeColor(value.card.background);
    const border = safeColor(value.card.border);
    const radius = safeRadius(value.card.radius, 32);
    if (background) card.background = background;
    if (border) card.border = border;
    if (radius !== undefined) card.radius = radius;
    if (value.card.glass === true) card.glass = true;
    if (Object.keys(card).length) theme.card = card;
  }

  if (isRecord(value.text)) {
    const text: NonNullable<SurveyTheme["text"]> = {};
    const heading = safeColor(value.text.heading);
    const body = safeColor(value.text.body);
    const muted = safeColor(value.text.muted);
    if (heading) text.heading = heading;
    if (body) text.body = body;
    if (muted) text.muted = muted;
    if (Object.keys(text).length) theme.text = text;
  }

  if (isRecord(value.button)) {
    const radius = safeRadius(value.button.radius, 32);
    if (radius !== undefined) theme.button = { radius };
  }

  return Object.keys(theme).length ? theme : null;
}
