import { useEffect, useState } from "react";
import type { ConfigIssue } from "../../../../../src/game-plugin/types";
import {
  flipCardManifest,
  flipCardProps,
  type FlipCardConfig,
} from "../../../../../src/game-plugin/plugins/flip-card/manifest";
import { defineGamePlugin } from "../../define";
import type { GameEditViewProps, GamePlayViewProps } from "../../types";

/**
 * 答题翻牌 · 客户端半身。
 *
 * 编辑态只做 Schema 表达不了的部分（卡面缩略与结构检查），字段本身交给
 * SchemaForm；答题态只负责渲染引擎算好的视图，不自己判分。
 */

/** 插件自定义校验：卡组至少要有一张有 2 个以上选项的卡。 */
function validateConfig(config: FlipCardConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (config.cards.length === 0) {
    issues.push({ key: "cards", message: "至少配置一张卡牌", severity: "error" });
    return issues;
  }
  config.cards.forEach((card, index) => {
    if (card.options.length < 2) {
      issues.push({ key: "cards", message: `第 ${index + 1} 张卡至少需要 2 个选项`, severity: "error" });
    }
  });
  return issues;
}

function EditView({ config, mode }: GameEditViewProps<FlipCardConfig>) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 overflow-x-auto rounded-xl bg-[var(--surface-muted)] p-2">
        {config.cards.map((card, index) => (
          <div
            key={index}
            className="w-32 shrink-0 rounded-lg border border-[var(--color-edge)] bg-[var(--surface)] p-2 text-xs"
          >
            <p className="truncate font-semibold text-[var(--color-ink)]">{card.front || "未命名"}</p>
            <p className="mt-1 line-clamp-2 text-[var(--color-muted-soft)]">{card.back || "—"}</p>
            <p className="mt-1 text-[10px] text-[var(--color-muted)]">
              {card.options.length} 选项 · {card.score} 分
            </p>
          </div>
        ))}
        {config.cards.length === 0 ? (
          <p className="p-2 text-xs text-[var(--color-muted-soft)]">还没有卡牌</p>
        ) : null}
      </div>
      <p className="text-[11px] text-[var(--color-muted-soft)]">
        {mode === "basic"
          ? "在右侧「卡组」里添加题目；每张卡的第一个选项是正确答案。"
          : `打乱 ${config.shuffle ? "开" : "关"} · 通关线 ${config.passRatio}%（专业设置见右侧）`}
      </p>
    </div>
  );
}

function PlayView({ config, host, saved, disabled }: GamePlayViewProps<FlipCardConfig>) {
  const [view, setView] = useState<Awaited<ReturnType<typeof host.start>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!host.adultAck) return; // 门禁由宿主渲染，插件不自建
    let cancelled = false;
    void host
      .start()
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "开局失败");
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  const finish = async (optionIndex: number) => {
    if (!view || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await host.act({ kind: "answer", optionIndex, step: view.step - 1 });
      setView(response.view);
      setFlipped(false);
      if (response.finished) await host.commit();
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
    } finally {
      setBusy(false);
    }
  };

  if (saved?.completed) {
    return (
      <p className="mt-4 rounded-xl bg-[var(--survey-primary-soft)] p-4 text-sm text-[var(--survey-heading)]">
        已通关：{saved.grade ?? "—"} 级 · {saved.score} 分
      </p>
    );
  }
  if (error) return <p className="mt-4 text-sm text-red-500">{error}</p>;
  if (!view) return <p className="mt-4 text-sm text-[var(--survey-muted)]">正在发牌…</p>;

  const card = view.payload.card as { front: string; back: string; options: string[] } | null;
  const done = view.status !== "active";

  return (
    <div className="mt-4 flex flex-col gap-3">
      <p className="text-xs text-[var(--survey-muted)]">
        第 {view.step} / {view.total} 张 · 得分 {view.score}
        {flipped ? " · 已揭晓" : ""}
      </p>
      {card ? (
        <button
          type="button"
          disabled={disabled || busy || done}
          onClick={() => setFlipped((value) => !value)}
          className="w-full rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-5 text-left"
        >
          <span className="block text-base font-bold text-[var(--survey-heading)]">{card.front}</span>
          <span className={`mt-2 block text-sm text-[var(--survey-body)] ${flipped ? "" : "select-none blur-[3px]"}`}>
            {card.back || "（点击翻牌）"}
          </span>
          <span className="mt-2 block text-[11px] text-[var(--survey-muted)]">{flipped ? "已揭晓" : "点击翻牌揭晓提示"}</span>
        </button>
      ) : null}
      {done ? (
        <p className="rounded-xl bg-[var(--survey-primary-soft)] p-4 text-sm text-[var(--survey-heading)]">
          {view.status === "won" ? "挑战成功！" : "挑战结束"} · 总分 {view.score} / {view.maxScore}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {(card?.options ?? []).map((label, index) => (
            <button
              key={index}
              type="button"
              disabled={disabled || busy}
              onClick={() => void finish(index)}
              className="rounded-xl border border-[var(--survey-card-border)] px-3 py-2.5 text-sm font-semibold text-[var(--survey-heading)] disabled:opacity-50"
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {!done ? (
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => void host.abandon().then(() => host.commit())}
          className="text-xs font-medium text-red-400"
        >
          放弃本局
        </button>
      ) : null}
      {typeof view.payload.cover === "number" ? (
        <img src={`/api/survey/media/${view.payload.cover}`} alt="" className="rounded-xl" loading="lazy" />
      ) : null}
    </div>
  );
}

export default defineGamePlugin<typeof flipCardProps, FlipCardConfig>({
  manifest: flipCardManifest,
  props: flipCardProps,
  validate: validateConfig,
  EditView,
  PlayView,
  summary: (config) => `${config.cards.length} 张卡`,
});
