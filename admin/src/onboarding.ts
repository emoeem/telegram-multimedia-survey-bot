/**
 * admin 新手引导（2026-11-07 T3）：首次进入管理后台的四步入门——
 * 「新建问卷 → 预览 → 发布 → 查看报告」。
 *
 * 「只讲不改」是本模块的硬边界：引导只告诉用户每一步去哪个页面、找哪个
 * 入口，绝不代替用户创建或修改任何问卷文档——所以这里只有步骤数据与
 * 完成标记的读写，零 API 调用；浮层也只挂在总览页（DashboardPage）而不
 * 进编辑器：编辑器有 2 秒静默自动保存（EditorShell），任何浮层出现在
 * 那里都可能误触保存队列或挡住画布。
 *
 * 纯逻辑模块、零 import（对齐 workspaces.ts / publish-choice.ts 的仓内
 * 约定）：根目录的 vitest/tsc 会把 tests/unit/admin 的用例连进程序编译，
 * 而 React / lucide-react 只装在 admin 自己的 node_modules 里、根目录解析
 * 不到；同时根工程 lib 是 WebWorker（没有 `window` 标识符），所以 DOM
 * 一律按能力探测经 globalThis 读取（同 survey/haptics.ts 的写法）——同一
 * 份代码要同时过 admin（lib DOM）与根（lib WebWorker）两套编译。
 */

/** 一个引导步骤：一句话说清「去哪、找什么」，对应的必须是真实路由。 */
export interface OnboardingStep {
  /** 展示用步骤号（"1"-"4"），取自数组位置。 */
  number: string;
  /** 步骤名（与页面里的动作一一对应）。 */
  title: string;
  /** 一句话定位：去哪个页面、找哪个入口。 */
  hint: string;
  /**
   * 对应的真实路由（App.tsx，admin basename 下）。编辑器步骤带 ":id"
   * 占位，由 onboardingStepTarget 用当前问卷 id 替换；还没有问卷时回退
   * 到问卷列表（创建问卷的入口）。
   */
  to: string;
  /** 浮层里「前往」按钮的文案。 */
  cta: string;
}

/**
 * 四步引导（2026-11-07）：入口都经实测核对——
 *   1. 「新建问卷」按钮在问卷列表（SurveysPage）；
 *   2. 「预览」与 3. 「发布」按钮都在编辑器工具栏（EditorPage），所以
 *      第 2/3 步同指 /surveys/:id/editor；
 *   4. 新答卷实时出现在「答卷动态」（/responses），报告在「报告」页
 *      （/reports）归档，hint 里一并说明。
 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    number: "1",
    title: "新建问卷",
    hint: "在「问卷列表」点「新建问卷」，填写标题即可创建。",
    to: "/surveys",
    cta: "去问卷列表",
  },
  {
    number: "2",
    title: "编辑与预览",
    hint: "创建后自动进入编辑器：添加题目，工具栏「预览」随时查看填写效果。",
    to: "/surveys/:id/editor",
    cta: "去编辑器",
  },
  {
    number: "3",
    title: "发布",
    hint: "题目就绪后点工具栏「发布」，问卷转为只读并开始收集答卷。",
    to: "/surveys/:id/editor",
    cta: "去发布",
  },
  {
    number: "4",
    title: "查看报告",
    hint: "新答卷实时出现在「答卷动态」，完成的报告在「报告」页归档。",
    to: "/responses",
    cta: "去答卷动态",
  },
];

/** 完成标记的 localStorage 键：沿用 admin:editor-mode 的 `admin:` 前缀约定。 */
export const ONBOARDING_COMPLETE_KEY = "admin:onboarding-complete";

const COMPLETE_VALUE = "1";

/**
 * localStorage 的最小形状：不能引用 DOM 的 `Storage` 类型——根工程的
 * WebWorker lib 里没有它。字段全部按可选探测，隐私模式下部分实现只禁写。
 */
interface OnboardingStorage {
  getItem?: (key: string) => string | null;
  setItem?: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

/**
 * 读取 localStorage：用 globalThis 而不是 `window`——同一份代码要在 admin
 * 工程（lib DOM）和根工程（lib WebWorker，没有 `window` 标识符）下都编译
 * （同 survey/haptics.ts 的写法）。单测跑在 node 环境，这里拿到 undefined
 * 也是合法状态，调用方按「读不到」处理。
 */
function onboardingStorage(): OnboardingStorage | undefined {
  return (globalThis as unknown as { localStorage?: OnboardingStorage }).localStorage;
}

/**
 * 是否运行在自动化（Playwright）环境：Playwright 启动的浏览器
 * （Chromium / WebKit / Firefox）都会把 `navigator.webdriver` 置为 true
 * （WebDriver 规范的自动化指纹），真实用户浏览器恒为 false，node 单测
 * 环境则没有该字段。
 *
 * 视觉截图跳过引导浮层选择本方案而不是 URL 参数 `?onboarding=off`：
 * qa/visual 下 admin.spec、key-screens 等多个 spec 都用 page.goto(path)
 * 直达截图，URL 参数要逐条改 goto，新增用例忘带参数就会再次把浮层截进
 * 基线；webdriver 指纹让所有 Playwright 上下文零改动自动跳过，真实用户
 * 不受影响。
 */
export function isAutomationEnvironment(): boolean {
  const nav = (typeof navigator === "undefined" ? undefined : navigator) as { webdriver?: boolean } | undefined;
  return nav?.webdriver === true;
}

/**
 * 把步骤的 to 换算成可点的真实路由：带 ":id" 占位的编辑器步骤用当前问卷
 * id 替换；还没有任何问卷时回退到问卷列表——那里同时是「新建问卷」的
 * 入口，与新用户的实际状态一致。
 */
export function onboardingStepTarget(step: OnboardingStep, surveyId: number | null | undefined): string {
  if (!step.to.includes(":id")) return step.to;
  if (surveyId === null || surveyId === undefined) return "/surveys";
  return step.to.replace(":id", String(surveyId));
}

/**
 * 是否该显示引导：完成标记不存在（或读不到）即显示。
 * localStorage 不可用（隐私模式 / 被策略禁用 / node 环境）时静默降级为
 * 「显示」——宁可多引导一次，也不让新用户彻底错过入门；跳过按钮在当次
 * 会话内仍然有效（浮层自己有 state）。自动化环境（Playwright 截图矩阵）
 * 一律不显示，见 isAutomationEnvironment。
 */
export function shouldShowOnboarding(): boolean {
  if (isAutomationEnvironment()) return false;
  try {
    const stored = onboardingStorage()?.getItem?.(ONBOARDING_COMPLETE_KEY);
    return stored !== COMPLETE_VALUE;
  } catch {
    return true;
  }
}

/** 标记完成（最后一步「完成」或「跳过」都走这里）；写不进去就当本次会话没记住。 */
export function markOnboardingComplete(): void {
  try {
    onboardingStorage()?.setItem?.(ONBOARDING_COMPLETE_KEY, COMPLETE_VALUE);
  } catch {
    // 隐私模式写不进去不影响本次引导（与 EditorShell 的 admin:editor-mode 同一先例）
  }
}

/** 重放：清掉完成标记，下次 shouldShowOnboarding() 再显示（设置页入口）。 */
export function resetForReplay(): void {
  try {
    onboardingStorage()?.removeItem?.(ONBOARDING_COMPLETE_KEY);
  } catch {
    // 读不到自然也删不了；下次访问仍按未完成处理，行为一致
  }
}
