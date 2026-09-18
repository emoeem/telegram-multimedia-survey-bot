import { expect, test } from "@playwright/test";

test.describe("Telegram admin login", () => {
  test("starts the deep link and automatically redirects after approval", async ({ page }) => {
    let approved = false;
    await page.route("**/api/admin/auth/telegram/start", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", headers: { "Set-Cookie": "admin_login_request=test-binding; Path=/; HttpOnly; SameSite=Lax" }, body: JSON.stringify({ loginUrl: "https://t.me/example_bot?start=admin_login_abcdefghijklmnopqrstuvwxyz123456", expiresIn: 300 }) });
    });
    await page.route("**/api/admin/auth/telegram/status", async (route) => {
      if (!approved) { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "pending" }) }); return; }
      await route.fulfill({ status: 200, contentType: "application/json", headers: { "Set-Cookie": "admin_session=test-session; Path=/; HttpOnly; SameSite=Lax" }, body: JSON.stringify({ status: "approved", redirect: "/admin" }) });
    });
    await page.goto("/admin/login");
    await page.getByRole("button", { name: "使用 Telegram 登录" }).click();
    await expect(page.getByRole("button", { name: "等待 Telegram 确认…" })).toBeDisabled();
    await expect(page.getByText("请在 Telegram 中点击「确认登录」")).toBeVisible();
    approved = true;
    await expect(page).toHaveURL(/\/admin\/?$/, { timeout: 5_000 });
  });

  test("shows expiry instead of looping forever", async ({ page }) => {
    await page.route("**/api/admin/auth/telegram/start", async (route) => { await route.fulfill({ status: 200, contentType: "application/json", headers: { "Set-Cookie": "admin_login_request=test-binding; Path=/; HttpOnly; SameSite=Lax" }, body: JSON.stringify({ loginUrl: "https://t.me/example_bot?start=admin_login_abcdefghijklmnopqrstuvwxyz123456", expiresIn: 300 }) }); });
    await page.route("**/api/admin/auth/telegram/status", async (route) => { await route.fulfill({ status: 410, contentType: "application/json", body: JSON.stringify({ code: "login_request_expired", message: "登录请求已过期，请重新开始。" }) }); });
    await page.goto("/admin/login");
    await page.getByRole("button", { name: "使用 Telegram 登录" }).click();
    await expect(page.getByText("登录请求已过期，请重新开始。"), { timeout: 5_000 }).toBeVisible();
    await expect(page.getByRole("button", { name: "使用 Telegram 登录" })).toBeEnabled();
  });

  test("shows rate-limit errors without navigating", async ({ page }) => {
    await page.route("**/api/admin/auth/telegram/start", async (route) => { await route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "60" }, body: JSON.stringify({ code: "rate_limited", message: "操作过于频繁，请稍后再试" }) }); });
    await page.goto("/admin/login");
    await page.getByRole("button", { name: "使用 Telegram 登录" }).click();
    await expect(page.getByText("操作过于频繁，请稍后再试")).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/login$/);
  });
});
