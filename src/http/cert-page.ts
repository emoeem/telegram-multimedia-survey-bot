/** 认证卡生成器的路由判定。
 *
 * 单独成模块是为了能直接单测：`src/index.ts` 的 import 图会拖进 OG 图用的
 * resvg-wasm，vitest 加载不了那个包，所以任何要从测试里够到 worker 路由的
 * 逻辑都得先抽出来。
 */

/** `/cert` → `/cert/` 的重定向目标。
 *
 * **必须保持相对路径**。同一个 Worker 挂在两个域名后面：
 *   - `emoe.eu.cc`  —— Cloudflare 共享段，国内多数网络 SNI 阻断；
 *   - `emoemok.top` —— Vercel 中继（见 docs/ops/CN_ACCESS_VERCEL_RELAY.md），国内可达。
 * 中继会把请求改写成 `https://emoe.eu.cc/<path>` 再打进来，因此 `request.url`
 * 的 host 永远是 Cloudflare 那个域名。若这里写成绝对地址，从 emoemok.top 进来的
 * 国内用户点开 `/cert` 会被甩回打不开的 emoe.eu.cc —— 表现为「链接打不开」。
 * 相对 Location 由浏览器按当前访问域名补全，两个域名都能正确落到 `/cert/`。
 */
export const CERT_PAGE_REDIRECT_LOCATION = "/cert/";

export type CertPageRoute = { kind: "redirect" } | { kind: "html" };

export function certPageRoute(pathname: string): CertPageRoute | null {
  if (pathname === CERT_PAGE_REDIRECT_LOCATION.slice(0, -1)) return { kind: "redirect" };
  if (pathname.startsWith(CERT_PAGE_REDIRECT_LOCATION)) {
    /* 带扩展名的（app.js / styles.css / vendor/qrcode.js）交给静态资源兜底，
     * 否则会被一律替换成 index.html，页面拿不到脚本和样式。 */
    const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
    if (!lastSegment.includes(".")) return { kind: "html" };
  }
  return null;
}
