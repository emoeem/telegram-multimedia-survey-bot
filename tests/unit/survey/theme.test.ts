import { describe, expect, it } from "vitest";
import { normalizeSurveyTheme } from "../../../src/survey/theme";

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
});
