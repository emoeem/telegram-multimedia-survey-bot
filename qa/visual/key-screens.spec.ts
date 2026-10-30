import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { scanA11y } from "./a11y";

/**
 * 关键页面视觉基线（2026-10-30 固化）。
 *
 * 上一轮人工截的 40 张对比图是一次性的；这里把最容易回退的四类页面钉进
 * CI 已有的 visual 门禁（`pnpm test:visual:gate`，ci.yml visual job）：
 *   1. 场景题 1440×900 桌面舞台版式
 *   2. 场景题 390×844 竖屏 + 844×390 横屏
 *   3. VN 对话页 390×844（含「声音开关收进顶栏、不压对话框」的防回退断言）
 *   4. 认证卡盖章反馈 390×844
 *
 * 素材全部 1px GIF / 仓库内 WAV，离线可跑（联网的用例单独打 @production，
 * 不属于 push 门禁）。断言的是版式与控件几何，不是图像内容。
 */
const GIF_1PX = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const BGM_WAV = readFileSync(new URL("../fixtures/showcase-sample.wav", import.meta.url));

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

const SCENE_ID = 140;
const VN_ID = 141;
/** 问卷主题背景 / VN 节点图 / BGM 走的媒体 id（路由按 id 分流图片与音频）。 */
const MEDIA = { bg: 9002, node: 9003, bgm: 9001 };

function surveySkeleton(id: number) {
  return {
    id,
    title: "关键页面视觉基线",
    description: "防回退用例。",
    accessCodeRequired: false,
    anonymous: true,
    allowMultiple: false,
    maxResponses: 1,
    display: "auto",
    pages: [{ id: 1, title: "序章" }],
    questions: [],
  };
}

/** 单场景 + 两个热点（与 survey-display.spec.ts 同构，断言几何与版式）。 */
function sceneSurvey() {
  const survey = surveySkeleton(SCENE_ID) as Record<string, unknown>;
  survey.theme = null;
  survey.questions = [
    {
      id: 1,
      type: "scene",
      title: "雨夜书房",
      description: "点击画面里发亮的区域。",
      required: true,
      order: 1,
      pageId: 1,
      validation: null,
      settings: {
        scene: {
          version: 1,
          start: "room",
          scenes: {
            room: {
              id: "room",
              title: "雨夜书房",
              image: `/api/survey/media/${MEDIA.bg}`,
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
                  action: { kind: "image", src: `/api/survey/media/${MEDIA.node}`, title: "窗外" },
                },
                {
                  id: "desk",
                  x: 0.6,
                  y: 0.6,
                  w: 0.3,
                  h: 0.3,
                  label: "书桌",
                  meta: "02",
                  action: { kind: "image", src: `/api/survey/media/${MEDIA.node}`, title: "书桌" },
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
  ];
  return survey;
}

/** VN 模式问卷：主题背景 + BGM + 叙事节点（note + speaker + 节点图）。 */
function vnSurvey() {
  const survey = surveySkeleton(VN_ID) as Record<string, unknown>;
  survey.theme = {
    vn: true,
    background: { image: `/api/survey/media/${MEDIA.bg}` },
    audio: { url: `/api/survey/media/${MEDIA.bgm}` },
  };
  survey.questions = [
    {
      id: 1,
      type: "note",
      title: "",
      description: "雨夜，废弃书房的门虚掩着。推开它，灰尘在手电光柱里翻涌。",
      required: false,
      order: 1,
      pageId: 1,
      validation: null,
      settings: { speaker: "？？？" },
      condition: null,
      skipToQuestionId: null,
      media: [{ url: `/api/survey/media/${MEDIA.node}`, alt: "" }],
      options: [],
    },
  ];
  return survey;
}

async function installSurveyRoutes(page: Page, survey: unknown) {
  const def = survey as { id: number };
  await page.addInitScript(TELEGRAM_STUB);
  await page.route("**/api/survey/media/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/api/survey/media/${MEDIA.bgm}`)) {
      void route.fulfill({ contentType: "audio/wav", body: BGM_WAV });
      return;
    }
    void route.fulfill({ contentType: "image/gif", body: Buffer.from(GIF_1PX, "base64") });
  });
  await page.route(`**/api/survey/${def.id}/responses`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ responseId: 1, resumed: false, currentQuestionId: null }),
    }),
  );
  await page.route(`**/api/survey/${def.id}/responses/1`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ answers: {} }) }),
  );
  await page.route(`**/api/survey/${def.id}**`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(def) }),
  );
}

async function rectOf(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom };
    });
}

test.describe("关键页面 · 场景题", () => {
  test("1440×900 桌面：舞台版式铺开", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installSurveyRoutes(page, sceneSurvey());
    await page.goto(`/s/${SCENE_ID}`);
    await expect(page.locator("[data-layout]")).toHaveAttribute("data-layout", "stage");
    await expect(page.locator(".hotspot-stage")).toBeVisible();
    await expect(page).toHaveScreenshot("key-scene-1440x900.png", { maxDiffPixelRatio: 0.002 });
  });

  test("390×844 竖屏：阅读窄卡", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installSurveyRoutes(page, sceneSurvey());
    await page.goto(`/s/${SCENE_ID}`);
    await expect(page.locator("[data-layout]")).toHaveAttribute("data-layout", "reading");
    await expect(page.locator(".hotspot-stage")).toBeVisible();
    await scanA11y(page, test.info().title);
    await expect(page).toHaveScreenshot("key-scene-390x844.png", { maxDiffPixelRatio: 0.002 });
  });

  test("844×390 横屏：场景仍在且不被裁切", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await installSurveyRoutes(page, sceneSurvey());
    await page.goto(`/s/${SCENE_ID}`);
    await expect(page.locator(".hotspot-stage")).toBeVisible();
    await expect(page).toHaveScreenshot("key-scene-844x390.png", { maxDiffPixelRatio: 0.002 });
  });
});

test.describe("关键页面 · VN 对话", () => {
  test("390×844：对话框沉底、声音开关收进顶栏（不压正文）", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installSurveyRoutes(page, vnSurvey());
    await page.goto(`/s/${VN_ID}`);

    await expect(page.locator("[data-vn='1']")).toHaveCount(1);
    const dialog = page.locator(".vn-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.locator(".vn-dialog-speaker")).toHaveText("？？？");

    // 打字机逐字动画结束后再截图（完成态不保留 role=button）。
    await expect(page.locator(".vn-dialog-text span[role='button']")).toHaveCount(0, { timeout: 15_000 });

    // 2026-10-30 回归护栏：悬浮静音钮曾压住 VN 对话框正文，现收进顶栏。
    // 断言两点：按钮在 header 内；对话框整体在 header 之下，几何上无交叠。
    const soundBtn = page.locator("header button[aria-label='开启声音']");
    await expect(soundBtn).toHaveCount(1);
    const headerRect = await rectOf(page, "header");
    const dialogRect = await rectOf(page, ".vn-dialog");
    expect(dialogRect.y).toBeGreaterThanOrEqual(headerRect.bottom - 1);

    await scanA11y(page, test.info().title);
    await expect(page).toHaveScreenshot("key-vn-dialog-390x844.png", { maxDiffPixelRatio: 0.002 });
  });
});

test.describe("关键页面 · 认证卡盖章", () => {
  test("390×844：印章定格在卡面中央", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // 认证卡是独立单文件页（cert.html），线上只有这些 API 且全部失败降级，
    // 这里拦截成 404 让它走本地默认主题，行为与离线 file:// 一致。
    await page.route("**/api/cert*/**", (route) =>
      route.fulfill({ status: 404, body: "{}", contentType: "application/json" }),
    );
    await page.goto("/cert/cert.html");

    // 盖章动画「落下 0.42s + 淡出 0.3s + 900ms 自毁」是瞬态：冻结两件事让
    // 截图确定性成立——① 应用里 ≥800ms 的 setTimeout（印章 900ms 自毁定时器）
    // 不再触发；② 动画整体关掉并把 overlay 钉在终态姿势。
    await page.evaluate(() => {
      const original = window.setTimeout;
      window.setTimeout = (handler: TimerHandler, delay?: number, ...args: unknown[]) =>
        (delay ?? 0) >= 800
          ? 0
          : (original as (h: TimerHandler, d?: number, ...a: unknown[]) => number)(handler, delay, ...args);
    });
    await page.addStyleTag({
      content: `.stamp-overlay { animation: none !important; opacity: 0.92 !important; transform: scale(1) rotate(-10deg) !important; }
.canvas-wrap.stamp-press #card { animation: none !important; }`,
    });

    const certify = page.locator("#certifyBtn");
    await expect(certify).toBeVisible();
    await certify.click();

    const overlay = page.locator(".stamp-overlay");
    await expect(overlay).toBeVisible();
    await expect(page.locator(".canvas-wrap")).toHaveClass(/stamp-press/);
    // 0.01：动画冻结后印章边缘仍有抗锯齿级抖动，CI 上偶发超出 0.002（已在
    // 真 CI 环境重拍基线并验证吻合，放宽只为吸收这层噪声）。
    await expect(page).toHaveScreenshot("key-cert-stamp-390x844.png", { maxDiffPixelRatio: 0.01 });
  });
});
