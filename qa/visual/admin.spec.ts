import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { scanA11y } from "./a11y";

/*
 * 断言的是「最终长什么样」，不是「动画走到第几帧」。
 *
 * 总览/统计页的环形图会从 0 长到目标角度（约 1s）。之前截图固定等 250ms，
 * 于是在 4 并发下机器一慢，截到的就是动画第 1 帧——同一张图，有时 38 条
 * SVG path、有时 46 条，表现为「偶发 1–2 条失败，单跑全过」。给截图用例声明
 * 减少动态效果，`EChart` 自己会把 `animation` 关掉（见 EChart.tsx 的
 * `usePrefersReducedMotion`），首帧即终态，与机器快慢无关。
 */
test.use({ reducedMotion: "reduce" });

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

const THEMES = ["light", "dark"] as const;

/**
 * DashboardPage 渲染的两条路径（/admin/ 与兜底的 /admin/analytics，App.tsx 的
 * path:"*" 把后者重定向到总览）。T2 重心视图（2026-11-07）后，环形图收进默认
 * 折叠的「报告交付队列」details，首次展开才挂载——收起态容器 0 宽，ECharts 在
 * 里面会画塌，所以默认视图不再出现 .echarts-for-react，等它会永远超时（这正是
 * 2026-11-07 第一轮 visual CI 的 8 条 TimeoutError）。改为等「功能地图」标题：
 * 它只在 data 到位后随整页一次渲染（此前是 SkeletonPanel），数据未落地时截不到
 * 真页，与旧等待防的「骨架/成图两态互截」是同一个目的。同页的「更新于 HH:MM」
 * 是活时钟，截图时一并屏蔽（时:分笔画随运行时刻变化，恰好贴着 0.002 阈值，
 * 时而通过时而超）。
 */
const DASHBOARD_PATHS = new Set(["/admin/", "/admin/analytics"]);

const PAGES = [
  "/admin/",
  "/admin/login",
  "/admin/surveys",
  "/admin/surveys/1",
  "/admin/surveys/1/editor",
  "/admin/surveys/3/editor",
  "/admin/surveys/1/responses",
  "/admin/templates",
  "/admin/task-packs",
  "/admin/analytics",
  "/admin/audit",
  "/admin/plaza",
  "/admin/profile-gallery",
  "/admin/reports",
  "/admin/settings",
  "/admin/licenses",
  "/admin/users",
  "/admin/surveys/1/analytics",
  "/admin/surveys/1/versions",
  "/admin/surveys/1/responses/10",
  // M6.3（docs/design/IMPLEMENTATION_PROGRESS.md）：以下 12 条此前无任何视觉
  // 覆盖，侧栏/导航/布局改动不会被发现。逐条入矩阵（空数据态，与既有基线口径
  // 一致——各页 EmptyPanel 分支）。
  "/admin/categories",
  "/admin/responses",
  "/admin/imports",
  "/admin/cert-content",
  "/admin/notes",
  "/admin/web-submissions",
  "/admin/showcase",
  "/admin/trash",
  "/admin/web-apps",
  "/admin/media-library",
  "/admin/control",
  "/admin/coin-economy",
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
      {
        id: 1,
        title: "示例问卷",
        description: null,
        status: "published",
        ownerId: 1,
        createdAt: now,
        updatedAt: now,
        questionCount: 3,
        responseCount: 5,
      },
      {
        id: 2,
        title: "草稿问卷",
        description: null,
        status: "draft",
        ownerId: 1,
        createdAt: now,
        updatedAt: now,
        questionCount: 1,
        responseCount: 0,
      },
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
  "/api/admin/surveys/3/editor": {
    survey: {
      id: 3,
      title: "未命名问卷",
      description: null,
      status: "draft",
      anonymous: false,
      allowMultipleResponses: false,
      maxResponsesPerUser: 1,
      version: 1,
      createdAt: now,
      updatedAt: now,
      responseCount: 0,
      questionCount: 0,
      editable: true,
    },
    questions: [],
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
  "/api/admin/task-packs": {
    packs: [
      {
        id: 1,
        name: "示例 · 楼道挑战",
        description: "虚构模拟：逐层上行，每层抽取一个任务。",
        normalFloors: 10,
        hellFloors: 12,
        prepItems: ["手机（计时用）", "一杯水"],
        prepText: "出发前按顺序确认清单。",
        enabled: true,
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
        items: [
          {
            id: 1,
            packId: 1,
            title: "镜面摩擦",
            description: "示例任务描述文案。",
            warning: "",
            score: 5,
            persona: "any",
            mode: "any",
            minFloor: 1,
            maxFloor: 10,
            enabled: true,
            sortOrder: 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
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
  "/api/admin/surveys/1/analytics": {
    survey: { id: 1, title: "示例问卷", status: "published" },
    overview: { totalStarted: 5, totalCompleted: 4, completionRate: 80 },
    statusCounts: { completed: 4, in_progress: 1, abandoned: 0, cancelled: 0, archived: 0 },
    optionStats: [],
    numericStats: [],
    completionTimeBuckets: [],
  },
  "/api/admin/audit-logs": { items: [], page: 1, total: 0, totalPages: 1 },
  "/api/admin/plaza/posts": { items: [], total: 0, limit: 20, offset: 0 },
  "/api/admin/profile-gallery": {
    items: [],
    total: 0,
    publishedTotal: 0,
    limit: 20,
    offset: 0,
    surveyId: null,
    surveyTitle: "",
  },
  "/api/admin/report-deliveries": {
    items: [],
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 1,
    statusSummary: { pending: 0, delivering: 0, delivered: 0, failed: 0 },
  },
  "/api/admin/licenses": { items: [] },
  "/api/admin/releases": { items: [] },
  "/api/admin/trials": { items: [] },
  // M6.3：以下端点此前落进 `{}` 兜底，页面按真实形状解构直接崩（control 读
  // `jobs.backlog.deliveries` 等）。mock 一律与 src/http/admin/read.ts、
  // admin/src/api.ts 的真实响应形状同形——空列表态，不虚构数字。
  "/api/control/jobs": {
    counts: {
      deliveries: [],
      imageGeneratorJobs: [],
      renderJobs: [],
      exportJobs: [],
    },
    backlog: { deliveries: 0, imageGeneratorJobs: 0, renderJobs: 0, exportJobs: 0 },
    recentFailures: [],
  },
  "/api/admin/media-library": { items: [], total: 0, limit: 30, offset: 0 },
  "/api/admin/web-submissions/list": { ok: true, total: 0, limit: 20, offset: 0, items: [] },
  "/api/admin/web-submissions/count": { ok: true, pending: 0, total: 0 },
  "/api/admin/web-submissions/form-config": {
    ok: true,
    showcaseEnabled: false,
    showcaseFields: ["title", "description", "nickname"],
    steps: [],
  },
  "/api/admin/submissions": { submissions: [] },
  "/api/admin/gacha/pools": { pools: [] },
  "/api/admin/coins/challenges": { challenges: [] },
  "/api/admin/coins/config": {
    timezoneOffsetMinutes: 480,
    checkin: {
      enabled: true,
      ladder: [{ minStreak: 1, amount: 5 }],
      backfill: { enabled: true, cost: 50, maxBackfillDays: 3 },
    },
    challenges: { enabled: true },
    pricing: { minPrice: 10, maxPrice: 100, hotWeight: 1, qualityFactor: 1, refreshSeconds: 60 },
    submissions: {
      enabled: true,
      autoApproveText: false,
      baseRewards: { text: 20, image: 40 },
      tierMultipliers: [1, 2],
      dailyRewardCap: 100,
      maxPerDay: 5,
    },
    gacha: { enabled: true, maxMulti: 10 },
  },
  // M6.3：/users 基线原本只有空态（audit 结论），换有数据变体——标签/封禁徽标/
  // 移动字段卡都是布局敏感元素，空态截不到。
  "/api/admin/users": {
    items: [
      {
        id: 1,
        telegramUserId: 100,
        username: "demo",
        firstName: "演示",
        lastName: null,
        completedResponses: 6,
        tags: ["内测", "问卷达人"],
        bannedAt: null,
      },
      {
        id: 2,
        telegramUserId: 101,
        username: "nightowl",
        firstName: "夜猫",
        lastName: "子",
        completedResponses: 2,
        tags: ["夜跑"],
        bannedAt: null,
      },
      {
        id: 3,
        telegramUserId: 102,
        username: null,
        firstName: "匿名",
        lastName: null,
        completedResponses: 0,
        tags: [],
        bannedAt: now,
      },
    ],
    page: 1,
    pageSize: 20,
    total: 3,
    totalPages: 1,
  },
  "/api/admin/surveys/1/versions": { versions: [] },
  "/api/admin/surveys/1/responses/10": {
    survey: { id: 1, title: "示例问卷", anonymous: false },
    response: {
      id: 10,
      status: "completed",
      statusLabel: "已完成",
      version: 1,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      respondent: { telegramUserId: 100, username: "demo", firstName: "演示", lastName: null },
      participantKey: null,
      submittedAt: now,
      previousResponseId: null,
      nextResponseId: null,
    },
    answers: [],
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
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ environment: "production" }),
    }),
  );
  await page.route("**://telegram.org/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: TELEGRAM_STUB }),
  );
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    for (const path of PAGES) {
      test(`admin ${path} · ${theme} @ ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.addInitScript((value) => localStorage.setItem("admin_theme", value), theme);
        await mockAdminApi(page);

        const problems: string[] = [];
        page.on("pageerror", (error) => problems.push(`pageerror: ${String(error)}`));
        page.on("console", (message) => {
          if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
        });

        await page.goto(path, { waitUntil: "domcontentloaded" });
        await expect(page.locator("h1, main").first()).toBeVisible();
        if (DASHBOARD_PATHS.has(path)) {
          // 旧断言等 .echarts-for-react 挂载；T2 后图表藏在默认折叠的 details 里，
          // 默认视图不渲染（见 DASHBOARD_PATHS 注释）。「功能地图」标题只在 data
          // 落地后出现，等它即可保证整页已渲染，骨架态不会混进截图。
          await expect(page.getByRole("heading", { name: "功能地图" })).toBeVisible();
        }
        await page.waitForTimeout(250);
        if (path === "/admin/surveys/3/editor") {
          await expect(page.getByRole("button", { name: "添加题目" })).toBeVisible();
        }
        if (path === "/admin/surveys/1/editor") {
          if (viewport.width >= 900) {
            await expect(page.getByText("上传题面附件")).toBeVisible();
            await expect(page.getByText("选项媒体").first()).toBeVisible();
          } else {
            // P3/S10 新壳：窄屏属性栏隐藏（与 editor-layout.spec「窄屏 900px」同一契约），
            // 旧断言「上传题面附件可见」只对旧壳成立，这里改断手机操作栏。
            await expect(page.locator(".editor-mobile-bar")).toBeVisible();
          }
        }
        if (path === "/admin/surveys/1/analytics") {
          await page.waitForTimeout(1200);
        }

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        expect(problems).toEqual([]);

        await scanA11y(page, test.info().title);

        const dashboardClock = DASHBOARD_PATHS.has(path) ? [page.getByText(/更新于/)] : undefined;
        await expect(page).toHaveScreenshot(
          `admin-${path.replaceAll("/", "_")}${theme === "dark" ? "-dark" : ""}-${viewport.width}x${viewport.height}.png`,
          { maxDiffPixelRatio: 0.002, ...(dashboardClock ? { mask: dashboardClock } : {}) },
        );
      });
    }
  }
}

// ---- M6.3 补充状态（docs/design/IMPLEMENTATION_PROGRESS.md 批次 6.3）----
// 主矩阵只覆盖默认态；以下两个状态此前从未被截图，却是 M10 呈现改动的敏感面。

test("admin dashboard · 报告交付队列展开态（图表挂载）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript((value) => localStorage.setItem("admin_theme", value), "dark");
  await mockAdminApi(page);
  await page.goto("/admin/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "功能地图" })).toBeVisible();

  // T2 后队列默认折叠（details）；展开才挂载 4 张投递卡 + 环形图。
  await page.locator("details", { hasText: "报告交付队列" }).locator("summary").click();
  await expect(page.locator(".echarts-for-react").first()).toBeVisible();
  await page.waitForTimeout(300);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page).toHaveScreenshot("admin-dashboard-queue-expanded-1440x900.png", {
    maxDiffPixelRatio: 0.002,
    mask: [page.getByText(/更新于/)],
  });
});

test("admin mobile · 侧栏抽屉开启态", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((value) => localStorage.setItem("admin_theme", value), "dark");
  await mockAdminApi(page);
  await page.goto("/admin/surveys", { waitUntil: "domcontentloaded" });
  await expect(page.locator("h1, main").first()).toBeVisible();

  await page.getByRole("button", { name: "打开菜单" }).click();
  // 抽屉打开后工作区导航应可见（Layout 的 slide-in 侧栏）。
  await expect(page.locator("aside.admin-sidebar")).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page).toHaveScreenshot("admin-mobile-drawer-open-390x844.png", {
    maxDiffPixelRatio: 0.002,
  });
});
