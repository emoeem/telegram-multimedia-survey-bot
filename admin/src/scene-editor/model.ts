import {
  HOTSPOT_SCENE_VERSION,
  type Hotspot,
  type HotspotScene,
  type HotspotSceneConfig,
} from "../../../src/survey/hotspot";

/**
 * 场景编辑器的纯函数层：矩形几何、id 生成、媒体 URL 映射、草稿校验。
 * 不依赖 React/DOM，便于单测；页面只负责状态与事件。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const MIN_RECT = 0.01;
export const NUDGE_STEP = 0.005;
export const NUDGE_STEP_FAST = 0.02;
export const MAX_HOTSPOT_LABEL = 40;
export const MAX_HOTSPOT_TEXT = 400;
export const MAX_SCENE_TITLE = 80;

export interface DraftIssue {
  /** 与检查器字段对应的路径，如 `scenes.room.image`。 */
  path: string;
  message: string;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 两个拖拽点 → 归一化矩形；反向拖拽（右下 → 左上）也能得到正向矩形。 */
export function normalizeRect(start: { x: number; y: number }, end: { x: number; y: number }): Rect {
  const x = Math.min(clamp01(start.x), clamp01(end.x));
  const y = Math.min(clamp01(start.y), clamp01(end.y));
  const w = Math.abs(clamp01(end.x) - clamp01(start.x));
  const h = Math.abs(clamp01(end.y) - clamp01(start.y));
  return clampRect({ x, y, w, h });
}

/** 夹紧到 [0,1] 且保证最小尺寸；w/h 过大时以左上角为锚点收缩。 */
export function clampRect(rect: Rect): Rect {
  const w = Math.min(1, Math.max(MIN_RECT, Number.isFinite(rect.w) ? rect.w : MIN_RECT));
  const h = Math.min(1, Math.max(MIN_RECT, Number.isFinite(rect.h) ? rect.h : MIN_RECT));
  const x = Math.min(1 - w, Math.max(0, Number.isFinite(rect.x) ? rect.x : 0));
  const y = Math.min(1 - h, Math.max(0, Number.isFinite(rect.y) ? rect.y : 0));
  return { x, y, w, h };
}

export function moveRect(rect: Rect, dx: number, dy: number): Rect {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy });
}

/** 以边为锚点缩放：对边不动、被拖的边夹紧在 [0,1] 与最小尺寸之间。 */
export function resizeRect(rect: Rect, handle: ResizeHandle, dx: number, dy: number): Rect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;
  if (handle.includes("w")) left = Math.min(right - MIN_RECT, Math.max(0, left + dx));
  if (handle.includes("e")) right = Math.max(left + MIN_RECT, Math.min(1, right + dx));
  if (handle.includes("n")) top = Math.min(bottom - MIN_RECT, Math.max(0, top + dy));
  if (handle.includes("s")) bottom = Math.max(top + MIN_RECT, Math.min(1, bottom + dy));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function nudgeRect(rect: Rect, dx: number, dy: number): Rect {
  return moveRect(rect, dx, dy);
}

export function rectToStyle(rect: Rect): { left: string; top: string; width: string; height: string } {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`,
  };
}

/** 媒体资产 id ↔ 两种 URL：配置里存公开 URL，编辑器里用 admin 预览 URL。 */
export function publicMediaUrl(mediaAssetId: number): string {
  return `/api/survey/media/${mediaAssetId}`;
}

export function adminMediaUrl(mediaAssetId: number): string {
  return `/api/admin/media/${mediaAssetId}/image`;
}

export function mediaIdFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const publicMatch = url.match(/^\/api\/survey\/media\/(\d+)$/);
  if (publicMatch) return Number(publicMatch[1]);
  const adminMatch = url.match(/^\/api\/admin\/media\/(\d+)\/image$/);
  if (adminMatch) return Number(adminMatch[1]);
  return null;
}

/** 预览时把保存用的公开 URL 换成 admin 预览 URL；外部 URL 原样保留。 */
export function transformConfigForPreview(config: HotspotSceneConfig): HotspotSceneConfig {
  const clone = JSON.parse(JSON.stringify(config)) as HotspotSceneConfig;
  for (const scene of Object.values(clone.scenes)) {
    const sceneMediaId = mediaIdFromUrl(scene.image);
    if (sceneMediaId !== null) scene.image = adminMediaUrl(sceneMediaId);
    for (const hotspot of scene.hotspots) {
      if (hotspot.action.kind !== "image") continue;
      const mediaId = mediaIdFromUrl(hotspot.action.src);
      if (mediaId !== null) hotspot.action.src = adminMediaUrl(mediaId);
    }
  }
  return clone;
}

/** 编辑器里显示一张图：媒体资产换 admin 预览地址，外部 URL 原样。 */
export function displayMediaUrl(url: string): string {
  const mediaId = mediaIdFromUrl(url);
  return mediaId !== null ? adminMediaUrl(mediaId) : url;
}

function uniqueId(existing: Set<string>, prefix: string): string {
  let index = 1;
  while (existing.has(`${prefix}-${index}`) || existing.has(`${prefix}${index}`)) index += 1;
  return `${prefix}-${index}`;
}

export function nextSceneId(config: HotspotSceneConfig | null): string {
  const existing = new Set(Object.keys(config?.scenes ?? {}));
  return uniqueId(existing, "scene");
}

export function nextHotspotId(config: HotspotSceneConfig | null): string {
  const existing = new Set<string>();
  for (const scene of Object.values(config?.scenes ?? {})) {
    for (const hotspot of scene.hotspots) existing.add(hotspot.id);
  }
  let index = 1;
  while (existing.has(`h${index}`)) index += 1;
  return `h${index}`;
}

export function nextHotspotMeta(scene: HotspotScene): string {
  const used = new Set(scene.hotspots.map((hotspot) => hotspot.meta).filter(Boolean));
  let index = scene.hotspots.length + 1;
  while (used.has(String(index).padStart(2, "0"))) index += 1;
  return String(index).padStart(2, "0");
}

export function createEmptyScene(id: string, title: string): HotspotScene {
  return {
    id,
    title,
    image: "",
    width: 1600,
    height: 1000,
    hotspots: [],
  };
}

/** 没有底图时返回 null；选中底图后由页面创建配置。 */
export function createConfigWithScene(scene: HotspotScene): HotspotSceneConfig {
  return {
    version: HOTSPOT_SCENE_VERSION,
    start: scene.id,
    scenes: { [scene.id]: scene },
  };
}

export function createHotspot(id: string, meta: string, rect: Rect): Hotspot {
  return {
    id,
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    label: "新热点",
    meta,
    action: { kind: "image", src: "", title: "查看" },
  };
}

export function countHotspots(config: HotspotSceneConfig | null): number {
  if (!config) return 0;
  return Object.values(config.scenes).reduce((sum, scene) => sum + scene.hotspots.length, 0);
}

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

/** 草稿字段校验；保存前仍会再用 parseHotspotScene 做最终闸门。 */
export function validateDraft(config: HotspotSceneConfig | null, options: { required?: boolean } = {}): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (!config) {
    return [{ path: "config", message: "还没有场景：请先选择或上传一张底图" }];
  }
  const sceneIds = Object.keys(config.scenes);
  if (sceneIds.length === 0) {
    issues.push({ path: "config", message: "至少需要一个场景" });
    return issues;
  }
  if (!sceneIds.includes(config.start)) {
    issues.push({ path: "config.start", message: "起始场景不存在" });
  }

  const hotspotIds = new Set<string>();
  for (const sceneId of sceneIds) {
    const scene = config.scenes[sceneId]!;
    const base = `scenes.${sceneId}`;
    if (!trimmed(scene.title)) issues.push({ path: `${base}.title`, message: "场景标题不能为空" });
    if (!trimmed(scene.image)) issues.push({ path: `${base}.image`, message: "请选择场景底图" });
    if (!(scene.width > 0) || !(scene.height > 0)) {
      issues.push({ path: `${base}.size`, message: "场景尺寸无效，请重新选择底图" });
    }
    if (scene.hotspots.length === 0) {
      issues.push({ path: `${base}.hotspots`, message: "每个场景至少需要一个热点" });
    }
    for (const hotspot of scene.hotspots) {
      const spotPath = `${base}.hotspots.${hotspot.id}`;
      if (hotspotIds.has(hotspot.id)) {
        issues.push({ path: `${spotPath}.id`, message: `热点 id「${hotspot.id}」重复` });
      }
      hotspotIds.add(hotspot.id);
      if (!trimmed(hotspot.label)) issues.push({ path: `${spotPath}.label`, message: "热点名称不能为空" });
      if (hotspot.w <= 0 || hotspot.h <= 0) {
        issues.push({ path: `${spotPath}.rect`, message: "热点尺寸必须大于 0" });
      }
      if (hotspot.x + hotspot.w > 1.0001 || hotspot.y + hotspot.h > 1.0001) {
        issues.push({ path: `${spotPath}.rect`, message: "热点超出场景边界" });
      }
      if (hotspot.action.kind === "image") {
        if (!trimmed(hotspot.action.src)) {
          issues.push({ path: `${spotPath}.src`, message: "请选择要展示的图片" });
        }
        if (!trimmed(hotspot.action.title)) {
          issues.push({ path: `${spotPath}.title`, message: "弹层标题不能为空" });
        }
      } else if (hotspot.action.sceneId === sceneId) {
        issues.push({ path: `${spotPath}.sceneId`, message: "不能跳转到当前场景" });
      } else if (!config.scenes[hotspot.action.sceneId]) {
        issues.push({ path: `${spotPath}.sceneId`, message: "目标场景不存在" });
      }
    }
  }

  if (options.required && countHotspots(config) === 0) {
    issues.push({ path: "config", message: "必答场景题至少需要一个热点" });
  }
  return issues;
}

export function issueAt(issues: DraftIssue[], path: string): string | undefined {
  return issues.find((issue) => issue.path === path)?.message;
}

export function sceneReferences(config: HotspotSceneConfig, sceneId: string): number {
  let count = 0;
  for (const scene of Object.values(config.scenes)) {
    for (const hotspot of scene.hotspots) {
      if (hotspot.action.kind === "scene" && hotspot.action.sceneId === sceneId) count += 1;
    }
  }
  return count;
}

export function imageMediaFilter(media: { mediaType?: string | null; mimeType?: string | null }): boolean {
  const type = (media.mimeType ?? "").toLowerCase();
  if (type.startsWith("image/")) return true;
  return media.mediaType === "photo";
}
