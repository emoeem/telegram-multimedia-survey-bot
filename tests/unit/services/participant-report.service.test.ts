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
    expect(defaultParticipantReportTemplate(result.kind, result.kind)).toBe("data");
  });

  it("keeps a plain form as answers instead of personality analysis", () => {
    const result = classifyParticipantReport([{ type: "text", title: "联系方式" }, { type: "long_text", title: "备注" }], false);
    expect(result.kind).toBe("form");
    expect(result.resultTitle).toBe("我的回答");
    expect(defaultParticipantReportTemplate(result.kind, result.kind)).toBe("transcript");
  });
});
