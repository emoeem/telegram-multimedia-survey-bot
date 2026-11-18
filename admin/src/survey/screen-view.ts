/**
 * screen_view 结构化埋点（2026-11-19 通宵批次 B3，已知待办 1）。
 *
 * 设计约束：
 *  - 纯数据 + 纯函数，不碰 DOM —— 根项目单测（WebWorker lib）直接引用本文件；
 *  - 口径钉死「整页」：一次页面挂载只发一条，由 main.tsx 在模块挂载时调用。
 *    SPA 内部不发第二条（分发链在 SurveyApp 首次渲染时就定了屏，后续导航
 *    都是整页跳转，每次跳转都是新的一次挂载）；
 *  - 输出形状钉死 `{"type":"screen_view","screen":…,"path":…}` 一条 JSON 行：
 *    浏览器 console.info 一条（本地排查用），同一条再 keepalive POST 到
 *    /api/client-log（main.tsx），由 Worker 校验后 console.info 一遍，
 *    Workers Logs（wrangler.toml [observability]）检索的是 Worker 侧那条；
 *  - 自动化环境（Playwright 置位 navigator.webdriver）不发：机器人流量不能
 *    混进「我的」分组重排与一切用户行为判断的数据里（同 onboarding.ts 的
 *    webdriver 探测口径）。
 */

/** screen 名：与 SurveyApp 的 pathname 分发链分支一一对应（13 屏）。 */
export type ScreenViewName =
  | "series"
  | "plaza"
  | "me"
  | "coins"
  | "notes"
  | "gacha"
  | "submissions"
  | "showcase"
  | "trial"
  | "submit"
  | "auth"
  | "help"
  | "survey";

/**
 * 整页路由 → screen 名映射。
 *
 * 分支顺序、前缀判断与 SurveyApp 组件的分发链逐条对齐：分发链加/删分支时
 * 这里必须同步（tests/unit/survey/screen-view.test.ts 会静态读 SurveyApp.tsx
 * 双向断言）。注意两条 /submit 旧路径渲染的是 RedirectTo，落地屏是投稿中心，
 * 但口径按入口路径记作 "submit"——统计「投稿入口还带来多少人」需要它。
 * 剩余路径（/s/:id 与根路径）交给问卷运行器，口径同为 "survey"。
 */
export function resolveScreenViewName(pathname: string): ScreenViewName {
  if (pathname === "/series" || pathname.startsWith("/series/")) return "series";
  if (pathname === "/plaza" || pathname.startsWith("/plaza/")) return "plaza";
  if (pathname === "/me" || pathname.startsWith("/me/")) return "me";
  if (pathname === "/coins" || pathname.startsWith("/coins/")) return "coins";
  if (pathname === "/notes" || pathname.startsWith("/notes/")) return "notes";
  if (pathname === "/gacha" || pathname.startsWith("/gacha/")) return "gacha";
  if (pathname === "/submissions" || pathname.startsWith("/submissions/")) return "submissions";
  if (pathname === "/showcase" || pathname.startsWith("/showcase/")) return "showcase";
  if (pathname === "/trial" || pathname.startsWith("/trial/")) return "trial";
  if (pathname === "/submit/inbox" || pathname.startsWith("/submit/inbox/")) return "submit";
  if (pathname === "/submit" || pathname.startsWith("/submit/")) return "submit";
  if (pathname === "/auth" || pathname.startsWith("/auth/")) return "auth";
  if (pathname === "/help" || pathname.startsWith("/help/")) return "help";
  return "survey";
}

/** 自动化环境判定只需这一个字段；node 单测环境没有 navigator，按真实用户处理。 */
type AutomationNav = { webdriver?: boolean } | undefined;

/**
 * 生成一条 screen_view 日志行；自动化环境返回 null（调用方不输出）。
 * 键序钉死 type → screen → path，检索端按整行字符串匹配时才稳定。
 */
export function buildScreenViewLine(pathname: string, nav: AutomationNav): string | null {
  if (nav?.webdriver === true) return null;
  return JSON.stringify({ type: "screen_view", screen: resolveScreenViewName(pathname), path: pathname });
}
