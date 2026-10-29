import type { ConfigIssue } from "../../types";

/**
 * quest 扩展包的内容格式（v1）——数据驱动的 Galgame 式剧情小游戏。
 *
 * 设计约束：
 *  - 扩展包是**纯数据**：manifest.json（包元信息）+ quest.json（本格式）+
 *    assets/（可选图片）。导入器把内容写进 task_packs.settings_json 的
 *    `content` 字段（JSON 字符串），之后运行不再触碰包文件——新游戏零代码。
 *  - 所有计分/门控数据（道具、分值、跳转目标）只存在服务端；答题端视图
 *    由引擎的 payload 下发，不包含任何「未到达」的节点与内部跳转表。
 *  - 本文件的校验是**唯一权威**：导入器（pack-import）与运行引擎共用，
 *    避免出现两把不一样的尺子。
 */

export const QUEST_CONTENT_VERSION = 1 as const;

/** 节点 / 道具数量护栏：单行 settings_json 是 D1 行，别把包写成数据库。 */
export const QUEST_LIMITS = {
  maxNodes: 60,
  maxItems: 24,
  maxChoicesPerNode: 6,
  maxTextLength: 600,
  maxChoiceTextLength: 80,
  maxItemNameLength: 24,
  maxItemDescLength: 120,
  maxSpeakerLength: 16,
  maxChapterLength: 16,
  maxTitleLength: 40,
  maxIntroLength: 200,
  maxScorePerChoice: 20,
} as const;

export type QuestItemKind = "clue" | "collectible" | "key";

export interface QuestItem {
  id: string;
  name: string;
  icon: string;
  kind: QuestItemKind;
  desc: string;
}

export interface QuestChoice {
  text: string;
  goto: string;
  /** 分支钥匙：未持有 requireItem 道具时该选项锁定（服务端拒绝执行）。 */
  requireItem?: string;
  /** 执行时获得的道具（首次执行才发放，防循环刷分/刷道具）。 */
  give?: string[];
  score?: number;
}

export interface QuestNode {
  id: string;
  chapter?: string;
  speaker?: string;
  text: string;
  image?: string;
  choices?: QuestChoice[];
  /** 结局节点（无 choices）的标题与评语。 */
  endingTitle?: string;
  endingNote?: string;
}

export interface QuestContent {
  version: typeof QUEST_CONTENT_VERSION;
  title: string;
  intro: string;
  start: string;
  items: QuestItem[];
  nodes: QuestNode[];
  /** 评级线（占可得分值的百分比），缺省 S90 / A70 / B50。 */
  grades?: { s?: number; a?: number; b?: number };
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function checkLength(issues: ConfigIssue[], key: string, value: string, max: number, label: string): void {
  if (value.length > max)
    issues.push({ key, message: `${label}超过 ${max} 字上限（当前 ${value.length} 字）`, severity: "error" });
}

/**
 * 解析并校验扩展包内容。任何结构问题都进 issues（error 阻塞导入/保存）；
 * 解析失败返回 null + 一条 error。静默修复一律不做——扩展包是作者手写的
 * 数据，宁可拒绝也不要猜。
 */
export function parseQuestContent(raw: unknown): { content: QuestContent | null; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { content: null, issues: [{ key: "content", message: "quest.json 必须是 JSON 对象", severity: "error" }] };
  }
  const doc = raw as Record<string, unknown>;
  if (doc.version !== QUEST_CONTENT_VERSION) {
    return {
      content: null,
      issues: [
        {
          key: "content",
          message: `formatVersion 必须是 ${QUEST_CONTENT_VERSION}（收到 ${String(doc.version)}）`,
          severity: "error",
        },
      ],
    };
  }

  const title = str(doc.title);
  const intro = str(doc.intro);
  const start = str(doc.start);
  if (!title) issues.push({ key: "content", message: "title 不能为空", severity: "error" });
  checkLength(issues, "content", title, QUEST_LIMITS.maxTitleLength, "title");
  checkLength(issues, "content", intro, QUEST_LIMITS.maxIntroLength, "intro");
  if (!start) issues.push({ key: "content", message: "start（起始节点）不能为空", severity: "error" });

  // ---- 道具 ----
  const items: QuestItem[] = [];
  const itemIds = new Set<string>();
  const rawItems = Array.isArray(doc.items) ? doc.items : [];
  if (rawItems.length > QUEST_LIMITS.maxItems) {
    issues.push({ key: "content", message: `道具数量超过 ${QUEST_LIMITS.maxItems} 上限`, severity: "error" });
  }
  rawItems.slice(0, QUEST_LIMITS.maxItems).forEach((entry, index) => {
    const key = `content.items.${index}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({ key, message: "道具必须是对象", severity: "error" });
      return;
    }
    const item = entry as Record<string, unknown>;
    const id = str(item.id);
    const name = str(item.name);
    const icon = str(item.icon) || "📦";
    const kindRaw = str(item.kind);
    const desc = str(item.desc);
    if (!ID_PATTERN.test(id)) {
      issues.push({
        key,
        message: `道具 id 不合法（小写字母/数字开头，≤32 位）：${id || "（空）"}`,
        severity: "error",
      });
      return;
    }
    if (itemIds.has(id)) {
      issues.push({ key, message: `道具 id 重复：${id}`, severity: "error" });
      return;
    }
    if (!name) issues.push({ key, message: `道具 ${id} 缺少 name`, severity: "error" });
    checkLength(issues, key, name, QUEST_LIMITS.maxItemNameLength, "道具 name");
    checkLength(issues, key, desc, QUEST_LIMITS.maxItemDescLength, "道具 desc");
    if (icon.length > 4) issues.push({ key, message: `道具 ${id} 的 icon 超过 4 字符`, severity: "error" });
    const kind = kindRaw === "clue" || kindRaw === "collectible" || kindRaw === "key" ? kindRaw : null;
    if (!kind) issues.push({ key, message: `道具 ${id} 的 kind 必须是 clue / collectible / key`, severity: "error" });
    itemIds.add(id);
    if (kind) items.push({ id, name, icon, kind, desc });
  });

  // ---- 节点 ----
  const nodes: QuestNode[] = [];
  const nodeIds = new Set<string>();
  const rawNodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  if (rawNodes.length === 0) {
    issues.push({ key: "content", message: "至少需要一个节点", severity: "error" });
  }
  if (rawNodes.length > QUEST_LIMITS.maxNodes) {
    issues.push({ key: "content", message: `节点数量超过 ${QUEST_LIMITS.maxNodes} 上限`, severity: "error" });
  }
  rawNodes.slice(0, QUEST_LIMITS.maxNodes).forEach((entry, index) => {
    const key = `content.nodes.${index}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({ key, message: "节点必须是对象", severity: "error" });
      return;
    }
    const node = entry as Record<string, unknown>;
    const id = str(node.id);
    const text = str(node.text);
    if (!ID_PATTERN.test(id)) {
      issues.push({ key, message: `节点 id 不合法：${id || "（空）"}`, severity: "error" });
      return;
    }
    if (nodeIds.has(id)) {
      issues.push({ key, message: `节点 id 重复：${id}`, severity: "error" });
      return;
    }
    nodeIds.add(id);
    if (!text) issues.push({ key, message: `节点 ${id} 缺少 text`, severity: "error" });
    checkLength(issues, key, text, QUEST_LIMITS.maxTextLength, `节点 ${id} 的 text`);
    const chapter = str(node.chapter);
    const speaker = str(node.speaker);
    const image = str(node.image);
    checkLength(issues, key, chapter, QUEST_LIMITS.maxChapterLength, `节点 ${id} 的 chapter`);
    checkLength(issues, key, speaker, QUEST_LIMITS.maxSpeakerLength, `节点 ${id} 的 speaker`);
    // asset:<文件名> 是扩展包的输入约定（导入器替换为站内 URL），其余同主题白名单。
    if (image && !/^(https:\/\/|\/|data:image\/|asset:[a-z0-9][a-z0-9._-]*)/.test(image)) {
      issues.push({
        key,
        message: `节点 ${id} 的 image 只允许 https://、站内相对路径、data:image/ 或 asset:引用`,
        severity: "error",
      });
    }

    const rawChoices = Array.isArray(node.choices) ? node.choices : [];
    if (rawChoices.length > QUEST_LIMITS.maxChoicesPerNode) {
      issues.push({ key, message: `节点 ${id} 的选项超过 ${QUEST_LIMITS.maxChoicesPerNode} 上限`, severity: "error" });
    }
    const choices: QuestChoice[] = [];
    rawChoices.slice(0, QUEST_LIMITS.maxChoicesPerNode).forEach((choiceEntry, choiceIndex) => {
      const choiceKey = `${key}.choices.${choiceIndex}`;
      if (!choiceEntry || typeof choiceEntry !== "object" || Array.isArray(choiceEntry)) {
        issues.push({ key: choiceKey, message: "选项必须是对象", severity: "error" });
        return;
      }
      const choice = choiceEntry as Record<string, unknown>;
      const choiceText = str(choice.text);
      const goto = str(choice.goto);
      if (!choiceText)
        issues.push({ key: choiceKey, message: `节点 ${id} 第 ${choiceIndex + 1} 个选项缺少 text`, severity: "error" });
      checkLength(issues, choiceKey, choiceText, QUEST_LIMITS.maxChoiceTextLength, "选项 text");
      if (!goto)
        issues.push({ key: choiceKey, message: `节点 ${id} 第 ${choiceIndex + 1} 个选项缺少 goto`, severity: "error" });
      const requireItem = str(choice.requireItem) || undefined;
      const give = Array.isArray(choice.give)
        ? choice.give.filter((item): item is string => typeof item === "string" && ID_PATTERN.test(item)).slice(0, 3)
        : undefined;
      const scoreRaw = choice.score;
      const score =
        typeof scoreRaw === "number" && Number.isFinite(scoreRaw)
          ? Math.max(0, Math.min(QUEST_LIMITS.maxScorePerChoice, Math.round(scoreRaw)))
          : undefined;
      if (give && give.length === 0)
        issues.push({ key: choiceKey, message: `节点 ${id} 的 give 为空数组（可省略）`, severity: "warning" });
      choices.push({
        text: choiceText,
        goto,
        ...(requireItem ? { requireItem } : {}),
        ...(give ? { give } : {}),
        ...(score !== undefined ? { score } : {}),
      });
    });

    nodes.push({
      id,
      ...(chapter ? { chapter } : {}),
      ...(speaker ? { speaker } : {}),
      text,
      ...(image ? { image } : {}),
      ...(choices.length > 0 ? { choices } : {}),
      ...(choices.length === 0 && str(node.endingTitle) ? { endingTitle: str(node.endingTitle) } : {}),
      ...(choices.length === 0 && str(node.endingNote) ? { endingNote: str(node.endingNote) } : {}),
    });
  });

  // ---- 图引用完整性 ----
  if (start && !nodeIds.has(start)) {
    issues.push({ key: "content", message: `start 指向不存在的节点：${start}`, severity: "error" });
  }
  const endingCount = nodes.filter((node) => !node.choices || node.choices.length === 0).length;
  if (nodes.length > 0 && endingCount === 0) {
    issues.push({ key: "content", message: "至少需要一个结局节点（没有 choices 的节点）", severity: "error" });
  }
  for (const node of nodes) {
    for (const choice of node.choices ?? []) {
      if (!nodeIds.has(choice.goto)) {
        issues.push({
          key: `content.nodes.${node.id}`,
          message: `选项 goto 指向不存在的节点：${choice.goto}`,
          severity: "error",
        });
      }
      if (choice.requireItem !== undefined && !itemIds.has(choice.requireItem)) {
        issues.push({
          key: `content.nodes.${node.id}`,
          message: `requireItem 指向不存在的道具：${choice.requireItem}`,
          severity: "error",
        });
      }
      for (const giveId of choice.give ?? []) {
        if (!itemIds.has(giveId)) {
          issues.push({
            key: `content.nodes.${node.id}`,
            message: `give 指向不存在的道具：${giveId}`,
            severity: "error",
          });
        }
      }
    }
  }
  // 评级线
  const gradesRaw = (doc.grades ?? {}) as Record<string, unknown>;
  const clampPercent = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : undefined;
  const s = clampPercent(gradesRaw.s);
  const a = clampPercent(gradesRaw.a);
  const b = clampPercent(gradesRaw.b);
  const grades: { s?: number; a?: number; b?: number } = {};
  if (s !== undefined) grades.s = s;
  if (a !== undefined) grades.a = a;
  if (b !== undefined) grades.b = b;

  if (issues.some((issue) => issue.severity === "error")) {
    return { content: null, issues };
  }
  return {
    content: {
      version: QUEST_CONTENT_VERSION,
      title,
      intro,
      start,
      items,
      nodes,
      ...(Object.keys(grades).length > 0 ? { grades } : {}),
    },
    issues,
  };
}

/** 从 settings_json 的 content 字符串还原内容（引擎运行时入口）。 */
export function parseQuestContentJson(contentJson: string): { content: QuestContent | null; issues: ConfigIssue[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return { content: null, issues: [{ key: "content", message: "content 不是合法 JSON", severity: "error" }] };
  }
  return parseQuestContent(parsed);
}
