/**
 * 顶栏 ⌘K 全局搜索的纯逻辑模块（T8）。
 *
 * 索引三类数据——问卷标题 / 报告模板名 / 素材文件名——全部由调用方（Layout 的
 * 搜索面板）用既有列表接口拉取后传入，这里只做规范化、匹配、分组与排序，
 * 零 import、零副作用（对齐 workspaces.ts 的仓内约定：根目录 vitest/tsc 会把
 * tests/unit/admin 的用例连进程序编译，纯模块保证两套 tsconfig 都能过）。
 *
 * 设计取舍（第一版）：
 *  - 不新增任何服务端查询接口，零 D1 查询增量（审计 3.2 成本红线）；列表
 *    接口自带的分页上限（问卷 50 / 素材 100）就是索引上限，超出部分属于
 *    已知取舍，宁缺毋滥不加请求。
 *  - 匹配是「全部关键词都命中」（AND）：多词查询天然收窄结果。
 *  - 组内排序：首词前缀命中排前，其余按数据原有顺序（列表本身按更新时间
 *    倒序，稳定排序等于「相关性优先、其次最新」）。
 *  - 空态热门词是静态功能入口文案，不是数据查询词：空面板服务「加引导」，
 *    点击直达对应页面。
 */

export type GlobalSearchGroup = "surveys" | "templates" | "media";

/** 问卷条目（来源：/api/admin/surveys 的 SurveySummary，只取搜索需要的字段）。 */
export interface GlobalSearchSurveyItem {
  id: number;
  title: string;
  /** 状态徽标文案（Layout 侧用 format.ts 的 STATUS_LABELS 映射）。 */
  statusLabel?: string;
}

/** 报告模板条目（来源：/api/admin/report-templates 的 ReportTemplateOption）。 */
export interface GlobalSearchTemplateItem {
  id: string;
  name: string;
  /** true = 自建模板，false / 缺省 = 内置模板。 */
  isCustom?: boolean;
}

/** 素材条目（来源：/api/admin/media-library 的 AdminMediaLibraryItem）。 */
export interface GlobalSearchMediaItem {
  id: number;
  /** 无文件名的素材（如纯结构化引用）不可搜索，匹配阶段跳过。 */
  fileName: string | null;
}

export interface GlobalSearchSources {
  surveys?: readonly GlobalSearchSurveyItem[];
  templates?: readonly GlobalSearchTemplateItem[];
  media?: readonly GlobalSearchMediaItem[];
}

export interface GlobalSearchHit {
  group: GlobalSearchGroup;
  /** 回车 / 点击后的跳转路由。 */
  to: string;
  /** 展示标题（问卷标题 / 模板名 / 素材文件名）。 */
  title: string;
  /** 右侧徽标（问卷状态、模板来源等），可缺省。 */
  meta?: string;
}

export interface GlobalSearchGroupResult {
  group: GlobalSearchGroup;
  label: string;
  hits: GlobalSearchHit[];
}

export interface GlobalSearchResult {
  query: string;
  /** 只含有命中的组（无结果的组不渲染），组间顺序固定：问卷 → 模板 → 素材。 */
  groups: GlobalSearchGroupResult[];
  /** groups 的扁平串联 = 键盘上下选择的顺序。 */
  hits: GlobalSearchHit[];
}

export const GLOBAL_SEARCH_GROUP_LABELS: Record<GlobalSearchGroup, string> = {
  surveys: "问卷",
  templates: "报告模板",
  media: "素材库",
};

/** 每组最多展示的命中数：面板一屏可读，更多结果引导用户精化关键词。 */
export const GLOBAL_SEARCH_LIMIT_PER_GROUP = 5;

/**
 * ⌘K 命中列表的读屏语义锚点（2026-11-14 G6，批三报告已知问题 #4）：
 * activeIndex 过去只以视觉类名（.is-active）表达，屏幕阅读器感知不到
 * 键盘高亮。Layout 面板的接线契约——命中容器 role="listbox"、
 * aria-label 用 LABEL、aria-activedescendant 指向当前高亮项的
 * globalSearchOptionId(index)，命中项自身 role="option"——常量与 id
 * 生成收拢在本纯模块，防回退断言锁在 global-search.test.ts。
 */
export const GLOBAL_SEARCH_LISTBOX_ID = "admin-search-listbox";
export const GLOBAL_SEARCH_LISTBOX_LABEL = "搜索结果列表";

/** 命中项的 option id（扁平 hits 下标）：容器 aria-activedescendant 与
 * 选项 id 必须由同一函数生成，键盘高亮 ↔ 读屏感知才不会错位。 */
export function globalSearchOptionId(index: number): string {
  return `admin-search-option-${index}`;
}

export interface GlobalSearchPopularTerm {
  label: string;
  /** 点击直达的页面（与 workspaces.ts 里同名 tab 的路由一致）。 */
  to: string;
  /** 芯片 tooltip 的一句话说明。 */
  hint: string;
}

/**
 * 空态热门词（静态文案）：功能名而非数据名，所以是「入口」不是查询词——
 * 空面板是引导位，点击直达。刻意独立声明而不去 import workspaces.ts：
 * 这四个词是给搜索面板的静态文案，绑定关系由单测锁定，不为它引入耦合。
 */
export const GLOBAL_SEARCH_POPULAR_TERMS: readonly GlobalSearchPopularTerm[] = [
  { label: "问卷模板", to: "/templates", hint: "报告模板的样式与排版" },
  { label: "批量导出", to: "/surveys", hint: "问卷列表里批量导出答卷报告" },
  { label: "用户标签", to: "/users", hint: "用户目录与身份信息" },
  { label: "小游戏", to: "/task-packs", hint: "小游戏任务包配置" },
];

/**
 * 查询与索引共用的规范化：小写化、全角 ASCII（U+FF01-FF5E）转半角、
 * 全角空格（U+3000）与连续空白折叠成单个空格。两侧同口径，中文不受影响，
 * 「ＢＧＭ」「bgm」「BGM」互相命中。
 */
export function normalizeSearchText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 组内排名：0 = 首词前缀命中（排前），1 = 包含命中；null = 未命中。 */
const PREFIX_RANK = 0;
const INCLUDES_RANK = 1;

function matchRank(haystack: string, tokens: readonly string[]): number | null {
  const first = tokens[0];
  if (first === undefined || first === "") return null;
  // 首词决定秩：位置 0 是前缀命中，其余出现位置是包含命中；没出现直接未命中。
  const firstIndex = haystack.indexOf(first);
  if (firstIndex === -1) return null;
  const rank = firstIndex === 0 ? PREFIX_RANK : INCLUDES_RANK;
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (!haystack.includes(token)) return null;
  }
  return rank;
}

export interface GlobalSearchOptions {
  /** 每组保留的命中数上限（默认 GLOBAL_SEARCH_LIMIT_PER_GROUP）。 */
  limitPerGroup?: number;
}

/**
 * 三组匹配 + 排序 + 截断。查询为空（或全空白）返回空结果——空态由 UI 渲染
 * 热门词 chips，不是匹配逻辑的职责。
 */
export function searchGlobalSearch(
  sources: GlobalSearchSources,
  rawQuery: string,
  options?: GlobalSearchOptions,
): GlobalSearchResult {
  const query = normalizeSearchText(rawQuery);
  if (query === "") return { query, groups: [], hits: [] };
  const tokens = query.split(" ").filter((token) => token !== "");
  if (tokens.length === 0) return { query, groups: [], hits: [] };
  const limit = options?.limitPerGroup ?? GLOBAL_SEARCH_LIMIT_PER_GROUP;

  const matchGroup = <T>(
    group: GlobalSearchGroup,
    items: readonly T[],
    textOf: (item: T) => string | null,
    hitOf: (item: T) => GlobalSearchHit,
  ): GlobalSearchGroupResult | null => {
    const matched: Array<{ rank: number; index: number; item: T }> = [];
    items.forEach((item, index) => {
      const text = textOf(item);
      if (text === null) return;
      const rank = matchRank(normalizeSearchText(text), tokens);
      if (rank === null) return;
      matched.push({ rank, index, item });
    });
    if (matched.length === 0) return null;
    matched.sort((a, b) => a.rank - b.rank || a.index - b.index);
    return {
      group,
      label: GLOBAL_SEARCH_GROUP_LABELS[group],
      hits: matched.slice(0, limit).map(({ item }) => hitOf(item)),
    };
  };

  const groups: GlobalSearchGroupResult[] = [];
  const surveyGroup = matchGroup(
    "surveys",
    sources.surveys ?? [],
    (item) => item.title,
    (item) => ({
      group: "surveys" as const,
      to: `/surveys/${item.id}`,
      title: item.title,
      ...(item.statusLabel === undefined ? {} : { meta: item.statusLabel }),
    }),
  );
  if (surveyGroup) groups.push(surveyGroup);

  const templateGroup = matchGroup(
    "templates",
    sources.templates ?? [],
    (item) => item.name,
    (item) => ({
      group: "templates" as const,
      to: "/templates",
      title: item.name,
      meta: item.isCustom ? "自定义" : "内置",
    }),
  );
  if (templateGroup) groups.push(templateGroup);

  const mediaGroup = matchGroup(
    "media",
    sources.media ?? [],
    (item) => item.fileName,
    (item) => ({
      group: "media" as const,
      to: "/media-library",
      title: item.fileName ?? "",
    }),
  );
  if (mediaGroup) groups.push(mediaGroup);

  return { query, groups, hits: groups.flatMap((group) => group.hits) };
}
