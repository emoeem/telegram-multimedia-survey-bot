/** 公开页面的路由判定（纯函数，便于单测）。
 *
 * 这里只处理「裸域名 / 投稿两屏」这两处原本没有正确落地的地方，其余页面
 * （/plaza、/showcase、/trial、/me、/s/:id …）仍由 src/index.ts 原有的分支处理。
 *
 * 抽成独立模块的原因：`src/index.ts` 的 import 图会拖进 OG 图用的 resvg-wasm，
 * vitest 加载不了那个包，任何要从测试够到的路由逻辑都得先搬出来。
 */

/** 裸域名落到哪。
 *
 * `https://<domain>/` 之前会落到后台 SPA 的 index.html，而那个 SPA 的
 * `basename` 是 `/admin`，React Router 匹配不到 `/` —— 结果是一张纯白页
 * （标题还写着「问卷管理后台」）。首页本该是问卷列表，所以这里 302 到 `/s`。
 *
 * **相对路径**：同一个 Worker 同时挂在 emoe.eu.cc（Cloudflare，国内 SNI 阻断）
 * 和 emoemok.top（Vercel 中继）后面，中继改写后 request.url 的 host 永远是
 * emoe.eu.cc；写成绝对地址会把国内用户甩回打不开的域名。
 */
export const HOME_REDIRECT_LOCATION = "/s";

export function homeRedirectLocation(pathname: string): string | null {
  return pathname === "/" ? HOME_REDIRECT_LOCATION : null;
}

/** 投稿表单 / 收件箱两屏的 meta 键。
 *
 * 这两条路径原来直接 `serveHtmlAsset("/survey.html")`，于是**完全没有**
 * canonical / og:url / og:title —— 在微信、Telegram 里转发是一条光秃秃的链接。
 * 现在走统一的 `servePublicPageWithMeta`，元信息由 PUBLIC_ORIGIN（国内域名）拼出。
 */
export function submitPageMetaPath(pathname: string): string | null {
  if (pathname === "/submit" || pathname === "/submit/") return "/submit";
  if (pathname === "/submit/inbox" || pathname.startsWith("/submit/inbox/")) return "/submit/inbox";
  /* 旧的独立投稿页把其它 /submit/* 也当表单页，保持行为不变。 */
  if (pathname.startsWith("/submit/")) return "/submit";
  return null;
}

/** 转义写进 HTML 属性的字符串（标题、描述、URL 都要过一遍）。 */
export function escapeMetaAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/** 每个公开页自己的标题与描述。
 *
 * 标题不只是浏览器标签：Telegram / 微信转发时卡片上的那行大字就取它。
 * `/cert`（认证卡生成器）也是公开页，但它单独发 `/cert/index.html`，
 * 所以键名是路径 `/cert`、资源另传 —— 见 `publicPageHead` 的调用点。 */
export const PUBLIC_PAGE_META: Record<string, { title: string; description: string }> = {
  "/plaza": { title: "广场 · 问卷平台", description: "发现公开个人资料、树洞内容与社区问卷。" },
  "/showcase": { title: "展示区 · 问卷平台", description: "沉浸式浏览创作者的公开个人展览与作品。" },
  "/trial": { title: "挑战任务 · 问卷平台", description: "参与文字扮演挑战任务，查看成绩与排行榜。" },
  "/me": { title: "我的 · 问卷平台", description: "查看你的答卷、资料卡与挑战记录。" },
  "/coins": { title: "我的金币 · 问卷平台", description: "每日签到、挑战任务与金币收支明细。" },
  "/gacha": { title: "报告抽卡 · 问卷平台", description: "用金币抽取其他用户主动公开并授权的报告与内容。" },
  "/series": { title: "系列书架 · 问卷平台", description: "追更连载作品：新章节发布即通知。" },
  "/u": { title: "个人画像 · 问卷平台", description: "跨问卷的答卷足迹与收集成就。" },
  "/submissions": { title: "投稿中心 · 问卷平台", description: "投稿原创内容获取金币奖励，并参与报告抽卡生态。" },
  "/auth": { title: "邮箱账号 · 问卷平台", description: "使用邮箱注册、登录或找回问卷平台账号。" },
  "/s": { title: "问卷 · 问卷平台", description: "选一份问卷开始回答，或看看社区里正在流行的问卷。" },
  "/submit": { title: "投稿 · 问卷平台", description: "不用注册、不用装 Telegram，直接把内容投过来。" },
  "/submit/inbox": { title: "投稿收件箱 · 问卷平台", description: "查看投稿进度、管理员回复与审核结果。" },
  "/cert": {
    title: "认证卡生成器 · 问卷平台",
    description: "纯前端趣味认证卡生成器：多套主题、字段可编辑、支持上传证件照，照片不出本机。",
  },
};

/** 一个公开页要注入 `<head>` 的片段：canonical / og / twitter 一整套。
 *
 * 抽成纯函数（只吃 origin 和 pathname）是为了能单测：canonical 必须是
 * `PUBLIC_ORIGIN`（国内域名）+ 路径，绝不能是请求来的 host —— 中继改写后
 * 那是 emoe.eu.cc，国内打不开。 */
export function publicPageHead(origin: string, pathname: string): { title: string; injectHead: string } {
  const meta = PUBLIC_PAGE_META[pathname] ?? PUBLIC_PAGE_META["/plaza"]!;
  const title = escapeMetaAttribute(meta.title);
  const description = escapeMetaAttribute(meta.description);
  const canonical = escapeMetaAttribute(`${origin.replace(/\/+$/, "")}${pathname}`);
  const injectHead = [
    '<link rel="canonical" href="' + canonical + '" />',
    '<meta name="description" content="' + description + '" />',
    '<meta property="og:type" content="website" />',
    '<meta property="og:title" content="' + title + '" />',
    '<meta property="og:description" content="' + description + '" />',
    '<meta property="og:url" content="' + canonical + '" />',
    '<meta property="og:site_name" content="问卷平台" />',
    '<meta name="twitter:card" content="summary" />',
    '<meta name="twitter:title" content="' + title + '" />',
    '<meta name="twitter:description" content="' + description + '" />',
  ].join("\n    ");
  return { title, injectHead };
}
