import { describe, expect, it } from "vitest";

import {
  buildExportContent,
  buildExportFileName,
  buildSurveyExportHtml,
  buildSurveyExportJson,
  buildSurveyExportMarkdown,
  describeValidation,
  escapeHtml,
  type ExportSurvey,
} from "../../admin/src/lib/survey-export";

const survey: ExportSurvey = {
  id: 7,
  title: "客户满意度调查",
  description: "三分钟填完",
  status: "published",
  pages: [
    { id: 1, title: "基本信息", description: null, order: 1 },
    { id: 2, title: "详细反馈", description: null, order: 2 },
  ],
  questions: [
    {
      id: 11,
      type: "single",
      title: "你的年龄段？",
      required: true,
      order: 1,
      pageId: 1,
      options: [
        { id: 1, label: "18-25", order: 1 },
        { id: 2, label: "26-35", order: 2 },
      ],
      validation: {},
    },
    {
      id: 12,
      type: "long_text",
      title: "还有什么想说的",
      required: false,
      order: 2,
      pageId: 2,
      options: [],
      validation: { max_length: 200 },
    },
  ],
};

describe("escapeHtml", () => {
  it("neutralises tags and attribute-breaking quotes", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(escapeHtml("a & b 'c'")).toBe("a &amp; b &#39;c&#39;");
  });
});

describe("describeValidation", () => {
  it("renders length, selection and scale constraints in plain Chinese", () => {
    expect(describeValidation({ min_length: 5, max_length: 200 })).toEqual(["5–200 字"]);
    expect(describeValidation({ min_selections: 1, max_selections: 3 })).toEqual(["选 1–3 项"]);
    expect(describeValidation({ scale_min: 1, scale_max: 5 })).toEqual(["评分 1–5"]);
    expect(describeValidation(null)).toEqual([]);
  });
});

describe("buildSurveyExportHtml", () => {
  const html = buildSurveyExportHtml([survey], { generatedAt: new Date("2026-01-02T03:04:05Z") });

  it("is a complete printable document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("@page{size:A4;margin:16mm}");
    expect(html).toContain("page-break-after:always");
    expect(html).toContain("window.print()");
  });

  it("renders every question with its type label and options", () => {
    expect(html).toContain("客户满意度调查");
    expect(html).toContain("你的年龄段？");
    expect(html).toContain("18-25");
    expect(html).toContain("多行文本");
    expect(html).toContain("*必答");
    expect(html).toContain("0–200 字");
  });

  it("groups questions under their page headings", () => {
    expect(html).toContain("基本信息");
    expect(html).toContain("详细反馈");
    // 第二页的题目必须出现在第二页标题之后
    expect(html.indexOf("还有什么想说的")).toBeGreaterThan(html.indexOf("详细反馈"));
  });

  it("escapes user content instead of injecting it", () => {
    const evil = buildSurveyExportHtml([{ ...survey, id: 9, title: '<img src=x onerror="alert(1)">', questions: [] }]);
    expect(evil).not.toContain("<img src=x onerror");
    expect(evil).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("keeps one article per survey and reports an empty selection", () => {
    const two = buildSurveyExportHtml([survey, { ...survey, id: 8, title: "第二份" }]);
    expect((two.match(/<article class="survey">/g) ?? []).length).toBe(2);
    expect(buildSurveyExportHtml([])).toContain("没有选中任何问卷");
  });
});

describe("buildSurveyExportMarkdown", () => {
  const markdown = buildSurveyExportMarkdown([survey], { generatedAt: new Date("2026-01-02T03:04:05Z") });

  it("writes one heading per question plus option list", () => {
    expect(markdown).toContain("# 客户满意度调查");
    expect(markdown).toContain("## 1. 你的年龄段？ **（必答）**");
    expect(markdown).toContain("- 18-25");
    expect(markdown).toContain("- 类型：多行文本");
    expect(markdown).toContain("- 限制：0–200 字");
  });

  it("escapes pipes in matrix columns so tables stay valid", () => {
    const matrix = buildSurveyExportMarkdown([
      {
        ...survey,
        questions: [
          {
            id: 1,
            type: "matrix",
            title: "评分",
            order: 1,
            columns: ["a|b", "c"],
            options: [],
          },
        ],
      },
    ]);
    expect(matrix).toContain("|  | a\\|b | c |");
  });
});

describe("buildSurveyExportJson", () => {
  it("keeps a structure that can be imported back", () => {
    const parsed = JSON.parse(buildSurveyExportJson([survey])) as {
      count: number;
      surveys: Array<{ id: number; questions: Array<{ options: unknown[] }> }>;
    };

    expect(parsed.count).toBe(1);
    expect(parsed.surveys[0]?.id).toBe(7);
    expect(parsed.surveys[0]?.questions).toHaveLength(2);
  });
});

describe("buildExportContent", () => {
  it("maps each format to its mime type and extension", () => {
    expect(buildExportContent("html", [survey]).extension).toBe("html");
    expect(buildExportContent("markdown", [survey]).mime).toBe("text/markdown");
    expect(buildExportContent("json", [survey]).mime).toBe("application/json");
  });
});

describe("buildExportFileName", () => {
  const stamp = new Date("2026-03-04T00:00:00Z");

  it("uses the survey title for a single export", () => {
    expect(buildExportFileName("html", [survey], stamp)).toBe("客户满意度调查-20260304.html");
  });

  it("uses the count for a batch export", () => {
    expect(buildExportFileName("json", [survey, { ...survey, id: 8 }], stamp)).toBe("surveys-2-20260304.json");
  });

  it("strips characters that break downloads on common filesystems", () => {
    const messy = buildExportFileName("markdown", [{ ...survey, title: 'a/b:c*?"<>|d' }], stamp);
    expect(messy).toBe("a-b-c-d-20260304.md");
  });
});

describe("分页分组不会丢题", () => {
  // 回归：导入器产出的 survey.json 里 `page_id` 是字符串 "p1"，编辑器接口给的
  // 是数字。早期实现只认数字并把不匹配的题目塞进 null 桶后丢弃，导致整卷题目
  // 在导出文件里消失（PDF 只剩标题页）。
  const paged: ExportSurvey = {
    id: 1,
    title: "带分页",
    pages: [
      { id: "p1", title: "第一页", description: null, order: 1 },
      { id: "p2", title: "第二页", description: null, order: 2 },
    ],
    questions: [
      { id: 1, type: "text", title: "甲", order: 1, pageId: "p1", options: [] },
      { id: 2, type: "text", title: "乙", order: 2, pageId: "p2", options: [] },
    ],
  };

  it("按字符串 page_id 正确归组", () => {
    const html = buildSurveyExportHtml([paged]);
    expect(html).toContain("第一页");
    expect(html).toContain("第二页");
    expect(html.indexOf("甲")).toBeGreaterThan(html.indexOf("第一页"));
    expect(html.indexOf("乙")).toBeGreaterThan(html.indexOf("第二页"));
  });

  it("pageId 与任何分页都对不上时仍然渲染全部题目", () => {
    const mismatched = buildSurveyExportHtml([
      { ...paged, questions: paged.questions.map((q) => ({ ...q, pageId: "nope" })) },
    ]);
    expect((mismatched.match(/<section class="question">/g) ?? []).length).toBe(2);
    expect(mismatched).toContain("未分页题目");
    expect(mismatched).toContain("甲");
    expect(mismatched).toContain("乙");
  });

  it("数字与字符串 id 混用时不丢题", () => {
    const mixed = buildSurveyExportHtml([
      {
        ...paged,
        pages: [
          { id: 1, title: "数字页", description: null, order: 1 },
          { id: "p2", title: "字符串页", description: null, order: 2 },
        ],
        questions: [
          { id: 1, type: "text", title: "甲", order: 1, pageId: 1, options: [] },
          { id: 2, type: "text", title: "乙", order: 2, pageId: "p2", options: [] },
          { id: 3, type: "text", title: "丙", order: 3, pageId: null, options: [] },
        ],
      },
    ]);
    expect((mixed.match(/<section class="question">/g) ?? []).length).toBe(3);
    expect(mixed).toContain("数字页");
    expect(mixed).toContain("字符串页");
  });
});
