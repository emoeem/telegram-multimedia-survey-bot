import { describe, expect, it } from "vitest";

import {
  buildResponseReportHtml,
  type ResponseReport,
} from "../../../src/services/response-report.service";

describe("response report service", () => {
  it("renders Chinese answers and escapes untrusted content", () => {
    const report: ResponseReport = {
      surveyTitle: "测试问卷 <script>",
      responseNumber: 2,
      status: "已完成",
      respondent: "@tester",
      startedAt: "2026/08/15 09:00:00",
      completedAt: "2026/08/15 09:05:00",
      items: [
        {
          number: 1,
          title: "你的回答？",
          answer: "<img src=x onerror=alert(1)>",
          media: [
            {
              label: "图片 · answer.jpg",
              imageDataUrl: "data:image/png;base64,AAAA",
            },
          ],
        },
      ],
    };

    const html = buildResponseReportHtml(report);

    expect(html).toContain("测试问卷 &lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("第 2 份答卷");
    expect(html).toContain("data:image/png;base64,AAAA");
  });
});
