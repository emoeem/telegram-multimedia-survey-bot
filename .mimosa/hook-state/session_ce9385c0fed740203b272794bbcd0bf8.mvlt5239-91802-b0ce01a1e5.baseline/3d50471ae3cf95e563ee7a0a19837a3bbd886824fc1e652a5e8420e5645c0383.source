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

  /*
   * 翻页由两套机制驱动：横向哨兵的 IntersectionObserver，和 scroller 自己的
   * `onScroll`（滚到距尾部半个屏内就加载）。原来这里是一次性的
   * `scrollLeft = scrollWidth` + 手搓一个 `scroll` 事件——单跑能过，4 并发下
   * 偶发超时：那一刻布局还没稳定，滚动位置被夹回，随后手搓的事件已经用掉了，
   * 真实几何再变化也不会再触发一次。
   *
   * 改成「反复滚到尾部直到第二页到位」：读的是真实滚动（不是手搓事件），
   * 每次轮询都重设一次位置，所以一次被夹回不会让整个用例判死。
   */
  await expect
    .poll(
      async () => {
        await scroller.evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
        });
        return page.locator(".showcase-slide").count();
      },
      { timeout: 15_000, intervals: [300, 500, 800, 1_200], message: "横向哨兵没有加载第二页" },
    )
    .toBe(25);

  // 只加载一页：加载中与 nextCursor=null 两道闸都必须生效，否则反复滚动会把
  // 同一个 cursor 反复请求。
  expect(requests).toBe(2);
});
