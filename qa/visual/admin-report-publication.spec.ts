import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

/**
 * 答卷详情页的「公开发布到 Telegram」状态卡片。
 *
 * 这张卡片是 A#2 的界面一半：生产库里 32 条 `failed` 无人知，因为界面上从来
 * 没有这个状态。这里只断言**行为**（状态可见、失败可重投、请求打到正确的端点），
 * 不做截图比对——视觉基线只能在 CI 的字体环境里生成（见
 * qa/visual/survey.spec.ts 同款说明），本地更新会污染基线。
 */
const NOW = "2026-10-29T03:00:00Z";
const indexHtml = readFileSync("admin/dist/index.html", "utf-8");

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

function detailMock(status: string) {
  return {
    survey: { id: 1, title: "夜行电车", anonymous: false },
    response: {
      id: 10,
      status: "completed",
      statusLabel: "已完成",
      version: 1,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
      respondent: { telegramUserId: 100, username: "demo", firstName: "演示", lastName: null },
      participantKey: null,
      submittedAt: NOW,
      previousResponseId: null,
      nextResponseId: null,
      reportPublicationRequested: true,
      reportPublicationStatus: status,
      reportPublishedAt: status === "published" ? NOW : null,
    },
    answers: [],
  };
}

/**
 * 所有 api 请求走同一个处理器、按 pathname 分派（和 admin.spec.ts 一致）。
 *
 * 不用多个 page.route 硬拼的原因：详情请求带查询串，通配符要匹配到带 query
 * 的完整 URL，一旦不匹配就落到兜底 `{}`，页面读不到数据直接进错误边界——
 * 那会伪装成"我的改动把页面弄坏了"。
 *
 * 外壳 HTML 最后注册（Playwright 后注册者优先）：它的通配符也会命中
 * /api/admin/... ，所以它对 /api 前缀一律 fallback。
 */
async function mockAdmin(page: Page, status: string, onRetry?: () => void): Promise<void> {
  const detail = detailMock(status);
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/admin/surveys/1/responses/10/report-publication/retry") {
      onRetry?.();
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, status: "pending" }) });
    }
    if (url.pathname === "/api/admin/surveys/1/responses/10") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(detail) });
    }
    // 详情页顶部还有一份报告模板选择器：返回 `{}` 会让页面读 undefined.map 直接
    // 掉进错误边界（看起来像"新加的卡片把页面弄坏了"）。
    if (url.pathname === "/api/admin/report-templates") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          templates: [
            {
              id: "classic",
              name: "经典报告",
              theme: "catppuccin-latte",
              layout: "editorial",
              renderers: ["web", "pdf"],
            },
          ],
        }),
      });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({}) });
  });
  await page.route("**://telegram.org/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: TELEGRAM_STUB }),
  );
  await page.route("**/admin/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api")) return route.fallback();
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: indexHtml });
  });
}

test("发布失败：详情页显示 failed 状态并给出「重新发布」入口", async ({ page }) => {
  let retried = 0;
  await mockAdmin(page, "failed", () => {
    retried += 1;
  });

  await page.goto("/admin/surveys/1/responses/10", { waitUntil: "domcontentloaded" });

  const card = page.locator("section", { hasText: "公开发布到 Telegram" }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText("发布失败")).toBeVisible();
  // 失败的原因要能被看到：这里给出可执行的下一步，而不是一个红色标签。
  await expect(card.getByText(/可以重投续发/)).toBeVisible();

  await card.getByRole("button", { name: "重新发布" }).click();
  await expect.poll(() => retried).toBe(1);
  await expect(card.getByText("已重新入队，稍后刷新可看状态。")).toBeVisible();
});

test("排队中也可以看到状态（不是只有一个红色失败态）", async ({ page }) => {
  await mockAdmin(page, "pending");
  await page.goto("/admin/surveys/1/responses/10", { waitUntil: "domcontentloaded" });

  const card = page.locator("section", { hasText: "公开发布到 Telegram" }).first();
  await expect(card.getByText("排队发布中")).toBeVisible();
  // 没失败就不该出现重投按钮：那条路只对 failed 有意义。
  await expect(card.getByRole("button", { name: "重新发布" })).toHaveCount(0);
});

test("已发布：显示状态与发布时刻，且不提供重投", async ({ page }) => {
  await mockAdmin(page, "published");
  await page.goto("/admin/surveys/1/responses/10", { waitUntil: "domcontentloaded" });

  const card = page.locator("section", { hasText: "公开发布到 Telegram" }).first();
  await expect(card.getByText("已发布")).toBeVisible();
  await expect(card.getByText(/发布时刻/)).toBeVisible();
  await expect(card.getByRole("button", { name: "重新发布" })).toHaveCount(0);
});
