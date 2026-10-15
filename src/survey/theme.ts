/**
 * SurveyTheme — the Phase-3 visual theme system for the Web Survey.
 *
 * Themes are stored in surveys.settings_json (imported via
 * settings.theme) and normalized here so the public survey endpoint only
 * ever emits safe, known tokens. The survey UI maps them onto CSS custom
 * properties; surveys without a theme keep the platform default look.
 */

/**
 * 界面音效（UI SFX）事件名。
 *
 * 按「交互语义」而不是「声音文件」命名，这样换素材、换音源都不用改前端：
 * - select      选项被按下（轻点反馈）
 * - confirm     提交 / 确认退出等不可逆动作
 * - cancel      返回上一题 / 取消 / 关闭弹窗
 * - page        推进到下一段剧情或下一页
 * - transition  页/场景切换（含进入结局）
 */
export const SURVEY_SFX_CUES = ["select", "confirm", "cancel", "page", "transition"] as const;

export type SurveySfxCue = (typeof SURVEY_SFX_CUES)[number];

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
  /** Optional background music (data:audio / https / site-relative URL). */
  audio?: {
    url?: string;
    /**
     * Per-page BGM overrides keyed by the page's position in `pages`
     * (0-based, as stringified object keys). When the participant is on a
     * page with an override, it replaces the default `url`.
     */
    byPage?: Record<string, string>;
    /**
     * Per-question BGM overrides keyed by the question's `order` (stringified
     * integer). Takes precedence over `byPage`. Use it for one-off cues — a
     * turn in the story, an ending — that should not depend on which page the
     * node happens to live on.
     */
    byQuestion?: Record<string, string>;
    /**
     * 界面音效：事件名 → 音频 URL。缺省时前端完全不播音效（老问卷行为不变）。
     * 只播放这里显式声明的 cue，不做任何默认音效。
     */
    sfx?: Partial<Record<SurveySfxCue, string>>;
  };
  /**
   * 出场立绘（视觉小说式「立ち絵」）：同一角色的透明 PNG 多表情套图。
   * 与 BGM 同构——页级默认 + 节点级覆盖，缺省时前端完全不渲染立绘层，
   * 老问卷的观感与行为不变。用 `name` 生成 alt 文本（无障碍）。
   */
  sprite?: {
    /** 角色名（用于 alt / 无障碍朗读）。 */
    name?: string;
    /** 表情名 → 图片 URL（透明 PNG/WebP）。 */
    expressions?: Record<string, string>;
    /** 无节点/页覆盖时使用的表情名；缺省取 `expressions` 的第一个键。 */
    default?: string;
    /** 页级默认表情，键 = 页码（0 起，字符串）。 */
    byPage?: Record<string, string>;
    /** 节点级覆盖，键 = 题目 `order`（字符串）。优先级高于 `byPage`。 */
    byQuestion?: Record<string, string>;
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
  /** Submitted screen customization shown by the Web Survey. */
  completion?: {
    /** Custom thank-you message (≤600 chars). */
    message?: string;
    /** https:// or site-relative redirect offered as a button. */
    redirectUrl?: string;
    /** Show a "fill again" button (only honoured when the survey allows multiple responses). */
    showRestart?: boolean;
  };
}

/**
 * Ready-made survey themes sourced from the DaisyUI theme library
 * (daisyui/theme/<id>.css). Only these ids are accepted anywhere.
 */export const SURVEY_THEME_PRESETS = [
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

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\)|transparent)$/;

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
  return image.startsWith("data:image/") || image.startsWith("https://") || image.startsWith("/") ? image : undefined;
}

function safeAudioUrl(value: unknown): string | undefined {
  const url = safeString(value, 4000);
  if (!url) return undefined;
  return url.startsWith("data:audio/") || url.startsWith("https://") || url.startsWith("/") ? url : undefined;
}

/** 表情名白名单：只允许小写字母/数字/连字符，避免把任意字符串当键写进主题。 */
const EXPRESSION_KEY = /^[a-z0-9][a-z0-9_-]{0,23}$/;

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

  if (isRecord(value.audio)) {
    const url = safeAudioUrl(value.audio.url);
    const audio: NonNullable<SurveyTheme["audio"]> = {};
    if (url) audio.url = url;
    for (const [field, maxDigits] of [
      // Keys are page positions (0-based) in the survey's pages array.
      ["byPage", 3],
      // Keys are question `order` values (1-based, as stored).
      ["byQuestion", 4],
    ] as const) {
      const raw = value.audio[field];
      if (!isRecord(raw)) continue;
      const safeOverrides: Record<string, string> = {};
      for (const [key, entry] of Object.entries(raw)) {
        if (!new RegExp(`^\\d{1,${maxDigits}}$`).test(key)) continue;
        const safe = safeAudioUrl(entry);
        if (safe) safeOverrides[key] = safe;
      }
      if (Object.keys(safeOverrides).length > 0) audio[field] = safeOverrides;
    }
    // 界面音效：只接受白名单事件名，值走与 BGM 同一套 URL 白名单。
    if (isRecord(value.audio.sfx)) {
      const cues: Partial<Record<SurveySfxCue, string>> = {};
      for (const cue of SURVEY_SFX_CUES) {
        const safe = safeAudioUrl(value.audio.sfx[cue]);
        if (safe) cues[cue] = safe;
      }
      if (Object.keys(cues).length > 0) audio.sfx = cues;
    }
    if (Object.keys(audio).length > 0) theme.audio = audio;
  }

  // 立绘层：表情名与页/节点键都必须是构造成的数据，URL 走图片白名单。
  if (isRecord(value.sprite)) {
    const sprite: NonNullable<SurveyTheme["sprite"]> = {};
    const name = safeString(value.sprite.name, 40);
    if (name) sprite.name = name;
    if (isRecord(value.sprite.expressions)) {
      const expressions: Record<string, string> = {};
      for (const [key, entry] of Object.entries(value.sprite.expressions)) {
        if (!EXPRESSION_KEY.test(key)) continue;
        const safe = safeImage(entry);
        if (safe) expressions[key] = safe;
      }
      if (Object.keys(expressions).length > 0) sprite.expressions = expressions;
    }
    const fallback = safeString(value.sprite.default, 24);
    if (fallback && EXPRESSION_KEY.test(fallback)) sprite.default = fallback;
    for (const [field, maxDigits] of [
      // Keys are page positions (0-based) in the survey's pages array.
      ["byPage", 3],
      // Keys are question `order` values (1-based, as stored).
      ["byQuestion", 4],
    ] as const) {
      const raw = value.sprite[field];
      if (!isRecord(raw)) continue;
      const safeOverrides: Record<string, string> = {};
      for (const [key, entry] of Object.entries(raw)) {
        if (!new RegExp(`^\\d{1,${maxDigits}}$`).test(key)) continue;
        const expression = safeString(entry, 24);
        if (expression && EXPRESSION_KEY.test(expression)) safeOverrides[key] = expression;
      }
      if (Object.keys(safeOverrides).length > 0) sprite[field] = safeOverrides;
    }
    // 一张图都没有的 sprite 块没有任何用途（resolveSprite 也是 undefined），直接丢掉。
    if (sprite.expressions && Object.keys(sprite.expressions).length > 0) theme.sprite = sprite;
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

  if (isRecord(value.completion)) {
    const completion: NonNullable<SurveyTheme["completion"]> = {};
    const message = safeString(value.completion.message, 600);
    const redirectUrl = safeString(value.completion.redirectUrl, 500);
    if (message) completion.message = message;
    if (redirectUrl && (redirectUrl.startsWith("https://") || redirectUrl.startsWith("/"))) {
      completion.redirectUrl = redirectUrl;
    }
    if (value.completion.showRestart === true) completion.showRestart = true;
    if (Object.keys(completion).length) theme.completion = completion;
  }

  return Object.keys(theme).length ? theme : null;
}

/**
 * Normalizes a theme out of surveys.settings_json. Both stored shapes occur in
 * the wild: the admin editor and saveImportedSurvey wrap the theme under a
 * `theme` key, while older writers stored the theme object as the whole
 * settings JSON — which is what the public definition readers expect. Accept
 * either so every reader sees the same result.
 */
export function normalizeStoredSurveyTheme(settings: unknown): SurveyTheme | null {
  if (isRecord(settings) && isRecord(settings.theme)) {
    return normalizeSurveyTheme(settings.theme);
  }
  return normalizeSurveyTheme(settings);
}

/**
 * Which track the player should be playing on a given node.
 *
 * Precedence: a per-question cue (a story turn, an ending) beats the page's
 * override, which beats the survey-wide default. `pageIndex` is the page's
 * position in `pages` and is -1 when the node's page is unknown, which simply
 * misses every byPage key.
 */
export function resolveBgmUrl(
  theme: SurveyTheme | null | undefined,
  questionOrder: number | null | undefined,
  pageIndex: number,
): string | undefined {
  const audio = theme?.audio;
  if (!audio) return undefined;
  const cue =
    questionOrder === null || questionOrder === undefined
      ? undefined
      : audio.byQuestion?.[String(questionOrder)];
  return cue ?? audio.byPage?.[String(pageIndex)] ?? audio.url;
}

/**
 * 该节点该显示哪张立绘。
 *
 * 优先级与 BGM 完全一致：节点级表情覆盖 > 页级默认 > `sprite.default` >
 * `expressions` 的第一个键。目标表情没有对应图片时，逐级回退到任一可用表情，
 * 而不是让立绘整块消失（画面闪一下比少一张图更糟）。没有任何图片时返回
 * undefined，调用方不渲染立绘层。
 */
export function resolveSprite(
  theme: SurveyTheme | null | undefined,
  questionOrder: number | null | undefined,
  pageIndex: number,
): { url: string; expression: string; name?: string } | undefined {
  const sprite = theme?.sprite;
  const expressions = sprite?.expressions;
  if (!sprite || !expressions) return undefined;
  const keys = Object.keys(expressions);
  const fallbackKey = keys[0];
  if (fallbackKey === undefined) return undefined;
  const pageCue = sprite.byPage?.[String(pageIndex)];
  const wanted =
    (questionOrder === null || questionOrder === undefined
      ? undefined
      : sprite.byQuestion?.[String(questionOrder)]) ??
    pageCue ??
    sprite.default;
  const usable = (candidate: string | undefined): candidate is string =>
    candidate !== undefined && expressions[candidate] !== undefined;
  // 目标表情没有素材时逐级回退（页级 → default → 第一个可用表情）：
  // 情绪错一档也比立绘整块消失好。
  const expression = usable(wanted)
    ? wanted
    : usable(pageCue)
      ? pageCue
      : usable(sprite.default)
        ? sprite.default
        : fallbackKey;
  const url = expressions[expression];
  if (url === undefined) return undefined;
  return sprite.name === undefined
    ? { url, expression }
    : { url, expression, name: sprite.name };
}
