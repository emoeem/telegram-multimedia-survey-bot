import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { scanA11y } from "./a11y";

/**
 * Desktop layout regression for the survey editor with a large imported
 * survey (~135 questions). Guards the viewport-height chain
 * (shell → main → editor page → three columns) and the phone-shaped live
 * preview: no page-level scrollbar, no dead band under the workspace,
 * independent per-column scrolling, preview sync while switching questions.
 * Geometry-based on purpose — pixel snapshots of a live editor are too flaky.
 */

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

const now = "2026-08-23T12:00:00Z";
const SHOTS_DIR = "qa/artifacts/editor-layout/shots";

type MockQuestion = Record<string, unknown>;

function buildQuestions(count: number): MockQuestion[] {
  const types = ["single", "multiple", "yes_no", "rating", "text", "long_text", "number", "note"];
  return Array.from({ length: count }, (__, i) => {
    const type = types[i % types.length];
    const longTitle = i % 7 === 0;
    return {
      id: 1000 + i,
      type,
      title: longTitle
        ? `第${i + 1}题：这是一道特别特别长的题目标题用来验证大量导入后左侧列表与中间编辑区对超长标题的截断与换行处理是否正常`
        : `第${i + 1}题：这是导入的${type === "note" ? "剧情文段" : "题目"}`,
      description: i % 3 === 0 ? "这是导入后的题目描述，用于检查描述文本的展示效果。" : null,
      required: i % 2 === 0,
      order: i,
      pageId: null,
      settings: null,
      validation: null,
      condition: null,
      media:
        i % 11 === 0 ? [{ mediaAssetId: 500 + i, mediaType: "image", fileName: "pic.png", mimeType: "image/png" }] : [],
      options:
        type === "single" || type === "multiple" || type === "yes_no" || type === "rating"
          ? Array.from({ length: 2 + (i % 4) }, (__, j) => ({
              id: 50000 + i * 10 + j,
              label: `选项 ${j + 1}${i % 5 === 0 ? "（这个选项的文案也比较长，检查选项行的换行与间距）" : ""}`,
              order: j,
              media: [],
            }))
          : [],
    };
  });
}

function editorPayload(surveyId: number, questions: MockQuestion[]) {
  return {
    survey: {
      id: surveyId,
      title: "导入的大量题目问卷",
      description: "用于复现布局问题的导入问卷",
      status: "draft",
      anonymous: false,
      allowMultipleResponses: false,
      maxResponsesPerUser: 1,
      version: 3,
      createdAt: now,
      updatedAt: now,
      responseCount: 0,
      questionCount: questions.length,
      editable: true,
      reportTemplateId: null,
      theme: { preset: "light" },
    },
    questions,
    pages: [],
  };
}

const BASE_MOCKS: Record<string, unknown> = {
  "/api/admin/session": { ok: true, role: "admin", userId: 1, telegramUserId: 1 },
  "/api/admin/deployment": { licenseCenter: false },
  "/api/admin/environment": { environment: "production" },
  "/api/admin/report-templates": {
    templates: [
      { id: "classic", name: "经典报告", theme: "catppuccin-latte", layout: "editorial", renderers: ["web", "pdf"] },
    ],
  },
  "/api/admin/settings": {
    settings: {
      reportChannelId: "-100123",
      defaultReportTemplate: "classic",
      mediaTtlSeconds: 604800,
      maxUploadMb: 10,
      maxResponseMediaMb: 50,
      pdfMaxMb: 15,
    },
  },
};

const BIG = editorPayload(121, buildQuestions(135));
const FEW = editorPayload(123, buildQuestions(3));
const EMPTY = editorPayload(122, []);

async function mockEditorApi(page: Page, editors: Record<string, unknown>) {
  await page.addInitScript(TELEGRAM_STUB);
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = editors[path] ?? BASE_MOCKS[path];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body ?? {}),
    });
  });
  await page.route("**://telegram.org/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: TELEGRAM_STUB }),
  );
}

interface Geometry {
  docOverflowY: number;
  docOverflowX: number;
  columns: Array<{ name: string; height: number; top: number; scrollHeight: number; clientHeight: number }>;
  pageBottom: number;
  viewportHeight: number;
  phone: { width: number; height: number; bottom: number };
  previewBottom: number;
}

async function readGeometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        height: r.height,
        width: r.width,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    };
    const doc = document.documentElement;
    const columns = [".editor-structure", ".editor-canvas", ".editor-preview"].map((sel) => {
      const b = box(sel)!;
      return {
        name: sel,
        height: Math.round(b.height),
        top: Math.round(b.top),
        scrollHeight: b.scrollHeight,
        clientHeight: b.clientHeight,
      };
    });
    const phone = box(".phone-frame")!;
    const preview = box(".editor-preview")!;
    const page_ = box(".editor-page")!;
    return {
      docOverflowY: doc.scrollHeight - doc.clientHeight,
      docOverflowX: doc.scrollWidth - window.innerWidth,
      columns,
      pageBottom: Math.round(page_.bottom),
      viewportHeight: window.innerHeight,
      phone: { width: Math.round(phone.width), height: Math.round(phone.height), bottom: Math.round(phone.bottom) },
      previewBottom: Math.round(preview.bottom),
    };
  });
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1600, height: 900 },
]) {
  test(`135-question editor fills the viewport at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockEditorApi(page, { "/api/admin/surveys/121/editor": BIG });
    await page.goto("/admin/surveys/121/editor?ui=legacy", { waitUntil: "networkidle" });
    await page.waitForSelector(".editor-body");
    await page.waitForTimeout(300);

    const g = await readGeometry(page);
    // The workspace must reach the bottom of the viewport (minus main padding)
    // instead of ending early with a dead band; the document must not scroll.
    expect(g.docOverflowY, "page-level vertical scrollbar").toBeLessThanOrEqual(1);
    expect(g.docOverflowX, "horizontal overflow").toBeLessThanOrEqual(1);
    expect(g.pageBottom, "editor page bottom").toBeGreaterThanOrEqual(g.viewportHeight - 34);
    const heights = g.columns.map((c) => c.height);
    expect(Math.max(...heights) - Math.min(...heights), "column height mismatch").toBeLessThanOrEqual(2);
    // 135 questions must scroll inside their own panels.
    const structure = g.columns[0]!;
    const canvas = g.columns[1]!;
    expect(structure.scrollHeight).toBeGreaterThan(structure.clientHeight);
    expect(canvas.scrollHeight).toBeGreaterThan(canvas.clientHeight);
    // Phone preview keeps a portrait ratio and stays inside its column.
    const ratio = g.phone.width / g.phone.height;
    expect(ratio, "phone frame aspect ratio").toBeGreaterThan(0.42);
    expect(ratio, "phone frame aspect ratio").toBeLessThan(0.52);
    expect(g.phone.bottom, "phone frame inside preview column").toBeLessThanOrEqual(g.previewBottom + 2);

    mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: `${SHOTS_DIR}/spec-${viewport.width}x${viewport.height}.png` });
  });
}

test("question switching, search and preview sync survive 135 questions", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await mockEditorApi(page, { "/api/admin/surveys/121/editor": BIG });
  await page.goto("/admin/surveys/121/editor?ui=legacy", { waitUntil: "networkidle" });
  await page.waitForSelector(".editor-body");

  // Jump to question 60 from the left tree; the canvas must scroll it into view
  // and the phone preview must follow. The smooth scroll over ~4.5k px of
  // summary rows takes a while, so poll instead of a fixed wait.
  await page.locator(".tree-question", { hasText: "第60题：" }).first().click();
  const active = page.locator('.block-item.is-active[data-block-id="1059"]');
  await expect(active).toBeVisible();
  const canvasBox = await page.locator(".editor-canvas").boundingBox();
  expect(canvasBox).not.toBeNull();
  await expect
    .poll(async () => (await active.boundingBox())!.y, { timeout: 5_000, message: "active card scrolled into view" })
    .toBeLessThanOrEqual(canvasBox!.y + canvasBox!.height);
  expect((await active.boundingBox())!.y).toBeGreaterThanOrEqual(canvasBox!.y - 2);
  await expect(page.locator(".phone-card-meta")).toContainText("第 60 / 135 题");

  // Phone "next" moves the selection and the editor follows.
  await page.locator(".phone-btn", { hasText: "下一题" }).click();
  await expect(page.locator('.block-item.is-active[data-block-id="1060"]')).toBeVisible();
  await expect(page.locator(".phone-card-meta")).toContainText("第 61 / 135 题");

  // Left list search narrows to the matching question and can be cleared.
  await page.getByLabel("搜索题目").fill("第70题");
  await expect(page.locator(".tree-question")).toHaveCount(1);
  await page.getByLabel("搜索题目").fill("");
  await expect(page.locator(".tree-question").first()).toBeVisible();

  // Resizing keeps the fit.
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForTimeout(200);
  const g = await readGeometry(page);
  expect(g.docOverflowY).toBeLessThanOrEqual(1);
  expect(g.docOverflowX).toBeLessThanOrEqual(1);
});

test("empty survey renders without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await mockEditorApi(page, { "/api/admin/surveys/122/editor": EMPTY });
  await page.goto("/admin/surveys/122/editor?ui=legacy", { waitUntil: "networkidle" });
  await expect(page.getByText("这份问卷还没有内容")).toBeVisible();
  const g = await readGeometry(page);
  expect(g.docOverflowY).toBeLessThanOrEqual(1);
  expect(g.docOverflowX).toBeLessThanOrEqual(1);
  const heights = g.columns.map((c) => c.height);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(2);
  writeFileSync(`${SHOTS_DIR}/spec-empty-geometry.json`, JSON.stringify(g, null, 2));
});

test("a few questions fill the columns without inner scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await mockEditorApi(page, { "/api/admin/surveys/123/editor": FEW });
  await page.goto("/admin/surveys/123/editor?ui=legacy", { waitUntil: "networkidle" });
  await page.waitForSelector(".editor-body");
  const g = await readGeometry(page);
  expect(g.docOverflowY).toBeLessThanOrEqual(1);
  expect(g.docOverflowX).toBeLessThanOrEqual(1);
  const heights = g.columns.map((c) => c.height);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(2);
  const canvas = g.columns[1]!;
  // The active question editor card can legitimately exceed one column height
  // (long question with many options) — the canvas then scrolls internally.
  // What must not happen is the card being clipped by a broken height chain.
  expect(canvas.clientHeight).toBeGreaterThan(400);
});

test("narrow viewport degrades to the stacked mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await mockEditorApi(page, { "/api/admin/surveys/121/editor": BIG });
  await page.goto("/admin/surveys/121/editor?ui=legacy", { waitUntil: "networkidle" });
  await page.waitForSelector(".editor-body");
  await expect(page.locator(".editor-preview")).toBeHidden();
  await expect(page.locator(".editor-mobile-bar")).toBeVisible();
  const doc = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(doc.overflowX).toBeLessThanOrEqual(1);
});

test("添加互动场景：POST 空 scene 题并跳转独立场景编辑器", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const builderPayload = editorPayload(1, buildQuestions(2));
  const scenePayload = {
    ...builderPayload,
    questions: [
      {
        id: 77,
        type: "scene",
        title: "互动场景",
        description: null,
        required: true,
        order: 0,
        pageId: null,
        settings: null,
        validation: null,
        condition: null,
        media: [],
        options: [],
      },
    ],
  };
  await mockEditorApi(page, { "/api/admin/surveys/1/editor": builderPayload });

  // 后注册的精确路由优先于 mockEditorApi 的通配符：POST 之后 GET 返回带
  // scene 题的编辑器数据，模拟「创建完跳到场景编辑器」的真实服务端状态。
  let created = false;
  const posts: Array<Record<string, unknown>> = [];
  await page.route("**/api/admin/surveys/1/questions", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts.push(route.request().postDataJSON() as Record<string, unknown>);
    created = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: 77, order: 0, updatedAt: now }),
    });
  });
  await page.route("**/api/admin/surveys/1/editor", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(created ? scenePayload : builderPayload),
    }),
  );

  await page.goto("/admin/surveys/1/editor?ui=legacy", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "添加互动场景" }).click();

  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ type: "scene", title: "互动场景", required: true, pageId: null });
  await expect(page).toHaveURL(/\/admin\/surveys\/1\/scene\/77$/);
  await expect(page.locator(".scene-editor")).toBeVisible();
  await expect(page.locator(".scene-editor-topbar")).toContainText("互动场景");
  // 空配置落在题目面板：提示先添加场景。
  await expect(page.locator(".scene-editor-empty")).toContainText("还没有场景");
});

// ---------------------------------------------------------------------------
// P2 三栏画布外壳（?ui=next）：与旧壳共用 .editor-* 三栏 CSS，所以几何断言
// 同型（三栏等高、无页面级滚动、无死带、大问卷栏内滚动）；差异在于右栏是
// 属性面板（选中即配置），预览改为顶栏按钮的弹层，没有 phone-frame。
// 新壳在 ?ui=next 之后的独立 chunk，不影响旧壳任何截图基线。
// ---------------------------------------------------------------------------

async function readNextGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        height: Math.round(r.height),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    };
    const doc = document.documentElement;
    return {
      docOverflowY: doc.scrollHeight - doc.clientHeight,
      docOverflowX: doc.scrollWidth - window.innerWidth,
      columns: [".editor-structure", ".editor-canvas", ".editor-preview"].map((sel) => box(sel)!),
      pageBottom: Math.round(box(".editor-page")!.bottom),
      viewportHeight: window.innerHeight,
      phoneFrame: document.querySelector(".phone-frame") !== null,
    };
  });
}

test.describe("P2 三栏外壳（?ui=next）", () => {
  test("135 题：三栏等高、无页面级滚动、画布内部滚动、右栏默认选中第一题", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockEditorApi(page, { "/api/admin/surveys/121/editor": BIG });
    await page.goto("/admin/surveys/121/editor?ui=next", { waitUntil: "networkidle" });
    await page.waitForSelector(".editor-body");
    await page.waitForTimeout(300);

    const g = await readNextGeometry(page);
    expect(g.docOverflowY, "page-level vertical scrollbar").toBeLessThanOrEqual(1);
    expect(g.docOverflowX, "horizontal overflow").toBeLessThanOrEqual(1);
    expect(g.pageBottom, "editor page bottom").toBeGreaterThanOrEqual(g.viewportHeight - 34);
    const heights = g.columns.map((column) => column.height);
    expect(Math.max(...heights) - Math.min(...heights), "column height mismatch").toBeLessThanOrEqual(2);
    // 135 张摘要卡必须在自己的栏内滚动；物料区内容短，不强制内部滚动。
    const canvas = g.columns[1]!;
    expect(canvas.scrollHeight).toBeGreaterThan(canvas.clientHeight);
    // 新壳没有旧壳的手机预览；右栏是属性面板，默认选中第一题显示题卡。
    expect(g.phoneFrame, "new shell has no inline phone preview").toBe(false);
    await expect(page.locator("aside.editor-preview .q-editor")).toBeVisible();
    await expect(page.locator('.editor-canvas [data-block-id="1000"].block-item')).toBeVisible();
  });

  test("选中即配置：点摘要卡 → 属性面板切题，快捷条出现且必答可切换", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockEditorApi(page, { "/api/admin/surveys/121/editor": BIG });
    await page.goto("/admin/surveys/121/editor?ui=next", { waitUntil: "networkidle" });
    await page.waitForSelector(".editor-body");

    await page.locator(".editor-canvas .q-row", { hasText: "第60题：" }).first().click();
    const activeRow = page.locator('.editor-canvas .block-item[data-block-id="1059"]');
    await expect(activeRow).toBeVisible();
    // 快捷条只在激活卡上出现。
    const quickBar = activeRow.getByRole("toolbar");
    await expect(quickBar).toBeVisible();
    // 属性面板展示同一道题（右栏题卡的题号 = 第 60 题）。
    await expect(page.locator(".editor-preview .q-editor .q-index")).toHaveText("第 60 题");

    // 必答切换：本地立即生效（buildQuestions 里第 60 题 required=false）。
    const requiredSwitch = quickBar.getByRole("switch", { name: "必答" });
    await expect(requiredSwitch).toHaveAttribute("aria-checked", "false");
    await requiredSwitch.click();
    await expect(requiredSwitch).toHaveAttribute("aria-checked", "true");
    // 摘要卡上的必答标签同步出现。
    await expect(activeRow.locator(".q-row-tag.is-req")).toBeVisible();
  });

  test("问卷设置入口：右栏切到设置面板", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockEditorApi(page, { "/api/admin/surveys/121/editor": BIG });
    await page.goto("/admin/surveys/121/editor?ui=next", { waitUntil: "networkidle" });
    await page.waitForSelector(".editor-body");

    await page.locator(".editor-canvas [aria-pressed]", { hasText: "问卷设置" }).click();
    // ResultRulesPanel 也带 settings-panel 类，这里认主面板的标题。
    await expect(page.locator(".editor-preview .settings-panel-title", { hasText: "问卷设置" })).toBeVisible();
  });

  test("物料区添加题目：插入到画布并选中（待保存态）", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockEditorApi(page, { "/api/admin/surveys/121/editor": BIG });
    await page.goto("/admin/surveys/121/editor?ui=next", { waitUntil: "networkidle" });
    await page.waitForSelector(".editor-body");

    const rows = page.locator(".editor-canvas .q-row");
    await expect(rows).toHaveCount(135);
    await page.locator('aside[aria-label="物料区"] button', { hasText: "单选" }).first().click();
    await expect(rows).toHaveCount(136);
    // 新题进入选中态：属性面板出现未保存标记。
    await expect(page.locator(".editor-preview .q-chip-unsaved")).toBeVisible();
  });

  test("空问卷：空态文案 + 三栏等高 + 右栏设置面板", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockEditorApi(page, { "/api/admin/surveys/122/editor": EMPTY });
    await page.goto("/admin/surveys/122/editor?ui=next", { waitUntil: "networkidle" });
    await page.waitForSelector(".editor-body");
    await expect(page.getByText(/这份问卷还没有内容/)).toBeVisible();
    const g = await readNextGeometry(page);
    expect(g.docOverflowY).toBeLessThanOrEqual(1);
    expect(g.docOverflowX).toBeLessThanOrEqual(1);
    const heights = g.columns.map((column) => column.height);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(2);
    await expect(page.locator(".editor-preview .settings-panel-title", { hasText: "问卷设置" })).toBeVisible();
  });

  test("窄屏 900px：属性栏隐藏、手机操作栏可见、无横向溢出", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await mockEditorApi(page, { "/api/admin/surveys/121/editor": BIG });
    await page.goto("/admin/surveys/121/editor?ui=next", { waitUntil: "networkidle" });
    await page.waitForSelector(".editor-body");
    await expect(page.locator(".editor-preview")).toBeHidden();
    await expect(page.locator(".editor-mobile-bar")).toBeVisible();
    const g = await readNextGeometry(page);
    expect(g.docOverflowX).toBeLessThanOrEqual(1);
  });

  test("S4 拖拽：物料拖入画布产生一道新题（drop 才产生命令）", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockEditorApi(page, { "/api/admin/surveys/121/editor": BIG });
    await page.goto("/admin/surveys/121/editor?ui=next", { waitUntil: "networkidle" });
    await page.waitForSelector(".editor-body");
    const rows = page.locator(".editor-canvas .q-row");
    await expect(rows).toHaveCount(135);

    const source = page.locator('aside[aria-label="物料区"] [aria-label="拖动 单选 到画布"]');
    const target = page.locator(".editor-canvas .block-list").first();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    // dnd-kit PointerSensor 需要 pointerdown → 移动超过激活阈值 → up 的完整序列。
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + 80, { steps: 12 });
    await page.mouse.up();

    // drop 才产生命令：恰好一道新题追加到末尾并进入选中态。
    await expect(rows).toHaveCount(136);
    await expect(page.locator(".editor-preview .q-chip-unsaved")).toBeVisible();
  });

  test("S4 拖拽：画布内拖拽柄排序不改变题目数量", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockEditorApi(page, { "/api/admin/surveys/121/editor": BIG });
    await page.goto("/admin/surveys/121/editor?ui=next", { waitUntil: "networkidle" });
    await page.waitForSelector(".editor-body");

    const handles = page.locator('.editor-canvas [aria-label="拖动排序"]');
    const first = await handles.nth(0).boundingBox();
    const third = await handles.nth(2).boundingBox();
    expect(first).not.toBeNull();
    expect(third).not.toBeNull();
    await page.mouse.move(first!.x + first!.width / 2, first!.y + first!.height / 2);
    await page.mouse.down();
    await page.mouse.move(third!.x + third!.width / 2, third!.y + third!.height + 8, { steps: 12 });
    await page.mouse.up();

    // 排序只重排全序，不增减题目；选中态不变（第一题仍是第一题卡内容）。
    await expect(page.locator(".editor-canvas .q-row")).toHaveCount(135);
  });

  test("S9 a11y：新壳（基础模式）axe 无 serious/critical 违规", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockEditorApi(page, { "/api/admin/surveys/121/editor": BIG });
    await page.goto("/admin/surveys/121/editor?ui=next", { waitUntil: "networkidle" });
    await page.waitForSelector(".editor-body");
    await page.waitForTimeout(300);
    await scanA11y(page, "editor next shell (basic) @ 1600x900");
  });

  test("S9 a11y：新壳（专业模式，逻辑页签）axe 无 serious/critical 违规", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockEditorApi(page, { "/api/admin/surveys/121/editor": BIG });
    await page.addInitScript(() => localStorage.setItem("admin:editor-mode", "pro"));
    await page.goto("/admin/surveys/121/editor?ui=next", { waitUntil: "networkidle" });
    await page.waitForSelector(".editor-body");
    await page.waitForTimeout(300);
    await scanA11y(page, "editor next shell (pro) @ 1600x900");
  });

  test("S8 往返前提：新壳打开不做修改 → 不产生任何写请求（数据零漂移）", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const writes: string[] = [];
    await page.route("**/api/**", (route) => {
      const method = route.request().method();
      const path = new URL(route.request().url()).pathname;
      if (method !== "GET" && path !== "/api/admin/session") writes.push(`${method} ${path}`);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BIG) });
    });
    await page.goto("/admin/surveys/121/editor?ui=next", { waitUntil: "networkidle" });
    await page.waitForSelector(".editor-body");
    // 选中几道题、切设置页签、切回——纯导航不得触发保存。
    await page.locator(".editor-canvas .q-row").nth(3).click();
    await page.locator(".editor-canvas [aria-pressed]", { hasText: "问卷设置" }).click();
    await page.locator(".editor-canvas .q-row").first().click();
    await page.waitForTimeout(2600); // 超过 autosave 的 2s 防抖窗口
    expect(writes, `unexpected writes: ${writes.join(", ")}`).toEqual([]);
  });
});
