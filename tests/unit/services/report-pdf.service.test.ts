import { describe, expect, it } from "vitest";

import { buildReportPdfDocument } from "../../../src/services/report/pdf";

const profile = {
  resultType: "survey_result",
  title: "PDF 报告",
  subtitle: "自动生成",
  fields: {},
  stats: [
    { id: "s1", label: "总分", value: 80, max: 100 },
  ],
  tags: ["测试"],
  images: {},
  metadata: {
    profile: [{ label: "问题一", value: "回答一" }],
  },
  schemaVersion: 1,
};

describe("report PDF pipeline", () => {
  it("builds a print-ready document from the shared ReportViewModel", () => {
    const html = buildReportPdfDocument(profile, {}, {
      surveyTitle: "问卷标题",
      reportId: "#42",
    });

    expect(html).toContain("PDF 报告");
    expect(html).toContain("问卷标题");
    expect(html).toContain("回答一");
    expect(html).toContain("@media print");
  });
});
