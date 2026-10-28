import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_IMPORT_LINES,
  parseImportLines,
  summarizeBatch,
  type ImportBatchItem,
} from "../../admin/src/lib/import-lines";

describe("parseImportLines", () => {
  it("splits one URL per line and keeps the original order", () => {
    const result = parseImportLines(
      ["https://forms.office.com/r/aaa", "https://forms.zohopublic.com/x/form/bbb"].join("\n"),
    );

    expect(result.lines.map((line) => line.url)).toEqual([
      "https://forms.office.com/r/aaa",
      "https://forms.zohopublic.com/x/form/bbb",
    ]);
    expect(result.lines.map((line) => line.lineNumber)).toEqual([1, 2]);
    expect(result.rejected).toEqual([]);
    expect(result.empty).toBe(false);
  });

  it("ignores blank lines and comment lines without shifting line numbers", () => {
    const text = [
      "",
      "   ",
      "# 这一批先导前两个",
      "https://forms.office.com/r/aaa",
      "",
      "https://forms.office.com/r/bbb",
    ].join("\n");

    const result = parseImportLines(text);

    expect(result.lines.map((line) => line.url)).toEqual([
      "https://forms.office.com/r/aaa",
      "https://forms.office.com/r/bbb",
    ]);
    // 行号指向用户在文本框里看到的真实行，而不是「第几个链接」。
    expect(result.lines.map((line) => line.lineNumber)).toEqual([4, 6]);
  });

  it("reports non-http(s) and malformed lines instead of silently dropping them", () => {
    const result = parseImportLines(
      ["ftp://example.com/form", "not a url", "https://forms.office.com/r/ok"].join("\n"),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.rejected.map((item) => item.lineNumber)).toEqual([1, 2]);
    expect(result.rejected[0]?.reason).toContain("http");
  });

  it("rejects hosts without a dot so a typo is not treated as a real host", () => {
    const result = parseImportLines("https://localhost:8787/form");

    expect(result.lines).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });

  it("merges duplicate URLs after normalization", () => {
    const text = [
      "https://forms.office.com/r/aaa",
      "https://forms.office.com/r/aaa",
      "HTTPS://Forms.Office.com/r/aaa",
    ].join("\n");

    const result = parseImportLines(text);

    // 大小写不同的 scheme/host 规范化成同一个 URL，只保留第一次出现。
    expect(result.lines).toHaveLength(1);
    expect(result.duplicates).toHaveLength(2);
  });

  it("caps the queue but still reports the overflow count", () => {
    const text = Array.from({ length: 8 }, (_, index) => `https://forms.office.com/r/q${index}`).join("\n");

    const result = parseImportLines(text, { maxLines: 3 });

    expect(result.lines).toHaveLength(3);
    expect(result.overflow).toBe(5);
    expect(result.rejected).toEqual([]);
  });

  it("does not spend the line budget on rejected or duplicate rows", () => {
    const text = [
      "not a url",
      "https://forms.office.com/r/a",
      "https://forms.office.com/r/a",
      "https://forms.office.com/r/b",
    ].join("\n");

    const result = parseImportLines(text, { maxLines: 2 });

    expect(result.lines.map((line) => line.url)).toEqual([
      "https://forms.office.com/r/a",
      "https://forms.office.com/r/b",
    ]);
    expect(result.overflow).toBe(0);
  });

  it("marks input with no usable content as empty", () => {
    expect(parseImportLines("").empty).toBe(true);
    expect(parseImportLines("\n \n# 只有注释\n").empty).toBe(true);
    expect(parseImportLines("not a url").empty).toBe(false);
  });

  it("defaults to a bounded batch size", () => {
    const text = Array.from({ length: DEFAULT_MAX_IMPORT_LINES + 2 }, (_, index) =>
      `https://forms.office.com/r/d${index}`,
    ).join("\n");

    const result = parseImportLines(text);

    expect(result.lines).toHaveLength(DEFAULT_MAX_IMPORT_LINES);
    expect(result.overflow).toBe(2);
  });

  it("handles windows line endings", () => {
    const result = parseImportLines("https://forms.office.com/r/a\r\nhttps://forms.office.com/r/b");

    expect(result.lines).toHaveLength(2);
    expect(result.lines[1]?.raw).toBe("https://forms.office.com/r/b");
  });
});

describe("summarizeBatch", () => {
  const item = (status: ImportBatchItem["status"]): ImportBatchItem => ({
    url: "https://forms.office.com/r/a",
    raw: "https://forms.office.com/r/a",
    lineNumber: 1,
    status,
  });

  it("counts each terminal state and knows when the batch is finished", () => {
    const summary = summarizeBatch([item("imported"), item("created"), item("failed")]);

    expect(summary).toEqual({ total: 3, imported: 1, created: 1, failed: 1, finished: true });
  });

  it("is unfinished while any row is still in flight", () => {
    expect(summarizeBatch([item("imported"), item("creating")]).finished).toBe(false);
    expect(summarizeBatch([item("pending")]).finished).toBe(false);
  });

  it("treats an empty list as finished so the UI does not show a spinner forever", () => {
    expect(summarizeBatch([])).toEqual({ total: 0, imported: 0, created: 0, failed: 0, finished: true });
  });
});
