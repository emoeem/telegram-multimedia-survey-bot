/**
 * Renders static report HTML fixtures for every built-in template so the
 * Playwright QA suite can screenshot reports offline (no API/auth needed).
 * Run via: vite-node scripts/generate-report-fixtures.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_TEMPLATES } from "../src/services/report/template";
import { buildResponsiveReportHtml } from "../src/services/report/web";
import { reportFixtureViewModel } from "../qa/report-fixture";

const outDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../qa/fixtures/report",
);

await mkdir(outDir, { recursive: true });

for (const template of Object.values(REPORT_TEMPLATES)) {
  const html = buildResponsiveReportHtml(
    reportFixtureViewModel,
    {
      surveyTitle: "堕落游戏",
      completedAt: "2026-08-23 14:00",
      reportId: "#188",
    },
    template,
  );
  await writeFile(resolve(outDir, `${template.id}.html`), html, "utf-8");
}

console.log(`generated ${Object.keys(REPORT_TEMPLATES).length} report fixtures`);
