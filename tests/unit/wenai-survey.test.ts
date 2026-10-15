import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateUnifiedSurvey } from "../../src/survey/validator";

const here = dirname(fileURLToPath(import.meta.url));
const contentPath = resolve(here, "../../scripts/wenai/wenai-survey.json");
const assetsDir = resolve(here, "../../scripts/wenai/assets");

const content = JSON.parse(readFileSync(contentPath, "utf-8"));
const survey = content.survey as {
  title: string;
  cover?: { url: string };
  questions: Array<{
    id: string;
    type: string;
    title: string;
    required: boolean | null;
    media?: Array<{ url: string }>;
    options?: Array<{ id: string; label: string; value: string; media?: Array<{ url: string }> }>;
  }>;
  settings: {
    theme: { background: { image: string }; audio: { url: string } };
  };
};

/** Every media reference used anywhere in the survey definition. */
function mediaUrls(): string[] {
  const urls: string[] = [];
  if (survey.cover?.url) urls.push(survey.cover.url);
  urls.push(survey.settings.theme.background.image, survey.settings.theme.audio.url);
  for (const question of survey.questions) {
    for (const media of question.media ?? []) urls.push(media.url);
    for (const option of question.options ?? []) {
      for (const media of option.media ?? []) urls.push(media.url);
    }
  }
  return urls;
}

describe("文爱问卷定义（scripts/wenai/wenai-survey.json）", () => {
  it("通过 validateUnifiedSurvey 结构校验", () => {
    expect(validateUnifiedSurvey(content)).toEqual([]);
  });

  it("媒体引用全部指向真实存在的素材文件", () => {
    const urls = mediaUrls();
    expect(urls.length).toBeGreaterThan(10);
    for (const url of urls) {
      expect(url).toMatch(/^kv:\/\//);
      const file = join(assetsDir, url.replace("kv://", ""));
      expect(existsSync(file), `缺少素材 ${file}`).toBe(true);
    }
  });

  it("年龄门槛与虚构声明是必答题，且为前两道作答题", () => {
    const answerable = survey.questions.filter((q) => q.type !== "note");
    expect(answerable[0]?.id).toBe("q-age");
    expect(answerable[1]?.id).toBe("q-fiction");
    expect(answerable[0]?.required).toBe(true);
    expect(answerable[1]?.required).toBe(true);
  });

  it("尺度板块的每一项都有 愿意/看情况/不愿意 三档", () => {
    const scale = survey.questions.filter((q) =>
      ["q-kiss", "q-explicit", "q-cnc", "q-bond", "q-dirty"].includes(q.id),
    );
    expect(scale.length).toBe(5);
    for (const question of scale) {
      expect(question.options?.map((o) => o.value)).toEqual(["yes", "maybe", "no"]);
    }
  });

  it("界限板块包含未成年、血缘、真实隐私等硬红线", () => {
    const limits = survey.questions.find((q) => q.id === "q-limits");
    const values = limits?.options?.map((o) => o.value) ?? [];
    for (const expected of ["minors", "incest", "real_identity", "un_negotiated_noncon"]) {
      expect(values).toContain(expected);
    }
  });

  it("选择题的 option value 不重复且无空白", () => {
    for (const question of survey.questions) {
      const values = question.options?.map((o) => o.value) ?? [];
      expect(values, question.id).toEqual([...new Set(values)]);
      for (const value of values) expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it("主题指向 kv:// 占位，由导入脚本替换为 /api/survey/media/:id", () => {
    expect(survey.settings.theme.background.image).toBe("kv://cover.jpg");
    expect(survey.settings.theme.audio.url).toBe("kv://bgm.mp3");
  });
});
