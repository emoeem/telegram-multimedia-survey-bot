import { describe, expect, it } from "vitest";

import { submissionTargetFromUrl } from "../../../admin/src/survey/submission-target";

/**
 * `SUBMISSION_BOT_URL` 既可能是 t.me 机器人，也可能是一个网页投稿页（本部署配的就是
 * `https://emoemok.top/submit`）。旧实现解析不出 handle 时返回 "投稿机器人"，而调用方
 * 已经把「投稿机器人」写进了文案，于是首页底部出现「投稿机器人 投稿机器人，投稿给我」。
 *
 * 现在解析器返回目标本身，文案由调用方按 kind 拼，任何一种配置都不会再重复。
 */
describe("submissionTargetFromUrl", () => {
  it("t.me 机器人解析成 @handle", () => {
    expect(submissionTargetFromUrl("https://t.me/tougaojiqirbot")).toEqual({
      kind: "bot",
      label: "@tougaojiqirbot",
    });
  });

  it("带 query、带结尾斜杠、协议缺省的 t.me 链接都能解析", () => {
    expect(submissionTargetFromUrl("https://t.me/tougaojiqirbot?start=abc")?.label).toBe("@tougaojiqirbot");
    expect(submissionTargetFromUrl("https://t.me/tougaojiqirbot/")?.label).toBe("@tougaojiqirbot");
    expect(submissionTargetFromUrl("t.me/tougaojiqirbot")?.label).toBe("@tougaojiqirbot");
  });

  it("网页投稿页解析成域名，而不是退回「投稿机器人」", () => {
    expect(submissionTargetFromUrl("https://emoemok.top/submit")).toEqual({
      kind: "web",
      label: "emoemok.top",
    });
  });

  it("去掉 www. 前缀，避免「网页投稿 · www.xxx」这种冗余", () => {
    expect(submissionTargetFromUrl("https://www.emoemok.top/submit")?.label).toBe("emoemok.top");
  });

  it("非 t.me 的 http 链接也是 web 目标（客户部署可能指向自己的站）", () => {
    expect(submissionTargetFromUrl("https://example.com/inbox")).toEqual({
      kind: "web",
      label: "example.com",
    });
  });

  it("非法 URL 退化成去掉协议与路径的第一段，且永不为空", () => {
    const target = submissionTargetFromUrl("emoemok.top/submit");
    expect(target?.kind).toBe("web");
    expect(target?.label).toBe("emoemok.top");
  });

  it("空值返回 null，调用方据此整块不渲染", () => {
    expect(submissionTargetFromUrl(null)).toBeNull();
    expect(submissionTargetFromUrl(undefined)).toBeNull();
    expect(submissionTargetFromUrl("")).toBeNull();
    expect(submissionTargetFromUrl("   ")).toBeNull();
  });

  it("label 永远不是「投稿机器人」本身（那正是重复的根源）", () => {
    for (const url of [
      "https://t.me/tougaojiqirbot",
      "https://emoemok.top/submit",
      "https://www.emoemok.top/submit",
      "emoemok.top/submit",
    ]) {
      expect(submissionTargetFromUrl(url)?.label).not.toContain("投稿机器人");
    }
  });
});
