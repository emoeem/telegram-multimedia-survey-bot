import { describe, expect, it } from "vitest";
import {
  SURVEY_SFX_CUES,
  normalizeStoredSurveyTheme,
  normalizeSurveyTheme,
  resolveBgmUrl,
  resolveSprite,
} from "../../../src/survey/theme";

describe("normalizeSurveyTheme", () => {
  it("passes safe tokens through", () => {
    const theme = normalizeSurveyTheme({
      background: {
        color: "#111111",
        image: "https://cdn.example.com/bg.jpg",
        position: "center top",
        size: "cover",
      },
      primaryColor: "#ff0000",
      secondaryColor: "rgb(1, 2, 3)",
      card: { radius: 16, glass: true },
      text: { heading: "#fff", muted: "rgba(255,255,255,0.7)" },
      button: { radius: 24 },
      overlay: { opacity: 0.4, blur: 8, color: "#000000" },
    });

    expect(theme).toEqual({
      background: {
        color: "#111111",
        image: "https://cdn.example.com/bg.jpg",
        position: "center top",
        size: "cover",
      },
      primaryColor: "#ff0000",
      secondaryColor: "rgb(1, 2, 3)",
      card: { radius: 16, glass: true },
      text: { heading: "#fff", muted: "rgba(255,255,255,0.7)" },
      button: { radius: 24 },
      overlay: { opacity: 0.4, blur: 8, color: "#000000" },
    });
  });

  it("drops unsafe or invalid values", () => {
    const theme = normalizeSurveyTheme({
      background: {
        image: "javascript:alert(1)",
        position: "weird",
        size: "stretch",
      },
      primaryColor: "red",
      card: { radius: "16px", background: "url(javascript:alert(1))" },
      text: { heading: 42 },
    });

    expect(theme).toBeNull();
  });

  it("clamps opacity, blur, and radius", () => {
    const theme = normalizeSurveyTheme({
      overlay: { opacity: 5, blur: 100 },
      card: { radius: -4 },
      button: { radius: 999 },
    });

    expect(theme).toEqual({
      overlay: { opacity: 1, blur: 40 },
      card: { radius: 0 },
      button: { radius: 32 },
    });
  });

  it("returns null for non-objects and empty input", () => {
    expect(normalizeSurveyTheme(null)).toBeNull();
    expect(normalizeSurveyTheme("x")).toBeNull();
    expect(normalizeSurveyTheme([])).toBeNull();
    expect(normalizeSurveyTheme({})).toBeNull();
    expect(normalizeSurveyTheme({ background: {}, card: {} })).toBeNull();
  });

  it("accepts only known presets and migrates retired DaisyUI ids", () => {
    // 2026-10 重设计收敛为三套：旧 id 迁移到最近似主题，而不是丢弃。
    expect(normalizeSurveyTheme({ preset: "night" })).toEqual({ preset: "dark" });
    expect(normalizeSurveyTheme({ preset: "luxury" })).toEqual({ preset: "foxgold" });
    expect(normalizeSurveyTheme({ preset: "retro" })).toEqual({ preset: "light" });
    expect(normalizeSurveyTheme({ preset: "foxgold" })).toEqual({ preset: "foxgold" });
    expect(normalizeSurveyTheme({ preset: "dark", primaryColor: "#ff0000" })).toEqual({
      preset: "dark",
      primaryColor: "#ff0000",
    });
    expect(normalizeSurveyTheme({ preset: "unknown-theme" })).toBeNull();
  });

  it("accepts safe background music URLs only", () => {
    expect(
      normalizeSurveyTheme({
        audio: { url: "https://cdn.example.com/bgm.mp3" },
      }),
    ).toEqual({ audio: { url: "https://cdn.example.com/bgm.mp3" } });
    expect(
      normalizeSurveyTheme({
        audio: { url: "data:audio/mpeg;base64,YWFh" },
      }),
    ).toEqual({ audio: { url: "data:audio/mpeg;base64,YWFh" } });
    expect(normalizeSurveyTheme({ audio: { url: "javascript:alert(1)" } })).toBeNull();
  });
});

describe("normalizeStoredSurveyTheme", () => {
  const theme = { preset: "foxgold", primaryColor: "#d4576b", audio: { url: "/api/survey/media/716" } };

  it("unwraps the {theme: ...} wrapper written by the admin editor and imports", () => {
    expect(normalizeStoredSurveyTheme({ theme })).toEqual(theme);
    expect(normalizeStoredSurveyTheme({ theme, reportTemplateId: "classic" })).toEqual(theme);
  });

  it("still accepts the theme stored as the whole settings object", () => {
    expect(normalizeStoredSurveyTheme(theme)).toEqual(theme);
  });

  it("returns null for missing or malformed themes", () => {
    expect(normalizeStoredSurveyTheme(null)).toBeNull();
    expect(normalizeStoredSurveyTheme({})).toBeNull();
    expect(normalizeStoredSurveyTheme({ theme: { preset: "nope" } })).toBeNull();
  });
});

describe("normalizeSurveyTheme audio.byPage", () => {
  it("keeps numeric page keys with safe urls", () => {
    const theme = normalizeSurveyTheme({
      audio: {
        url: "/api/survey/media/1",
        byPage: { "0": "/api/survey/media/1", "3": "/api/survey/media/4" },
      },
    });
    expect(theme?.audio).toEqual({
      url: "/api/survey/media/1",
      byPage: { "0": "/api/survey/media/1", "3": "/api/survey/media/4" },
    });
  });

  it("drops unsafe urls and non-page keys", () => {
    const theme = normalizeSurveyTheme({
      audio: {
        url: "/api/survey/media/1",
        byPage: {
          "1": "javascript:alert(1)",
          "chapter-two": "/api/survey/media/2",
          "-1": "/api/survey/media/3",
          "9999": "",
        },
      },
    });
    expect(theme?.audio).toEqual({ url: "/api/survey/media/1" });
  });

  it("keeps byPage alone when no default url is set", () => {
    const theme = normalizeSurveyTheme({
      audio: { byPage: { "0": "https://cdn.example.com/rain.mp3" } },
    });
    expect(theme?.audio).toEqual({ byPage: { "0": "https://cdn.example.com/rain.mp3" } });
  });
});

describe("normalizeSurveyTheme audio.byQuestion", () => {
  it("keeps numeric question-order keys alongside byPage", () => {
    const theme = normalizeSurveyTheme({
      audio: {
        url: "/api/survey/media/1",
        byPage: { "0": "/api/survey/media/1" },
        byQuestion: { "8": "/api/survey/media/2", "19": "/api/survey/media/3", "55": "/api/survey/media/4" },
      },
    });
    expect(theme?.audio).toEqual({
      url: "/api/survey/media/1",
      byPage: { "0": "/api/survey/media/1" },
      byQuestion: { "8": "/api/survey/media/2", "19": "/api/survey/media/3", "55": "/api/survey/media/4" },
    });
  });

  it("drops unsafe urls and non-numeric keys", () => {
    const theme = normalizeSurveyTheme({
      audio: {
        byQuestion: {
          "8": "javascript:alert(1)",
          "data:audio/mpeg;base64,YWFh": "/api/survey/media/9",
          q8: "/api/survey/media/2",
          "-1": "/api/survey/media/3",
          "8.5": "/api/survey/media/4",
        },
      },
    });
    expect(theme).toBeNull();
  });

  it("keeps a 4-digit order even though byPage caps at 3", () => {
    const theme = normalizeSurveyTheme({
      audio: { byPage: { "9999": "/api/survey/media/1" }, byQuestion: { "9999": "/api/survey/media/2" } },
    });
    // byPage keys are page positions (small), byQuestion keys are question orders.
    expect(theme?.audio).toEqual({ byQuestion: { "9999": "/api/survey/media/2" } });
  });

  it("keeps byQuestion alone when no default url is set", () => {
    const theme = normalizeSurveyTheme({
      audio: { byQuestion: { "19": "https://cdn.example.com/finale.mp3" } },
    });
    expect(theme?.audio).toEqual({ byQuestion: { "19": "https://cdn.example.com/finale.mp3" } });
  });
});

describe("resolveBgmUrl", () => {
  const theme = normalizeSurveyTheme({
    audio: {
      url: "/api/survey/media/1",
      byPage: { "0": "/api/survey/media/2", "3": "/api/survey/media/3" },
      byQuestion: { "19": "/api/survey/media/4" },
    },
  })!;

  it("prefers a per-question cue over both the page override and the default", () => {
    expect(resolveBgmUrl(theme, 19, 3)).toBe("/api/survey/media/4");
  });

  it("falls back to the page override when the node has no cue", () => {
    expect(resolveBgmUrl(theme, 20, 3)).toBe("/api/survey/media/3");
    expect(resolveBgmUrl(theme, 1, 0)).toBe("/api/survey/media/2");
  });

  it("falls back to the survey-wide default when neither map matches", () => {
    expect(resolveBgmUrl(theme, 20, 5)).toBe("/api/survey/media/1");
    // pageIndex is -1 whenever the node's page is not in `pages`.
    expect(resolveBgmUrl(theme, 20, -1)).toBe("/api/survey/media/1");
  });

  it("skips the cue lookup when the order is unknown", () => {
    expect(resolveBgmUrl(theme, null, 3)).toBe("/api/survey/media/3");
    expect(resolveBgmUrl(theme, undefined, 0)).toBe("/api/survey/media/2");
  });

  it("returns undefined without a theme or without audio", () => {
    expect(resolveBgmUrl(null, 19, 3)).toBeUndefined();
    expect(resolveBgmUrl(undefined, 19, 3)).toBeUndefined();
    expect(resolveBgmUrl(normalizeSurveyTheme({ primaryColor: "#fff" }), 19, 3)).toBeUndefined();
  });
});

describe("audio.sfx（界面音效 cue 表）", () => {
  it("只保留白名单 cue，且逐条过滤不安全 URL", () => {
    const theme = normalizeSurveyTheme({
      audio: {
        sfx: {
          select: "/api/survey/media/1",
          confirm: "https://cdn.example.com/confirm.mp3",
          bomb: "/api/survey/media/9",
          cancel: "javascript:alert(1)",
        },
      },
    });
    expect(theme?.audio?.sfx).toEqual({
      select: "/api/survey/media/1",
      confirm: "https://cdn.example.com/confirm.mp3",
    });
    expect(SURVEY_SFX_CUES).toEqual(["select", "confirm", "cancel", "page", "transition"]);
  });

  it("一个可用 cue 都没有时 sfx 字段直接消失，而不是留空对象", () => {
    const theme = normalizeSurveyTheme({ audio: { sfx: { bogus: "/api/survey/media/1" } } });
    expect(theme).toBeNull();
  });
});

describe("theme.sprite（立绘）", () => {
  it("过滤不安全 URL 与非法表情名，保留页级/节点级映射", () => {
    const theme = normalizeSurveyTheme({
      sprite: {
        name: "苏晚棠",
        default: "neutral",
        expressions: {
          neutral: "/api/survey/media/1",
          smile: "/api/survey/media/2",
          shy: "https://cdn.example.com/shy.webp",
          bad: "javascript:alert(1)",
          "Not-A-Key": "/api/survey/media/3",
        },
        byPage: { "0": "neutral", "5": "smile", no: "neutral" },
        byQuestion: { "13": "shy", "99999": "smile" },
      },
    });
    expect(theme?.sprite).toEqual({
      name: "苏晚棠",
      default: "neutral",
      expressions: {
        neutral: "/api/survey/media/1",
        smile: "/api/survey/media/2",
        shy: "https://cdn.example.com/shy.webp",
      },
      byPage: { "0": "neutral", "5": "smile" },
      byQuestion: { "13": "shy" },
    });
  });

  it("一个可用表情都没有时 sprite 字段消失", () => {
    const theme = normalizeSurveyTheme({
      sprite: { name: "苏晚棠", expressions: { bad: "javascript:alert(1)" } },
    });
    expect(theme).toBeNull();
  });
});

describe("resolveSprite", () => {
  const theme = normalizeSurveyTheme({
    sprite: {
      name: "苏晚棠",
      default: "neutral",
      expressions: {
        neutral: "/api/survey/media/1",
        smile: "/api/survey/media/2",
        soft: "/api/survey/media/3",
      },
      byPage: { "0": "smile", "3": "soft" },
      byQuestion: { "13": "soft", "14": "shy" },
    },
  })!;

  it("优先级：节点级 > 页级 > default", () => {
    expect(resolveSprite(theme, 13, 0)).toEqual({ url: "/api/survey/media/3", expression: "soft", name: "苏晚棠" });
    expect(resolveSprite(theme, 20, 0)).toEqual({ url: "/api/survey/media/2", expression: "smile", name: "苏晚棠" });
    expect(resolveSprite(theme, 20, 1)).toEqual({ url: "/api/survey/media/1", expression: "neutral", name: "苏晚棠" });
  });

  it("目标表情没有素材时回退到可用表情，而不是让立绘整块消失", () => {
    // order 14 指定 shy，但 shy 没有 URL ⇒ 回落到页级 smile
    expect(resolveSprite(theme, 14, 0)).toEqual({ url: "/api/survey/media/2", expression: "smile", name: "苏晚棠" });
  });

  it("order 未知时跳过节点级查表", () => {
    expect(resolveSprite(theme, null, 0)?.expression).toBe("smile");
    expect(resolveSprite(theme, undefined, 3)?.expression).toBe("soft");
  });

  it("没有主题或没有立绘时返回 undefined", () => {
    expect(resolveSprite(null, 13, 0)).toBeUndefined();
    expect(resolveSprite(undefined, 13, 0)).toBeUndefined();
    expect(resolveSprite(normalizeSurveyTheme({ primaryColor: "#fff" }), 13, 0)).toBeUndefined();
  });
});
