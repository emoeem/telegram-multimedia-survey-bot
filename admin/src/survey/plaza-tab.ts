/**
 * 广场页签解析 —— 纯函数，不碰 DOM、不发请求（2026-11-19 通宵批次 B5）。
 *
 * 单独成模块的理由与 submission-target.ts 相同：解析逻辑要配单测（worker 的
 * Node 测试环境没有 DOM，直接 import PlazaScreen.tsx 会把 React/window 拉进来）。
 *
 * 默认页签从「资料墙」改为「树洞」：广场的定位就是匿名树洞（欢迎卡与
 * screen-help.ts 的 plaza intro 同口径），直开 /plaza 首屏应该是树洞。
 * 带 tab 参数的直达链接行为不变——完成页的 /plaza?tab=profiles、机器人与
 * 更新通知里的 /plaza?tab=treehole 都按原样落地；历史链接里还出现过单数
 * tab=profile，同样按资料墙处理。其余未知值跟随新默认（树洞）。
 *
 * 注意：裸 /plaza 的语义随默认翻转而变化。机器人侧原本依赖旧默认落到
 * 资料墙的两个按钮（plaza-handler.ts 的「🧑 个人资料」「打开个人资料画廊」）
 * 与答卷档案详情页的「返回广场 / 回广场逛逛」已在 2026-11-19 复核时显式
 * 改带 ?tab=profiles；其余裸 /plaza 入口（主菜单「🏛 广场」、展示区空态
 * 「去广场看看」、底部导航等）语义是逛广场，落树洞即为正确。
 */

export type PlazaTab = "treehole" | "profiles";

export function plazaTabFromSearch(search: string): PlazaTab {
  const requested = new URLSearchParams(search).get("tab");
  if (requested === "treehole") return "treehole";
  if (requested === "profiles" || requested === "profile") return "profiles";
  return "treehole";
}
