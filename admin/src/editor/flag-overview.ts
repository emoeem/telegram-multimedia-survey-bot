/**
 * flag/变量总览（G7c）的纯收集器：从各题 condition_json 里收齐当前问卷
 * 全部 flag 及其使用点。语义与 src/survey/engine.ts 的运行时对齐：
 *  - 产出：flagRules（挂在题目 condition 上的计分规则，按引用题答案命中
 *    累计分）与 game 题通关自动置的 game_passed_<题id>；
 *  - 消费：flagJumps（跳题门槛，目标必须向前）。
 *
 * 「结果规则」（result-engine）按 answers.<题id> 取值、求值上下文不含
 * flags（result-engine.service.ts 的 buildAnswerContext），所以本总览不含
 * 结果规则使用点——面板文案据实说明，不虚构一个不存在的引用面。
 *
 * 纯函数、无 React/DOM 依赖，供总览面板与单测共用。
 */

export interface FlagOverviewQuestion {
  id: number;
  type: string;
  title: string;
  condition: Record<string, unknown> | null;
}

/** 使用点类别：题面计分（flagRules 挂载处）/ 跳题规则（flagJumps）/ 游戏通关。 */
export type FlagUsageKind = "scoring" | "jump" | "game";

export interface FlagUsage {
  /** 使用点所在题：点击定位到这道题（规则就在它的 condition 里配置）。 */
  questionId: number;
  questionTitle: string;
  kind: FlagUsageKind;
  /** 人话描述，含来源题 / 门槛 / 跳向。 */
  detail: string;
}

export interface FlagEntry {
  flag: string;
  usages: FlagUsage[];
}

export function collectFlagOverview(questions: readonly FlagOverviewQuestion[]): FlagEntry[] {
  const titleOf = (id: number): string => {
    const found = questions.find((question) => question.id === id);
    return found ? found.title?.trim() || `第 ${id} 题` : `第 ${id} 题`;
  };
  const byFlag = new Map<string, FlagUsage[]>();
  const push = (flag: string, usage: FlagUsage): void => {
    const list = byFlag.get(flag) ?? [];
    list.push(usage);
    byFlag.set(flag, list);
  };

  for (const question of questions) {
    const label = question.title?.trim() || `第 ${question.id} 题`;
    // game 题：通关自动产出 flag（computeFlags），创作者无需配置即有产出点。
    if (question.type === "game") {
      push(`game_passed_${question.id}`, {
        questionId: question.id,
        questionTitle: label,
        kind: "game",
        detail: "小游戏题通关后自动获得；在 flagJumps 里引用可实现「必须通关才继续」",
      });
    }
    const condition = question.condition;
    if (!condition) continue;
    if (Array.isArray(condition.flagRules)) {
      for (const rule of condition.flagRules as Array<Record<string, unknown>>) {
        const flag = typeof rule.flag === "string" ? rule.flag.trim() : "";
        // 空 flag 产不出任何值（引擎同样跳过）；体检面板已有专门的空名报告。
        if (!flag) continue;
        const sourceId = Number(rule.questionId);
        const sourceLabel = Number.isInteger(sourceId) && sourceId > 0 ? `「${titleOf(sourceId)}」` : "来源题";
        const score = Number(rule.score);
        const scoreText = Number.isFinite(score) && score !== 1 ? `累计 +${score}` : "累计 +1";
        push(flag, {
          questionId: question.id,
          questionTitle: label,
          kind: "scoring",
          detail: `${sourceLabel}答案 = ${String(rule.equals ?? "?")} 时${scoreText}`,
        });
      }
    }
    if (Array.isArray(condition.flagJumps)) {
      for (const jump of condition.flagJumps as Array<Record<string, unknown>>) {
        const flag = typeof jump.flag === "string" ? jump.flag.trim() : "";
        if (!flag) continue;
        const targetId = Number(jump.targetQuestionId);
        const targetLabel = Number.isInteger(targetId) && targetId > 0 ? `「${titleOf(targetId)}」` : "目标题";
        push(flag, {
          questionId: question.id,
          questionTitle: label,
          kind: "jump",
          detail: `≥ ${String(jump.gte ?? "?")} 时跳向${targetLabel}`,
        });
      }
    }
  }

  // flag 名按码元序排：一屏稳定可扫读，也保证单测断言不依赖 locale。
  return [...byFlag.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([flag, usages]) => ({ flag, usages }));
}
