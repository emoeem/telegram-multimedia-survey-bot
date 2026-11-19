/**
 * 应用中心「网页导航」的打开逻辑（2026-11-20 P0 加固批次 M4，安全敏感面）。
 *
 * 纯函数、零网络副作用：openWebAppLink 只做「校验 → 分支 → 打开」，不发任何
 * 请求（点击前无预加载/ping）；必须由用户点击回调调用，本模块不存在自动
 * 触发路径。三分支：
 *
 * 1. Telegram + open_mode=miniapp：currentWebApp().openLink(url)——Telegram
 *    WebView 里 window.open 不可靠，客户端文档要求外链一律走 openLink，
 *    mini app 链接由 Telegram 内嵌打开；
 * 2. Telegram + open_mode=browser：同样走 openLink，由 Telegram 交给系统
 *    浏览器（等效新上下文）；
 * 3. 普通浏览器：window.open(url, '_blank', 'noopener,noreferrer')——新标签
 *    且切断 opener，防反向 tabnabbing。
 *
 * 绝不把第三方站点塞 iframe（mini app 的内嵌呈现是 Telegram openLink 的
 * 职责，不是我们的）；纵深防御：打开前用公开 API 下发的 allowed_domains
 * 二次校验目标 host（镜像服务端策略，权威定义见
 * src/db/repositories/web-app.repository.ts 的 ALLOWED_DOMAIN_WILDCARD_PREFIX
 * 注释），不命中一律拦截——管理端数据异常或被篡改时前端不盲目打开。
 */

/** 打开结果：blocked 之外的三种都已真正调起打开动作。 */
export type WebAppOpenOutcome =
  "opened:telegram-miniapp" | "opened:telegram-link" | "opened:browser-tab" | "blocked:not-allowed";

/** 只依赖打开所需的最小形状（WebAppLink / 公开 API 行都满足）。 */
export interface OpenableWebApp {
  url: string;
  openMode?: string;
  allowedDomains?: string[] | null;
}

/** Telegram 桥的最小结构子集（telegram.ts currentWebApp() 的返回可直传）。 */
export interface WebAppOpenTelegramBridge {
  openLink?: (url: string) => void;
}

export interface WebAppOpenEnv {
  /** Telegram 桥；普通浏览器环境传 null/undefined。 */
  telegramWebApp?: WebAppOpenTelegramBridge | null;
  /** 注入点（单测用）；生产走 window.open。 */
  windowOpen?: (url: string, target: string, features: string) => unknown;
}

/**
 * 结构化的 browser 全局（同 telegram.ts 的处理：本文件也会被根项目的
 * 单测在 WebWorker lib 下编译，那里没有 window 声明，一律经 globalThis）。
 */
const browserScope = globalThis as unknown as {
  window?: { open?: (url?: string, target?: string, features?: string) => unknown };
};

/** 白名单条目的小写归一化：去空白；非法（非字符串/空）丢弃。 */
function normalizeDomainEntry(item: unknown): string {
  return typeof item === "string" ? item.trim().toLowerCase() : "";
}

/**
 * 打开前的白名单二次校验（纵深防御，服务端同策略的镜像）：
 * - 显式主机名 `a.example.com`：精确匹配（不含子域）；
 * - 通配 `*.example.com`：任意深度子域命中，不含裸域 `example.com`；
 * - 比较用 URL.hostname（小写、不含端口）；url 解析不出 host → false。
 *
 * 空白名单一律 false（拦截并提示）：服务端保存时已强制「未配置=与 url
 * 同域」落库（src/http/admin/web-app.ts 收口块），到达公开 API 的行都带
 * 非空白名单；看到空列表只能是绕过 API 写入的脏数据或被篡改——前端对
 * 数据异常宁可拦错不可放行，提示用户而不是静默打开。
 */
export function isWebAppUrlAllowed(url: string, allowedDomains: string[] | null | undefined): boolean {
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname) return false;
  const domains = (Array.isArray(allowedDomains) ? allowedDomains : []).map(normalizeDomainEntry).filter(Boolean);
  if (domains.length === 0) return false;
  for (const domain of domains) {
    if (domain.startsWith("*.")) {
      const base = domain.slice(2);
      if (base && hostname.endsWith(`.${base}`)) return true;
    } else if (hostname === domain) {
      return true;
    }
  }
  return false;
}

/**
 * 打开一个网页导航条目。只在用户点击回调里调用；除 blocked 外的返回值都
 * 表示已经调起对应分支的打开动作。
 */
export function openWebAppLink(app: OpenableWebApp, env: WebAppOpenEnv = {}): WebAppOpenOutcome {
  const url = typeof app?.url === "string" ? app.url.trim() : "";
  // 第一道闸：目标 host 必须命中公开 API 下发的白名单（纵深防御）。
  if (!url || !isWebAppUrlAllowed(url, app?.allowedDomains)) return "blocked:not-allowed";
  const telegram = env.telegramWebApp ?? null;
  if (telegram && typeof telegram.openLink === "function") {
    // Telegram 内（分支 1/2）：一律走官方 openLink，不碰 window.open，
    // 更不 iframe。open_mode 只决定 Telegram 侧呈现（内嵌/外跳），
    // 打开动作本身相同。
    telegram.openLink(url);
    return app.openMode === "miniapp" ? "opened:telegram-miniapp" : "opened:telegram-link";
  }
  // 普通浏览器（分支 3）：新标签 + noopener,noreferrer。
  const open = env.windowOpen ?? browserScope.window?.open?.bind(browserScope.window);
  if (!open) return "blocked:not-allowed";
  open(url, "_blank", "noopener,noreferrer");
  return "opened:browser-tab";
}
