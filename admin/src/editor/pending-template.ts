/**
 * 「从模板开始」的跨页交接（2026-11-07 T4）：SurveysPage 新建对话框选定模板
 * 后写入标记，EditorShell 挂载时取走并一次性插入骨架。
 *
 * 为什么要一个交接槽位而不是 router state：创建成功 → navigate → EditorPage
 * 拉数据 → EditorShell 挂载，中间隔着一次数据请求；sessionStorage 在同一
 * tab 内不丢、刷新也能补投，且随 tab 关闭自然消失，不会把「待应用模板」
 * 泄漏到明天的会话里。槽位是单槽设计：每次创建都覆盖上一次的意图。
 *
 * 语义（全部纯函数，tests/unit/admin/pending-template.test.ts 钉住）：
 *   - 写入：带模板创建才写；空白创建（null）不写，还会顺手清掉旧槽位——
 *     「这次创建不带模板」本身就是对上一个槽位的覆盖；
 *   - 消费：take 是「读即取走」，surveyId 匹配才消费（不匹配的留给它自己
 *     的编辑器）；EditorShell 拿到后立即插入并靠一次性取走防止重复应用
 *     （React StrictMode 的 effect 双调用也由此兜住）；
 *   - 过期：标记只服务「创建 → 进入编辑器」这一次导航，超过 TTL 视为陈旧
 *     按无标记处理，编辑器退回空白画布（与引入本机制前的行为一致）。
 *
 * 纯逻辑模块：零 React / DOM import（对齐 workspaces.ts / onboarding.ts 的
 * 仓内约定）——根目录的 vitest/tsc 会把 tests/unit/admin 的用例连进程序编
 * 译，而根工程 lib 是 WebWorker（没有 `window`/`sessionStorage` 标识符），
 * 所以存储一律按能力探测经 globalThis 读取；同一份代码要同时过 admin
 * （lib DOM）与根（lib WebWorker）两套编译。唯一的依赖 templates.ts 本身
 * 就是纯函数模块（tests/unit/editor/templates.test.ts 已从根工程引用）。
 */

import { TEMPLATE_OPTIONS, type TemplateId } from "./templates";

/** sessionStorage 键：沿用 admin:editor-mode / admin:onboarding-complete 的 `admin:` 前缀约定。 */
export const PENDING_TEMPLATE_KEY = "admin:pending-template";

/**
 * 标记存活窗口：正常路径下创建后一秒内就进编辑器；60s 是给慢网络下
 * EditorPage 首次拉数据留的余量。过期 = 交接待办失效，宁可空白也不在
 * 几分钟后突然往画布里插组件。
 */
export const PENDING_TEMPLATE_TTL_MS = 60_000;

/** 槽位里的原始记录形状（JSON 序列化存储）。 */
export interface PendingTemplateRecord {
  /** 标记归属的问卷 id：只有它自己的编辑器才能消费。 */
  surveyId: number;
  /** 要应用的内置模板 id（templates.ts 的 TemplateId）。 */
  templateId: TemplateId;
  /** 写入时刻（epoch ms），过期判定的基准。 */
  at: number;
}

/**
 * sessionStorage 的最小形状：不能引用 DOM 的 `Storage` 类型——根工程的
 * WebWorker lib 里没有它。字段全部按可选探测（同 onboarding.ts 的写法）。
 */
interface PendingTemplateStorage {
  getItem?: (key: string) => string | null;
  setItem?: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

function pendingTemplateStorage(): PendingTemplateStorage | undefined {
  return (globalThis as unknown as { sessionStorage?: PendingTemplateStorage }).sessionStorage;
}

/** 合法模板 id 集合（来自 TEMPLATE_OPTIONS，单一数据源）。 */
const VALID_TEMPLATE_IDS: ReadonlySet<string> = new Set(TEMPLATE_OPTIONS.map((option) => option.id));

/**
 * 解析槽位原始值：非 JSON / 字段缺失或类型不对 / 模板 id 不在
 * TEMPLATE_OPTIONS 里（旧版本残留或被改写）一律按无标记处理。
 * 注意 insertTemplate 对未知 id 会走 else 分支插「混合互动」——这里挡在
 * 前面，被污染的槽位永远不会触发一次意外的插入。
 */
export function parsePendingTemplate(raw: string | null): PendingTemplateRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingTemplateRecord> | null;
    if (
      parsed &&
      typeof parsed.surveyId === "number" &&
      Number.isInteger(parsed.surveyId) &&
      typeof parsed.templateId === "string" &&
      VALID_TEMPLATE_IDS.has(parsed.templateId) &&
      typeof parsed.at === "number" &&
      Number.isFinite(parsed.at)
    ) {
      return { surveyId: parsed.surveyId, templateId: parsed.templateId, at: parsed.at };
    }
  } catch {
    // 非法 JSON：当作没有标记
  }
  return null;
}

/** 过期判定：超过 TTL（严格大于）即陈旧；恰好踩线仍算新鲜。 */
export function isPendingTemplateFresh(record: PendingTemplateRecord, now: number): boolean {
  return now - record.at <= PENDING_TEMPLATE_TTL_MS;
}

/**
 * 写入待应用标记（createSurvey 成功后、navigate 之前调用）。
 * `templateId` 传 null 表示空白创建：不写标记，并清掉可能残留的旧槽位。
 * `at` 仅供测试注入；存储写不进去（隐私模式 / 被策略禁用）就当本次不带
 * 模板——编辑器会打开空白画布，与引入本机制前一致。
 */
export function setPendingTemplate(surveyId: number, templateId: TemplateId | null, at: number = Date.now()): void {
  try {
    const storage = pendingTemplateStorage();
    if (!storage) return;
    if (templateId === null) {
      storage.removeItem?.(PENDING_TEMPLATE_KEY);
      return;
    }
    const record: PendingTemplateRecord = { surveyId, templateId, at };
    storage.setItem?.(PENDING_TEMPLATE_KEY, JSON.stringify(record));
  } catch {
    // 写不进去不影响创建本身；编辑器侧读不到自然按空白处理
  }
}

/**
 * 取走并消费（EditorShell 挂载时调用）：surveyId 匹配的标记立即从槽位移除
 * （无论新鲜与否——消费即终局），新鲜则返回模板 id，否则 null。不匹配的
 * 标记不动：那是别的问卷的交接待办，不该被顺手丢掉。
 */
export function takePendingTemplate(surveyId: number, now: number = Date.now()): TemplateId | null {
  try {
    const record = parsePendingTemplate(pendingTemplateStorage()?.getItem?.(PENDING_TEMPLATE_KEY) ?? null);
    if (!record || record.surveyId !== surveyId) return null;
    pendingTemplateStorage()?.removeItem?.(PENDING_TEMPLATE_KEY);
    return isPendingTemplateFresh(record, now) ? record.templateId : null;
  } catch {
    return null;
  }
}
