import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUBMISSION_TAB,
  SUBMISSION_TABS,
  directEntryFromSearch,
  searchForTab,
  tabForLegacySubmitPath,
  tabFromSearch,
} from "../../../admin/src/survey/submission-tab";

/**
 * 投稿中心把原来两条独立入口（/submit 免登录、/submissions 金币）收成一个
 * 页面。页签解析是这条合并的接缝：解析错了会把用户丢进错的那半，而错的那半
 * 看起来完全正常（表单在、按钮在），只是没有他要的东西。
 *
 * 页签模型收拢过一次：三个页签（账号投稿 / 免登录投稿 / 我的投稿）→ 两个
 * （投稿 / 我的投稿），两条投稿流水线变成「投稿」页签内的次级分段。旧值
 * `account` / `anon` 仍会从历史链接、服务端 302 和 RedirectTo 进来，必须继续
 * 解析到正确的落点。
 */
describe("投稿中心页签解析", () => {
  it("没有参数时落到投稿页签", () => {
    expect(tabFromSearch("")).toBe("submit");
    expect(tabFromSearch("?")).toBe("submit");
    expect(DEFAULT_SUBMISSION_TAB).toBe("submit");
  });

  it("认得两个合法页签", () => {
    expect(tabFromSearch("?tab=submit")).toBe("submit");
    expect(tabFromSearch("?tab=inbox")).toBe("inbox");
  });

  it("三页签时代的旧值归到投稿页签而不是报错", () => {
    expect(tabFromSearch("?tab=account")).toBe("submit");
    expect(tabFromSearch("?tab=anon")).toBe("submit");
  });

  it("容忍大小写与首尾空白", () => {
    expect(tabFromSearch("?tab=INBOX")).toBe("inbox");
    expect(tabFromSearch("?tab=%20Inbox%20")).toBe("inbox");
  });

  it("和其它参数混在一起也能解析", () => {
    expect(tabFromSearch("?utm_source=group&tab=inbox&utm_medium=post")).toBe("inbox");
  });

  it("非法值回落到默认页签而不是报错", () => {
    expect(tabFromSearch("?tab=coin")).toBe("submit");
    expect(tabFromSearch("?tab=")).toBe("submit");
    expect(tabFromSearch("?tab=anon&tab=inbox")).toBe("submit");
    expect(tabFromSearch("?submit=1")).toBe("submit");
  });

  it("searchForTab 对默认页签返回空串（分享用的地址不带冗余参数）", () => {
    expect(searchForTab("submit")).toBe("");
    expect(searchForTab("inbox")).toBe("?tab=inbox");
  });

  it("searchForTab 的输出能被 tabFromSearch 原样读回", () => {
    for (const tab of SUBMISSION_TABS) {
      expect(tabFromSearch(searchForTab(tab))).toBe(tab);
    }
  });
});

describe("免登录直投的落点判定", () => {
  it("旧链接 ?tab=anon 落到直投表单", () => {
    expect(directEntryFromSearch("?tab=anon")).toBe(true);
    expect(directEntryFromSearch("?tab=ANON")).toBe(true);
    expect(directEntryFromSearch("?utm_source=group&tab=anon")).toBe(true);
  });

  it("其余进法（含旧值 account）都落在金币表单", () => {
    expect(directEntryFromSearch("")).toBe(false);
    expect(directEntryFromSearch("?tab=account")).toBe(false);
    expect(directEntryFromSearch("?tab=inbox")).toBe(false);
    expect(directEntryFromSearch("?tab=direct")).toBe(false);
  });
});

describe("旧投稿路径映射", () => {
  it("/submit 落到投稿页签（anon 目标再由 directEntryFromSearch 解释成直投表单）", () => {
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

  it("旧路径的 302 目标能被页签解析接住（服务端重定向 → 前端落点的闭环）", () => {
    for (const target of ["anon", "inbox"] as const) {
      const search = `?tab=${target}`;
      expect(tabFromSearch(search)).toBe(target === "inbox" ? "inbox" : "submit");
    }
  });
});

/**
 * 合并的结构性保证：投稿中心只此一页，且旧的独立路由分支已经变成重定向。
 * 这几条靠 grep 源码来钉 —— 一旦有人把 /submit 分支加回来，「两个投稿中心」
 * 就悄悄复活了，而单测里的纯函数一个都不会红。
 */
describe("合并后的路由结构", () => {
  const surveyApp = readFileSync(join(process.cwd(), "admin", "src", "survey", "SurveyApp.tsx"), "utf8");
  const hub = readFileSync(join(process.cwd(), "admin", "src", "survey", "SubmissionHub.tsx"), "utf8");

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

  it("页签收成两个：金币/直投是投稿页签内的分段，不再是并列页签", () => {
    /* 页签按钮只剩「投稿 / 我的投稿」；分段按钮（免登录直投）的 role 是
     * tablist 但渲染在页签之外的容器里，靠 data-submission-hub 的两态钉住
     * 页签数量。 */
    expect(hub).toContain('(["submit", "inbox"] as const).map');
    expect(hub).toContain("免登录直投");
    expect(hub).not.toContain('id: "account"');
  });
});
