import { expect, test, type Page } from "@playwright/test";

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

interface MediaRef {
  url: string;
}

interface FixtureOption {
  id: number;
  label: string;
  media: MediaRef[];
}

interface FixtureQuestion {
  id: number;
  type: string;
  title: string;
  description?: string;
  required: boolean;
  order: number;
  pageId: number | null;
  validation: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  condition: Record<string, unknown> | null;
  skipToQuestionId: number | null;
  media: MediaRef[];
  options: FixtureOption[];
}

interface FixtureSurvey {
  id: number;
  title: string;
  description?: string;
  accessCodeRequired: boolean;
  anonymous: boolean;
  allowMultiple: boolean;
  maxResponses: number;
  theme: Record<string, unknown> | null;
  pages: Array<{ id: number; title: string | null; description: string | null; order: number }>;
  questions: FixtureQuestion[];
}

interface Fixture {
  id: number;
  firstQuestionTitle: string;
  survey: FixtureSurvey;
}

function question(overrides: Partial<FixtureQuestion> & { id: number; type: string; title: string }): FixtureQuestion {
  return {
    required: true,
    order: 0,
    pageId: null,
    validation: null,
    settings: null,
    condition: null,
    skipToQuestionId: null,
    media: [],
    options: [],
    ...overrides,
  };
}

function option(id: number, label: string, media: MediaRef[] = []): FixtureOption {
  return { id, label, media };
}

const LONG_TITLE =
  "这是一个非常非常长的题目标题，用来验证移动端长文本折叠与换行排版是否正常，避免文字溢出屏幕或者把选项挤到题目外面去，长度足够覆盖两到三行手机屏幕";

const LONG_OPTION =
  "这是一个特别长的选项文本，长度足够让它在手机屏幕上换行两三次，用来确认选项文字不会溢出卡片边界，也不会撑破整个问卷页面布局，保持阅读顺畅";

const FIXTURES: Fixture[] = [
  {
    id: 101,
    firstQuestionTitle: "你的名字",
    survey: {
      id: 101,
      title: "基础问卷",
      description: "用于视觉回归的基础问卷。",
      accessCodeRequired: false,
      anonymous: true,
      allowMultiple: false,
      maxResponses: 1,
      theme: null,
      pages: [],
      questions: [
        question({ id: 1, type: "text", title: "你的名字", required: false }),
        question({
          id: 2,
          type: "single",
          title: "最喜欢的颜色",
          options: [option(1, "红色"), option(2, "蓝色"), option(3, "绿色"), option(4, "其他")],
        }),
        question({ id: 3, type: "long_text", title: "自我介绍", required: false }),
      ],
    },
  },
  {
    id: 102,
    firstQuestionTitle: LONG_TITLE,
    survey: {
      id: 102,
      title: "长文本压力测试",
      description:
        "本问卷包含超长标题、超长描述与超长选项，专门用于验证溢出与折叠。" +
        "描述文本继续补充更多内容，确保其长度足以触发折叠逻辑，让视觉回归能够真正覆盖长文本场景。",
      accessCodeRequired: false,
      anonymous: true,
      allowMultiple: false,
      maxResponses: 1,
      theme: null,
      pages: [],
      questions: [
        question({
          id: 1,
          type: "single",
          title: LONG_TITLE,
          options: [
            option(1, LONG_OPTION),
            option(2, `${LONG_OPTION}（第二个更长的变体，继续延长到四行左右以便观察排版）`),
          ],
        }),
      ],
    },
  },
  {
    id: 103,
    firstQuestionTitle: "十选一",
    survey: {
      id: 103,
      title: "多选项压力测试",
      accessCodeRequired: false,
      anonymous: true,
      allowMultiple: false,
      maxResponses: 1,
      theme: null,
      pages: [],
      questions: [
        question({
          id: 1,
          type: "single",
          title: "十选一",
          options: Array.from({ length: 12 }, (_, index) => option(index + 1, `选项 ${index + 1}`)),
        }),
        question({
          id: 2,
          type: "multiple",
          title: "多选八项",
          options: Array.from({ length: 8 }, (_, index) => option(index + 1, `多选项 ${index + 1}`)),
        }),
      ],
    },
  },
  {
    id: 104,
    firstQuestionTitle: "带媒体题目",
    survey: {
      id: 104,
      title: "媒体布局测试",
      accessCodeRequired: false,
      anonymous: true,
      allowMultiple: false,
      maxResponses: 1,
      theme: null,
      pages: [],
      questions: [
        question({
          id: 1,
          type: "single",
          title: "带媒体题目",
          media: [{ url: "/api/survey/media/1" }, { url: "/api/survey/media/2" }],
          options: [option(1, "带图选项", [{ url: "/api/survey/media/3" }]), option(2, "普通选项")],
        }),
        question({ id: 2, type: "image", title: "图片上传题", required: false }),
      ],
    },
  },
  {
    id: 105,
    firstQuestionTitle: "主题问卷",
    survey: {
      id: 105,
      title: "深蓝夜主题",
      accessCodeRequired: false,
      anonymous: true,
      allowMultiple: false,
      maxResponses: 1,
      theme: { preset: "night" },
      pages: [],
      questions: [
        question({
          id: 1,
          type: "single",
          title: "主题问卷",
          options: [option(1, "选项 A"), option(2, "选项 B"), option(3, "选项 C")],
        }),
      ],
    },
  },
  {
    id: 106,
    firstQuestionTitle: "第一页问题",
    survey: {
      id: 106,
      title: "分页问卷",
      accessCodeRequired: false,
      anonymous: true,
      allowMultiple: false,
      maxResponses: 1,
      theme: null,
      pages: [
        { id: 1, title: "第一页", description: null, order: 0 },
        { id: 2, title: "第二页", description: null, order: 1 },
      ],
      questions: [
        question({ id: 1, type: "text", title: "第一页问题", pageId: 1, required: false }),
        question({ id: 2, type: "text", title: "第二页问题", pageId: 2, required: false }),
      ],
    },
  },
];

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

async function installRoutes(page: Page, fixture: Fixture): Promise<void> {
  // Registered first so it only catches calls the specific handlers below
  // deliberately leave unmatched (Playwright checks routes in reverse order).
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**://telegram.org/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: TELEGRAM_STUB }),
  );
  await page.route("**/api/survey/media/**", (route) =>
    route.fulfill({ contentType: "image/gif", body: Buffer.from(GIF_1PX, "base64") }),
  );
  await page.route(`**/api/survey/${fixture.id}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(fixture.survey),
    }),
  );
  await page.route(`**/api/survey/${fixture.id}/responses`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ responseId: 1, resumed: false, currentQuestionId: null }),
    }),
  );
  await page.route(`**/api/survey/${fixture.id}/responses/1`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ answers: {} }),
    }),
  );
}

for (const fixture of FIXTURES) {
  for (const viewport of VIEWPORTS) {
    test(`survey ${fixture.id} @ ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await installRoutes(page, fixture);

      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(`pageerror: ${String(error)}`));
      page.on("requestfailed", (request) => problems.push(`requestfailed: ${request.method()} ${request.url()}`));
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
      });

      await page.goto(`/s/${fixture.id}`);
      await expect(page.getByText(fixture.firstQuestionTitle).first()).toBeVisible();

      if (fixture.survey.theme?.preset) {
        await expect(page.locator(".min-h-dvh")).toHaveAttribute("data-theme", String(fixture.survey.theme.preset));
      }

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      expect(problems).toEqual([]);

      await expect(page).toHaveScreenshot(`survey-${fixture.id}-${viewport.width}x${viewport.height}.png`, {
        maxDiffPixelRatio: 0.002,
      });
    });
  }
}

test("hides the bottom nav while an input is focused", async ({ page }) => {
  const fixture = FIXTURES.find((item) => item.id === 101);
  if (!fixture) throw new Error("fixture 101 missing");
  await page.setViewportSize(VIEWPORTS[0]);
  await installRoutes(page, fixture);

  await page.goto(`/s/${fixture.id}`);
  const input = page.locator("main input").first();
  await expect(input).toBeVisible();

  await input.click();
  await expect(page.locator("nav")).toHaveClass(/translate-y-full/);

  await page.locator("main h1").click();
  await expect(page.locator("nav")).not.toHaveClass(/translate-y-full/);
});

test("lets the participant switch the survey theme", async ({ page }) => {
  const fixture = FIXTURES.find((item) => item.id === 105);
  if (!fixture) throw new Error("fixture 105 missing");
  await page.setViewportSize(VIEWPORTS[0]);
  await installRoutes(page, fixture);

  await page.goto(`/s/${fixture.id}`);
  await expect(page.locator(".min-h-dvh")).toHaveAttribute("data-theme", "night");

  await page.getByRole("button", { name: "选择主题" }).click();
  await page.getByRole("button", { name: /黑金奢华/ }).click();
  await expect(page.locator(".min-h-dvh")).toHaveAttribute("data-theme", "luxury");
});
