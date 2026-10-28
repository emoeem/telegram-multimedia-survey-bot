import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOTSPOT_SCENE_MAX_HOTSPOTS_PER_SCENE,
  hotspotMediaUrls,
  parseHotspotScene,
  parseHotspotSceneFromJson,
  resolveHotspotSceneRefs,
} from "../../src/survey/hotspot";
import { validateUnifiedSurvey } from "../../src/survey/validator";

const here = dirname(fileURLToPath(import.meta.url));
const contentPath = resolve(here, "../../scripts/hotspot/hotspot-survey.json");
const assetsDir = resolve(here, "../../scripts/hotspot/assets");

const content = JSON.parse(readFileSync(contentPath, "utf-8")) as {
  survey: {
    title: string;
    pages: Array<{ id: string }>;
    questions: Array<{
      id: string;
      type: string;
      required: boolean | null;
      order: number;
      page_id: string;
      options?: unknown[];
      media?: Array<{ url: string; alt?: string }>;
      settings?: Record<string, unknown>;
    }>;
  };
  mediaMeta: Record<string, { width: number; height: number; alt: string }>;
};

const sceneQuestion = content.survey.questions.find((question) => question.type === "scene");

/** 构造一个最小合法配置；用例在其上做单点变异。 */
function baseConfig(): Record<string, unknown> {
  return {
    version: 1,
    start: "room",
    scenes: {
      room: {
        id: "room",
        title: "房间",
        image: "https://cdn.example.test/room.webp",
        width: 1600,
        height: 1000,
        hotspots: [
          {
            id: "window",
            x: 0.05,
            y: 0.08,
            w: 0.3,
            h: 0.5,
            label: "窗外",
            action: { kind: "image", src: "https://cdn.example.test/window.webp", title: "窗外" },
          },
        ],
      },
    },
  };
}

describe("hotspot.ts 校验器", () => {
  it("合法配置解析成功，并保留全部字段", () => {
    const config = parseHotspotScene({ scene: baseConfig() });
    expect(config).not.toBeNull();
    expect(config!.start).toBe("room");
    expect(config!.scenes.room!.hotspots).toHaveLength(1);
    expect(hotspotMediaUrls(config!)).toEqual([
      "https://cdn.example.test/room.webp",
      "https://cdn.example.test/window.webp",
    ]);
  });

  it("接受裸配置（不带 scene 包裹）与 settings_json 文本", () => {
    expect(parseHotspotScene(baseConfig())?.start).toBe("room");
    expect(parseHotspotSceneFromJson(JSON.stringify(baseConfig()))?.start).toBe("room");
    expect(parseHotspotSceneFromJson("not json")).toBeNull();
    expect(parseHotspotSceneFromJson(null)).toBeNull();
  });

  it("拒绝：版本不符 / start 缺失 / 场景 id 非法 / 坐标越界", () => {
    const badVersion = { ...baseConfig(), version: 2 };
    expect(parseHotspotScene(badVersion)).toBeNull();

    const badStart = { ...baseConfig(), start: "nope" };
    expect(parseHotspotScene(badStart)).toBeNull();

    const badSceneId = baseConfig() as { scenes: Record<string, unknown> };
    badSceneId.scenes = { "bad id!": badSceneId.scenes.room };
    expect(parseHotspotScene(badSceneId)).toBeNull();

    const outOfBounds = baseConfig() as { scenes: Record<string, Record<string, unknown>> };
    const hotspots = [...(outOfBounds.scenes.room!.hotspots as unknown[])];
    hotspots[0] = { ...(hotspots[0] as Record<string, unknown>), x: 0.9, w: 0.5 };
    outOfBounds.scenes.room!.hotspots = hotspots;
    expect(parseHotspotScene(outOfBounds)).toBeNull();
  });

  it("拒绝：子场景引用不存在 / 热点 id 跨场景重复", () => {
    const dangling = JSON.parse(JSON.stringify(baseConfig())) as Record<string, unknown>;
    const scenes = dangling.scenes as Record<string, Record<string, unknown>>;
    scenes.shelf = {
      id: "shelf",
      title: "书架",
      image: "https://cdn.example.test/shelf.webp",
      width: 1600,
      height: 1000,
      hotspots: [
        { id: "book", x: 0.1, y: 0.3, w: 0.2, h: 0.2, label: "书", action: { kind: "scene", sceneId: "nope" } },
      ],
    };
    (scenes.room!.hotspots as unknown[]).push({
      id: "toshelf",
      x: 0.7,
      y: 0.1,
      w: 0.2,
      h: 0.3,
      label: "书架",
      action: { kind: "scene", sceneId: "shelf" },
    });
    expect(parseHotspotScene(dangling)).toBeNull();

    // 同一热点 id 出现在两个场景 = 扁平 visited 的歧义，必须拒绝。
    const duplicate = JSON.parse(JSON.stringify(dangling)) as typeof dangling;
    const dupScenes = duplicate.scenes as Record<string, Record<string, unknown>>;
    (dupScenes.shelf!.hotspots as unknown[])[0] = {
      id: "window",
      x: 0.1,
      y: 0.3,
      w: 0.2,
      h: 0.2,
      label: "书",
      action: { kind: "image", src: "https://cdn.example.test/book.webp", title: "书" },
    };
    expect(parseHotspotScene(duplicate)).toBeNull();
  });

  it("图片 URL 白名单：kv:// 占位只在导入校验时放行", () => {
    const withPlaceholder = baseConfig() as { scenes: Record<string, Record<string, unknown>> };
    withPlaceholder.scenes.room!.image = "kv://scene-room.webp";
    expect(parseHotspotScene(withPlaceholder)).toBeNull();
    expect(parseHotspotScene(withPlaceholder, { allowPlaceholderRefs: true })).not.toBeNull();

    const evil = baseConfig() as { scenes: Record<string, Record<string, unknown>> };
    evil.scenes.room!.image = "javascript:alert(1)";
    expect(parseHotspotScene(evil, { allowPlaceholderRefs: true })).toBeNull();
  });

  // 阶段 D 写侧：{assetId} 结构化引用是合法存储形态——消毒层原样保留
  // （不能转回 URL），渲染前经 resolveHotspotSceneRefs 派生。
  it("结构化 {assetId} 引用：消毒保留 + 解析派生 URL + 脏值拒绝（阶段 D）", () => {
    const structured = baseConfig() as { scenes: Record<string, Record<string, unknown>> };
    structured.scenes.room!.image = { assetId: 12 };
    (structured.scenes.room!.hotspots as { action: Record<string, unknown> }[])[0]!.action = {
      kind: "image",
      src: { assetId: 15 },
      title: "查看",
    };
    const parsed = parseHotspotScene(structured);
    expect(parsed).not.toBeNull();
    // 存储形态保持结构化（写入闸门不吞对象）。
    expect(parsed!.scenes.room!.image).toEqual({ assetId: 12 });
    expect(parsed!.scenes.room!.hotspots[0]!.action).toMatchObject({ src: { assetId: 15 } });

    // 渲染解析：{assetId} → 公开 URL；场景跳转热点原样保留。
    const resolved = resolveHotspotSceneRefs(parsed!);
    expect(resolved.scenes.room!.image).toBe("/api/survey/media/12");
    const resolvedFirst = resolved.scenes.room!.hotspots[0]!;
    if (resolvedFirst.action.kind === "image") {
      expect(resolvedFirst.action.src).toBe("/api/survey/media/15");
    } else {
      throw new Error("expected image action");
    }

    // 脏对象（非正整数 assetId）在消毒层剥掉 → 场景缺底图 → 配置整体拒绝。
    const dirty = baseConfig() as { scenes: Record<string, Record<string, unknown>> };
    dirty.scenes.room!.image = { assetId: -1 };
    expect(parseHotspotScene(dirty)).toBeNull();

    // 字符串形态不受影响：外链原样，存储不对象化。
    const external = baseConfig() as { scenes: Record<string, Record<string, unknown>> };
    external.scenes.room!.image = "https://cdn.example.test/room.webp";
    const parsedExternal = parseHotspotScene(external);
    expect(parsedExternal!.scenes.room!.image).toBe("https://cdn.example.test/room.webp");
  });

  it("hotspotMediaUrls 对 {assetId} 引用同样产出 URL 清单（阶段 D）", () => {
    const structured = baseConfig() as { scenes: Record<string, Record<string, unknown>> };
    structured.scenes.room!.image = { assetId: 12 };
    (structured.scenes.room!.hotspots as { action: Record<string, unknown> }[])[0]!.action = {
      kind: "image",
      src: { assetId: 15 },
      title: "查看",
    };
    const parsed = parseHotspotScene(structured)!;
    expect(hotspotMediaUrls(parsed)).toContain("/api/survey/media/12");
    expect(hotspotMediaUrls(parsed)).toContain("/api/survey/media/15");
  });

  it("热点数量护栏", () => {
    const crowded = baseConfig() as { scenes: Record<string, Record<string, unknown>> };
    const spots = Array.from({ length: HOTSPOT_SCENE_MAX_HOTSPOTS_PER_SCENE + 1 }, (_, i) => ({
      id: `spot${i}`,
      x: 0,
      y: 0,
      w: 0.01,
      h: 0.01,
      label: `点${i}`,
      action: { kind: "image", src: "https://cdn.example.test/x.webp", title: "x" },
    }));
    crowded.scenes.room!.hotspots = spots;
    expect(parseHotspotScene(crowded)).toBeNull();
  });
});

describe("雨夜书房 问卷定义（scripts/hotspot/hotspot-survey.json）", () => {
  it("通过 validateUnifiedSurvey 结构校验（含 kv:// 占位）", () => {
    expect(validateUnifiedSurvey(content)).toEqual([]);
  });

  it("结构：1 页 2 题，scene 题必答、尾声选填", () => {
    expect(content.survey.questions).toHaveLength(2);
    expect(content.survey.pages).toHaveLength(1);
    const [scene, farewell] = content.survey.questions;
    expect(scene!.type).toBe("scene");
    expect(scene!.required).toBe(true);
    expect(scene!.options).toEqual([]);
    expect(farewell!.type).toBe("long_text");
    expect(farewell!.required).toBe(false);
  });

  it("场景配置：2 个场景、7 个热点、id 全局唯一、子场景引用有效", () => {
    const config = parseHotspotScene(sceneQuestion!.settings, { allowPlaceholderRefs: true });
    expect(config).not.toBeNull();
    expect(Object.keys(config!.scenes)).toEqual(["room", "shelf"]);
    const allSpots = Object.values(config!.scenes).flatMap((scene) => scene.hotspots);
    expect(allSpots).toHaveLength(7);
    expect(new Set(allSpots.map((spot) => spot.id)).size).toBe(7);
    const sceneAction = allSpots.find((spot) => spot.action.kind === "scene");
    expect(
      sceneAction && sceneAction.action.kind === "scene" && config!.scenes[sceneAction.action.sceneId],
    ).toBeTruthy();
  });

  it("配置引用的每张图都作为题面媒体挂载（公开性依赖 question_media）且素材真实存在", () => {
    const config = parseHotspotScene(sceneQuestion!.settings, { allowPlaceholderRefs: true })!;
    const referenced = new Set(hotspotMediaUrls(config));
    const attached = new Set((sceneQuestion!.media ?? []).map((media) => media.url));
    for (const url of referenced) {
      expect(attached.has(url), `配置引用 ${url} 未挂到 question.media`).toBe(true);
      const slug = url.replace("kv://", "");
      expect(existsSync(join(assetsDir, slug)), `缺少素材 ${slug}`).toBe(true);
    }
    expect(attached.size).toBe(8);
  });

  it("mediaMeta 与真实文件一一对应（尺寸/alt 由导入脚本回填 media_assets）", () => {
    const meta = content.mediaMeta;
    expect(Object.keys(meta)).toHaveLength(8);
    for (const [slug, entry] of Object.entries(meta)) {
      expect(entry.alt.trim()).toBeTruthy();
      expect(entry.width).toBeGreaterThan(0);
      expect(entry.height).toBeGreaterThan(0);
      expect(existsSync(join(assetsDir, slug)), `mediaMeta 指向不存在的 ${slug}`).toBe(true);
    }
  });

  it("每张题面媒体都有非空 alt（无障碍兜底文案）", () => {
    for (const media of sceneQuestion!.media ?? []) {
      expect(media.alt?.trim() ?? "", `${media.url} 缺 alt`).toBeTruthy();
    }
  });
});
