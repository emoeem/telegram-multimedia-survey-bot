import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

const PAGES = [
  "/admin/",
  "/admin/login",
  "/admin/surveys",
  "/admin/surveys/1",
  "/admin/surveys/1/editor",
  "/admin/surveys/1/responses",
  "/admin/templates",
];

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
const API_MOCKS: Record<string, unknown> = {
  "/api/admin/dashboard": {
    users: 12,
    surveys: 4,
    publishedSurveys: 2,
    responses: 36,
    todayResponses: 5,
    reportDeliveries: { pending: 1, delivering: 2, delivered: 30, failed: 1 },
    recentSurveys: [{ id: 1, title: "示例问卷", status: "published", updatedAt: now }],
    recentResponses: [{ id: 10, surveyId: 1, status: "completed", updatedAt: now, title: "示例问卷" }],
    recentActions: [{ id: 1, action: "survey.publish", entityType: "survey", entityId: "1", createdAt: now }],
  },
  "/api/admin/surveys": {
    items: [
      { id: 1, title: "示例问卷", description: null, status: "published", ownerId: 1, createdAt: now, updatedAt: now, questionCount: 3, responseCount: 5 },
      { id: 2, title: "草稿问卷", description: null, status: "draft", ownerId: 1, createdAt: now, updatedAt: now, questionCount: 1, responseCount: 0 },
    ],
    page: 1,
    pageSize: 20,
    total: 2,
    totalPages: 1,
  },
  "/api/admin/surveys/1": {
    id: 1,
    title: "示例问卷",
    description: "演示问卷",
    status: "published",
    owner_id: 1,
    created_at: now,
    updated_at: now,
    access_code: null,
    questionCount: 3,
    responseCount: 5,
    completedCount: 4,
    firstName: "演示",
    username: "demo",
    report_template_id: "classic",
    theme: { preset: "light" },
    themePresets: [
      { id: "light", name: "明亮" },
      { id: "dark", name: "暗色" },
      { id: "luxury", name: "黑金奢华" },
    ],
  },
  "/api/admin/surveys/1/editor": {
    survey: {
      id: 1,
      title: "示例问卷",
      description: null,
      status: "draft",
      anonymous: false,
      allowMultipleResponses: true,
      maxResponsesPerUser: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
      responseCount: 0,
      questionCount: 1,
      editable: true,
    },
    questions: [
      {
        id: 11,
        type: "single",
        title: "第一题",
        description: null,
        required: true,
        order: 0,
        pageId: null,
        settings: null,
        validation: null,
        condition: null,
        media: [],
        options: [
          { id: 21, label: "选项 A", order: 0, media: [] },
          { id: 22, label: "选项 B", order: 1, media: [] },
        ],
      },
    ],
    pages: [],
  },
  "/api/admin/surveys/1/responses": {
    survey: { id: 1, title: "示例问卷", anonymous: false },
    items: [
      {
        id: 10,
        status: "completed",
        statusLabel: "已完成",
        version: 1,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        respondent: { telegramUserId: 100, username: "demo", firstName: "演示", lastName: null },
      },
    ],
    page: 1,
    pageSize: 20,
    total: 1,
    totalPages: 1,
  },
  "/api/admin/report-templates": {
    templates: [
      { id: "classic", name: "经典报告", theme: "catppuccin-latte", layout: "editorial", renderers: ["web", "pdf"] },
      { id: "data", name: "数据分析", theme: "daisy-light", layout: "data", renderers: ["web", "pdf"] },
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

const indexHtml = readFileSync("admin/dist/index.html", "utf-8");

async function mockAdminApi(page: Page) {
  await page.route("**/admin/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api")) return route.fallback();
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: indexHtml });
  });
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const body = API_MOCKS[url.pathname];
    if (body === undefined) {
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/health", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ environment: "production" }) }),
  );
  await page.route("**://telegram.org/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: TELEGRAM_STUB }),
  );
}

for (const viewport of VIEWPORTS) {
  for (const path of PAGES) {
    test(`admin ${path} @ ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockAdminApi(page);

      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(`pageerror: ${String(error)}`));
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
      });

      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page.locator("h1").first()).toBeVisible();

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      expect(problems).toEqual([]);

      await expect(page).toHaveScreenshot(
        `admin-${path.replaceAll("/", "_")}-${viewport.width}x${viewport.height}.png`,
        { maxDiffPixelRatio: 0.002 },
      );
    });
  }
}
