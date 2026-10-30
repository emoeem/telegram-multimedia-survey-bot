import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { scanA11y } from "./a11y";

/**
 * 互动场景题（scene）的端到端走查：热点点击 → 内层弹层 → 子场景切换 →
 * 答案落库 payload → 必答门禁 → 提交。
 *
 * 全部 /api/** 被 mock（abort + 白名单），场景图走 /fixtures/hotspot/ 的
 * 真实 WebP；断言的核心是「参与者真的探索过」会以
 * `{kind:"scene",visited:[…]}` 的形状 POST 到 answers 端点。
 */

const SURVEY_ID = 990;
const ARTIFACTS = "qa/artifacts/hotspot";

const FIX = (name: string) => `/fixtures/hotspot/${name}`;
const ALT_ROOM = "雨夜书房全景插画";
const ALT_WINDOW = "窗外雨夜的街";

function hotspot(spot: { id: string; x: number; y: number; w: number; h: number; label: string }, action: unknown) {
  return { id: spot.id, x: spot.x, y: spot.y, w: spot.w, h: spot.h, label: spot.label, action };
}

const SCENE_SETTINGS = {
  scene: {
    version: 1,
    start: "room",
    scenes: {
      room: {
        id: "room",
        title: "雨夜书房",
        intro: "点击画面里发亮的区域。",
        image: FIX("scene-room.webp"),
        width: 1600,
        height: 1000,
        alt: ALT_ROOM,
        hotspots: [
          hotspot(
            { id: "window", x: 0.05, y: 0.08, w: 0.31, h: 0.58, label: "窗外" },
            {
              kind: "image",
              src: FIX("detail-window.webp"),
              title: "窗外",
              caption: "雨没有停。",
              note: "你看了很久，才听见自己的呼吸。",
            },
          ),
          hotspot(
            { id: "cat", x: 0.37, y: 0.76, w: 0.18, h: 0.22, label: "猫" },
            {
              kind: "image",
              src: FIX("detail-cat.webp"),
              title: "猫",
              caption: "它睡了。",
            },
          ),
          hotspot(
            { id: "shelf", x: 0.835, y: 0.08, w: 0.15, h: 0.5, label: "书架" },
            {
              kind: "scene",
              sceneId: "shelf",
            },
          ),
        ],
      },
      shelf: {
        id: "shelf",
        title: "书架 · 第二层",
        intro: "有些东西被放在这里。",
        image: FIX("scene-shelf.webp"),
        width: 1600,
        height: 1000,
        alt: "书架特写插画",
        hotspots: [
          hotspot(
            { id: "book", x: 0.175, y: 0.3, w: 0.115, h: 0.24, label: "旧书" },
            {
              kind: "image",
              src: FIX("detail-book.webp"),
              title: "旧书",
              caption: "书页里夹着一张车票。",
            },
          ),
        ],
      },
    },
  },
};

const SURVEY = {
  id: SURVEY_ID,
  title: "雨夜书房 · 互动场景",
  description: "场景题回归用问卷。",
  accessCodeRequired: false,
  anonymous: true,
  allowMultiple: false,
  maxResponses: 1,
  theme: null,
  pages: [{ id: 1, title: "雨夜书房", description: null, order: 0 }],
  questions: [
    {
      id: 1,
      type: "scene",
      title: "探索这间书房",
      description: "点击画面里发亮的区域查看细节。",
      required: true,
      order: 0,
      pageId: 1,
      validation: null,
      settings: SCENE_SETTINGS,
      condition: null,
      skipToQuestionId: null,
      media: [
        { url: FIX("scene-room.webp"), alt: ALT_ROOM },
        { url: FIX("scene-shelf.webp"), alt: "书架特写插画" },
        { url: FIX("detail-window.webp"), alt: ALT_WINDOW },
        { url: FIX("detail-cat.webp"), alt: "熟睡的黑猫" },
        { url: FIX("detail-book.webp"), alt: "夹着车票的旧书" },
      ],
      options: [],
    },
    {
      id: 2,
      type: "long_text",
      title: "离开之前",
      description: "留一句话（可空）。",
      required: false,
      order: 1,
      pageId: 1,
      validation: null,
      settings: null,
      condition: null,
      skipToQuestionId: null,
      media: [],
      options: [],
    },
  ],
};

interface CapturedAnswer {
  questionId: number;
  value: unknown;
}

async function installRoutes(page: Page): Promise<{ answers: CapturedAnswer[]; submitted: boolean }> {
  const captured: CapturedAnswer[] = [];
  let submitted = false;
  await page.addInitScript(() => {
    window.close = () => {};
  });
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**://telegram.org/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.Telegram = { WebApp: { initData: "", ready() {}, expand() {}, close() {} } };`,
    }),
  );
  await page.route(`**/api/survey/${SURVEY_ID}`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(SURVEY) }),
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
  await page.route(`**/api/survey/${SURVEY_ID}/responses/1/answers`, (route) => {
    const body = route.request().postDataJSON() as CapturedAnswer;
    captured.push(body);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route(`**/api/survey/${SURVEY_ID}/responses/1/submit`, (route) => {
    submitted = true;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, completed: true, reportUrl: "/report/x" }),
    });
  });
  return {
    answers: captured,
    get submitted() {
      return submitted;
    },
  };
}

function spot(page: Page, label: string) {
  return page.getByRole("button", { name: new RegExp(`^${label}，`) });
}

test.beforeAll(() => {
  mkdirSync(ARTIFACTS, { recursive: true });
});

// 2026-10-30 沉浸式重设计后场景题在全宽度走 stage 版式（无 .hotspot-plate，
// 场景标题由 StageFrame 的 aria-label 承载、meta 变左上悬浮 pill）。
// 本文件覆盖热点/弹层/子场景/累计语义，钉在 900×800（stage 版式）运行。
test.use({ viewport: { width: 900, height: 800 } });

test("热点点击展开内层图片，答案以 {kind:scene,visited} 落库", async ({ page }, testInfo) => {
  const captured = await installRoutes(page);
  await page.goto(`/s/${SURVEY_ID}`);
  await expect(page.locator(".hotspot-stage img")).toBeVisible();
  await expect(page.locator(".hotspot-spot")).toHaveCount(3);

  await scanA11y(page, `${testInfo.title} · 场景`);

  // 必答门禁：没探索就点继续，必须被拦下（undefined 值走通用必答文案）。
  await page.getByRole("button", { name: /继续/ }).click();
  await expect(page.getByText(/此题必答|至少探索一处高亮区域/)).toBeVisible();

  await spot(page, "窗外").click();
  const modal = page.locator(".hotspot-modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator("h3")).toHaveText("窗外");
  await expect(modal.locator(".hotspot-modal-note")).toContainText("呼吸");
  await expect(modal.locator("img")).toHaveAttribute("alt", ALT_WINDOW);
  await page.screenshot({ path: `${ARTIFACTS}/modal-window.png` });

  // 探索即落库：payload 必须是 {kind:"scene",visited:["window"]}。
  await expect
    .poll(() => captured.answers.at(-1), "点击热点后答案应立即入队落库")
    .toEqual({ questionId: 1, value: { kind: "scene", visited: ["window"] } });

  await scanA11y(page, `${testInfo.title} · 弹层`);
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();

  // 选框进入已探索态；进度提示更新（room 3 + shelf 1 = 总数 4）。
  await expect(spot(page, "窗外")).toHaveClass(/is-visited/);
  await expect(page.locator(".hotspot-meta")).toContainText("1 / 4");

  writeFileSync(`${ARTIFACTS}/scene-room.html`, await page.content());
});

test("子场景切换、返回，跨场景 visited 连续累计", async ({ page }) => {
  const captured = await installRoutes(page);
  await page.goto(`/s/${SURVEY_ID}`);
  await expect(page.locator(".hotspot-stage img")).toBeVisible();

  await spot(page, "书架").click();
  // stage 版式没有 .hotspot-plate：子场景标题由 StageFrame 的 aria-label 承载。
  await expect(page.locator(".stage-frame[aria-label='书架 · 第二层']")).toBeVisible();
  // 切场景是「预载完成再换图」，到这里图片应已就位，不出现黑屏帧。
  await expect(page.locator(".hotspot-stage img")).toHaveAttribute("src", FIX("scene-shelf.webp"));
  await expect(page.locator(".hotspot-back")).toBeVisible();
  await page.screenshot({ path: `${ARTIFACTS}/scene-shelf.png` });

  await spot(page, "旧书").click();
  const modal = page.locator(".hotspot-modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator("h3")).toHaveText("旧书");
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();

  // 回到第一个场景：探索进度跨场景累计（书架 + 旧书 = 2，总数 3+1=4）。
  await page.locator(".hotspot-back").click();
  await expect(page.locator(".stage-frame[aria-label='雨夜书房']")).toBeVisible();
  await expect(page.locator(".hotspot-meta")).toContainText("2 / 4");
  await expect.poll(() => captured.answers.at(-1)?.value).toEqual({ kind: "scene", visited: ["shelf", "book"] });
});

test("探索后继续走到下一题并提交", async ({ page }) => {
  const captured = await installRoutes(page);
  await page.goto(`/s/${SURVEY_ID}`);
  await expect(page.locator(".hotspot-stage img")).toBeVisible();

  await spot(page, "猫").click();
  await expect(page.locator(".hotspot-modal h3")).toHaveText("猫");
  await page.locator(".hotspot-modal-back").click();
  await expect(page.locator(".hotspot-modal")).toBeHidden();

  await page.getByRole("button", { name: /继续/ }).click();
  await expect(page.getByText("离开之前")).toBeVisible();

  await page.getByRole("textbox").fill("晚安。");
  // 输入框保持聚焦时底栏按「键盘弹出」语义隐藏（navHidden=inputFocused），
  // 这是平台行为；先失焦再点提交。
  await page.getByRole("textbox").blur();
  await page.getByRole("button", { name: /提交问卷/ }).click();
  await expect.poll(() => captured.submitted).toBe(true);
  // 两题的答案都应经过 answers 端点（scene 题在探索与翻题时各入队一次，
  // 与平台「重发幂等」的保存模型一致，这里只关心两题都到了）。
  expect(new Set(captured.answers.map((entry) => entry.questionId))).toEqual(new Set([1, 2]));
});
