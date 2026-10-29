import { unzipSync } from "fflate";
import type { Env } from "../../index";
import { createMediaStore } from "../../services/media/temporary-media-store";
import { storeDeduplicatedMedia } from "../../services/media/media-dedup.service";
import { createTaskPack } from "../../db/repositories/task-pack.repository";
import { writeAudit } from "./helpers";
import type { WriteContext } from "./helpers";
import { gamePluginRegistry } from "../../game-plugin/registry";
import { parseQuestContent, QUEST_LIMITS, type QuestContent } from "../../game-plugin/plugins/quest/content";

/**
 * 小游戏扩展包导入器（2026-10-29）。
 *
 * 扩展包 = 一个 ZIP：
 *   manifest.json   包元信息（formatVersion/id/title/author/description/adult）
 *   quest.json      游戏内容（见 src/game-plugin/plugins/quest/content.ts 的格式）
 *   assets/*        可选图片（≤20 张、单张 ≤2MB）；内容里用 `asset:<文件名>` 引用
 *
 * 导入 = 解压 → 校验 → 图片入素材库（内容寻址去重）→ 引用替换为公开 URL →
 * 生成一个 game_type="quest" 的任务包。之后这个游戏就是纯数据行，
 * 改内容 = 重新导入，**全程不改代码**。
 */

export const QUEST_PACK_FORMAT_VERSION = 1 as const;
const PACK_MAX_BYTES = 8 * 1024 * 1024;
const ASSET_MAX_BYTES = 2 * 1024 * 1024;
const ASSET_MAX_COUNT = 20;
const ASSET_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export interface ParsedQuestPack {
  manifest: {
    formatVersion: number;
    id: string;
    title: string;
    author: string;
    description: string;
    adult: boolean;
  };
  content: QuestContent;
  /** 内容里的 `asset:<name>` 引用清单（导入 HTTP 层负责替换为真实 URL）。 */
  assetNames: string[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * 纯解析：ZIP 字节 → 结构化包。不碰数据库 / KV，可单测。
 * 抛错信息面向管理员（400 直出）。
 */
export function parseQuestPackBundle(zipBytes: Uint8Array): ParsedQuestPack {
  if (zipBytes.byteLength === 0) throw new Error("扩展包文件为空");
  if (zipBytes.byteLength > PACK_MAX_BYTES) throw new Error(`扩展包不能超过 ${PACK_MAX_BYTES / 1024 / 1024}MB`);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch {
    throw new Error("无法解压扩展包（需要标准 ZIP 格式）");
  }
  const pick = (name: string): Uint8Array | undefined => {
    if (entries[name]) return entries[name];
    const match = Object.keys(entries).find((key) => key === name || key.endsWith(`/${name}`));
    return match ? entries[match] : undefined;
  };

  const manifestBytes = pick("manifest.json");
  if (!manifestBytes) throw new Error("扩展包缺少 manifest.json");
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error("manifest.json 不是合法 JSON");
  }
  const manifest = asObject(manifestRaw);
  if (!manifest) throw new Error("manifest.json 必须是 JSON 对象");
  if (manifest.formatVersion !== QUEST_PACK_FORMAT_VERSION) {
    throw new Error(`扩展包格式版本必须是 ${QUEST_PACK_FORMAT_VERSION}（收到 ${String(manifest.formatVersion)}）`);
  }
  const id = textOf(manifest.id, 32);
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
    throw new Error(`manifest.id 不合法（小写字母/数字开头，≤32 位）：${id || "（空）"}`);
  }
  const title = textOf(manifest.title, 60);
  if (!title) throw new Error("manifest.title 不能为空");

  const questBytes = pick("quest.json");
  if (!questBytes) throw new Error("扩展包缺少 quest.json");
  if (questBytes.byteLength > 512 * 1024) throw new Error("quest.json 超过 512KB 上限");
  let questRaw: unknown;
  try {
    questRaw = JSON.parse(new TextDecoder().decode(questBytes));
  } catch {
    throw new Error("quest.json 不是合法 JSON");
  }
  const { content, issues } = parseQuestContent(questRaw);
  if (!content) {
    const detail = issues
      .filter((issue) => issue.severity === "error")
      .slice(0, 5)
      .map((issue) => issue.message);
    throw new Error(`quest.json 校验失败：${detail.join("；")}`);
  }

  // assets 盘点（只认 assets/ 目录下的白名单扩展名）
  const assetNames: string[] = [];
  for (const [path, bytes] of Object.entries(entries)) {
    const normalized = path.replace(/\\/g, "/");
    if (!normalized.startsWith("assets/") || normalized.endsWith("/")) continue;
    const fileName = normalized.slice("assets/".length);
    if (fileName.includes("/")) continue;
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    if (!ASSET_MIME[ext]) continue; // 非图片资源直接忽略（不是错误）
    if (bytes.byteLength > ASSET_MAX_BYTES) {
      throw new Error(`assets/${fileName} 超过 2MB 上限`);
    }
    assetNames.push(fileName);
  }
  if (assetNames.length > ASSET_MAX_COUNT) {
    throw new Error(`assets 图片数量超过 ${ASSET_MAX_COUNT} 上限`);
  }
  // 内容里引用到的 asset 必须真实存在
  const referenced = new Set<string>();
  for (const node of content.nodes) {
    const match = node.image?.match(/^asset:(.+)$/);
    if (match) referenced.add(match[1]!);
  }
  for (const name of referenced) {
    if (!assetNames.includes(name)) {
      throw new Error(`quest.json 引用了 assets/${name}，但包里没有这个文件`);
    }
  }

  return {
    manifest: {
      formatVersion: QUEST_PACK_FORMAT_VERSION,
      id,
      title,
      author: textOf(manifest.author, 40),
      description: textOf(manifest.description, 300),
      adult: manifest.adult === true,
    },
    content,
    assetNames,
  };
}

/** 内容里的 `asset:<name>` → 上传后的公开 URL。 */
function resolveAssetRefs(content: QuestContent, urlByName: Map<string, string>): QuestContent {
  return {
    ...content,
    nodes: content.nodes.map((node) =>
      node.image?.startsWith("asset:")
        ? { ...node, image: urlByName.get(node.image.slice("asset:".length)) ?? node.image }
        : node,
    ),
  };
}

export async function handleQuestPackImport(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
): Promise<Response | null> {
  if (request.method !== "POST" || url.pathname !== "/api/admin/task-packs/import") return null;
  const { user, isAdmin, fail: ctxFail, json: ctxJson } = ctx;
  if (!isAdmin) return ctxFail(403, "forbidden", "仅管理员可导入扩展包");

  let zipBytes: Uint8Array;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File))
      return ctxFail(400, "validation_failed", "请以 multipart/form-data 上传扩展包 ZIP（字段名 file）");
    zipBytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return ctxFail(400, "validation_failed", "无法读取上传内容（需要 multipart/form-data）");
  }

  let pack: ParsedQuestPack;
  try {
    pack = parseQuestPackBundle(zipBytes);
  } catch (error) {
    return ctxFail(400, "validation_failed", error instanceof Error ? error.message : "扩展包解析失败");
  }

  // 图片入素材库（内容寻址去重：同图只存一份）。
  const urlByName = new Map<string, string>();
  if (pack.assetNames.length > 0) {
    const entries = unzipSync(zipBytes);
    const store = createMediaStore({ MEDIA: env.MEDIA, MEDIA_KV: env.MEDIA_KV });
    for (const name of pack.assetNames) {
      const entryKey = Object.keys(entries).find((key) => key === `assets/${name}` || key.endsWith(`/assets/${name}`));
      if (!entryKey) continue;
      const bytes = entries[entryKey]!;
      const ext = name.split(".").pop()?.toLowerCase() ?? "png";
      const { asset } = await storeDeduplicatedMedia(env.DB, store, {
        bytes,
        mimeType: ASSET_MIME[ext] ?? "image/png",
        mediaType: "photo",
        fileName: name,
      });
      urlByName.set(name, `/api/survey/media/${asset.id}`);
    }
  }

  const content = resolveAssetRefs(pack.content, urlByName);
  const settings = {
    content: JSON.stringify(content),
    packId: pack.manifest.id,
    adult: pack.manifest.adult,
    cover: null,
  };
  // 走注册表闸门（Schema 归一化），保证与后台手工建包同一套安全边界。
  const validated = gamePluginRegistry.validateConfig("quest", settings);
  const blocking = validated.issues.filter((issue) => issue.severity === "error");
  if (blocking.length > 0) {
    return ctxFail(400, "validation_failed", blocking.map((issue) => issue.message).join("；"));
  }

  const created = await createTaskPack(env.DB, {
    name: pack.manifest.title.slice(0, 60),
    description: (pack.manifest.description || `扩展包 ${pack.manifest.id}（${pack.content.nodes.length} 节点）`).slice(
      0,
      300,
    ),
    gameType: "quest",
    settings: validated.config,
    items: [],
  });
  await writeAudit(env.DB, {
    actorUserId: user.id,
    action: "task_pack.import",
    entityType: "task_pack",
    entityId: String(created.id),
    after: {
      name: created.name,
      packId: pack.manifest.id,
      nodes: pack.content.nodes.length,
      items: pack.content.items.length,
      assets: urlByName.size,
    },
  });
  return ctxJson({
    pack: created,
    stats: {
      nodes: pack.content.nodes.length,
      items: pack.content.items.length,
      assets: urlByName.size,
      limits: QUEST_LIMITS,
    },
  });
}
