/**
 * 帮助中心（/help，2026-11-19 通宵批次 B3，已知待办 2）的渲染数据层。
 *
 * 设计约束：
 *  - 纯数据 + 纯函数，不碰 DOM —— 根项目单测（WebWorker lib）直接引用本文件；
 *  - 内容完全复用 screen-help.ts 的 SCREEN_HELP 注册表（? 弹层与帮助中心
 *    是同一份数据的两个渲染面，改一处两边同步）；
 *  - 「未接线键」也渲染：cert 是独立静态页没有 ? 按钮，但它的说明照样进
 *    帮助中心——整页帮助不该漏任何一屏。
 */

import { SCREEN_HELP, type ScreenHelp } from "./screen-help";

/** 分组标题：与各屏 PageHeader 的 title 同口径，用户在两处看到同一个称呼。 */
export const HELP_SCREEN_TITLES: Record<string, string> = {
  survey: "问卷大厅",
  plaza: "广场",
  showcase: "展示区",
  trial: "挑战任务",
  coins: "我的金币",
  gacha: "抽奖中心",
  submissions: "投稿中心",
  notes: "纸条聊天",
  series: "系列书架",
  me: "我的",
  submit: "投稿",
  cert: "认证卡生成器",
};

export interface HelpScreenGroup {
  /** 注册表键（= helpKey）。 */
  key: string;
  /** 分组标题（中文，缺省回退到键名——单测守卫不允许回退发生）。 */
  title: string;
  help: ScreenHelp;
}

/** 注册表 → 渲染分组：保持 SCREEN_HELP 的定义顺序。 */
export function groupScreenHelp(): HelpScreenGroup[] {
  return Object.entries(SCREEN_HELP).map(([key, help]) => ({
    key,
    title: HELP_SCREEN_TITLES[key] ?? key,
    help,
  }));
}
