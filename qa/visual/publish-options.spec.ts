import { expect, test, type Page } from "@playwright/test";

/**
 * 「公开发布到 Telegram」的三项选择弹窗（迁移 0092）。
 *
 * 这里覆盖的是**只有真浏览器才能证明的部分**：勾选后确实先弹窗、弹窗里的三项
 * 都能操作、选「仅自己可见」时留言被禁用、提交请求体里三个字段名正确、失败时
 * 错误横幅真的出现在视口内（而不是"点了没反应"）。
 *
 * 纯逻辑（限长、归一化、摘要文案、视口换算）在 vitest 里另有单测；这里不重复，
 * 只钉交互契约——字段名错了，后端就等于永远收不到"匿名"，而界面上看起来一切正常。
 */
const SURVEY_ID = 128;
const ARTIFACTS = "qa/artifacts/publish-options";

const SURVEY = {
  id: SURVEY_ID,
  title: "夜行电车",
  description: "公开发布弹窗回归用问卷。",
  accessCodeRequired: false,
  anonymous: false,
  allowMultiple: false,
  maxResponses: 1,
  theme: null,
  pages: [],
  galleryProfile: { enabled: false, canPublish: false },
  questions: [
    {
      id: 11,
      type: "text",
      title: "给三年后的自己留一句话",
      required: false,
      order: 0,
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

type SubmitCapture = { body: Record<string, unknown> | null };

async function installRoutes(page: Page, capture: SubmitCapture, submitStatus = 200): Promise<void> {
  await page.addInitScript(() => {
    window.close = () => {};
  });
  await page.route("**://telegram.org/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "window.Telegram={WebApp:{initData:'',ready(){},expand(){}}};",
    }),
  );
  await page.route("**/api/**", (route) => route.abort());
  await page.route(`**/api/survey/${SURVEY_ID}`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(SURVEY) }),
  );
  await page.route(`**/api/survey/${SURVEY_ID}/responses`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ responseId: 7, resumed: false, currentQuestionId: null }),
    }),
  );
  await page.route(`**/api/survey/${SURVEY_ID}/responses/7`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ answers: {} }) }),
  );
  await page.route(`**/api/survey/${SURVEY_ID}/responses/7/answers`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) }),
  );
  await page.route(`**/api/survey/${SURVEY_ID}/responses/7/submit`, async (route) => {
    capture.body = route.request().postDataJSON() as Record<string, unknown>;
    if (submitStatus !== 200) {
      await route.fulfill({
        status: submitStatus,
        contentType: "application/json",
        body: JSON.stringify({ code: "server_error", error: "服务器开小差了，请稍后重试" }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, completed: true, reportUrl: `/report/7?t=x` }),
    });
  });
}

async function openDialog(page: Page): Promise<void> {
  await page.goto(`/s/${SURVEY_ID}`);
  await expect(page.getByText(SURVEY.questions[0]!.title).first()).toBeVisible();
  // 最后一题的「公开发布」勾选框：点它不直接开闸，而是先弹三项选择。
  // 用 click 而不是 check：确认之前复选框必须保持未勾（见下面的用例），
  // 而 check() 会等到元素变成 checked，那正是这里要禁止的行为。
  await page.getByRole("checkbox").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("勾选「公开发布」先弹窗问三项，而不是直接开闸", async ({ page }) => {
  const capture: SubmitCapture = { body: null };
  await installRoutes(page, capture);

  await page.goto(`/s/${SURVEY_ID}`);
  await expect(page.getByText(SURVEY.questions[0]!.title).first()).toBeVisible();
  // 勾选之前没有任何发布选项。
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.getByRole("checkbox").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("是否公布")).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /公开/ })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /仅自己可见/ })).toBeVisible();
  await expect(dialog.getByText("匿名发布")).toBeVisible();
  await expect(dialog.getByRole("textbox")).toBeVisible();

  await page.screenshot({ path: `${ARTIFACTS}/dialog-desktop.png`, fullPage: false });
});

test("确认之前勾选框保持未勾；取消弹窗也不改变它", async ({ page }) => {
  const capture: SubmitCapture = { body: null };
  await installRoutes(page, capture);
  await openDialog(page);

  // 上一版把 checked 写成 `publishToTelegram || publishDialogOpen`：弹窗一开
  // 就显示为已勾，取消后又弹回未选——同一个控件在两次操作里说两种话。
  await expect(page.getByRole("checkbox").first()).not.toBeChecked();

  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("checkbox").first()).not.toBeChecked();
  await expect(page.getByText(/公开发布 ·/)).toBeHidden();
});

test("匿名默认开启，留言计入字数并在确认后显示摘要", async ({ page }) => {
  const capture: SubmitCapture = { body: null };
  await installRoutes(page, capture);
  await openDialog(page);

  const dialog = page.getByRole("dialog");
  // 匿名是默认值：频道消息发出去收不回来，"公开身份"必须是主动取消勾选。
  const anonymous = dialog.getByRole("checkbox");
  await expect(anonymous).toBeChecked();

  await dialog.getByRole("textbox").fill("这次的第 3 题我纠结了很久");
  await expect(dialog.getByText("14/200")).toBeVisible();

  await dialog.getByRole("button", { name: /确定公开/ }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  // 摘要让"我到底选了什么"一眼可见。
  await expect(page.getByText(/公开发布 · 匿名（不显示 Telegram 信息） · 留言 14 字/)).toBeVisible();
});

test("选「仅自己可见」：留言框禁用，确认按钮改文案，勾选框回到未选", async ({ page }) => {
  const capture: SubmitCapture = { body: null };
  await installRoutes(page, capture);
  await openDialog(page);

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: /仅自己可见/ }).check();
  await expect(dialog.getByRole("textbox")).toBeDisabled();
  await dialog.getByRole("button", { name: /仅自己可见/ }).click();

  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText(/仅自己可见 · 不会发布到频道/)).toBeVisible();
  await expect(page.getByRole("checkbox").first()).not.toBeChecked();
});

test("提交请求体带 publishToTelegram / publishAnonymous / publishMessage 三个字段", async ({ page }) => {
  const capture: SubmitCapture = { body: null };
  await installRoutes(page, capture);
  await openDialog(page);

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("  留言有首尾空白  ");
  await dialog.getByRole("button", { name: /确定公开/ }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.getByRole("button", { name: /提交问卷/ }).click();
  await expect.poll(() => capture.body).not.toBeNull();
  expect(capture.body).toMatchObject({
    publishToTelegram: true,
    publishAnonymous: true,
    // 首尾空白在提交时裁掉（编辑中不裁，否则词间空格会被吃掉）。
    publishMessage: "留言有首尾空白",
  });
});

test("提交失败时错误文案出现在视口内（不是点了没反应）", async ({ page }) => {
  const capture: SubmitCapture = { body: null };
  await installRoutes(page, capture, 500);
  await page.goto(`/s/${SURVEY_ID}`);
  await expect(page.getByText(SURVEY.questions[0]!.title).first()).toBeVisible();

  await page.getByRole("button", { name: /提交问卷/ }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  // 具体文案来自 API 层（HTTP 码），重要的是它出现了、可读、且提示可重试。
  await expect(alert).toContainText("HTTP 500");

  // 关键断言：横幅必须落在视口里。旧实现把横幅放在题目卡片内部，点底部固定的
  // 提交按钮后它在屏幕外，看起来就是"没反应"。
  const box = await alert.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  await page.screenshot({ path: `${ARTIFACTS}/submit-failure.png`, fullPage: false });
});

test("手机尺寸（390×844，Mini App 典型视口）弹窗可完整操作", async ({ page }) => {
  const capture: SubmitCapture = { body: null };
  await page.setViewportSize({ width: 390, height: 844 });
  await installRoutes(page, capture);
  await openDialog(page);

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("手机上也能打字");
  await expect(dialog.getByRole("textbox")).toHaveValue("手机上也能打字");
  // 底部弹出的面板不能溢出视口（键盘弹起时靠 visualViewport 收缩，见 modal-viewport.ts）。
  const box = (await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(844);

  await page.screenshot({ path: `${ARTIFACTS}/dialog-mobile.png`, fullPage: false });
});
