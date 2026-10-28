import { describe, expect, it } from "vitest";

import {
  HOME_REDIRECT_LOCATION,
  bareAdminRedirect,
  homeRedirectLocation,
  escapeMetaAttribute,
  publicPageHead,
  submitPageMetaPath,
} from "../../../src/http/public-page";

/**
 * 两条都跟「国内域名」直接相关：
 *  - 裸域名原本落到后台 SPA 外壳（basename=/admin）→ 纯白页；
 *  - 投稿两屏原本不注入 canonical/og → 转发出去是光秃秃的链接，
 *    而且 canonical 缺失时搜索引擎会把 emoe.eu.cc 当主域（国内打不开的那个）。
 */
describe("裸域名重定向", () => {
  it("/ 落到 /s", () => {
    expect(homeRedirectLocation("/")).toBe("/s");
  });

  it("目标是相对路径（中继改写 host 后仍然落在用户访问的域名上）", () => {
    expect(HOME_REDIRECT_LOCATION).toBe("/s");
    expect(HOME_REDIRECT_LOCATION.startsWith("/")).toBe(true);
    expect(HOME_REDIRECT_LOCATION).not.toContain("http");
    expect(HOME_REDIRECT_LOCATION).not.toContain("emoe.eu.cc");
  });

  it("其它路径不受影响", () => {
    for (const path of ["/s", "/s/1", "/plaza", "/submit", "/admin/", "/cert/"]) {
      expect(homeRedirectLocation(path), path).toBeNull();
    }
  });
});

/**
 * 后台 SPA 的 basename 是 /admin。裸路径进兜底后 React Router 匹配不到，
 * 会命中 `*` 静默跳回总览——页面看起来正常，只是不是用户点的那个。
 * 这组用例锁住「补前缀」这一层，以及「别把公开页劫进后台」这条边界。
 */
describe("后台裸路径补 /admin 前缀", () => {
  it("导出的旧地址被补回前缀（文档里写错成 /exports 也不会跳到总览）", () => {
    expect(bareAdminRedirect("/exports")).toBe("/admin/exports");
    expect(bareAdminRedirect("/settings")).toBe("/admin/settings");
    expect(bareAdminRedirect("/surveys")).toBe("/admin/surveys");
  });

  it("带子路径与查询串时整段保留", () => {
    expect(bareAdminRedirect("/surveys/12/editor")).toBe("/admin/surveys/12/editor");
    expect(bareAdminRedirect("/surveys/12/responses/7")).toBe("/admin/surveys/12/responses/7");
  });

  it("公开页一个都不拦（否则会把前台流量劫进后台）", () => {
    for (const path of ["/s", "/s/1", "/s/1/og.png", "/submit", "/submit/inbox", "/plaza", "/showcase", "/trial", "/cert", "/me", "/report/42", "/report/42.pdf"]) {
      expect(bareAdminRedirect(path), path).toBeNull();
    }
  });

  it("根路径交给 homeRedirectLocation，不在这里重复处理", () => {
    expect(bareAdminRedirect("/")).toBeNull();
  });

  it("API 与静态资源不受影响（第一段不是后台视图名）", () => {
    for (const path of ["/api/admin/surveys", "/api/survey/1", "/assets/main.js", "/health"]) {
      expect(bareAdminRedirect(path), path).toBeNull();
    }
  });

  it("只是名字相近的路径不会被误判", () => {
    /* `/report/:id` 是公开报告页，`/reports` 才是后台归档；
     * `/submission` 不是 `/submit`，两者都不该命中。 */
    for (const path of ["/reports-archive", "/surveyss", "/settings-backup", "/usersx"]) {
      expect(bareAdminRedirect(path), path).toBeNull();
    }
  });
});

describe("投稿两屏的 meta 路径", () => {
  it("表单页与收件箱各自有键（收件箱不能复用表单页的 canonical）", () => {
    expect(submitPageMetaPath("/submit")).toBe("/submit");
    expect(submitPageMetaPath("/submit/")).toBe("/submit");
    expect(submitPageMetaPath("/submit/inbox")).toBe("/submit/inbox");
    expect(submitPageMetaPath("/submit/inbox/12")).toBe("/submit/inbox");
  });

  it("旧的 /submit/* 子路径仍当表单页处理（保持原有行为）", () => {
    expect(submitPageMetaPath("/submit/preview")).toBe("/submit");
    /* 拼错的子路径也归到表单页的 canonical：行为与改动前一致（都发 survey.html），
     * 同时把重复 URL 的权重收回到 /submit 一条。 */
    expect(submitPageMetaPath("/submit/inboxx")).toBe("/submit");
  });

  it("不相干的路径返回 null", () => {
    for (const path of ["/", "/s", "/plaza", "/submission", "/submits"]) {
      expect(submitPageMetaPath(path), path).toBeNull();
    }
  });
});

describe("公开页 head 注入", () => {
  it("canonical 永远取 PUBLIC_ORIGIN，而不是请求来的 host", () => {
    /* 中继改写后 request.url 是 emoe.eu.cc（国内 SNI 阻断）；若 canonical 跟着
     * host 走，搜索引擎就会把打不开的那个域名当主域。 */
    const { injectHead } = publicPageHead("https://emoemok.top", "/plaza");
    expect(injectHead).toContain('<link rel="canonical" href="https://emoemok.top/plaza" />');
    expect(injectHead).toContain('<meta property="og:url" content="https://emoemok.top/plaza" />');
    expect(injectHead).not.toContain("emoe.eu.cc");
  });

  it("origin 末尾多一个斜杠也不会拼出 //path", () => {
    const { injectHead } = publicPageHead("https://emoemok.top/", "/submit");
    expect(injectHead).toContain('href="https://emoemok.top/submit"');
    expect(injectHead).not.toContain("top//submit");
  });

  it("认证卡生成器有自己的一整条 meta（它单独发 /cert/index.html）", () => {
    const { title, injectHead } = publicPageHead("https://emoemok.top", "/cert");
    expect(title).toBe("认证卡生成器 · 问卷平台");
    expect(injectHead).toContain('href="https://emoemok.top/cert"');
    expect(injectHead).toContain('content="认证卡生成器 · 问卷平台"');
  });

  it("未知路径回退到广场那一套，不会抛错也不会拼出 undefined", () => {
    const { injectHead } = publicPageHead("https://emoemok.top", "/nope");
    expect(injectHead).toContain('href="https://emoemok.top/nope"');
    expect(injectHead).not.toContain("undefined");
  });

  it("标题里的引号与 & 被转义，不会撑破属性", () => {
    expect(escapeMetaAttribute('A &copy; "quote"')).toBe("A &amp;copy; &quot;quote&quot;");
  });
});
