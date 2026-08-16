import { describe, expect, it } from "vitest";

import { buildSurveySummaryReportHtml } from "../../../src/services/survey-report.service";

describe("survey report service", () => {
  it("escapes survey content and renders aggregate statistics", () => {
    const html = buildSurveySummaryReportHtml({
      surveyTitle: "<问卷>",
      surveyId: 7,
      generatedAt: "2026/08/15 13:00:00",
      statistics: { totalStarted: 10, totalCompleted: 8, completionRate: 80 },
      optionStatistics: [{
        questionId: 1,
        questionTitle: "喜欢 <script>",
        questionType: "single",
        optionId: 2,
        optionLabel: "A & B",
        count: 8,
        percentage: 100,
      }],
      numericStatistics: [{
        questionId: 3,
        questionTitle: "评分",
        count: 8,
        average: 4.25,
        min: 1,
        max: 5,
      }],
    });

    expect(html).toContain("&lt;问卷&gt;");
    expect(html).toContain("喜欢 &lt;script&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).toContain("4.25");
  });
});
