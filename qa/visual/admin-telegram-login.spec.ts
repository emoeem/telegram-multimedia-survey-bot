import { expect, test } from "@playwright/test";

test.describe("admin password login", () => {
  test("logs in and performs a hard navigation after success", async ({ page }) => {
    await page.route("**/api/admin/auth/password", async (route) => {
      expect(route.request().method()).toBe("POST");
      expect((await route.request().postDataJSON()).password).toBe("test-password");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Set-Cookie": "admin_session=test-session; Path=/; HttpOnly; SameSite=Lax" },
        body: JSON.stringify({ ok: true, redirect: "/admin" }),
      });
    });
    await page.goto("/admin/login");
    await page.getByLabel("管理员密码").fill("test-password");
    await page.getByRole("button", { name: "登录管理后台" }).click();
    await expect(page).toHaveURL(/\/admin\/?$/, { timeout: 5_000 });
  });

  test("shows incorrect-password errors without navigating", async ({ page }) => {
    await page.route("**/api/admin/auth/password", async (route) => {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "管理员密码错误" }) });
    });
    await page.goto("/admin/login");
    await page.getByLabel("管理员密码").fill("wrong-password");
    await page.getByRole("button", { name: "登录管理后台" }).click();
    await expect(page.getByRole("alert")).toHaveText("管理员密码错误");
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test("shows rate-limit errors", async ({ page }) => {
    await page.route("**/api/admin/auth/password", async (route) => {
      await route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "60" }, body: JSON.stringify({ message: "操作过于频繁，请稍后再试" }) });
    });
    await page.goto("/admin/login");
    await page.getByLabel("管理员密码").fill("test-password");
    await page.getByRole("button", { name: "登录管理后台" }).click();
    await expect(page.getByRole("alert")).toHaveText("操作过于频繁，请稍后再试");
  });
});
