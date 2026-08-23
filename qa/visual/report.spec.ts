import { expect, test } from "@playwright/test";

const TEMPLATES = [
  { id: "classic", name: "经典报告" },
  { id: "magazine-dark", name: "杂志暗色" },
  { id: "data", name: "数据分析" },
  { id: "identity", name: "身份档案" },
  { id: "magazine", name: "杂志" },
  { id: "minimal", name: "极简" },
  { id: "gallery", name: "影集" },
];

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];

for (const template of TEMPLATES) {
  for (const viewport of VIEWPORTS) {
    test(`report ${template.id} @ ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);

      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(`pageerror: ${String(error)}`));
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
      });

      await page.goto(`/fixtures/report/${template.id}.html`);
      await expect(page.locator("h1").first()).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      expect(problems).toEqual([]);

      await expect(page).toHaveScreenshot(
        `report-${template.id}-${viewport.width}x${viewport.height}.png`,
        { maxDiffPixelRatio: 0.002 },
      );
    });
  }
}

// PDF layout is independent from the responsive web layout: print media is
// forced to a single A4 column even though the viewport width would otherwise
// trigger the desktop grid.
for (const template of TEMPLATES) {
  test(`report ${template.id} print (A4)`, async ({ page }) => {
    await page.setViewportSize({ width: 794, height: 1123 });
    await page.emulateMedia({ media: "print" });

    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${String(error)}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
    });

    await page.goto(`/fixtures/report/${template.id}.html`);
    await expect(page.locator("h1").first()).toBeVisible();

    const wrapDisplay = await page.evaluate(() => {
      const wrap = document.querySelector(".wrap");
      return wrap ? getComputedStyle(wrap).display : null;
    });
    expect(wrapDisplay).toBe("block");
    expect(problems).toEqual([]);

    await expect(page).toHaveScreenshot(
      `report-${template.id}-print-A4.png`,
      { maxDiffPixelRatio: 0.002 },
    );
  });
}
