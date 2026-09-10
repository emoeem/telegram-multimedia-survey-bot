import { expect, test, type Page } from "@playwright/test";

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
        normalFloors: 10,
        hellFloors: 12,
        prepItems: ["手机（计时用）", "一杯水", "便签纸和笔"],
        prepText: "出发前把准备清单放在门口，按顺序确认。",
      },
    ],
  },
  "/api/trial/me": { telegram: false, isAdmin: false },
  "/api/trial/runs/active": { run: null },
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
    await expect(page.getByText("挑战任务").first()).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(problems).toEqual([]);

    await expect(page).toHaveScreenshot(`trial-home-${viewport.width}x${viewport.height}.png`, {
      maxDiffPixelRatio: 0.002,
    });
  });
}
