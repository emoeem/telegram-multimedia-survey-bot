/**
 * 工作区信息架构的唯一数据源（T2 重心视图）。
 *
 * Layout 的图标轨 / 工作区 tab 条与 Dashboard 的「功能地图」都从这里取数，
 * 数据只维护一份：改这里，两处导航与地图同步变化。
 *
 * 本模块保持零 import（对齐 publish-choice.ts 等纯逻辑模块的仓内约定）：
 * 根目录的 vitest/tsc 会把 tests/unit/admin 的用例连进程序编译，而 lucide-react
 * 只装在 admin 自己的 node_modules 里、根目录解析不到。因此图标以字符串键存储，
 * 由 Layout 侧映射成 lucide 组件；类型全部就地声明（结构与 api.ts 的
 * DashboardData 字段兼容即可）。
 */

export type WorkspaceId = "surveys" | "content" | "community" | "system";

/** 图标键 → Layout 侧 `ICONS` 表映射为 lucide-react 组件。 */
export type WorkspaceIconKey =
  | "badgeCheck"
  | "clipboardList"
  | "coins"
  | "contact"
  | "fileUp"
  | "images"
  | "inbox"
  | "keyRound"
  | "listChecks"
  | "package"
  | "palette"
  | "scrollText"
  | "serverCog"
  | "settings"
  | "sprout"
  | "tags"
  | "target"
  | "trash2"
  | "users";

export interface WorkspaceNavItem {
  /** 工作区内序号（1 起连续）：编号取自数据，角色过滤后不漂移。 */
  order: number;
  to: string;
  label: string;
  icon: WorkspaceIconKey;
  /** 一句话说明（功能地图 tab 芯片的 tooltip）。 */
  hint: string;
}

export interface Workspace {
  id: WorkspaceId;
  /** 工作区序号（1-4）：图标轨 tooltip、tab 条编号与功能地图共用。 */
  order: number;
  label: string;
  icon: WorkspaceIconKey;
  /** 图标轨点击后的着陆页。 */
  entry: string;
  /** 一句话说明（图标轨 tooltip / 功能地图工作区卡副标题）。 */
  hint: string;
  /** 工作区顶部 tab 条（含着陆页自身）。 */
  tabs: WorkspaceNavItem[];
}

/**
 * 工作区信息架构（2026-10-31 用户提案，原注释随数据迁入此处）：左侧常驻的
 * 20+ 项全局导航在创作/操作时几乎全是噪音。改为两层：
 *
 *  - 全局图标轨（56px 常驻）：每个工作区一个图标，点击进入其着陆页；
 *  - 工作区子导航：进入工作区后，主区域顶部出现该工作区的横向 tab 条
 *    （如问卷工作区：列表|分类|导入|答卷动态|报告），其余工作区不可见——
 *    「点问卷这个分类，整个界面就不一样」。
 *
 * 路由不变，只是导航的组织方式变了；问卷详情子页（/surveys/:id/*）归属
 * 问卷工作区（Layout 的 workspaceIdOf 硬编码该前缀），子导航条继续显示，
 * 页内返回按钮负责上下层回退。
 *
 * 2026-11-07 T2：加入编号坐标——工作区 order（1-4）与 tab order（工作区内
 * 1 起），图标轨 tooltip、tab 条标签与 Dashboard 功能地图共用同一编号，
 * 「功能多而不迷路」：编号随数据走，角色过滤后也不漂移。
 */
export const WORKSPACES: readonly Workspace[] = [
  {
    id: "surveys",
    order: 1,
    label: "问卷",
    icon: "clipboardList",
    entry: "/surveys",
    hint: "创建与编辑问卷、查看答卷与报告",
    tabs: [
      { order: 1, to: "/surveys", label: "问卷列表", icon: "clipboardList", hint: "全部问卷的列表、筛选与状态操作" },
      { order: 2, to: "/categories", label: "分类", icon: "tags", hint: "问卷分组与排序管理" },
      { order: 3, to: "/imports", label: "导入", icon: "fileUp", hint: "从 Word / 网页导入问卷" },
      { order: 4, to: "/responses", label: "答卷动态", icon: "listChecks", hint: "实时查看各问卷的新答卷" },
      { order: 5, to: "/reports", label: "报告", icon: "package", hint: "报告生成与归档记录" },
    ],
  },
  {
    id: "content",
    order: 2,
    label: "内容",
    icon: "coins",
    entry: "/coin-economy",
    hint: "投稿、用户、模板与素材",
    tabs: [
      { order: 1, to: "/coin-economy", label: "金币经济", icon: "coins", hint: "金币发放、消费与流水" },
      { order: 2, to: "/web-submissions", label: "网页投稿", icon: "inbox", hint: "网页端投稿的审核与处理" },
      { order: 3, to: "/users", label: "用户", icon: "users", hint: "用户目录与身份信息" },
      { order: 4, to: "/templates", label: "模板", icon: "palette", hint: "报告模板的样式与排版" },
      { order: 5, to: "/cert-content", label: "认证卡内容", icon: "badgeCheck", hint: "认证卡文案与素材配置" },
      { order: 6, to: "/media-library", label: "素材库", icon: "images", hint: "图片 / 视频等媒体素材" },
    ],
  },
  {
    id: "community",
    order: 3,
    label: "社区",
    icon: "sprout",
    entry: "/plaza",
    hint: "树洞、画廊与展示区",
    tabs: [
      { order: 1, to: "/plaza", label: "树洞", icon: "sprout", hint: "树洞帖子的审核与展示" },
      { order: 2, to: "/profile-gallery", label: "个人画廊", icon: "contact", hint: "用户个人主页画廊" },
      { order: 3, to: "/showcase", label: "展示区", icon: "images", hint: "精选内容的公开展示" },
      // Renamed from 挑战任务: the footer's /trial link carries the same label,
      // and the two point at different pages (this one is the 小游戏 admin, the
      // footer one is the public 小游戏 page). The page title here is 小游戏管理.
      { order: 4, to: "/task-packs", label: "小游戏管理", icon: "target", hint: "小游戏任务包配置" },
    ],
  },
  {
    id: "system",
    order: 4,
    label: "系统",
    icon: "settings",
    entry: "/settings",
    hint: "审计、回收站、授权与设置",
    tabs: [
      { order: 1, to: "/audit", label: "审计", icon: "scrollText", hint: "敏感操作审计日志" },
      { order: 2, to: "/trash", label: "回收站", icon: "trash2", hint: "已删除内容的恢复" },
      { order: 3, to: "/licenses", label: "授权", icon: "keyRound", hint: "部署授权与许可" },
      { order: 4, to: "/control", label: "控制中心", icon: "serverCog", hint: "运行状态与运维操作" },
      { order: 5, to: "/settings", label: "设置", icon: "settings", hint: "系统参数与机器人配置" },
    ],
  },
];

/** 按序号排列的工作区（防御式排序：数据文件内乱序也不影响展示顺序）。 */
export const WORKSPACES_BY_ORDER: readonly Workspace[] = [...WORKSPACES].sort((a, b) => a.order - b.order);

/**
 * tab 的稳定编号（如 "1.2"）：workspace 序号 + tab 在工作区内的序号。
 * 编号只取显式 order 字段——Layout 按角色过滤 tabs（creator 隐藏导入/分类、
 * 未接授权中心隐藏授权/控制中心）后，编号也不漂移，口头「去 1.4」始终成立。
 */
export function tabNumberOf(workspace: Workspace, tab: WorkspaceNavItem): string {
  return `${workspace.order}.${tab.order}`;
}

/**
 * 功能地图的计数输入：只用 /api/admin/dashboard 的既有字段
 * （admin/src/api.ts 的 DashboardData），零新增请求、零 D1 行读成本。
 */
export interface FeatureMapCounts {
  /** 问卷总数（DashboardData.surveys）。 */
  surveys: number;
  /** 已发布问卷数（DashboardData.publishedSurveys）。 */
  publishedSurveys: number;
}

export interface FeatureMapBadge {
  label: string;
  value: number;
}

export interface FeatureMapTab {
  /** 稳定编号（tabNumberOf），如 "1.2"。 */
  number: string;
  label: string;
  to: string;
  hint: string;
}

export interface FeatureMapWorkspace {
  number: string;
  id: WorkspaceId;
  label: string;
  hint: string;
  entry: string;
  badges: FeatureMapBadge[];
  tabs: FeatureMapTab[];
}

/**
 * 从工作区数据推导功能地图模型：编号工作区卡 → tab 芯片（一句话 hint）+ 计数徽章。
 *
 * 徽章只标在有可靠数据的工作区上：问卷工作区用 DashboardData 的 surveys 总数与
 * publishedSurveys；其余工作区在 dashboard 接口里没有对应字段，宁缺毋滥，
 * 不猜语义（tab 级 draft/published/closed/archived 精确计数需追加拉取
 * SurveyListData，属于可选第二步，会引入新的 D1 行读成本——审计 3.2）。
 */
export function buildFeatureMap(counts: FeatureMapCounts): FeatureMapWorkspace[] {
  return WORKSPACES_BY_ORDER.map((workspace) => ({
    number: String(workspace.order),
    id: workspace.id,
    label: workspace.label,
    hint: workspace.hint,
    entry: workspace.entry,
    badges:
      workspace.id === "surveys"
        ? [
            { label: "问卷", value: counts.surveys },
            { label: "已发布", value: counts.publishedSurveys },
          ]
        : [],
    tabs: workspace.tabs.map((tab) => ({
      number: tabNumberOf(workspace, tab),
      label: tab.label,
      to: tab.to,
      hint: tab.hint,
    })),
  }));
}
