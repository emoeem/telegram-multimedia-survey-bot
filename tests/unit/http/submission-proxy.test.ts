import { describe, expect, it } from "vitest";

import {
  isSubmissionBotApiPath,
  resolveSubmissionBotOrigin,
  SUBMISSION_API_PREFIX,
} from "../../../src/http/submission-proxy";

/**
 * 这条代理是「投稿中心」能成立的前提：免登录投稿的表单、收件箱、回复全都
 * 在主站之外的 submission-bot Worker 上。合并前它们只在中继域名上存在，所以
 * 同一个产品看起来有两个投稿中心。
 *
 * 这里钉住两件事：前缀匹配不能把本站的金币投稿接口吞掉（`/api/submissions`
 * 只差一个字母），以及源站配置解析不能让畸形的值变成打到别处的请求。
 */
describe("投稿机器人接口前缀", () => {
  it("认得精确前缀本身", () => {
    expect(isSubmissionBotApiPath("/api/submit")).toBe(true);
    expect(SUBMISSION_API_PREFIX).toBe("/api/submit");
  });

  it("认得所有子路径", () => {
    expect(isSubmissionBotApiPath("/api/submit/form")).toBe(true);
    expect(isSubmissionBotApiPath("/api/submit/inbox")).toBe(true);
    expect(isSubmissionBotApiPath("/api/submit/reply")).toBe(true);
    expect(isSubmissionBotApiPath("/api/submit/message")).toBe(true);
  });

  it("绝不吞掉本站的金币投稿接口", () => {
    /* 只差一个 s：/api/submissions 属于本 Worker 的 D1 表，被代理走会让
     * 「账号投稿」页签整个失效，而且报错看起来像后端挂了。 */
    expect(isSubmissionBotApiPath("/api/submissions")).toBe(false);
    expect(isSubmissionBotApiPath("/api/submissions/12/withdraw")).toBe(false);
    expect(isSubmissionBotApiPath("/api/submissions/media/3")).toBe(false);
  });

  it("别的路径不归它管", () => {
    expect(isSubmissionBotApiPath("/api/submits")).toBe(false);
    expect(isSubmissionBotApiPath("/api/submit-other")).toBe(false);
    expect(isSubmissionBotApiPath("/submit")).toBe(false);
    expect(isSubmissionBotApiPath("/api/coins/overview")).toBe(false);
    expect(isSubmissionBotApiPath("/")).toBe(false);
  });
});

describe("投稿机器人源站解析", () => {
  it("未配置时返回 null（调用方据此回 503，不静默回落）", () => {
    expect(resolveSubmissionBotOrigin({})).toBeNull();
    expect(resolveSubmissionBotOrigin({ SUBMISSION_BOT_API_ORIGIN: "" })).toBeNull();
    expect(resolveSubmissionBotOrigin({ SUBMISSION_BOT_API_ORIGIN: "   " })).toBeNull();
  });

  it("取 origin，丢掉多余路径与尾斜杠", () => {
    expect(resolveSubmissionBotOrigin({ SUBMISSION_BOT_API_ORIGIN: "https://bot.example.com" })).toBe(
      "https://bot.example.com",
    );
    expect(resolveSubmissionBotOrigin({ SUBMISSION_BOT_API_ORIGIN: "https://bot.example.com/" })).toBe(
      "https://bot.example.com",
    );
    expect(resolveSubmissionBotOrigin({ SUBMISSION_BOT_API_ORIGIN: " https://bot.example.com/// " })).toBe(
      "https://bot.example.com",
    );
  });

  it("畸形值一律拒绝", () => {
    /* 放过一个非 URL 会让 fetch 抛在请求路径里，那是最难查的一类 500。 */
    expect(resolveSubmissionBotOrigin({ SUBMISSION_BOT_API_ORIGIN: "not-a-url" })).toBeNull();
    expect(resolveSubmissionBotOrigin({ SUBMISSION_BOT_API_ORIGIN: "ftp://bot.example.com" })).toBeNull();
    expect(resolveSubmissionBotOrigin({ SUBMISSION_BOT_API_ORIGIN: "javascript:alert(1)" })).toBeNull();
  });
});
