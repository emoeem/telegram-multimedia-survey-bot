import { describe, expect, it } from "vitest";

import {
  SURVEY_DISPLAY_MODES,
  SURVEY_DISPLAY_MODE_LABELS,
  isWideDisplayMode,
  normalizeSurveyDisplayMode,
  readSurveyDisplayMode,
} from "../../../src/survey/display";

describe("问卷显示模式（settings_json.display）", () => {
  it("只接受三个白名单值，其余一律 null", () => {
    for (const mode of SURVEY_DISPLAY_MODES) {
      expect(normalizeSurveyDisplayMode(mode)).toBe(mode);
    }
    for (const dirty of ["IMMERSIVE", "fullscreen", "", " auto", null, undefined, 1, {}, [], true]) {
      expect(normalizeSurveyDisplayMode(dirty)).toBeNull();
    }
  });

  // 读侧宽容：脏数据/缺键一律回落 auto——公开端永远拿到合法值，
  // 存量的 settings_json（含 theme 包裹形态）不会因为新增键而改变行为。
  it("readSurveyDisplayMode：缺省与脏值回落 auto", () => {
    expect(readSurveyDisplayMode(null)).toBe("auto");
    expect(readSurveyDisplayMode(undefined)).toBe("auto");
    expect(readSurveyDisplayMode({})).toBe("auto");
    expect(readSurveyDisplayMode({ theme: { preset: "dark" } })).toBe("auto");
    expect(readSurveyDisplayMode({ display: "wat" })).toBe("auto");
    expect(readSurveyDisplayMode([])).toBe("auto");
    expect(readSurveyDisplayMode("immersive")).toBe("auto");
    expect(readSurveyDisplayMode({ display: "immersive" })).toBe("immersive");
    expect(readSurveyDisplayMode({ theme: { preset: "dark" }, display: "landscape" })).toBe("landscape");
  });

  it("宽版式判定：immersive / landscape 为真，auto 为假", () => {
    expect(isWideDisplayMode("auto")).toBe(false);
    expect(isWideDisplayMode("immersive")).toBe(true);
    expect(isWideDisplayMode("landscape")).toBe(true);
  });

  it("每个模式都有设置面板文案（新增模式必须补文案，否则面板会出现空白卡）", () => {
    for (const mode of SURVEY_DISPLAY_MODES) {
      expect(SURVEY_DISPLAY_MODE_LABELS[mode].title.length).toBeGreaterThan(0);
      expect(SURVEY_DISPLAY_MODE_LABELS[mode].hint.length).toBeGreaterThan(0);
    }
  });
});
