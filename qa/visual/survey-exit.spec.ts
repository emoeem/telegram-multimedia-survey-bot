import { expect, test, type Page } from "@playwright/test";

/**
 * Regression cover for "退出问卷无反应" on `/s/<id>`.
 *
 * `waitForTelegramWebApp()` lazily loads `telegram-web-app.js`, which installs
 * `window.Telegram.WebApp` in *every* browser — a plain tab included. Its
 * `close()` posts to a host that is only listening inside a real Mini App, so
 * outside Telegram it did nothing while the old code still returned early and
 * skipped the navigation fallbacks, leaving the participant stuck on the page.
 *
 * `initData` is the signal the Telegram client itself injects, so these tests
 * pin both sides of that boundary: an empty `initData` (plain browser) must
 * navigate away, a non-empty one (real Mini App) must defer to the bridge.
 */

const SURVEY_ID = 118;

/** Mirrors what `telegram-web-app.js` installs outside Telegram. */
function bridgeStub(initData: string): string {
  return `
window.Telegram = {
  WebApp: {
    initData: ${JSON.stringify(initData)},
    ready() {}, expand() {}, setHeaderColor() {},
    close() { window.__bridgeClosed = (window.__bridgeClosed || 0) + 1; }
  }
};
window.__bridgeClosed = 0;
`;
}

const SURVEY = {
  id: SURVEY_ID,
  title: "雨季信箱",
  description: "互动视觉小说回归用问卷。",
  accessCodeRequired: false,
  anonymous: true,
  allowMultiple: false,
  maxResponses: 1,
  theme: null,
  pages: [],
  questions: [
    {
      id: 1,
      type: "single",
      title: "第一晚，你要回哪一封信？",
      required: true,
      order: 0,
      pageId: null,
      validation: null,
      settings: null,
      condition: null,
      skipToQuestionId: null,
      media: [],
      options: [
        { id: 1, label: "回那封写了一半的信", media: [] },
        { id: 2, label: "先把信收进抽屉", media: [] },
      ],
    },
    {
      id: 2,
      type: "text",
      title: "你想说的第一句话",
      required: false,
      order: 1,
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

async function installRoutes(page: Page, initData: string): Promise<void> {
  // A user-opened tab cannot be closed by script; Playwright's page can, which
  // would end the test instead of exercising the navigation fallback.
  await page.addInitScript(() => {
    window.close = () => {};
  });
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**://telegram.org/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: bridgeStub(initData) }),
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
}

/** Starts the flow and leaves one question answered, so exit must confirm. */
async function startAndAnswer(page: Page): Promise<void> {
  await page.goto(`/s/${SURVEY_ID}`);
  await expect(page.getByText(SURVEY.questions[0]!.title).first()).toBeVisible();
  await page.getByText(SURVEY.questions[0]!.options[0]!.label, { exact: true }).click();
}

test("确定退出 actually leaves the survey outside Telegram", async ({ page }) => {
  await installRoutes(page, "");
  await startAndAnswer(page);

  await page.getByRole("button", { name: "退出问卷" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "确认", exact: true }).click();

  // The bug: `close()` ran against a host that is not listening and the early
  // return skipped every navigation fallback, so the page never changed.
  await expect(page).not.toHaveURL(new RegExp(`/s/${SURVEY_ID}`));
});

test("确定退出 returns to the page the participant came from", async ({ page }) => {
  await installRoutes(page, "");
  await page.goto("/s");
  await page.goto(`/s/${SURVEY_ID}`);
  await expect(page.getByText(SURVEY.questions[0]!.title).first()).toBeVisible();
  await page.getByText(SURVEY.questions[0]!.options[0]!.label, { exact: true }).click();

  await page.getByRole("button", { name: "退出问卷" }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();

  await expect(page).toHaveURL(/\/s$/);
});

test("取消 keeps the dialog closed and the answers intact", async ({ page }) => {
  await installRoutes(page, "");
  await startAndAnswer(page);

  // Selection in the generic option list is rendered visually (primary border
  // plus a check icon) rather than through aria-checked, so pin the class of
  // the selected option and require it to survive the cancelled exit.
  const selected = page.getByRole("button", { name: SURVEY.questions[0]!.options[0]!.label });
  const selectedClass = await selected.getAttribute("class");
  expect(selectedClass).toContain("survey-primary");

  await page.getByRole("button", { name: "退出问卷" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();

  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/s/${SURVEY_ID}`));
  expect(await selected.getAttribute("class")).toBe(selectedClass);
});

test("inside a real Mini App the bridge owns the exit", async ({ page }) => {
  await installRoutes(page, "user=%7B%22id%22%3A42%7D&hash=deadbeef");
  await startAndAnswer(page);

  await page.getByRole("button", { name: "退出问卷" }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();

  await expect.poll(() => page.evaluate(() => (window as { __bridgeClosed?: number }).__bridgeClosed)).toBe(1);
  // The WebView is closed by Telegram; the page must not navigate itself away.
  await expect(page).toHaveURL(new RegExp(`/s/${SURVEY_ID}`));
});
