import { expect, test, type Page } from "@playwright/test";
import { scanA11y } from "./a11y";

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

const now = "2026-08-23T12:00:00Z";
const API_MOCKS: Record<string, unknown> = {
  "/api/trial/packs": {
    packs: [
      {
        id: 1,
        name: "示例 · 楼道挑战",
        description: "虚构模拟：逐层上行，每层抽取一个任务。",
        // 0106 起 /api/trial/packs 带出包级 adult：mock 与服务端同形（18+ 包）。
        gameType: "tower",
        gameLabel: "爬塔挑战",
        adult: true,
        normalFloors: 10,
        hellFloors: 12,
        prepItems: ["手机（计时用）", "一杯水", "便签纸和笔"],
        prepText: "出发前把准备清单放在门口，按顺序确认。",
      },
    ],
  },
  "/api/trial/me": { telegram: false, isAdmin: false },
  "/api/trial/runs/active": { run: null },
  // 0106 包级 ack 交互用：确认 18+ 后开局进入商店阶段。
  "/api/trial/runs": {
    run: {
      id: 1,
      packId: 1,
      packName: "示例 · 楼道挑战",
      persona: "male",
      mode: "normal",
      currentFloor: 1,
      maxFloor: 10,
      score: 0,
      completedTasks: 0,
      skippedTasks: 0,
      status: "active",
      phase: "shop",
      coins: 60,
      inventory: { skipTickets: 0, boosters: 0, shields: 0 },
      boosted: false,
    },
    task: null,
  },
  "/api/trial/history": { runs: [] },
  "/api/trial/leaderboard": { entries: [] },
};

async function mockTrialApi(page: Page) {
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

for (const viewport of VIEWPORTS) {
  test(`trial home @ ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockTrialApi(page);

    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${String(error)}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
    });

    await page.goto("/trial", { waitUntil: "domcontentloaded" });
    // 0106 起 /trial 无整页 18+ 门禁：首页包卡直接渲染，adult 包带包卡级徽标。
    // BottomNav 把 /trial 页签改名为「小游戏」后，页面里不再有「挑战任务」字样；
    // 这里断言 mock 小游戏包真正渲染出来（首页加载数据的信号）。
    await expect(page.getByText("示例 · 楼道挑战")).toBeVisible();
    await expect(page.getByText("18+", { exact: true })).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(problems).toEqual([]);

    await scanA11y(page, test.info().title);

    await expect(page).toHaveScreenshot(`trial-home-${viewport.width}x${viewport.height}.png`, {
      maxDiffPixelRatio: 0.002,
    });

    // 包级 ack 交互（0106）：未 ack 的 adult 包开局先弹按包确认弹层，确认后
    // 落包级键并携带 adultAck 参数开局，进入商店阶段（ack 后路径）。
    // M9 手风琴（2026-11-22 用户验收）：包卡默认折叠——先点包卡展开，
    // 身份/模式等开局内容才挂载。
    await page.getByText("示例 · 楼道挑战").first().click();
    await expect(page.getByRole("button", { name: /任务按公向文案抽取/ })).toBeVisible();
    await page.getByRole("button", { name: /任务按公向文案抽取/ }).click();
    await page.getByRole("button", { name: /以「公 · 普通」开始/ }).click();
    await expect(page.getByRole("button", { name: /我已年满 18 周岁/ })).toBeVisible();
    const startRequest = page.waitForRequest(
      (request) => request.url().includes("/api/trial/runs") && request.method() === "POST",
    );
    await page.getByRole("button", { name: /我已年满 18 周岁/ }).click();
    await startRequest;
    await expect(page.getByText("开局商店")).toBeVisible();
  });
}
