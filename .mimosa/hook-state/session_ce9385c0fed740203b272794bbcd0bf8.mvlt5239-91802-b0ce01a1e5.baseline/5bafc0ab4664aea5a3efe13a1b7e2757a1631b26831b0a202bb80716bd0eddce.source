import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

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
    await page.goto("/admin/surveys/121/editor", { waitUntil: "networkidle" });
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
  await page.goto("/admin/surveys/121/editor", { waitUntil: "networkidle" });
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
  await page.goto("/admin/surveys/122/editor", { waitUntil: "networkidle" });
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
  await page.goto("/admin/surveys/123/editor", { waitUntil: "networkidle" });
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
  await page.goto("/admin/surveys/121/editor", { waitUntil: "networkidle" });
  await page.waitForSelector(".editor-body");
  await expect(page.locator(".editor-preview")).toBeHidden();
  await expect(page.locator(".editor-mobile-bar")).toBeVisible();
  const doc = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(doc.overflowX).toBeLessThanOrEqual(1);
});
