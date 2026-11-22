import { expect, test, type Page } from "@playwright/test";
import { scanA11y } from "./a11y";

/**
 * 公开站盲区路由的视觉与功能守卫（M6 批次 6.3，docs/design/IMPLEMENTATION_PROGRESS.md）。
 *
 * 此前 /me /plaza /notes /coins /gacha /submissions /series /auth 八条路由在
 * qa/visual 零覆盖，M9 分组栅格/社区网格化改造没有回归保护。本规格全部取
 * 「匿名访客 + 空数据」态（与真实 API 形状同形，来源 admin/src/survey/api.ts、
 * plaza-api.ts、note-api.ts）；登录态与数据态由各业务流程规格覆盖。
 *
 * ⚠️ 基线纪律：基线 PNG 只能由 visual-baseline.yml（CI 字体环境）生成/更新；
 * 本地首跑会自动写入 local-font 基线并判失败——**本地生成的 PNG 不得提交**。
 */

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
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

const FEED_EMPTY = { items: [], total: 0, limit: 10, offset: 0 };

// 与 api.ts / plaza-api.ts / note-api.ts 的真实响应形状同形（匿名空数据）。
const API_MOCKS: Record<string, unknown> = {
  "/api/me/overview": {
    identity: { telegram: false, email: false, emailMasked: null },
    completedSurveys: 0,
    profileSurveyId: null,
    myProfile: null,
    trial: { runs: 0, completed: 0, bestScore: 0 },
    achievements: { unlocked: 0, total: 12, unseen: 0, items: [] },
    showcase: null,
    totalEarned: 0,
    checkin: {
      checkedInToday: false,
      streak: 0,
      todayAmount: null,
      nextAmount: 5,
      today: "2026-11-22",
      ladder: [{ minStreak: 1, amount: 5 }],
      days: [],
      backfill: { enabled: true, cost: 50, maxDays: 3 },
    },
  },
  "/api/me/reports": { reports: [] },
  "/api/me/profile-share": { share: null },
  "/api/me/notifications": { items: [], unread: 0 },
  "/api/me/notifications/unread-count": { unread: 0 },
  "/api/me/showcase": { showcase: null },
  "/api/plaza/posts": { ...FEED_EMPTY, topic: null },
  "/api/plaza/topics": { topics: [] },
  "/api/plaza/profiles": FEED_EMPTY,
  "/api/plaza/trial-shares": FEED_EMPTY,
  "/api/note/me": {
    ok: true,
    note: null,
    balance: 0,
    freeDrawsPerDay: 1,
    drawCostCoins: 10,
    reportHideThreshold: 5,
  },
  "/api/note/threads": { ok: true, threads: [] },
  "/api/coins/overview": {
    balance: 0,
    totalEarned: 0,
    totalSpent: 0,
    checkin: {
      checkedInToday: false,
      streak: 0,
      todayAmount: null,
      nextAmount: 5,
      today: "2026-11-22",
      ladder: [{ minStreak: 1, amount: 5 }],
      days: [],
      backfill: { enabled: true, cost: 50, maxDays: 3 },
    },
    earnedToday: 0,
    dailyRewardCap: 100,
    features: { checkin: true, challenges: true, gacha: true, submissions: true },
  },
  "/api/coins/challenges": { challenges: [] },
  "/api/coins/transactions": {
    transactions: [],
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 1,
  },
  "/api/gacha/pools": { pools: [] },
  "/api/gacha/collection": { items: [], total: 0 },
  "/api/submissions": { submissions: [] },
  "/api/series": { series: [] },
};

async function mockPublicApi(page: Page) {
  await page.route("**://telegram.org/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: TELEGRAM_STUB }),
  );
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const body = API_MOCKS[url.pathname];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body ?? {}),
    });
  });
}

interface ScreenCase {
  path: string;
  /** 页面稳定地标（数据/壳渲染完成的信号），一律用匿名态可见文案。 */
  landmark: RegExp;
}

const SCREENS: ScreenCase[] = [
  { path: "/me", landmark: /我的|匿名|注册/ },
  { path: "/plaza", landmark: /广场|树洞|档案/ },
  { path: "/notes", landmark: /纸条/ },
  { path: "/coins", landmark: /金币|签到|登录/ },
  { path: "/gacha", landmark: /奖池|抽卡|金币|登录/ },
  { path: "/submissions", landmark: /投稿/ },
  { path: "/series", landmark: /系列|书架|连载|还没有/ },
  { path: "/auth", landmark: /邮箱账号|登录|注册/ },
];

for (const viewport of VIEWPORTS) {
  for (const screen of SCREENS) {
    test(`public ${screen.path} @ ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockPublicApi(page);

      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(`pageerror: ${String(error)}`));
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
      });

      await page.goto(screen.path, { waitUntil: "domcontentloaded" });
      await expect(page.locator("h1, main, [data-theme]").first()).toBeVisible({ timeout: 10_000 });
      // 地标放宽为页面级：/auth 是独立卡片页（无 <main>），各屏匿名/登录闸口
      // 态文案不同——强绑死具体文案会让规格随批次文案改动而脆断。
      await expect(page.getByText(screen.landmark).first()).toBeVisible({ timeout: 10_000 });
      // 懒加载页签（/submissions 等）在 Suspense 过渡期的瞬态 DOM 会让 a11y 扫描
      // 误报（aria-prohibited-attr 曾在过渡帧出现，稳定态为零）——等网络空闲
      // 再扫（截断至 5s，避免个别长轮询端点拖死用例）。
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${screen.path} 横向溢出 ${overflow}px`).toBeLessThanOrEqual(1);
      expect(problems, `${screen.path} 控制台/页面错误:\n${problems.join("\n")}`).toEqual([]);

      await scanA11y(page, test.info().title);

      await expect(page).toHaveScreenshot(
        `public-${screen.path.replaceAll("/", "")}-${viewport.width}x${viewport.height}.png`,
        { maxDiffPixelRatio: 0.002 },
      );
    });
  }
}
