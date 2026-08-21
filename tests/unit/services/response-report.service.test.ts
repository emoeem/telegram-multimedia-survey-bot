import { describe, expect, it } from "vitest";
import { buildResponseReportHtml, planResponseReportPages, responseReportDensity, validateResponseReport, type ResponseReport, type ResponseReportItem, type ResponseReportMedia } from "../../../src/services/response-report.service";

function item(number: number, overrides: Partial<ResponseReportItem> = {}): ResponseReportItem {
  return { questionId: number, number, type: "text", title: `问题 ${number}`, required: number % 2 === 1, answered: true, answerId: number, answer: `答案 ${number}`, rawAnswer: `答案 ${number}`, options: [], questionMedia: [], answerMedia: [], ...overrides };
}
function report(items: ResponseReportItem[]): ResponseReport {
  return { surveyTitle: "测试问卷 <script>", responseNumber: 2, status: "已完成", respondent: "@tester", startedAt: "2026-08-15 09:00", completedAt: "2026-08-15 09:05", items };
}
function media(id: number, role: ResponseReportMedia["role"]): ResponseReportMedia {
  return { id, role, label: `${role} ${id}`, imageDataUrl: `data:image/png;base64,${id}` };
}

describe("complete survey response report", () => {
  it("renders every source question, answer state, and original order", () => {
    const input = report(Array.from({ length: 120 }, (_, index) => item(index + 1)));
    const html = buildResponseReportHtml(input);
    expect((html.match(/data-question-id=/g) ?? []).length).toBe(120);
    expect((html.match(/data-answer-id=/g) ?? []).length).toBe(120);
    expect(html.indexOf('data-question-id="1"')).toBeLessThan(html.indexOf('data-question-id="120"'));
    expect(responseReportDensity(input)).toBe("compact");
  });

  it("renders every choice in source order with stable CSS controls", () => {
    const input = report([item(1, { type: "single", answer: "香蕉", rawAnswer: null, options: [
      { id: 11, label: "苹果", selected: false, media: [] }, { id: 12, label: "香蕉", selected: true, media: [] }, { id: 13, label: "橙子", selected: false, media: [] },
    ] })]);
    const html = buildResponseReportHtml(input);
    expect(html).toContain('data-option-id="11"'); expect(html).toContain('data-option-id="12"');
    expect(html).toContain('data-selected="true"'); expect(html).toContain("control radio selected");
    expect(html).not.toContain("☑"); expect(html).not.toContain("●");
    expect(html.indexOf("苹果")).toBeLessThan(html.indexOf("香蕉")); expect(html.indexOf("香蕉")).toBeLessThan(html.indexOf("橙子"));
  });

  it("preserves a long answer byte-for-byte across semantic page fragments", () => {
    const answer = "首行\n" + "完整正文。".repeat(800) + "\n末行";
    const input = report([item(1, { type: "long_text", answer, rawAnswer: answer })]);
    const pages = planResponseReportPages(input);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => page.fragments).filter((fragment) => fragment.answer !== undefined).map((fragment) => fragment.answer).join("")).toBe(answer);
    expect(buildResponseReportHtml(input)).toContain("CONTINUED →");
  });

  it("preserves very long question titles and descriptions across pages", () => {
    const title = "超长题目。".repeat(180);
    const description = "完整说明。".repeat(240);
    const input = report([item(1, { title, description })]);
    const fragments = planResponseReportPages(input).flatMap((page) => page.fragments);
    expect(fragments.map((fragment) => fragment.title ?? "").join("")).toBe(title);
    expect(fragments.map((fragment) => fragment.description ?? "").join("")).toBe(description);
  });

  it("renders rating scale, selected value, and required metadata", () => {
    const options = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, label: String(index + 1), selected: index === 2, media: [] }));
    const html = buildResponseReportHtml(report([item(1, { type: "rating", answer: "3", rawAnswer: null, options })]));
    expect(html).toContain("RATING SCALE"); expect(html).toContain("YOUR SELECTION"); expect(html).toContain("REQUIRED");
    expect((html.match(/data-option-id=/g) ?? []).length).toBe(5);
  });

  it("renders complete matrix rows, columns, and selected state", () => {
    const options = Array.from({ length: 24 }, (_, index) => ({ id: index + 1, label: `矩阵行 ${index + 1}`, selected: false, media: [] }));
    const input = report([item(1, { type: "matrix", answer: "已填写", rawAnswer: null, matrixColumns: ["低", "中", "高"], matrixSelections: { "21": 2 }, options })]);
    const pages = planResponseReportPages(input);
    const html = buildResponseReportHtml(input);
    expect(new Set(pages.flatMap((page) => page.fragments).flatMap((fragment) => options.slice(fragment.optionStart ?? 0, fragment.optionEnd ?? 0).map((option) => option.id))).size).toBe(24);
    expect((html.match(/data-column-order=/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('data-selected="true"');
    for (const option of options) expect(html).toContain(option.label);
  });

  it("splits wide matrices by columns without dropping any column", () => {
    const columns = Array.from({ length: 23 }, (_, index) => `列 ${index + 1}`);
    const input = report([item(1, { type: "matrix", answer: "已填写", rawAnswer: null, matrixColumns: columns, matrixSelections: { "1": 22 }, options: [{ id: 1, label: "矩阵行", selected: false, media: [] }] })]);
    const html = buildResponseReportHtml(input);
    expect([...html.matchAll(/data-column-order="(\d+)"/g)].map((match) => Number(match[1]))).toEqual(columns.map((_, index) => index));
    expect(html).toContain("COLUMNS 21–23");
    expect(html).toContain('data-selected="true"');
  });

  it("keeps question, option, and upload media associations", () => {
    const input = report([item(1, { type: "image", answer: "已上传媒体文件", rawAnswer: null, questionMedia: [media(1, "question")], answerMedia: Array.from({ length: 7 }, (_, index) => media(index + 2, "answer")), options: [{ id: 1, label: "图片选项", selected: true, media: [media(20, "option")] }] })]);
    const html = buildResponseReportHtml(input);
    expect(html).toContain("QUESTION MEDIA"); expect(html).toContain("OPTION MEDIA"); expect(html).toContain("YOUR UPLOAD");
    expect((html.match(/data-media-id=/g) ?? []).length).toBe(9);
    expect(new Set(planResponseReportPages(input).flatMap((page) => page.fragments).flatMap((fragment) => [...(fragment.questionMedia ?? []), ...(fragment.answerMedia ?? [])]).map((entry) => entry.id)).size).toBe(8);
  });

  it("splits media-heavy image options without duplicating or dropping media", () => {
    const optionMedia = Array.from({ length: 8 }, (_, index) => media(index + 1, "option"));
    const input = report([item(1, { type: "single", answer: "图片 A", rawAnswer: null, options: [{ id: 10, label: "图片 A", selected: true, media: optionMedia }] })]);
    const fragments = planResponseReportPages(input).flatMap((page) => page.fragments);
    expect(fragments.flatMap((fragment) => fragment.optionMediaById?.["10"] ?? []).map((entry) => entry.id)).toEqual(optionMedia.map((entry) => entry.id));
    expect((buildResponseReportHtml(input).match(/data-media-role="option"/g) ?? []).length).toBe(8);
  });

  it("keeps unanswered questions visible and explicitly marked", () => {
    const html = buildResponseReportHtml(report([item(1, { required: false, answered: false, answerId: null, answer: "未作答", rawAnswer: null })]));
    expect(html).toContain('data-answered="false"'); expect(html).toContain("未作答"); expect(html).toContain("OPTIONAL");
  });

  it("paginates 130 questions with images without losing coverage", () => {
    const input = report(Array.from({ length: 130 }, (_, index) => item(index + 1, { answerMedia: index % 4 === 0 ? [media(index + 1, "answer")] : [] })));
    const pages = planResponseReportPages(input);
    expect(pages.length).toBeGreaterThan(20);
    expect(new Set(pages.flatMap((page) => page.fragments.map((fragment) => fragment.item.questionId))).size).toBe(130);
  });

  it("keeps all 300 questions and stored answers", () => {
    const input = report(Array.from({ length: 300 }, (_, index) => item(index + 1)));
    const html = buildResponseReportHtml(input);
    expect(new Set(planResponseReportPages(input).flatMap((page) => page.fragments.map((fragment) => fragment.item.questionId))).size).toBe(300);
    expect((html.match(/data-answer-id=/g) ?? []).length).toBe(300);
    expect(html).toContain('data-question-id="300"');
  });

  it("rejects question, option, answer, unanswered, and media corruption", () => {
    expect(() => validateResponseReport(report([item(1), item(2, { questionId: 1 })]))).toThrow(/duplicate question ID/);
    expect(() => validateResponseReport(report([item(1, { answer: "被修改", rawAnswer: "原始答案" })]))).toThrow(/Answer integrity/);
    expect(() => validateResponseReport(report([item(1, { answered: false, answerId: null, answer: "伪造答案", rawAnswer: null })]))).toThrow(/Unanswered state/);
    expect(() => validateResponseReport(report([item(1, { type: "single", rawAnswer: null, options: [{ id: 1, label: "A", selected: true, media: [] }, { id: 1, label: "B", selected: false, media: [] }] })]))).toThrow(/Option coverage/);
    expect(() => validateResponseReport(report([item(1, { questionMedia: [media(1, "question")], answerMedia: [media(1, "answer")] })]))).toThrow(/Media association/);
    expect(() => validateResponseReport(report([item(1, { questionMedia: [media(2, "answer")] })]))).toThrow(/Media association/);
  });

  it("escapes untrusted content", () => { const html = buildResponseReportHtml(report([item(1, { answer: "<img onerror=alert(1)>", rawAnswer: "<img onerror=alert(1)>" })])); expect(html).not.toContain("<script>"); expect(html).toContain("&lt;img onerror=alert(1)&gt;"); });
});
