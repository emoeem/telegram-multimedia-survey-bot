import { expect, test } from "@playwright/test";

function showcasePerson(id: number) {
  return {
    id,
    name: `创作者 ${id}`,
    subtitle: "分页测试",
    description: null,
    accentColor: null,
    background: { from: "#182042", to: "#05070d", imageUrl: null },
    illustrationUrl: null,
    avatarUrl: null,
    tags: [],
    links: [],
    surveyId: null,
    featured: false,
    items: [],
  };
}

test("showcase loads the next cursor page when the horizontal sentinel enters the scroller", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/showcase?*", async (route) => {
    requests += 1;
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get("cursor");
    if (!cursor) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: Array.from({ length: 24 }, (_, index) => showcasePerson(index + 1)),
          total: 25,
          limit: 24,
          nextCursor: "next-page",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [showcasePerson(25)], total: 25, limit: 24, nextCursor: null }),
    });
  });

  await page.goto("/showcase");
  await expect(page.locator(".showcase-slide")).toHaveCount(24);

  const scroller = page.locator(".showcase-scroller");
  await scroller.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  await expect.poll(() => page.locator(".showcase-slide").count(), { timeout: 10_000 }).toBe(25);
  expect(requests).toBe(2);
});
