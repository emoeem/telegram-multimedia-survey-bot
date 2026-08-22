import { describe, expect, it } from "vitest";

import {
  DEFAULT_REPORT_TEMPLATE,
  MAGAZINE_DARK_TEMPLATE,
  validateReportTemplateSpec,
} from "../../../src/services/report/template";
import { buildResponsiveReportHtml } from "../../../src/services/report/web";
import type { ReportViewModel } from "../../../src/services/report/model";

const view: ReportViewModel = {
  hero: { title: "结果报告", subtitle: "副标题", tags: ["标签"] },
  scores: [
    { key: "s1", label: "总分", value: 80, max: 100, percentage: 80, level: "HIGH" },
  ],
  charts: { radar: [], bars: [] },
  tags: ["标签"],
  insights: [],
  quotes: [],
  gallery: [],
  summary: "总结内容",
  profile: [{ id: "a1", sourceId: "q1", label: "问题", value: "回答" }],
  contentStats: { answerCount: 1, imageCount: 0, longTextCount: 0, scoreCount: 1 },
  meta: {},
};

describe("report template system", () => {
  it("validates template specs", () => {
    const ok = validateReportTemplateSpec({
      id: "custom",
      name: "自定义",
      theme: "dracula",
      sections: [{ kind: "cover" }, { kind: "scores" }],
      renderers: ["web", "pdf"],
      css: ".x{}",
    });
    expect(ok.error).toBeUndefined();
    expect(ok.template?.sections).toHaveLength(2);

    expect(validateReportTemplateSpec({ id: "x", name: "x", theme: "nope", sections: [{ kind: "hero" }] }).error).toBeDefined();
    expect(validateReportTemplateSpec({ id: "x", name: "x", theme: "dracula", sections: [{ kind: "sparkles" }] }).error).toBeDefined();
  });

  it("renders exactly the sections a template declares, in order", () => {
    const html = buildResponsiveReportHtml(view, {}, {
      ...DEFAULT_REPORT_TEMPLATE,
      sections: [
        { kind: "summary", title: "我的总结" },
        { kind: "answers" },
      ],
    });
    expect(html).toContain("我的总结");
    expect(html).toContain("回答明细");
    expect(html).not.toContain("得分概览");
    expect(html).not.toContain("分析解读");
  });

  it("applies the template theme and custom css", () => {
    const html = buildResponsiveReportHtml(view, {}, {
      ...DEFAULT_REPORT_TEMPLATE,
      theme: "dracula",
      css: ".report-cover{border:3px dashed red}",
    });
    expect(html).toContain("--report-bg:#282a36");
    expect(html).toContain(".report-cover{border:3px dashed red}");
  });

  it("renders a magazine cover section from the built-in template", () => {
    const html = buildResponsiveReportHtml(view, {}, MAGAZINE_DARK_TEMPLATE);
    expect(html).toContain("report-cover");
    expect(html).toContain("结果报告");
    expect(html).toContain("--report-bg:#282a36");
  });
});
