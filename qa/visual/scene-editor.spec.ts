import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { scanA11y } from "./a11y";

/**
 * 场景编辑器（/admin/surveys/:id/scene/:qid）的交互回归。
 *
 * 全部 /api/** 被 mock：编辑器读的是 GET /editor（草稿、0 答卷、editable），
 * 保存是 PATCH /questions/:qid，上传是 POST /questions/:qid/media。图片走
 * qa/fixtures/hotspot/ 的真实 WebP，通过 /api/admin/media/<id>/image 提供。
 *
 * 覆盖：拖拽新建 → 选图 → 保存 payload；移动/缩放/方向键；加场景/设起始/
 * scene 动作；上传后 baseUpdatedAt 刷新；只读；409 重新加载；axe；1440/390
 * 无横向溢出。
 */

const SURVEY_ID = 1;
const QUESTION_ID = 10;
const ARTIFACTS = "qa/artifacts/scene-editor";

// 热点有 0.4s 的淡入 + 脉冲动画；截图必须等到终态，否则截到 opacity:0 的首帧。
test.use({ reducedMotion: "reduce" });

const now = "2026-10-27T10:00:00Z";
const TELEGRAM_STUB = `
window.Telegram = {
  WebApp: {
    initData: "",
    ready() {},
    expand() {},
    close() {},
    setHeaderColor() {},
    setBottomBarColor() {},
    requestTheme() {},
    requestViewport() {},
    requestSafeArea() {},
    requestContentSafeArea() {}
  }
};
`;

/** 每个媒体 id 对应一张真实图片；905 留给上传用例。 */
const MEDIA_FILES: Record<number, string> = {
  900: "scene-room.webp",
  901: "scene-shelf.webp",
  902: "detail-window.webp",
  903: "detail-cat.webp",
  904: "detail-book.webp",
  905: "detail-plant.webp",
};

const MEDIA_REFS = [
  { mediaAssetId: 900, mediaType: "photo", fileName: "scene-room.webp", mimeType: "image/webp" },
  { mediaAssetId: 901, mediaType: "photo", fileName: "scene-shelf.webp", mimeType: "image/webp" },
  { mediaAssetId: 902, mediaType: "photo", fileName: "detail-window.webp", mimeType: "image/webp" },
  { mediaAssetId: 903, mediaType: "photo", fileName: "detail-cat.webp", mimeType: "image/webp" },
  { mediaAssetId: 904, mediaType: "photo", fileName: "detail-book.webp", mimeType: "image/webp" },
];

/**
 * 种子配置故意用**旧形态**（公开 URL `/api/survey/media/<id>`）——读侧双读必须
 * 兼容存量数据。写侧（阶段 D）保存时一律改成 `{assetId}`，因此下面的保存断言
 * 期待结构化形态；编辑器里的显示仍映射为 admin URL（/api/admin/media/<id>/image）。
 */
const SCENE = {
  version: 1,
  start: "room",
  scenes: {
    room: {
      id: "room",
      title: "雨夜书房",
      intro: "点击发亮的区域。",
      image: "/api/survey/media/900",
      width: 1600,
      height: 1000,
      alt: "雨夜书房全景",
      hotspots: [
        {
          id: "h1",
          x: 0.05,
          y: 0.08,
          w: 0.31,
          h: 0.58,
          label: "窗外",
          meta: "01",
          action: {
            kind: "image",
            src: "/api/survey/media/902",
            title: "窗外",
            caption: "雨没有停。",
          },
        },
        {
          id: "h2",
          x: 0.835,
          y: 0.08,
          w: 0.15,
          h: 0.5,
          label: "书架",
          meta: "02",
          action: { kind: "scene", sceneId: "shelf" },
        },
      ],
    },
    shelf: {
      id: "shelf",
      title: "书架 · 第二层",
      image: "/api/survey/media/901",
      width: 1600,
      height: 1000,
      hotspots: [
        {
          id: "h3",
          x: 0.2,
          y: 0.3,
          w: 0.12,
          h: 0.24,
          label: "旧书",
          meta: "01",
          action: { kind: "image", src: "/api/survey/media/904", title: "旧书" },
        },
      ],
    },
  },
};

type JsonRecord = Record<string, unknown>;

interface SceneMockState {
  patches: JsonRecord[];
  uploads: string[];
  editorRequests: number;
  editable: boolean;
  status: string;
  responseCount: number;
  conflictOnce: boolean;
  serverVersion: number;
  baseUpdatedAt: string;
  questionTitle: string;
}

function editorPayload(state: SceneMockState) {
  return {
    survey: {
      id: SURVEY_ID,
      title: "雨夜书房（草稿）",
      description: "场景编辑器回归用问卷",
      status: state.status,
      anonymous: false,
      allowMultipleResponses: false,
      maxResponsesPerUser: 1,
      version: 1,
      createdAt: now,
      updatedAt: state.baseUpdatedAt,
      responseCount: state.responseCount,
      questionCount: 1,
      editable: state.editable,
      reportTemplateId: null,
      contentRating: "all",
      theme: { preset: "foxgold" },
    },
    questions: [
      {
        id: QUESTION_ID,
        type: "scene",
        title: state.serverVersion >= 2 ? "服务端的新标题" : state.questionTitle,
        description: state.serverVersion >= 2 ? "另一个页面保存过这一题。" : "点击发亮的区域。",
        required: true,
        order: 0,
        pageId: null,
        settings: { scene: JSON.parse(JSON.stringify(SCENE)) },
        validation: null,
        condition: null,
        media: MEDIA_REFS,
        options: [],
      },
    ],
    pages: [],
  };
}

/**
 * 装好所有 admin 依赖端点。返回可变的 state：只读/答卷数可以在用例中途改，
 * 再 reload 就能验证不同锁定原因。
 */
async function mockSceneApi(page: Page): Promise<SceneMockState> {
  const state: SceneMockState = {
    patches: [],
    uploads: [],
    editorRequests: 0,
    editable: true,
    status: "draft",
    responseCount: 0,
    conflictOnce: false,
    serverVersion: 1,
    baseUpdatedAt: now,
    questionTitle: "探索这间书房",
  };
  const editorPath = `/api/admin/surveys/${SURVEY_ID}/editor`;
  const questionPath = `/api/admin/surveys/${SURVEY_ID}/questions/${QUESTION_ID}`;

  await page.addInitScript(TELEGRAM_STUB);
  await page.route("**://telegram.org/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: TELEGRAM_STUB }),
  );
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    const mediaMatch = path.match(/^\/api\/admin\/media\/(\d+)\/image$/);
    if (mediaMatch) {
      const file = MEDIA_FILES[Number(mediaMatch[1])];
      if (!file) return route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
      return route.fulfill({ path: resolve("qa/fixtures/hotspot", file), contentType: "image/webp" });
    }

    if (path === "/api/admin/session") {
      return json({ ok: true, role: "admin", userId: 1, telegramUserId: 1 });
    }
    if (path === "/api/admin/deployment") return json({ licenseCenter: false });
    if (path === "/api/admin/environment") return json({ environment: "production" });

    if (path === editorPath && method === "GET") {
      state.editorRequests += 1;
      return json(editorPayload(state));
    }
    if (path === questionPath && method === "PATCH") {
      const body = request.postDataJSON() as JsonRecord;
      state.patches.push(body);
      if (state.conflictOnce) {
        state.conflictOnce = false;
        state.serverVersion = 2;
        return json({ error: "conflict", message: "问卷已被其他页面修改" }, 409);
      }
      state.baseUpdatedAt = `2026-10-27T10:${String(state.patches.length).padStart(2, "0")}:00Z`;
      return json({ ok: true, updatedAt: state.baseUpdatedAt });
    }
    if (path === `${questionPath}/media` && method === "POST") {
      state.uploads.push(request.headers()["content-type"] ?? "");
      return json({
        mediaAssetId: 905,
        mediaType: "photo",
        fileName: "detail-plant.webp",
        mimeType: "image/webp",
        // 上传会 touch 问卷；编辑器必须用它刷新 baseUpdatedAt，否则下次 PATCH 409。
        updatedAt: "2026-10-27T11:30:00Z",
      });
    }
    return json({});
  });
  return state;
}

async function canvasBox(page: Page) {
  const box = await page.locator(".scene-canvas").boundingBox();
  expect(box, "场景画布必须可见").not.toBeNull();
  return box!;
}

/** 按 0..1 的归一化坐标在画布上拖一条线（新建热点）。 */
async function dragOnCanvas(page: Page, from: [number, number], to: [number, number]) {
  const box = await canvasBox(page);
  const x1 = box.x + box.width * from[0];
  const y1 = box.y + box.height * from[1];
  const x2 = box.x + box.width * to[0];
  const y2 = box.y + box.height * to[1];
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 8 });
  await page.mouse.up();
}

async function spotRect(page: Page, id: string) {
  return page.locator(`[data-hotspot-id="${id}"]`).evaluate((element) => {
    const style = (element as HTMLElement).style;
    return {
      left: Number.parseFloat(style.left),
      top: Number.parseFloat(style.top),
      width: Number.parseFloat(style.width),
      height: Number.parseFloat(style.height),
    };
  });
}

async function openEditor(page: Page) {
  // 热点有 0.4s 淡入 + 脉冲；截图/断言等的是终态，不是动画首帧。
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/admin/surveys/${SURVEY_ID}/scene/${QUESTION_ID}`, { waitUntil: "networkidle" });
  await expect(page.locator(".scene-canvas")).toBeVisible();
  // 图片路由必须真的返回了 WebP，而不是 404 占位。
  await expect
    .poll(() => page.locator(".scene-canvas-image").evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
}

function savedHotspots(patch: JsonRecord): JsonRecord[] {
  const settings = patch.settings as { scene?: { scenes: Record<string, { hotspots: JsonRecord[] }> } };
  const scenes = settings.scene?.scenes ?? {};
  return Object.values(scenes).flatMap((scene) => scene.hotspots);
}

test.beforeAll(() => {
  mkdirSync(ARTIFACTS, { recursive: true });
});

test("拖拽新建热点 → 选图 → 保存写回完整场景配置", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await mockSceneApi(page);
  await openEditor(page);
  await expect(page.locator(".scene-canvas-spot")).toHaveCount(2);

  await scanA11y(page, `${testInfo.title} · 编辑器`);
  await page.screenshot({ path: `${ARTIFACTS}/editor-1440.png` });

  // 预览：复用参与者看到的 HotspotScene，Escape 关闭。
  await page.getByRole("button", { name: "预览" }).click();
  await expect(page.locator(".scene-editor-preview")).toBeVisible();
  await expect(page.locator(".scene-editor-preview .hotspot-spot")).toHaveCount(2);
  // 预览把配置里的公开 URL 映射回 admin URL，并渲染 scene.intro。
  await expect(page.locator(".scene-editor-preview .hotspot-stage img")).toHaveAttribute(
    "src",
    /\/api\/admin\/media\/900\/image$/,
  );
  await expect(page.locator(".scene-editor-preview .hotspot-intro")).toHaveText("点击发亮的区域。");
  // 等淡入结束再截图（reducedMotion 下这是 0.001ms，普通环境是 0.4s）。
  await expect
    .poll(() =>
      page
        .locator(".scene-editor-preview .hotspot-spot")
        .first()
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)),
    )
    .toBeGreaterThan(0.99);
  await page.screenshot({ path: `${ARTIFACTS}/preview.png` });
  await page.keyboard.press("Escape");
  await expect(page.locator(".scene-editor-preview")).toBeHidden();

  // 空白处拖拽 → 新热点（label 默认「新热点」，meta 顺延 03）。
  await dragOnCanvas(page, [0.42, 0.7], [0.62, 0.92]);
  await expect(page.locator(".scene-canvas-spot")).toHaveCount(3);
  await expect(page.locator(".scene-editor-inspector")).toContainText("新热点");
  await expect(page.getByLabel("名称", { exact: true })).toHaveValue("新热点");
  await expect(page.locator(".scene-editor-code").first()).toContainText("id: h4");

  await page.getByLabel("名称", { exact: true }).fill("台灯");
  await page.getByRole("button", { name: "选择图片" }).click();
  await expect(page.locator(".scene-editor-media-picker")).toBeVisible();
  await expect(page.locator(".scene-editor-media-item")).toHaveCount(5);
  await page.locator(".scene-editor-media-item", { hasText: "detail-cat.webp" }).click();
  await expect(page.locator(".scene-editor-media-picker")).toBeHidden();
  await expect(page.locator(".scene-editor-image-row img")).toHaveAttribute("src", /\/api\/admin\/media\/903\/image$/);

  await page.getByLabel("弹层标题", { exact: true }).fill("台灯");
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
  await expect(page.locator(".scene-editor-dirty")).toBeVisible();

  await page.getByRole("button", { name: "保存" }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  const patch = state.patches[0]!;
  expect(patch).toMatchObject({
    title: "探索这间书房",
    description: "点击发亮的区域。",
    required: true,
    baseUpdatedAt: now,
  });
  const hotspots = savedHotspots(patch);
  // room 3 个（含新建的台灯）+ shelf 1 个。
  expect(hotspots).toHaveLength(4);
  const roomHotspots = (patch.settings as { scene: { scenes: Record<string, { hotspots: JsonRecord[] }> } }).scene
    .scenes["room"]!.hotspots;
  expect(roomHotspots).toHaveLength(3);
  const lamp = hotspots.find((hotspot) => hotspot.label === "台灯");
  expect(lamp, "新热点必须写进 settings.scene").toMatchObject({
    id: "h4",
    meta: "03",
    action: { kind: "image", src: { assetId: 903 }, title: "台灯" },
  });

  // 保存成功后基线更新：未保存标记消失，按钮回到禁用。
  await expect(page.locator(".scene-editor-dirty")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  await page.screenshot({ path: `${ARTIFACTS}/editor-saved.png` });
});

test("拖动移动、角柄缩放与方向键微调都写回同一个矩形", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await mockSceneApi(page);
  await openEditor(page);

  await page.locator(".scene-editor-hotspot", { hasText: "窗外" }).click();
  const spot = page.locator('[data-hotspot-id="h1"]');
  await expect(spot).toHaveClass(/is-selected/);
  const before = await spotRect(page, "h1");

  // 方向键：每步 0.005（百分比 0.5）。
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const nudged = await spotRect(page, "h1");
  expect(nudged.left).toBeCloseTo(before.left + 1, 1);
  expect(nudged.top).toBeCloseTo(before.top + 0.5, 1);
  expect(nudged.width).toBeCloseTo(before.width, 3);

  // 拖动热点本体：中心 +40/+24 px。
  const box = await spot.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 40, box!.y + box!.height / 2 + 24, { steps: 6 });
  await page.mouse.up();
  const moved = await spotRect(page, "h1");
  expect(moved.left).toBeGreaterThan(nudged.left + 2);
  expect(moved.top).toBeGreaterThan(nudged.top + 1);
  expect(moved.width).toBeCloseTo(nudged.width, 1);

  // 右下角柄缩放：+40/+30 px。
  const handle = page.locator(".scene-canvas-spot.is-selected .scene-canvas-handle.is-se");
  await expect(handle).toBeVisible();
  const handleBox = await handle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 40, handleBox!.y + handleBox!.height / 2 + 30, {
    steps: 6,
  });
  await page.mouse.up();
  const resized = await spotRect(page, "h1");
  expect(resized.width).toBeGreaterThan(moved.width + 2);
  expect(resized.height).toBeGreaterThan(moved.height + 2);
  expect(resized.left).toBeCloseTo(moved.left, 1);
  expect(resized.top).toBeCloseTo(moved.top, 1);

  await page.getByRole("button", { name: "保存" }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  const h1 = savedHotspots(state.patches[0]!).find((hotspot) => hotspot.id === "h1")!;
  expect(h1.x).toBeCloseTo(resized.left / 100, 3);
  expect(h1.y).toBeCloseTo(resized.top / 100, 3);
  expect(h1.w).toBeCloseTo(resized.width / 100, 3);
  expect(h1.h).toBeCloseTo(resized.height / 100, 3);
});

test("新增场景、设起始、场景跳转动作一起保存", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await mockSceneApi(page);
  await openEditor(page);

  await page.locator(".scene-editor-section").first().getByRole("button", { name: "新增" }).click();
  await expect(page.locator(".scene-editor-scene")).toHaveCount(3);
  await expect(page.locator(".scene-editor-scene.is-active")).toContainText("场景 3");
  await expect(page.locator(".scene-canvas-empty")).toBeVisible();

  await page.getByRole("button", { name: "选择或上传底图" }).click();
  await page.locator(".scene-editor-media-item", { hasText: "scene-shelf.webp" }).click();
  await expect(page.locator(".scene-editor-media-picker")).toBeHidden();
  await expect(page.locator(".scene-canvas")).toBeVisible();
  // 底图尺寸从图片自然尺寸回填（1600×1000）。
  await expect(page.locator(".scene-editor-meta-line")).toContainText("1600 × 1000 px");

  await page.getByLabel("场景标题", { exact: true }).fill("书房角落");
  await page.getByRole("button", { name: "设为起始场景" }).click();
  await expect(page.locator(".scene-editor-scene.is-active")).toContainText("起始");

  await dragOnCanvas(page, [0.5, 0.5], [0.7, 0.7]);
  await expect(page.locator(".scene-canvas-spot")).toHaveCount(1);
  await page.getByLabel("名称", { exact: true }).fill("暗门");
  // select 的 label 文本包含 option 文案，不能用 exact 匹配。
  await page.getByRole("combobox", { name: /点击后/ }).selectOption("scene");
  await page.getByRole("combobox", { name: /目标场景/ }).selectOption("shelf");
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
  await page.getByRole("button", { name: "保存" }).click();

  await expect.poll(() => state.patches.length).toBe(1);
  const patch = state.patches[0]!;
  const scene = (patch.settings as { scene: { start: string; scenes: Record<string, JsonRecord> } }).scene;
  expect(scene.start, "起始场景必须切到新场景").toBe("scene-1");
  const added = scene.scenes["scene-1"] as unknown as {
    title: string;
    image: string;
    width: number;
    height: number;
    hotspots: JsonRecord[];
  };
  expect(added.title).toBe("书房角落");
  // 阶段 D 写侧：从素材库选图存 {assetId}（并登记 question_media）。
  expect(added.image).toEqual({ assetId: 901 });
  expect(added.width).toBe(1600);
  expect(added.height).toBe(1000);
  expect(added.hotspots[0]).toMatchObject({
    label: "暗门",
    action: { kind: "scene", sceneId: "shelf" },
  });
});

test("上传图片会刷新 baseUpdatedAt，随后保存不再 409", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await mockSceneApi(page);
  await openEditor(page);

  await page.locator(".scene-editor-hotspot", { hasText: "窗外" }).click();
  await page.getByRole("button", { name: "更换图片" }).click();
  await expect(page.locator(".scene-editor-media-picker")).toBeVisible();
  await page
    .locator('.scene-editor-media-picker input[type="file"]')
    .setInputFiles("qa/fixtures/hotspot/detail-plant.webp");
  await expect.poll(() => state.uploads.length).toBe(1);
  await expect(page.locator(".scene-editor-media-picker")).toBeHidden();
  await expect(page.locator(".scene-editor-image-row img")).toHaveAttribute("src", /\/api\/admin\/media\/905\/image$/);
  // 上传把新素材挂到题目上，选择器里应多出一张。
  await page.getByRole("button", { name: "更换图片" }).click();
  await expect(page.locator(".scene-editor-media-item")).toHaveCount(6);
  await page.keyboard.press("Escape");
  await expect(page.locator(".scene-editor-media-picker")).toBeHidden();

  await page.getByLabel("名称", { exact: true }).fill("窗外（雨）");
  await page.getByRole("button", { name: "保存" }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.patches[0]).toMatchObject({
    baseUpdatedAt: "2026-10-27T11:30:00Z",
  });
  const windowSpot = savedHotspots(state.patches[0]!).find((hotspot) => hotspot.id === "h1")!;
  expect(windowSpot.action).toMatchObject({ kind: "image", src: { assetId: 905 } });
});

test("只读：已发布或有答卷时禁用保存与拖拽并说明原因", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await mockSceneApi(page);
  state.status = "published";
  state.editable = false;
  await openEditor(page);

  await expect(page.locator(".scene-editor-banner")).toContainText("不是草稿");
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  await expect(page.locator(".scene-canvas")).toHaveAttribute("data-readonly", "true");
  await page.locator(".scene-editor-hotspot", { hasText: "窗外" }).click();
  await expect(page.getByLabel("名称", { exact: true })).toBeDisabled();

  await dragOnCanvas(page, [0.42, 0.7], [0.62, 0.92]);
  await expect(page.locator(".scene-canvas-spot")).toHaveCount(2);

  // 换成「草稿但已有答卷」：原因文案跟着变。
  state.status = "draft";
  state.responseCount = 3;
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator(".scene-editor-banner")).toContainText("已有 3 份答卷");
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  await page.screenshot({ path: `${ARTIFACTS}/editor-readonly.png` });
});

test("409 冲突：确认后重新加载服务端版本并丢弃本地修改", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await mockSceneApi(page);
  await openEditor(page);

  await page.getByLabel("场景标题", { exact: true }).fill("本地改了一半");
  state.conflictOnce = true;
  await page.getByRole("button", { name: "保存" }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  await expect(page.getByText("内容已被其他页面修改")).toBeVisible();
  await page.getByRole("button", { name: "重新加载" }).click();

  await expect.poll(() => state.editorRequests).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".scene-editor-heading h1")).toHaveText("服务端的新标题");
  await expect(page.locator(".scene-editor-dirty")).toHaveCount(0);
});

test("1440 与 390 宽都没有横向溢出", async ({ page }) => {
  const state = await mockSceneApi(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  const wide = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(wide.overflowX, "1440 横向溢出").toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${ARTIFACTS}/layout-1440.png`, fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator(".scene-canvas")).toBeVisible();
  const narrow = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(narrow.overflowX, "390 横向溢出").toBeLessThanOrEqual(1);
  // <1000px 三栏堆叠：侧栏、画布、检查器依次排开。
  const tops = await page.evaluate(() =>
    [".scene-editor-sidebar", ".scene-editor-main", ".scene-editor-inspector-col"].map(
      (selector) => document.querySelector(selector)!.getBoundingClientRect().top,
    ),
  );
  expect(tops[0]).toBeLessThan(tops[1]!);
  expect(tops[1]).toBeLessThan(tops[2]!);
  await scanA11y(page, "场景编辑器 · 390");
  await page.screenshot({ path: `${ARTIFACTS}/layout-390.png`, fullPage: true });
  writeFileSync(`${ARTIFACTS}/state.json`, JSON.stringify({ editorRequests: state.editorRequests }, null, 2));
});
