/**
 * 互动场景（scene 题）的共享 schema 与校验器。
 *
 * 配置存放在 survey_questions.settings_json（questionView 原样透传给前端），
 * 前后端都从这里拿类型与解析——与 theme.ts 同一套协作方式。场景图和内层图
 * 必须挂在该题的 question_media 上：媒体端点的公开性检查扫 question_media，
 * 问卷发布后素材自动公开，alt 文本也随 question.media 下发。
 *
 * 坐标一律是相对场景图原始尺寸的 0..1 归一化值，与屏幕像素解耦。
 */

import { parseMediaRef, resolveMediaRef } from "./media-ref";

export const HOTSPOT_SCENE_VERSION = 1;

/** 数量上限：导入/编辑时的防失控护栏（不是产品限制，调大即可）。 */
export const HOTSPOT_SCENE_MAX_SCENES = 12;
export const HOTSPOT_SCENE_MAX_HOTSPOTS_PER_SCENE = 24;
const HOTSPOT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_URL_LENGTH = 4000;
const MAX_LABEL_LENGTH = 40;
const MAX_TEXT_LENGTH = 400;

// 结构化媒体引用的双读解析（阶段 D 读侧先行）：字符串原样，{assetId} 派生。
// toUrl 在这里注入（媒体端点拼写归此维护）；parseMediaRef 见 media-ref.ts。
const toPublicMediaUrl = (assetId: number): string => ["/api/survey/media/", String(assetId)].join("");

export interface HotspotImageAction {
  kind: "image";
  src: string;
  title: string;
  caption?: string;
  note?: string;
}

export interface HotspotSceneAction {
  kind: "scene";
  sceneId: string;
}

export type HotspotAction = HotspotImageAction | HotspotSceneAction;

export interface Hotspot {
  id: string;
  /** 相对场景图的归一化坐标（0..1）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** 选框角标编号（如 "01"）；缺省时前端按序号补。 */
  meta?: string;
  action: HotspotAction;
}

export interface HotspotScene {
  id: string;
  title: string;
  intro?: string;
  image: string;
  width: number;
  height: number;
  alt?: string;
  hotspots: Hotspot[];
}

export interface HotspotSceneConfig {
  version: typeof HOTSPOT_SCENE_VERSION;
  start: string;
  scenes: Record<string, HotspotScene>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

/**
 * 与 theme.ts safeImage 同一白名单：data:image/、https://、站内相对路径。
 * allowPlaceholderRefs 只在导入校验时打开：声明 JSON 用 kv://<slug> 占位，
 * 导入脚本落库前会把它们换成 /api/survey/media/<id>；运行时（读端消毒）
 * 必须保持严格，否则一张坏图会以合法身份渲染出来。
 *
 * 阶段 D 双读：既有字符串输入走白名单原样返回（视觉逐像素一致）；
 * 结构化 {assetId} 直接派生 URL（写入侧切换后立即生效，白名单等价——
 * assetId 是正整数，派生的站内路径必然命中「/」前缀分支）。
 */
function safeImage(value: unknown, allowPlaceholderRefs = false): string | undefined {
  if (value !== null && typeof value === "object") {
    return resolveMediaRef(value, toPublicMediaUrl);
  }
  const image = safeString(value, MAX_URL_LENGTH);
  if (!image) return undefined;
  if (image.startsWith("data:image/") || image.startsWith("https://") || image.startsWith("/")) {
    return image;
  }
  return allowPlaceholderRefs && image.startsWith("kv://") ? image : undefined;
}

/** 0..1 归一化数值；非法输入返回 undefined。 */
function safeUnit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** 正整数（场景图像素尺寸）；非法输入返回 undefined。 */
function safeDimension(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded >= 1 && rounded <= 20000 ? rounded : undefined;
}

function parseAction(value: unknown, sceneIds: Set<string>, allowPlaceholderRefs = false): HotspotAction | null {
  if (!isRecord(value)) return null;
  if (value.kind === "image") {
    const src = safeImage(value.src, allowPlaceholderRefs);
    const title = safeString(value.title, MAX_LABEL_LENGTH);
    if (!src || !title) return null;
    const action: HotspotImageAction = { kind: "image", src, title };
    const caption = safeString(value.caption, MAX_TEXT_LENGTH);
    const note = safeString(value.note, MAX_TEXT_LENGTH);
    if (caption) action.caption = caption;
    if (note) action.note = note;
    return action;
  }
  if (value.kind === "scene") {
    const sceneId = safeString(value.sceneId, 32);
    // 引用完整性：子场景切换的目标必须在本配置内，且不允许自引用。
    if (!sceneId || !HOTSPOT_ID_RE.test(sceneId) || !sceneIds.has(sceneId)) return null;
    return { kind: "scene", sceneId };
  }
  return null;
}

function parseHotspot(value: unknown, sceneIds: Set<string>, allowPlaceholderRefs = false): Hotspot | null {
  if (!isRecord(value)) return null;
  const id = safeString(value.id, 32);
  const label = safeString(value.label, MAX_LABEL_LENGTH);
  const x = safeUnit(value.x);
  const y = safeUnit(value.y);
  const w = safeUnit(value.w);
  const h = safeUnit(value.h);
  if (!id || !HOTSPOT_ID_RE.test(id) || !label) return null;
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  // 零面积/越界矩形没有交互意义。
  if (w <= 0 || h <= 0 || x + w > 1 || y + h > 1) return null;
  const action = parseAction(value.action, sceneIds, allowPlaceholderRefs);
  if (!action) return null;
  const hotspot: Hotspot = { id, x, y, w, h, label, action };
  const meta = safeString(value.meta, 8);
  if (meta) hotspot.meta = meta;
  return hotspot;
}

function parseScene(
  id: string,
  value: unknown,
  sceneIds: Set<string>,
  allowPlaceholderRefs: boolean,
): HotspotScene | null {
  if (!isRecord(value)) return null;
  const title = safeString(value.title, 80);
  const image = safeImage(value.image, allowPlaceholderRefs);
  const width = safeDimension(value.width);
  const height = safeDimension(value.height);
  if (!title || !image || width === undefined || height === undefined) return null;
  if (!Array.isArray(value.hotspots)) return null;
  if (value.hotspots.length > HOTSPOT_SCENE_MAX_HOTSPOTS_PER_SCENE) return null;
  const hotspots: Hotspot[] = [];
  const seen = new Set<string>();
  for (const entry of value.hotspots) {
    const hotspot = parseHotspot(entry, sceneIds, allowPlaceholderRefs);
    if (!hotspot || seen.has(hotspot.id)) return null;
    seen.add(hotspot.id);
    hotspots.push(hotspot);
  }
  const scene: HotspotScene = { id, title, image, width, height, hotspots };
  const intro = safeString(value.intro, MAX_TEXT_LENGTH);
  const alt = safeString(value.alt, MAX_TEXT_LENGTH);
  if (intro) scene.intro = intro;
  if (alt) scene.alt = alt;
  return scene;
}

/**
 * 解析 settings_json 里的场景配置。输入不合法时返回 null（调用方决定是
 * 报错还是回退为普通叙事渲染）——与 normalizeSurveyTheme 的宽容策略一致。
 * allowPlaceholderRefs 仅供导入校验使用（见 safeImage 注释）。
 */
export function parseHotspotScene(
  settings: unknown,
  options: { allowPlaceholderRefs?: boolean } = {},
): HotspotSceneConfig | null {
  const allowPlaceholderRefs = options.allowPlaceholderRefs === true;
  if (!isRecord(settings)) return null;
  const raw = isRecord(settings.scene) ? settings.scene : settings;
  if (raw.version !== HOTSPOT_SCENE_VERSION) return null;
  const start = safeString(raw.start, 32);
  if (!start || !HOTSPOT_ID_RE.test(start) || !isRecord(raw.scenes)) return null;
  const sceneIds = new Set(Object.keys(raw.scenes));
  if (sceneIds.size === 0 || sceneIds.size > HOTSPOT_SCENE_MAX_SCENES || !sceneIds.has(start)) {
    return null;
  }
  const scenes: Record<string, HotspotScene> = {};
  // 答案是一份跨场景的扁平 visited 列表，热点 id 因此必须全图唯一。
  const hotspotIds = new Set<string>();
  for (const [id, value] of Object.entries(raw.scenes)) {
    if (!HOTSPOT_ID_RE.test(id)) return null;
    const scene = parseScene(id, value, sceneIds, allowPlaceholderRefs);
    if (!scene) return null;
    for (const hotspot of scene.hotspots) {
      if (hotspotIds.has(hotspot.id)) return null;
      hotspotIds.add(hotspot.id);
    }
    scenes[id] = scene;
  }
  return { version: HOTSPOT_SCENE_VERSION, start, scenes };
}

/** 从题目 settings_json 文本解析；解析失败返回 null。 */
export function parseHotspotSceneFromJson(settingsJson: string | null): HotspotSceneConfig | null {
  if (!settingsJson) return null;
  try {
    return parseHotspotScene(JSON.parse(settingsJson));
  } catch {
    return null;
  }
}

/** 收集配置引用的全部图片 URL（场景图 + 内层图），供脚本挂 question_media。 */
export function hotspotMediaUrls(config: HotspotSceneConfig): string[] {
  const urls = new Set<string>();
  for (const scene of Object.values(config.scenes)) {
    urls.add(scene.image);
    for (const hotspot of scene.hotspots) {
      if (hotspot.action.kind === "image") urls.add(hotspot.action.src);
    }
  }
  return [...urls];
}

/** 场景题在类型清单里的统一标签（导出/Bot 展示用）。 */
export const SCENE_QUESTION_LABEL = "互动场景";
