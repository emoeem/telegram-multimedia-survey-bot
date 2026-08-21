import { describe, expect, it } from "vitest";

import { parseReportGeneratorImport } from "../../../src/services/report-generator-import.service";

describe("report generator JSON import", () => {
  it("preserves question content while converting supported question types", () => {
    const imported = parseReportGeneratorImport(JSON.stringify({
      schema_version: 1,
      survey: {
        title: "导入测试",
        questions: [
          { id: "safe", type: "single", title: "请选择展示风格", required: true, options: [{ label: "简约", value: "simple" }, { label: "活泼", value: "bright" }] },
          { id: "score", type: "rating", title: "请为体验评分", required: true, options: [{ label: "1", value: "1" }, { label: "2", value: "2" }] },
          { id: "address", type: "text", title: "请输入地址", required: true, options: [] },
        ],
      },
    }));

    expect(imported.questions).toEqual([
      expect.objectContaining({ variableName: "imported_1", type: "single", options: ["简约", "活泼"] }),
      expect.objectContaining({ variableName: "imported_2", type: "rating", settings: { min: 1, max: 10, step: 1 } }),
      expect.objectContaining({ variableName: "imported_3", prompt: "请输入地址", type: "text" }),
    ]);
    expect(imported.skippedCount).toBe(0);
  });
});
