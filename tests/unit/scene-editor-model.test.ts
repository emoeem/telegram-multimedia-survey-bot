import { describe, expect, it } from "vitest";
import {
  adminMediaUrl,
  clampRect,
  createConfigWithScene,
  createEmptyScene,
  createHotspot,
  imageMediaFilter,
  issueAt,
  mediaIdFromUrl,
  moveRect,
  nextHotspotId,
  nextHotspotMeta,
  nextSceneId,
  normalizeRect,
  publicMediaUrl,
  resizeRect,
  sceneReferences,
  transformConfigForPreview,
  validateDraft,
  type Rect,
} from "../../admin/src/scene-editor/model";
import type { HotspotSceneConfig } from "../../src/survey/hotspot";

const BASE_RECT: Rect = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };

function validConfig(): HotspotSceneConfig {
  return {
    version: 1,
    start: "room",
    scenes: {
      room: {
        id: "room",
        title: "房间",
        image: publicMediaUrl(1),
        width: 1600,
        height: 1000,
        hotspots: [
          {
            id: "window",
            x: 0.1,
            y: 0.1,
            w: 0.3,
            h: 0.4,
            label: "窗外",
            action: { kind: "image", src: publicMediaUrl(2), title: "窗外" },
          },
          {
            id: "shelf",
            x: 0.7,
            y: 0.1,
            w: 0.2,
            h: 0.4,
            label: "书架",
            action: { kind: "scene", sceneId: "shelf" },
          },
        ],
      },
      shelf: {
        id: "shelf",
        title: "书架",
        image: publicMediaUrl(3),
        width: 1600,
        height: 1000,
        hotspots: [
          {
            id: "book",
            x: 0.2,
            y: 0.2,
            w: 0.2,
            h: 0.2,
            label: "旧书",
            action: { kind: "image", src: publicMediaUrl(4), title: "旧书" },
          },
        ],
      },
    },
  };
}

describe("矩形几何", () => {
  it("反向拖拽也能得到正向归一化矩形", () => {
    const rect = normalizeRect({ x: 0.6, y: 0.5 }, { x: 0.2, y: 0.1 });
    expect(rect.x).toBeCloseTo(0.2, 6);
    expect(rect.y).toBeCloseTo(0.1, 6);
    expect(rect.w).toBeCloseTo(0.4, 6);
    expect(rect.h).toBeCloseTo(0.4, 6);
  });

  it("越界坐标被夹紧，极小拖拽保底为最小尺寸", () => {
    const rect = normalizeRect({ x: -0.2, y: 0.95 }, { x: 0.001, y: 1.3 });
    expect(rect.x).toBe(0);
    expect(rect.y).toBeCloseTo(0.95, 5);
    expect(rect.w).toBeGreaterThan(0);
    expect(rect.h).toBeCloseTo(0.05, 5);
  });

  it("移动时整体夹在画布内", () => {
    expect(moveRect({ x: 0.9, y: 0.9, w: 0.2, h: 0.2 }, 0.5, 0.5)).toEqual({
      x: 0.8,
      y: 0.8,
      w: 0.2,
      h: 0.2,
    });
    expect(moveRect(BASE_RECT, -1, -1)).toEqual({ x: 0, y: 0, w: 0.4, h: 0.4 });
  });

  it("八个方向缩放都保持对边不动、不越界、不小于最小尺寸", () => {
    const east = resizeRect(BASE_RECT, "e", 0.1, 0);
    expect(east.x).toBeCloseTo(0.2, 6);
    expect(east.w).toBeCloseTo(0.5, 6);

    const west = resizeRect(BASE_RECT, "w", 0.1, 0);
    expect(west.x).toBeCloseTo(0.3, 6);
    expect(west.w).toBeCloseTo(0.3, 6);

    const northWest = resizeRect(BASE_RECT, "nw", 0.1, 0.1);
    expect(northWest.x).toBeCloseTo(0.3, 6);
    expect(northWest.y).toBeCloseTo(0.3, 6);
    expect(northWest.w).toBeCloseTo(0.3, 6);
    expect(northWest.h).toBeCloseTo(0.3, 6);

    const shrunk = resizeRect(BASE_RECT, "se", -0.5, -0.5);
    expect(shrunk.w).toBeCloseTo(0.01, 6);
    expect(shrunk.h).toBeCloseTo(0.01, 6);
    expect(shrunk.x).toBeCloseTo(0.2, 6);
  });

  it("clampRect 修正负数/超界尺寸", () => {
    expect(clampRect({ x: 2, y: -1, w: 2, h: -3 })).toEqual({ x: 0, y: 0, w: 1, h: 0.01 });
  });
});

describe("id 与媒体 URL", () => {
  it("场景 id 从 scene-1 起递增；热点 id 从 h1 起递增且跳过已用", () => {
    const config = validConfig();
    expect(nextSceneId(config)).toBe("scene-1");
    expect(nextHotspotId(config)).toBe("h1");
    const withH1 = {
      ...config,
      scenes: {
        ...config.scenes,
        room: {
          ...config.scenes.room!,
          hotspots: [...config.scenes.room!.hotspots, createHotspot("h1", "04", BASE_RECT)],
        },
      },
    };
    expect(nextHotspotId(withH1)).toBe("h2");
  });

  it("热点编号避开已用值", () => {
    const scene = validConfig().scenes.room!;
    expect(nextHotspotMeta(scene)).toBe("03");
    const withMeta = { ...scene, hotspots: [...scene.hotspots, { ...scene.hotspots[0]!, id: "x", meta: "03" }] };
    expect(nextHotspotMeta(withMeta)).toBe("04");
  });

  it("公开/admin 两种媒体 URL 都能解析出 id，外部 URL 返回 null", () => {
    expect(mediaIdFromUrl(publicMediaUrl(42))).toBe(42);
    expect(mediaIdFromUrl(adminMediaUrl(42))).toBe(42);
    expect(mediaIdFromUrl("https://cdn.example.test/a.webp")).toBeNull();
    expect(mediaIdFromUrl(null)).toBeNull();
  });

  it("预览配置把公开 URL 换成 admin URL，外部 URL 原样保留", () => {
    const config = validConfig();
    config.scenes.room!.hotspots[0]!.action = {
      kind: "image",
      src: "https://cdn.example.test/raw.webp",
      title: "外部",
    };
    const preview = transformConfigForPreview(config);
    expect(preview.scenes.room!.image).toBe(adminMediaUrl(1));
    expect(preview.scenes.shelf!.hotspots[0]!.action).toMatchObject({ src: adminMediaUrl(4) });
    expect(preview.scenes.room!.hotspots[0]!.action).toMatchObject({
      src: "https://cdn.example.test/raw.webp",
    });
    // 原配置不被修改
    expect(config.scenes.room!.image).toBe(publicMediaUrl(1));
  });

  it("只有图片媒体能进选择器", () => {
    expect(imageMediaFilter({ mediaType: "photo" })).toBe(true);
    expect(imageMediaFilter({ mimeType: "image/webp" })).toBe(true);
    expect(imageMediaFilter({ mediaType: "audio", mimeType: "audio/mpeg" })).toBe(false);
    expect(imageMediaFilter({})).toBe(false);
  });
});

describe("草稿校验", () => {
  it("完整配置没有错误", () => {
    expect(validateDraft(validConfig())).toEqual([]);
  });

  it("空配置/空场景给出可定位的错误", () => {
    expect(validateDraft(null)[0]?.path).toBe("config");
    const config = validConfig();
    config.scenes.room!.hotspots = [];
    const issues = validateDraft(config);
    expect(issueAt(issues, "scenes.room.hotspots")).toContain("至少需要一个热点");
  });

  it("缺底图/缺图片动作/悬空子场景/重复 id 都会报错", () => {
    const config = validConfig();
    config.scenes.room!.image = "";
    config.scenes.room!.hotspots[0]!.action = { kind: "image", src: "", title: "" };
    config.scenes.room!.hotspots[1]!.action = { kind: "scene", sceneId: "nope" };
    config.scenes.shelf!.hotspots[0]!.id = "window";
    const issues = validateDraft(config);
    expect(issueAt(issues, "scenes.room.image")).toBeTruthy();
    expect(issueAt(issues, "scenes.room.hotspots.window.src")).toBeTruthy();
    expect(issueAt(issues, "scenes.room.hotspots.window.title")).toBeTruthy();
    expect(issueAt(issues, "scenes.room.hotspots.shelf.sceneId")).toBeTruthy();
    expect(issueAt(issues, "scenes.shelf.hotspots.window.id")).toContain("重复");
  });

  it("越界热点与空标题会报错", () => {
    const config = validConfig();
    config.scenes.room!.title = "  ";
    config.scenes.room!.hotspots[0]!.x = 0.9;
    config.scenes.room!.hotspots[0]!.w = 0.2;
    const issues = validateDraft(config);
    expect(issueAt(issues, "scenes.room.title")).toBeTruthy();
    expect(issueAt(issues, "scenes.room.hotspots.window.rect")).toContain("超出");
  });

  it("必答题没有热点时阻断保存", () => {
    const config = validConfig();
    config.scenes.room!.hotspots = [];
    config.scenes.shelf!.hotspots = [];
    expect(validateDraft(config, { required: true }).some((issue) => issue.message.includes("必答"))).toBe(true);
  });

  it("子场景引用计数用于删除保护", () => {
    const config = validConfig();
    expect(sceneReferences(config, "shelf")).toBe(1);
    expect(sceneReferences(config, "room")).toBe(0);
  });

  it("从底图创建配置时以该场景为起点", () => {
    const scene = { ...createEmptyScene("scene-1", "场景 1"), image: publicMediaUrl(9), width: 800, height: 600 };
    const config = createConfigWithScene(scene);
    expect(config.start).toBe("scene-1");
    expect(config.scenes["scene-1"]!.width).toBe(800);
  });
});
