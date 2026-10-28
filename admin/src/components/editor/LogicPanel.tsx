import { ArrowRight, GitBranch } from "lucide-react";
import { findDependents, findTargets, type EditableConditionQuestion } from "../../editor/dependencies";

/**
 * 逻辑关系面板：把"谁跳向谁"从隐藏的 JSON 里翻译成人能读的列表。
 *
 * 为什么不画在画布上连线：画布现在是按页排布的卡片流，连线要处理跨页、
 * 滚动、缩放三种坐标变换，风险远高于收益；先把关系讲清楚、支持一点即跳，
 * 是这一步真正降低理解成本的部分。画布连线留作 P2。
 */
export function LogicPanel({
  questions,
  selectedId,
  onSelect,
}: {
  questions: EditableConditionQuestion[];
  selectedId: number | null;
  onSelect(questionId: number): void;
}) {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const selected = selectedId === null ? null : (byId.get(selectedId) ?? null);
  const inbound = selected ? findDependents(questions, selected.id) : [];
  const outbound = selected ? findTargets(selected) : [];
  const totalLinks = questions.reduce((sum, question) => sum + findTargets(question).length, 0);

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold text-[var(--color-muted)]">逻辑关系</p>
        <span className="text-[11px] text-[var(--color-muted-soft)]">共 {totalLinks} 条跳转</span>
      </div>

      {!selected ? (
        <p className="rounded-lg border border-dashed border-[var(--color-edge)] p-3 text-center text-[11px] text-[var(--color-muted-soft)]">
          在画布上选中一道题，这里会列出它的去向与来源。
        </p>
      ) : (
        <>
          <section className="rounded-lg border border-[var(--color-edge)] p-2.5">
            <p className="mb-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--color-ink)]">
              <ArrowRight className="h-3 w-3" /> 去向（{outbound.length}）
            </p>
            {outbound.length === 0 ? (
              <p className="text-[11px] text-[var(--color-muted-soft)]">按顺序继续，无跳转。</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {outbound.map((target, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      className="w-full truncate rounded px-1 py-0.5 text-left text-[11px] text-[var(--color-primary)] hover:bg-[var(--surface-muted)]"
                      onClick={() => onSelect(target.targetId)}
                      disabled={!byId.has(target.targetId)}
                    >
                      {target.detail} {byId.get(target.targetId)?.title || `第 ${target.targetId} 题`}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-[var(--color-edge)] p-2.5">
            <p className="mb-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--color-ink)]">
              <GitBranch className="h-3 w-3" /> 来源（{inbound.length}）
            </p>
            {inbound.length === 0 ? (
              <p className="text-[11px] text-[var(--color-muted-soft)]">没有题目跳到这里。</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {inbound.map((ref, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      className="w-full rounded px-1 py-0.5 text-left text-[11px] text-[var(--color-primary)] hover:bg-[var(--surface-muted)]"
                      onClick={() => onSelect(ref.fromId)}
                    >
                      <span className="block truncate">{ref.fromTitle}</span>
                      <span className="block truncate text-[10px] text-[var(--color-muted-soft)]">{ref.detail}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="text-[10px] leading-4 text-[var(--color-muted-soft)]">
            删除被引用的题目时，会先提示影响范围并一并清理这些跳转（可撤销）。
          </p>
        </>
      )}
    </div>
  );
}
