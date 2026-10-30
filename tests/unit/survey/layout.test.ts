import { describe, expect, it } from "vitest";

import {
  IMMERSIVE_MIN_WIDTH,
  SHORT_LANDSCAPE_MAX_HEIGHT,
  isShortLandscape,
  isStageQuestionType,
  resolveSurveyLayout,
  stageUsesStaticFooter,
} from "../../../src/survey/layout";

/**
 * 布局裁决矩阵：三档显示模式 × 媒体优先/阅读型题型 × 典型视口。
 *
 * 这张表就是「哪种设备看哪种版式」的规格说明，改动行为必须先改这里。
 */
const VIEWPORTS = {
  /** 手机竖屏 */
  phonePortrait: { width: 390, height: 844 },
  /** 手机横屏（矮横屏） */
  phoneLandscape: { width: 844, height: 390 },
  /** 平板竖屏：>=768，immersive 下算宽屏 */
  tabletPortrait: { width: 768, height: 1024 },
  /** 桌面 */
  desktop: { width: 1440, height: 900 },
} as const;

describe("问卷布局契约", () => {
  it("题型分类：画布优先集合；文字/选项/剧情走阅读", () => {
    for (const type of ["scene", "game", "image", "video", "audio", "file"]) {
      expect(isStageQuestionType(type)).toBe(true);
    }
    for (const type of ["single", "multiple", "text", "long_text", "note", "matrix", "rating", null, undefined]) {
      expect(isStageQuestionType(type)).toBe(false);
    }
  });

  it("auto：场景题全宽度上舞台（2026-10-30 沉浸式重设计）", () => {
    // 场景题：桌面、平板、手机竖屏、手机矮横屏全部 stage——
    // 手机竖屏 before 实测阅读窄卡只有 18% 可视面积（_review/immersive-2026-10-30/）。
    for (const viewport of Object.values(VIEWPORTS)) {
      expect(resolveSurveyLayout({ display: "auto", questionType: "scene", viewport })).toBe("stage");
    }
    expect(
      resolveSurveyLayout({ display: "auto", questionType: "scene", viewport: { width: 1023, height: 768 } }),
    ).toBe("stage");
    expect(resolveSurveyLayout({ display: "auto", questionType: "scene", viewport: { width: 320, height: 568 } })).toBe(
      "stage",
    );
    // 非场景题型（含其他画布优先类型）：auto 行为不变（game/image 由
    // SurveyApp 的 isScene 门控，layout 层维持 reading）。
    for (const questionType of ["game", "single", "note"]) {
      for (const viewport of Object.values(VIEWPORTS)) {
        expect(resolveSurveyLayout({ display: "auto", questionType, viewport })).toBe("reading");
      }
    }
  });

  it("immersive：场景题全宽度上舞台；其他画布题型 ≥768 才 stage", () => {
    expect(
      resolveSurveyLayout({ display: "immersive", questionType: "scene", viewport: VIEWPORTS.phonePortrait }),
    ).toBe("stage");
    expect(
      resolveSurveyLayout({ display: "immersive", questionType: "scene", viewport: VIEWPORTS.tabletPortrait }),
    ).toBe("stage");
    expect(resolveSurveyLayout({ display: "immersive", questionType: "game", viewport: VIEWPORTS.desktop })).toBe(
      "stage",
    );
    expect(resolveSurveyLayout({ display: "immersive", questionType: "game", viewport: VIEWPORTS.phonePortrait })).toBe(
      "reading",
    );
    // 文字题即使在桌面也不舞台化——长行难读。
    expect(resolveSurveyLayout({ display: "immersive", questionType: "single", viewport: VIEWPORTS.desktop })).toBe(
      "reading",
    );
  });

  it("landscape：矮横屏铺满；竖屏手机留在阅读（由提示条引导转屏）；宽屏等同沉浸", () => {
    expect(
      resolveSurveyLayout({ display: "landscape", questionType: "scene", viewport: VIEWPORTS.phoneLandscape }),
    ).toBe("stage");
    expect(
      resolveSurveyLayout({ display: "landscape", questionType: "scene", viewport: VIEWPORTS.phonePortrait }),
    ).toBe("reading");
    expect(resolveSurveyLayout({ display: "landscape", questionType: "scene", viewport: VIEWPORTS.desktop })).toBe(
      "stage",
    );
  });

  it("边界：宽度正好 768 进舞台（非场景画布题）；高度正好 560 且横屏算矮横屏", () => {
    expect(
      resolveSurveyLayout({
        display: "immersive",
        questionType: "game",
        viewport: { width: IMMERSIVE_MIN_WIDTH, height: 900 },
      }),
    ).toBe("stage");
    expect(
      resolveSurveyLayout({
        display: "immersive",
        questionType: "game",
        viewport: { width: IMMERSIVE_MIN_WIDTH - 1, height: 900 },
      }),
    ).toBe("reading");
    expect(isShortLandscape({ width: 1024, height: SHORT_LANDSCAPE_MAX_HEIGHT })).toBe(true);
    expect(isShortLandscape({ width: 1024, height: SHORT_LANDSCAPE_MAX_HEIGHT + 1 })).toBe(false);
    // 竖屏再矮也不是「横屏」。
    expect(isShortLandscape({ width: 390, height: 390 })).toBe(false);
  });

  it("舞台版式使用静态底栏（结构上不可能遮挡内容）", () => {
    expect(stageUsesStaticFooter("stage")).toBe(true);
    expect(stageUsesStaticFooter("reading")).toBe(false);
  });
});
