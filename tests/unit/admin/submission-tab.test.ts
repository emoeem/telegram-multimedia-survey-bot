import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUBMISSION_TAB,
  SUBMISSION_TABS,
  searchForTab,
  tabForLegacySubmitPath,
  tabFromSearch,
} from "../../../admin/src/survey/submission-tab";

/**
 * 投稿中心把原来两条独立入口（/submit 免登录、/submissions 金币）收成一个
 * 页面三个页签。页签解析是这条合并的接缝：解析错了会把用户丢进错的那半，
 * 而错的那半看起来完全正常（表单在、按钮在），只是没有他要的东西。
 */
describe("投稿中心页签解析", () => {
  it("没有参数时落到账号投稿", () => {
    expect(tabFromSearch("")).toBe("account");
    expect(tabFromSearch("?")).toBe("account");
    expect(DEFAULT_SUBMISSION_TAB).toBe("account");
  });

  it("认得三个合法页签", () => {
    expect(tabFromSearch("?tab=account")).toBe("account");
    expect(tabFromSearch("?tab=anon")).toBe("anon");
    expect(tabFromSearch("?tab=inbox")).toBe("inbox");
  });

  it("容忍大小写与首尾空白", () => {
    expect(tabFromSearch("?tab=ANON")).toBe("anon");
    expect(tabFromSearch("?tab=%20Inbox%20")).toBe("inbox");
  });

  it("和其它参数混在一起也能解析", () => {
    expect(tabFromSearch("?utm_source=group&tab=anon&utm_medium=post")).toBe("anon");
  });

  it("非法值回落到默认页签而不是报错", () => {
    expect(tabFromSearch("?tab=coin")).toBe("account");
    expect(tabFromSearch("?tab=")).toBe("account");
    expect(tabFromSearch("?tab=anon&tab=inbox")).toBe("anon");
    expect(tabFromSearch("?submit=1")).toBe("account");
  });

  it("searchForTab 对默认页签返回空串（分享用的地址不带冗余参数）", () => {
    expect(searchForTab("account")).toBe("");
    expect(searchForTab("anon")).toBe("?tab=anon");
    expect(searchForTab("inbox")).toBe("?tab=inbox");
  });

  it("searchForTab 的输出能被 tabFromSearch 原样读回", () => {
    for (const tab of SUBMISSION_TABS) {
      expect(tabFromSearch(searchForTab(tab))).toBe(tab);
    }
  });
});

describe("旧投稿路径映射", () => {
  it("/submit 去免登录投稿页签", () => {
    expect(tabForLegacySubmitPath("/submit")).toBe("anon");
    expect(tabForLegacySubmitPath("/submit/")).toBe("anon");
    /* 旧行为把 /submit/* 的其它子路径也当表单页，合并后保持同样的落点。 */
    expect(tabForLegacySubmitPath("/submit/anything")).toBe("anon");
  });

  it("/submit/inbox 去我的投稿页签", () => {
    /* 顺序是有意的：/submit/inbox 也以 /submit 开头，先判 inbox 才不会走错。 */
    expect(tabForLegacySubmitPath("/submit/inbox")).toBe("inbox");
    expect(tabForLegacySubmitPath("/submit/inbox/")).toBe("inbox");
    expect(tabForLegacySubmitPath("/submit/inbox/123")).toBe("inbox");
  });

  it("别的路径不归它管", () => {
    expect(tabForLegacySubmitPath("/submissions")).toBeNull();
    expect(tabForLegacySubmitPath("/submits")).toBeNull();
    expect(tabForLegacySubmitPath("/")).toBeNull();
    expect(tabForLegacySubmitPath("/s")).toBeNull();
  });
});

/**
 * 合并的结构性保证：三个页签都得真的渲染在一个页面里，且旧的独立路由分支
 * 已经变成重定向。这两条靠 grep 源码来钉 —— 一旦有人把 /submit 分支加回来，
 * 「两个投稿中心」就悄悄复活了，而单测里的纯函数一个都不会红。
 */
describe("合并后的路由结构", () => {
  const surveyApp = readFileSync(join(process.cwd(), "admin", "src", "survey", "SurveyApp.tsx"), "utf8");

  it("只保留一个投稿中心路由", () => {
    expect(surveyApp).toContain("<SubmissionHub />");
    expect(surveyApp).not.toContain("<SubmissionsScreen />");
  });

  it("旧的两条投稿路径都走重定向，不再渲染独立屏幕", () => {
    expect(surveyApp).toContain('<RedirectTo to="/submissions?tab=inbox" />');
    expect(surveyApp).toContain('<RedirectTo to="/submissions?tab=anon" />');
    expect(surveyApp).not.toContain("<SubmitScreen />");
    expect(surveyApp).not.toContain("<SubmitInboxScreen />");
  });

  it("服务端对旧路径返回 302 相对地址", () => {
    const index = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    expect(index).toMatch(/status:\s*302[^}]*Location:\s*`\/submissions\?tab=\$\{tab\}`/s);
  });
});
