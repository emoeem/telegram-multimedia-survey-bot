import { describe, expect, it } from "vitest";

import { cleanSurveyDescription } from "../../../src/bot/survey-handler";

describe("survey question presentation", () => {
  it("hides the generated PDF import description from survey listings", () => {
    expect(cleanSurveyDescription("Imported from Microsoft Forms PDF")).toBeNull();
    expect(cleanSurveyDescription(" Imported from Microsoft Forms PDF. ")).toBeNull();
    expect(cleanSurveyDescription("这是一份自定义问卷说明")).toBe("这是一份自定义问卷说明");
  });
});
