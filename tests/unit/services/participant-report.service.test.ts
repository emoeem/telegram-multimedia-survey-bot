import { describe, expect, it } from "vitest";
import { classifyParticipantReport, defaultParticipantReportTemplate } from "../../../src/services/participant-report.service";

describe("participant report classification", () => {
  it("recognizes a personal profile without inventing scores", () => {
    const result = classifyParticipantReport([
      { type: "text", title: "你的姓名" },
      { type: "number", title: "你的年龄" },
      { type: "text", title: "你的职业" },
      { type: "image", title: "个人展示照片" },
    ], false);
    expect(result.kind).toBe("personal_profile");
    expect(result.hasScores).toBe(false);
    expect(defaultParticipantReportTemplate(result.kind, "identity_card")).toBe("identity");
  });

  it("uses explicit rules as the strongest signal", () => {
    const result = classifyParticipantReport([{ type: "text", title: "你的姓名" }], true);
    expect(result.kind).toBe("assessment");
    // 产品决策：分类只用于报告标题/文案，默认模板一律经典报告。
    expect(defaultParticipantReportTemplate(result.kind, result.kind)).toBe("classic");
  });

  it("keeps a plain form as answers instead of personality analysis", () => {
    const result = classifyParticipantReport([{ type: "text", title: "联系方式" }, { type: "long_text", title: "备注" }], false);
    expect(result.kind).toBe("form");
    expect(result.resultTitle).toBe("我的回答");
    expect(defaultParticipantReportTemplate(result.kind, result.kind)).toBe("classic");
  });

  it("defaults every non-profile kind to the classic report", () => {
    for (const kind of ["assessment", "preference", "survey", "form", "unknown", undefined]) {
      expect(defaultParticipantReportTemplate(kind, null)).toBe("classic");
    }
    // 资料卡（广场展示）是唯一例外。
    expect(defaultParticipantReportTemplate("personal_profile", null)).toBe("identity");
    expect(defaultParticipantReportTemplate("survey", "identity_card")).toBe("identity");
  });
});
