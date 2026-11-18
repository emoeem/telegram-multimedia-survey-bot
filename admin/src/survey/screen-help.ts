/**
 * 每屏「这是什么」帮助内容注册表（2026-11-18，用户反馈：界面专业但功能太多看不懂）。
 *
 * 设计约束：
 *  - 纯数据 + 纯函数，不碰 DOM —— 根项目单测（WebWorker lib）直接引用本文件；
 *  - 内容口径是"外行人测试"：每个词都要用大白话解释它是什么、对我有什么用、
 *    第一步点哪里。避免内部术语（弱引用/素材库/投稿管线）出现在文案里；
 *  - entries 的 href 必须是公开路由白名单里的真实入口（tests/unit/survey/
 *    screen-help.test.ts 会校验），新增公开路由要同步补进 ROUTE_ALLOWLIST。
 */

export interface ScreenHelpEntry {
  /** 动作名（外行话）。 */
  label: string;
  /** 一句话说明这个动作会发生什么。 */
  hint: string;
  /** 可选跳转入口；缺省表示"就在当前屏做"。 */
  href?: string;
}

export interface ScreenHelp {
  /** 这一面是什么（一句话，页头 subtitle 的展开版）。 */
  intro: string;
  /** 新手最常用的 2-4 个动作。 */
  entries: ScreenHelpEntry[];
}

/**
 * 公开路由白名单：帮助条目里出现的 href 必须都在这里，防止文案里埋进
 * 已下线/拼错的入口。
 */
export const ROUTE_ALLOWLIST = [
  "/s",
  "/plaza",
  "/showcase",
  "/trial",
  "/me",
  "/coins",
  "/gacha",
  "/submissions",
  "/notes",
  "/series",
  "/cert/",
] as const;

export const SCREEN_HELP: Record<string, ScreenHelp> = {
  survey: {
    intro: "这里是问卷大厅：浏览可以填写的问卷，点开就直接答，答完会生成一份为你写的解读报告。",
    entries: [
      // 与注册墙同口径（src/http/survey/handler.ts：「填写问卷前请先注册或
      // 登录（邮箱即可）」）。旧文案「不用注册账号」与实际行为相反——浏览器
      // 匿名访客点开问卷会被 401 拦下，直接劝退。
      { label: "挑一份填", hint: "点开一份问卷开始作答，填写前需要注册或登录（用邮箱就行）", href: "/s" },
      { label: "回头看报告", hint: "填过的问卷的解读报告都在「我的」里", href: "/me" },
    ],
  },
  plaza: {
    intro: "广场是大家的匿名树洞：看看别人发的帖子，也可以匿名发一条自己的心里话。",
    entries: [
      { label: "逛帖子", hint: "就在当前页，往下滑就行" },
      { label: "匿名发帖", hint: "在广场里点发布，没人知道是你" },
      { label: "放一张纸条", hint: "想找人聊聊？去纸条聊天抽一个同路的人", href: "/notes" },
    ],
  },
  showcase: {
    intro: "展示区是答题结果做成的沉浸式人物档案：像翻一本画册一样，看一个人在问卷里留下的画像。",
    entries: [
      { label: "翻看档案", hint: "就在当前页，左右滑动切换人物" },
      { label: "去广场聊聊", hint: "看完想说话？去广场匿名发帖", href: "/plaza" },
    ],
  },
  trial: {
    intro: "挑战任务是用答题做的小游戏：一层层往上闯关，通关记录和排行榜都在这里。",
    entries: [
      { label: "开一局", hint: "挑一个挑战直接开始，答得越快分越高" },
      { label: "看排行榜", hint: "就在当前页往下滑" },
    ],
  },
  coins: {
    intro: "金币是站内奖励：每天签到、完成挑战都能攒，攒够了去抽随机报告、换奖励。",
    entries: [
      { label: "每日签到", hint: "就在当前页，点一下今天的格子" },
      { label: "去抽卡", hint: "用金币抽一份随机的答卷报告，像拆盲盒", href: "/gacha" },
    ],
  },
  gacha: {
    intro: "报告抽卡：用金币抽一份随机的答卷报告，像拆盲盒，抽到什么看运气。",
    entries: [
      { label: "抽一次", hint: "就在当前页，消耗金币开一抽" },
      { label: "攒金币", hint: "签到和挑战都能攒，去金币中心看看", href: "/coins" },
    ],
  },
  submissions: {
    intro: "投稿中心：你把自己做的问卷投给站方，审核通过后会出现在大厅里让更多人填。",
    entries: [
      { label: "投一份问卷", hint: "在当前页填投稿表单，不用注册" },
      { label: "查进度", hint: "投过的稿子和审核留言都在当前页" },
    ],
  },
  notes: {
    intro: "纸条聊天：匿名放一张纸条，系统帮你抽一个和你同路的人，两个人从此开始私聊。",
    entries: [
      { label: "放一张纸条", hint: "写一句话投进纸条池，等有缘人抽到" },
      { label: "看我的对话", hint: "抽到之后，聊天就在当前页里" },
    ],
  },
  series: {
    intro: "系列书架：像追小说一样追问卷连载，作者更新一章，你就能接着读。",
    entries: [
      { label: "挑一部追", hint: "就在当前页，点开第一部从第一章读" },
      { label: "回个人中心", hint: "追更的提醒会出现在「我的」里", href: "/me" },
    ],
  },
  me: {
    intro: "你的个人中心：填过的问卷、生成的报告、资料卡和所有通知都在这里。",
    entries: [
      { label: "我的报告", hint: "填过的每份问卷的解读报告都在这里" },
      { label: "资料卡", hint: "你的答题画像，可以直接分享" },
      { label: "通知", hint: "纸条配对、连载更新、审核结果都会在这里提醒" },
    ],
  },
  submit: {
    intro: "投稿页：把你做的问卷投给站方，不用注册，审核通过后自动发布。",
    entries: [
      { label: "填投稿表单", hint: "就在当前页" },
      { label: "看我的投稿", hint: "进度和审核留言在投稿中心", href: "/submissions" },
    ],
  },
  cert: {
    intro: "认证卡生成器：把答卷结果做成一张好看的图片卡片，可以直接发到朋友圈或群里。",
    entries: [{ label: "生成认证卡", hint: "就在当前页，选好样式保存图片即可" }],
  },
};

export function getScreenHelp(key: string): ScreenHelp | null {
  return SCREEN_HELP[key] ?? null;
}

/** 校验注册表里所有 href 都是公开路由白名单里的真实入口。 */
export function validateScreenHelpEntries(): string[] {
  const problems: string[] = [];
  for (const [key, help] of Object.entries(SCREEN_HELP)) {
    if (!help.intro.trim()) problems.push(`${key}: intro 不能为空`);
    if (help.entries.length === 0) problems.push(`${key}: 至少要有一个动作示例`);
    for (const entry of help.entries) {
      if (!entry.label.trim() || !entry.hint.trim()) problems.push(`${key}: entry 的 label/hint 不能为空`);
      const href = entry.href;
      if (href && !ROUTE_ALLOWLIST.some((route) => href === route || href.startsWith(`${route}/`))) {
        problems.push(`${key}: entry href 不在公开路由白名单里: ${href}`);
      }
    }
  }
  return problems;
}
