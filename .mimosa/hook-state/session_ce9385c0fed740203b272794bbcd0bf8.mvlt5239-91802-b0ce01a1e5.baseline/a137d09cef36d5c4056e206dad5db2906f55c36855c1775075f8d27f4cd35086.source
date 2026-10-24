import { describe, expect, it } from "vitest";

import { CERT_PAGE_REDIRECT_LOCATION, certPageRoute } from "../../../src/http/cert-page";

/**
 * 同一个 Worker 挂在两个域名后面：emoe.eu.cc（Cloudflare，国内高频 SNI 阻断）和
 * emoemok.top（Vercel 中继，国内可达）。中继会把请求改写成 emoe.eu.cc 再打进来，
 * 所以 request.url 的 host 永远是 Cloudflare 那个。这里钉住「重定向必须是相对路径」，
 * 否则从 emoemok.top 进来的国内用户会被一脚踢回打不开的域名。
 *
 * 注：不能直接 import src/index.ts —— 它的依赖图会拉进 OG 图用的 resvg-wasm，
 * vitest 加载不了；路由判定因此抽在 src/http/cert-page.ts。
 */
describe("认证卡页面路由", () => {
  it("/cert 判定为重定向", () => {
    expect(certPageRoute("/cert")).toEqual({ kind: "redirect" });
  });

  it("重定向目标是相对路径（这正是国内打不开的根因）", () => {
    expect(CERT_PAGE_REDIRECT_LOCATION).toBe("/cert/");
    expect(CERT_PAGE_REDIRECT_LOCATION.startsWith("/")).toBe(true);
    expect(CERT_PAGE_REDIRECT_LOCATION).not.toContain("http");
    expect(CERT_PAGE_REDIRECT_LOCATION).not.toContain("emoe.eu.cc");
  });

  it("/cert/ 出 HTML 页面", () => {
    expect(certPageRoute("/cert/")).toEqual({ kind: "html" });
  });

  it("嵌套页面路径也出 HTML", () => {
    expect(certPageRoute("/cert/preview")).toEqual({ kind: "html" });
  });

  it("带扩展名的静态资源放行，交给静态兜底", () => {
    for (const p of [
      "/cert/app.js",
      "/cert/styles.css",
      "/cert/render.js",
      "/cert/vendor/qrcode.js",
      "/cert/cert.html",
    ]) {
      expect(certPageRoute(p), p).toBeNull();
    }
  });

  it("其它路径不受影响", () => {
    expect(certPageRoute("/")).toBeNull();
    expect(certPageRoute("/admin/")).toBeNull();
    expect(certPageRoute("/certs")).toBeNull();
  });
});
