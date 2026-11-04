import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Replace, Search, X } from "lucide-react";
import { trapFocusWithin } from "../../focus-trap";
import type { EditableQuestion, TextReplacement } from "../../../editor/useSurveyEditor";

interface SearchMatch {
  key: string;
  questionId: number;
  questionTitle: string;
  field: "title" | "description" | "option";
  optionId?: number;
  value: string;
  next: string;
}

const FIELD_LABEL: Record<SearchMatch["field"], string> = {
  title: "题面",
  description: "描述",
  option: "选项",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceLiteral(value: string, needle: string, replacement: string, caseSensitive: boolean): string {
  if (!needle) return value;
  if (caseSensitive) return value.split(needle).join(replacement);
  return value.replace(new RegExp(escapeRegExp(needle), "gi"), () => replacement);
}

/** 命中片段高亮：按字面量切分，大小写开关与替换逻辑保持同一口径。 */
function highlight(value: string, needle: string, caseSensitive: boolean): ReactNode {
  if (!needle) return value;
  const haystack = caseSensitive ? value : value.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let hit = haystack.indexOf(target);
  while (hit >= 0) {
    if (hit > cursor) parts.push(value.slice(cursor, hit));
    parts.push(
      <mark
        key={`${hit}-${parts.length}`}
        className="rounded bg-[color-mix(in_srgb,var(--color-primary)_22%,transparent)] px-0.5 text-inherit"
      >
        {value.slice(hit, hit + needle.length)}
      </mark>,
    );
    cursor = hit + needle.length;
    hit = haystack.indexOf(target, cursor);
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts;
}

/**
 * 全局搜索替换（2026-11）。
 *
 * 只处理文案字段：题面、描述、选项标签。跳转/flag/媒体不在搜索范围内——
 * 它们是结构，误替换的代价远高于收益。应用走 useSurveyEditor 的批量替换
 * 方法：一条撤销快照 + 按题合并的 PATCH，整批可一次 Ctrl+Z 回退。
 */
export function SearchReplaceDialog({
  open,
  questions,
  disabled,
  onClose,
  onSelectQuestion,
  onApply,
}: {
  open: boolean;
  questions: readonly EditableQuestion[];
  disabled: boolean;
  onClose: () => void;
  onSelectQuestion: (questionId: number) => void;
  onApply: (replacements: TextReplacement[]) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [needle, setNeedle] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [applied, setApplied] = useState(0);

  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setApplied(0);
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  const matches = useMemo<SearchMatch[]>(() => {
    if (!needle) return [];
    const target = caseSensitive ? needle : needle.toLowerCase();
    const contains = (value: string) => (caseSensitive ? value : value.toLowerCase()).includes(target);
    const out: SearchMatch[] = [];
    for (const question of questions) {
      const questionTitle = question.title.trim() || `第 ${question.id} 题`;
      if (contains(question.title)) {
        out.push({
          key: `title:${question.id}`,
          questionId: question.id,
          questionTitle,
          field: "title",
          value: question.title,
          next: replaceLiteral(question.title, needle, replacement, caseSensitive),
        });
      }
      if (question.description && contains(question.description)) {
        out.push({
          key: `description:${question.id}`,
          questionId: question.id,
          questionTitle,
          field: "description",
          value: question.description,
          next: replaceLiteral(question.description, needle, replacement, caseSensitive),
        });
      }
      for (const option of question.options) {
        if (!contains(option.label)) continue;
        out.push({
          key: `option:${option.id}`,
          questionId: question.id,
          questionTitle,
          field: "option",
          optionId: option.id,
          value: option.label,
          next: replaceLiteral(option.label, needle, replacement, caseSensitive),
        });
      }
    }
    return out;
  }, [questions, needle, replacement, caseSensitive]);

  if (!open) return null;

  const affectedQuestions = new Set(matches.map((match) => match.questionId)).size;
  // 只替换「会变化」的命中：大小写不敏感 + 仅改大小写时，部分命中可能
  // 替换后与原文相同；不能因为其中一条没变化就整批禁用。
  const changes = matches.filter((match) => match.next !== match.value);
  const canApply = !disabled && changes.length > 0;

  const applyAll = () => {
    if (!canApply) return;
    onApply(
      changes.map((match) =>
        match.field === "option"
          ? { kind: "option", questionId: match.questionId, optionId: match.optionId!, value: match.next }
          : { kind: "field", questionId: match.questionId, field: match.field, value: match.next },
      ),
    );
    setApplied(changes.length);
  };

  return (
    <div
      className="fixed inset-0 z-[90] grid place-items-center bg-black/45 px-3 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="survey-search-title"
        className="survey-card flex max-h-[86dvh] w-full max-w-2xl flex-col overflow-hidden outline-none"
        onKeyDown={(event) => trapFocusWithin(panelRef.current, event.nativeEvent)}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--color-edge)] px-4 py-3.5">
          <div className="min-w-0">
            <h2
              id="survey-search-title"
              className="flex items-center gap-2 text-[15px] font-bold text-[var(--color-ink)]"
            >
              <Search className="h-4 w-4 text-[var(--color-primary)]" aria-hidden="true" />
              搜索与替换
            </h2>
            <p className="mt-1 text-xs leading-5 text-[var(--color-muted)]">
              只改文案（题面 / 描述 / 选项），不碰跳转和 flag；整批可一次撤销。
            </p>
          </div>
          <button type="button" className="btn btn-sm btn-quiet shrink-0" aria-label="关闭搜索替换" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid gap-2 border-b border-[var(--color-edge)] px-4 py-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-[var(--color-muted)]">查找</span>
            <input
              autoFocus
              type="text"
              className="input w-full"
              placeholder="输入要查找的文字"
              value={needle}
              onChange={(event) => {
                setNeedle(event.target.value);
                setApplied(0);
              }}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-[var(--color-muted)]">替换为</span>
            <input
              type="text"
              className="input w-full"
              placeholder="留空表示删除命中文字"
              value={replacement}
              onChange={(event) => {
                setReplacement(event.target.value);
                setApplied(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyAll();
                }
              }}
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
            <label className="inline-flex items-center gap-2 text-xs text-[var(--color-muted)]">
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={caseSensitive}
                onChange={(event) => {
                  setCaseSensitive(event.target.checked);
                  setApplied(0);
                }}
              />
              区分大小写
            </label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--color-muted)]" aria-live="polite">
                {needle
                  ? `${matches.length} 处命中 · ${affectedQuestions} 道题${
                      changes.length !== matches.length ? ` · ${changes.length} 处会变化` : ""
                    }`
                  : applied > 0
                    ? `已替换 ${applied} 处，可 Ctrl+Z 回退`
                    : "输入关键词开始查找"}
              </span>
              <button type="button" className="btn btn-sm btn-accent" disabled={!canApply} onClick={applyAll}>
                <Replace className="h-3.5 w-3.5" />
                替换全部
              </button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!needle ? (
            <div className="px-6 py-12 text-center text-xs leading-6 text-[var(--color-muted)]">
              支持在整份问卷的题面、描述和选项里查找；
              <br />
              替换只作用于匹配到的片段，不会改动其它文字。
            </div>
          ) : matches.length === 0 ? (
            <div className="px-6 py-12 text-center text-xs leading-6 text-[var(--color-muted)]">
              {applied > 0 ? `替换完成，共 ${applied} 处。` : `没有找到「${needle}」。`}
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-edge)]">
              {matches.map((match) => (
                <li key={match.key}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
                    onClick={() => {
                      onSelectQuestion(match.questionId);
                      onClose();
                    }}
                  >
                    <span className="mt-0.5 shrink-0 rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-muted)]">
                      {FIELD_LABEL[match.field]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-medium text-[var(--color-muted)]">
                        {match.questionTitle}
                      </span>
                      <span className="mt-1 block break-words text-[13px] leading-6 text-[var(--color-ink)]">
                        {highlight(match.value, needle, caseSensitive)}
                      </span>
                      {match.next !== match.value ? (
                        <span className="mt-1 block break-words text-xs leading-5 text-[var(--color-muted)]">
                          替换后：{match.next}
                        </span>
                      ) : (
                        <span className="mt-1 block text-[11px] text-[var(--color-muted)]">替换内容与原文相同</span>
                      )}
                    </span>
                    <ChevronHint />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="border-t border-[var(--color-edge)] px-4 py-2.5 text-[11px] leading-5 text-[var(--color-muted)]">
          替换会进入同一条待保存队列（Ctrl+S 保存 / 自动保存），不会立刻写库。
        </footer>
      </div>
    </div>
  );
}

function ChevronHint() {
  return <span className="mt-1 shrink-0 text-[11px] text-[var(--color-muted-soft)]">定位</span>;
}
