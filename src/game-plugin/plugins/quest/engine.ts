import type { GameEngine, GamePluginServer } from "../../types";
import { questManifest, questProps, type QuestConfig } from "./manifest";
import { parseQuestContentJson, type QuestContent, type QuestNode } from "./content";

/**
 * quest 剧情扩展包 · 服务端引擎（权威计分）。
 *
 * 四条硬约束（与 flip-card 同源）：
 *  1. 跳转表/道具/分值只存在于 config.content；payload 永不下发未到达节点；
 *  2. 一次选择只结算一次：action.step 必须等于 state.steps，重发/重连原样返回；
 *  3. 道具发放与计分都按「首次经过」去重——剧情回路刷不了分；
 *  4. requireItem 未满足的选择直接拒绝（服务端忽略，视图里它是锁定态）。
 *
 * 道具三件套（2026-10-29 扩展包规范）：
 *  - clue 线索道具：收集进线索栏，结局屏列出（叙事回报）；
 *  - collectible 收集品：计入结局收集统计 n/m，并按 collected 额外计分（每件 2 分）；
 *  - key 分支钥匙：choices[].requireItem 门控，未持有则锁定。
 */

export interface QuestState {
  nodeId: string;
  score: number;
  maxScore: number;
  /** 已获得道具 id（有序）。 */
  items: string[];
  /** 已结算过的选择键（`${nodeId}#${index}`），首次经过才计分/发放。 */
  taken: string[];
  steps: number;
}

export interface QuestAction {
  kind: "choose";
  choiceIndex: number;
  /** 客户端做选择时的步数（幂等键）。 */
  step: number;
}

interface QuestViewChoice {
  text: string;
  locked: boolean;
  /** 锁定原因（所需道具名）；仅锁定时下发。 */
  lockHint: string | null;
}

/** 输出给客户端的帧：当前节点 + 可见选项 + 已获道具，别的一概不发。 */
function viewOf(state: QuestState, content: QuestContent) {
  const node = content.nodes.find((candidate) => candidate.id === state.nodeId) ?? null;
  const items = state.items
    .map((id) => content.items.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const finished = Boolean(node && (node.choices ?? []).length === 0);
  const choices: QuestViewChoice[] = (node?.choices ?? []).map((choice) => {
    const locked = choice.requireItem !== undefined && !state.items.includes(choice.requireItem);
    return {
      text: choice.text,
      locked,
      lockHint: locked ? (content.items.find((item) => item.id === choice.requireItem)?.name ?? null) : null,
    };
  });
  return {
    status: finished ? ("won" as const) : ("active" as const),
    score: state.score,
    maxScore: state.maxScore,
    // 1 基展示值（客户端发 step-1 与服务端 0 基比对，同 flip-card 约定）。
    step: state.steps + 1,
    total: Math.max(1, countReachableMinSteps(content)),
    payload: {
      node: node
        ? {
            id: node.id,
            chapter: node.chapter ?? null,
            speaker: node.speaker ?? null,
            text: node.text,
            image: node.image ?? null,
          }
        : null,
      choices,
      inventory: items.map((item) => ({
        id: item.id,
        name: item.name,
        icon: item.icon,
        kind: item.kind,
        desc: item.desc,
      })),
      totalItems: content.items.length,
      finished,
      endingTitle: finished ? (node?.endingTitle ?? null) : null,
      endingNote: finished ? (node?.endingNote ?? null) : null,
      cluesFound: items.filter((item) => item.kind === "clue").length,
      collectiblesFound: items.filter((item) => item.kind === "collectible").length,
      packId: content.title,
      cover: null,
    },
  };
}

/**
 * 进度条的 total 用「最短通关步数」的保守估计（起点到最近结局的 BFS）。
 * 剧情步数天然非线性（分支/回路），精确值不存在，BFS 下界比节点总数诚实。
 */
function countReachableMinSteps(content: QuestContent): number {
  const byId = new Map(content.nodes.map((node) => [node.id, node] as const));
  const queue: Array<{ id: string; depth: number }> = [{ id: content.start, depth: 0 }];
  const seen = new Set<string>([content.start]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const node = byId.get(current.id);
    if (!node) return content.nodes.length;
    if ((node.choices ?? []).length === 0) return current.depth;
    for (const choice of node.choices ?? []) {
      if (!seen.has(choice.goto)) {
        seen.add(choice.goto);
        queue.push({ id: choice.goto, depth: current.depth + 1 });
      }
    }
  }
  return content.nodes.length;
}

function asConfig(raw: Record<string, unknown>): QuestConfig {
  return raw as unknown as QuestConfig;
}

function loadContent(config: Record<string, unknown>): QuestContent {
  const parsed = parseQuestContentJson(asConfig(config).content);
  if (!parsed.content) {
    // 结构损坏（手改 settings_json 等）：抛错 → trial-api 按「放弃」结算，
    // 参与者不会被卡死在坏包里。
    throw new Error(parsed.issues[0]?.message ?? "扩展包内容无效");
  }
  return parsed.content;
}

function collectibleBonus(content: QuestContent, items: string[]): number {
  const perItem = 2;
  return items.filter((id) => content.items.find((item) => item.id === id)?.kind === "collectible").length * perItem;
}

function gradeOf(state: QuestState, content: QuestContent): { grade: "S" | "A" | "B" | "C"; maxScore: number } {
  const maxScore =
    state.maxScore +
    collectibleBonus(
      content,
      content.items.map((item) => item.id),
    );
  const ratio = maxScore === 0 ? 1 : state.score / maxScore;
  const s = (content.grades?.s ?? 90) / 100;
  const a = (content.grades?.a ?? 70) / 100;
  const b = (content.grades?.b ?? 50) / 100;
  const grade = ratio >= s ? "S" : ratio >= a ? "A" : ratio >= b ? "B" : "C";
  return { grade, maxScore };
}

export const questEngine: GameEngine<QuestState, QuestAction> = {
  createRun({ config }) {
    const content = loadContent(config);
    const maxScore = content.nodes.reduce(
      (sum, node) => sum + (node.choices ?? []).reduce((inner, choice) => inner + (choice.score ?? 0), 0),
      0,
    );
    const state: QuestState = {
      nodeId: content.start,
      score: 0,
      maxScore,
      items: [],
      taken: [],
      steps: 0,
    };
    return { state, view: viewOf(state, content) };
  },

  apply({ state, config, action }) {
    const content = loadContent(config);
    if (action.step !== state.steps) {
      // 幂等：陈旧提交（网络重试/断线重连）不推进。
      return { state, view: viewOf(state, content), finished: isFinished(content, state) };
    }
    const node = content.nodes.find((candidate) => candidate.id === state.nodeId);
    if (!node || (node.choices ?? []).length === 0) {
      return { state, view: viewOf(state, content), finished: true };
    }
    const choiceIndex = Math.round(action.choiceIndex);
    const choice = (node.choices ?? [])[choiceIndex];
    if (!choice) {
      return { state, view: viewOf(state, content), finished: false };
    }
    if (choice.requireItem !== undefined && !state.items.includes(choice.requireItem)) {
      // 锁定选择：不推进也不报错（视图里它是禁用态，正常 UI 到不了这里）。
      return { state, view: viewOf(state, content), finished: false };
    }
    const takenKey = `${node.id}#${choiceIndex}`;
    const firstTime = !state.taken.includes(takenKey);
    const nextItems = firstTime
      ? [...state.items, ...(choice.give ?? []).filter((id) => !state.items.includes(id))]
      : state.items;
    const next: QuestState = {
      nodeId: choice.goto,
      score:
        state.score +
        (firstTime ? (choice.score ?? 0) : 0) +
        (firstTime ? collectibleBonus(content, nextItems) - collectibleBonus(content, state.items) : 0),
      maxScore: state.maxScore,
      items: nextItems,
      taken: firstTime ? [...state.taken, takenKey] : state.taken,
      steps: state.steps + 1,
    };
    return { state: next, view: viewOf(next, content), finished: isFinished(content, next) };
  },

  grade({ state, config }) {
    return gradeOf(state, loadContent(config));
  },

  view({ state, config }) {
    return viewOf(state, loadContent(config));
  },

  isAction(value): value is QuestAction {
    if (!value || typeof value !== "object") return false;
    const raw = value as Record<string, unknown>;
    return (
      raw.kind === "choose" &&
      Number.isInteger(raw.choiceIndex) &&
      Number(raw.choiceIndex) >= 0 &&
      Number.isInteger(raw.step) &&
      Number(raw.step) >= 0
    );
  },
};

function isFinished(content: QuestContent, state: QuestState): boolean {
  const node: QuestNode | undefined = content.nodes.find((candidate) => candidate.id === state.nodeId);
  return Boolean(node && (node.choices ?? []).length === 0);
}

/**
 * 服务端半身。engine 的边界断言与 flip-card 同款：注册表按
 * GameEngine<unknown, unknown> 收口，畸形 state 由 API 侧结算为放弃。
 */
export const questPlugin: GamePluginServer = {
  manifest: questManifest,
  props: questProps,
  engine: questEngine as unknown as GamePluginServer["engine"],
};
