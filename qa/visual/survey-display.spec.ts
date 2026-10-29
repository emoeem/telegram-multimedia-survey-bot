import { expect, test, type Page } from "@playwright/test";
import { scanA11y } from "./a11y";

/**
 * 显示模式（settings_json.display）的视觉用例。
 *
 * 三件事只有真布局才看得见，所以必须靠截图钉住：
 *  1. immersive：桌面宽屏下场景舞台按视口高度收、不再窄居中；
 *  2. landscape：手机竖屏出现可关闭的横屏提示条（不是遮挡遮罩）；
 *  3. landscape：横屏（短屏）下场景铺满可用高度、头部仍在。
 *
 * 素材用 1px GIF 占位——断言的是**几何与版式**（尺寸/位置/是否可见），
 * 不是图像内容，所以不需要真实插画。
 */
const GIF_1PX = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

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

const SURVEY_ID = 130;

/** 单场景 + 两个热点：场景题是显示模式的主要受益者。 */
function sceneSurvey(display: "auto" | "immersive" | "landscape") {
  return {
    id: SURVEY_ID,
    title: "显示模式视觉用例",
    description: "用于验证沉浸与横屏版式。",
    accessCodeRequired: false,
    anonymous: true,
    allowMultiple: false,
    maxResponses: 1,
    theme: null,
    display,
    pages: [],
    questions: [
      {
        id: 1,
        type: "scene",
        title: "雨夜书房",
        description: "点击画面里发亮的区域。",
        required: true,
        order: 1,
        pageId: null,
        validation: null,
        settings: {
          scene: {
            version: 1,
            start: "room",
            scenes: {
              room: {
                id: "room",
                title: "雨夜书房",
                image: "/api/survey/media/1",
                width: 1600,
                height: 1000,
                hotspots: [
                  {
                    id: "window",
                    x: 0.05,
                    y: 0.08,
                    w: 0.3,
                    h: 0.5,
                    label: "窗外",
                    meta: "01",
                    action: { kind: "image", src: "/api/survey/media/2", title: "窗外" },
                  },
                  {
                    id: "desk",
                    x: 0.6,
                    y: 0.6,
                    w: 0.3,
                    h: 0.3,
                    label: "书桌",
                    meta: "02",
                    action: { kind: "image", src: "/api/survey/media/3", title: "书桌" },
                  },
                ],
              },
            },
          },
        },
        condition: null,
        skipToQuestionId: null,
        media: [],
        options: [],
      },
    ],
  };
}

async function installRoutes(page: Page, display: "auto" | "immersive" | "landscape") {
  await page.addInitScript(TELEGRAM_STUB);
  const survey = sceneSurvey(display);
  await page.route("**/api/survey/media/**", (route) =>
    route.fulfill({ contentType: "image/gif", body: Buffer.from(GIF_1PX, "base64") }),
  );
  await page.route(`**/api/survey/${SURVEY_ID}/responses`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ responseId: 1, resumed: false, currentQuestionId: null }),
    }),
  );
  await page.route(`**/api/survey/${SURVEY_ID}/responses/1`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ answers: {} }) }),
  );
  await page.route(`**/api/survey/${SURVEY_ID}**`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(survey) }),
  );
}

async function stageBox(page: Page) {
  const box = await page.locator(".hotspot-stage").boundingBox();
  if (!box) throw new Error(".hotspot-stage 未渲染");
  return box;
}

test.describe("显示模式 · 沉浸", () => {
  test("immersive：桌面宽屏下场景舞台明显宽于默认版式", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });

    await installRoutes(page, "auto");
    await page.goto(`/s/${SURVEY_ID}`);
    await expect(page.locator(".hotspot-stage")).toBeVisible();
    const narrow = await stageBox(page);

    await installRoutes(page, "immersive");
    await page.goto(`/s/${SURVEY_ID}`);
    await expect(page.locator(".min-h-dvh")).toHaveAttribute("data-display", "immersive");
    const wide = await stageBox(page);

    // 默认版式受 max-w-3xl（768px）限制。沉浸版式的宽由「视口高度 - 头部/底栏」
    // 反推（场景必须一屏放得下、不滚动），1600×900 下约 1000px——比默认宽 1.35 倍。
    expect(narrow.width).toBeLessThan(800);
    expect(wide.width).toBeGreaterThan(narrow.width * 1.35);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await expect(page).toHaveScreenshot("survey-display-immersive-1600x900.png", { maxDiffPixelRatio: 0.002 });
  });

  test("auto：同一视口保持窄版式（回归护栏）", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await installRoutes(page, "auto");
    await page.goto(`/s/${SURVEY_ID}`);
    await expect(page.locator(".hotspot-stage")).toBeVisible();
    await expect(page).toHaveScreenshot("survey-display-auto-1600x900.png", { maxDiffPixelRatio: 0.002 });
  });
});

test.describe("显示模式 · 手机横屏优先", () => {
  test("portrait 手机：出现横屏提示条，且不遮挡答题内容", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installRoutes(page, "landscape");
    await page.goto(`/s/${SURVEY_ID}`);

    const hint = page.getByText("横过来看，场景会铺满整块屏幕。");
    await expect(hint).toBeVisible();
    await expect(page.getByRole("button", { name: "全屏横屏" })).toBeVisible();
    // 提示是条状而非遮罩：场景舞台仍然可见可点。
    await expect(page.locator(".hotspot-stage")).toBeVisible();
    await expect(page.getByText("雨夜书房").first()).toBeVisible();

    await scanA11y(page, test.info().title);
    await expect(page).toHaveScreenshot("survey-display-landscape-portrait-390x844.png", {
      maxDiffPixelRatio: 0.002,
    });
  });

  test("提示可关闭：关掉后不再出现", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installRoutes(page, "landscape");
    await page.goto(`/s/${SURVEY_ID}`);
    await page.getByRole("button", { name: "关闭横屏提示" }).click();
    await expect(page.getByText("横过来看，场景会铺满整块屏幕。")).toHaveCount(0);
  });

  test("横屏（短屏）：场景铺满可用高度", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await installRoutes(page, "landscape");
    await page.goto(`/s/${SURVEY_ID}`);

    await expect(page.locator(".min-h-dvh")).toHaveAttribute("data-display", "landscape");
    // 竖屏提示在横屏下不出现。
    await expect(page.getByText("横过来看，场景会铺满整块屏幕。")).toHaveCount(0);

    const box = await stageBox(page);
    // 短横屏下场景高度应吃掉视口的大部分（留头部与底部操作条）。
    expect(box.height).toBeGreaterThan(390 * 0.45);
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflowX).toBeLessThanOrEqual(1);

    await expect(page).toHaveScreenshot("survey-display-landscape-844x390.png", { maxDiffPixelRatio: 0.002 });
  });
});
