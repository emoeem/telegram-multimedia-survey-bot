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
      {
        // 场景题不是最后一题：沉浸式底栏走浮动胶囊分支（最后一题带「公开发布」
        // 区块时底栏保持静态，见 SurveyApp 的 stageNavOverlay 裁决）。
        id: 2,
        type: "text",
        title: "补充一句",
        description: null,
        required: false,
        order: 2,
        pageId: null,
        validation: null,
        settings: null,
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

/**
 * 取元素几何。用 evaluate 而不是 locator.boundingBox()：后者会等元素「稳定」
 * （连续两帧位置不变），答卷页有进度/音效等状态更新时容易直接等到超时。
 */
async function rectOf(page: Page, selector: string) {
  const rect = await page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  return rect;
}

async function stageBox(page: Page) {
  await expect(page.locator(".hotspot-stage")).toHaveCount(1);
  return rectOf(page, ".hotspot-stage");
}

test.describe("显示模式 · 沉浸", () => {
  test("immersive：舞台铺满整个视口，浮动底栏悬浮其上（不裁切、不滚动）", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await installRoutes(page, "immersive");
    await page.goto(`/s/${SURVEY_ID}`);

    // 布局契约：场景题 + immersive → stage 版式。
    await expect(page.locator("[data-layout]")).toHaveAttribute("data-layout", "stage");
    await expect(page.locator(".stage-frame-box")).toBeVisible();
    await expect(page.locator(".hotspot-stage")).toBeVisible();

    const stage = await stageBox(page);

    // 沉浸式（2026-10-30）：底栏是浮动胶囊（pointer-events 覆盖层），舞台
    // 吃满整个视口高度——旧的「舞台底边 ≤ 底栏顶边」契约随静态底栏一起退役。
    expect(stage.y).toBeGreaterThanOrEqual(-1);
    expect(stage.y + stage.height).toBeLessThanOrEqual(900 + 1);
    // 舞台宽度应明显大于阅读版式的上限（768px），证明真的铺开了。
    expect(stage.width).toBeGreaterThan(800);
    // 整页不滚动（100dvh flex 列）；横向也不能溢出。
    const metrics = await page.evaluate(() => ({
      scrollY: document.documentElement.scrollHeight - window.innerHeight,
      scrollX: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect(metrics.scrollY).toBeLessThanOrEqual(1);
    expect(metrics.scrollX).toBeLessThanOrEqual(1);
    // 头部信息条默认完全让位给画面（translateY 出视口）。
    const headerTop = await page.evaluate(
      () => (document.querySelector(".survey-float-header") as HTMLElement).getBoundingClientRect().bottom,
    );
    expect(headerTop).toBeLessThanOrEqual(0);

    await expect(page).toHaveScreenshot("survey-display-immersive-1600x900.png", { maxDiffPixelRatio: 0.002 });
  });

  test("auto：场景题桌面（≥1024）上舞台（2026-10-29 重设计）", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await installRoutes(page, "auto");
    await page.goto(`/s/${SURVEY_ID}`);
    // 场景是画布优先题型：宽屏不再窄卡居中（两侧空白是明确的使用反馈）。
    await expect(page.locator("[data-layout]")).toHaveAttribute("data-layout", "stage");
    await expect(page.locator(".hotspot-stage")).toBeVisible();
    // 场景引导语沉入头部信息条（滑出可见）。
    await expect(page.locator(".survey-stage-intro")).toContainText("点击画面里发亮的区域。");
    await expect(page).toHaveScreenshot("survey-display-auto-1600x900.png", { maxDiffPixelRatio: 0.002 });
  });

  test("auto：场景题窄屏/手机竖屏也上舞台（2026-10-30 沉浸式重设计）", async ({ page }) => {
    // 旧契约是 <1024 维持阅读窄卡；重设计后场景题全宽度上舞台——
    // before 实测手机 390 竖屏窄卡只有 18% 可视面积，是本次的主诉。
    await page.setViewportSize({ width: 900, height: 900 });
    await installRoutes(page, "auto");
    await page.goto(`/s/${SURVEY_ID}`);
    await expect(page.locator("[data-layout]")).toHaveAttribute("data-layout", "stage");
    await expect(page.locator(".hotspot-stage")).toBeVisible();
    const stage = await stageBox(page);
    expect(stage.width).toBeGreaterThan(800);
    // 手机竖屏（390）：舞台吃满整宽，宽度就是视口宽。
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const phoneBox = await stageBox(page);
    expect(phoneBox.width).toBe(390);
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflowX).toBeLessThanOrEqual(1);
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
    await expect(page.locator("[data-layout]")).toHaveAttribute("data-layout", "reading");
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

    await expect(page.locator("[data-layout]")).toHaveAttribute("data-layout", "stage");
    // 竖屏提示在横屏下不出现。
    await expect(page.getByText("横过来看，场景会铺满整块屏幕。")).toHaveCount(0);

    const box = await stageBox(page);
    // 短横屏沉浸式：舞台吃满整条视口高度（浮动底栏悬浮其上，不再静态占位）。
    expect(box.height).toBeGreaterThan(390 * 0.95);
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflowX).toBeLessThanOrEqual(1);

    await expect(page).toHaveScreenshot("survey-display-landscape-844x390.png", { maxDiffPixelRatio: 0.002 });
  });
});
