import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const adminSrc = join(process.cwd(), "admin", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * Guards the admin bundle split: ECharts (~1.1 MB) and the editor screens must
 * never be pulled back into the initial chunk by a top-level import. A static
 * import here silently doubles the first paint cost on a Telegram WebView, so
 * the regression is caught by tests instead of by a bundle-size report.
 */
describe("admin code splitting", () => {
  it("loads every route through React.lazy", () => {
    const app = readFileSync(join(adminSrc, "App.tsx"), "utf8");
    const routeImports = app.match(/^const \w+ = lazy\(/gm) ?? [];

    expect(routeImports.length).toBeGreaterThan(10);
    expect(routeImports.every((line) => line.includes("lazy("))).toBe(true);
  });

  it("defers echarts-for-react to a dynamic import", () => {
    const source = readFileSync(join(adminSrc, "components", "EChart.tsx"), "utf8");

    expect(source).toContain('import("echarts-for-react")');
    expect(source).not.toMatch(/^import\s+ReactECharts\s+from\s+["']echarts-for-react["']/m);
  });

  it("has no static echarts import anywhere in the admin source", () => {
    const offenders = walk(adminSrc)
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return /^import\s[^;]*from\s+["'](?:echarts|echarts-for-react)["']/m.test(source);
      });

    expect(offenders).toEqual([]);
  });
});
