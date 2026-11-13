import { useEffect, useState } from "react";
import type { ConfigIssue } from "../../../../../src/game-plugin/types";
import {
  highLowManifest,
  highLowProps,
  type HighLowConfig,
} from "../../../../../src/game-plugin/plugins/high-low/manifest";
import { defineGamePlugin } from "../../define";
import type { GameEditViewProps, GamePlayViewProps } from "../../types";

/**
 * 大小猜牌 · 客户端半身。
 *
 * 编辑态只做 Schema 表达不了的部分（规则概览），字段本身交给 SchemaForm；
 * 答题态只渲染服务端算好的视图（当前牌 + 上一手结果），下一张牌只存在于
 * 服务端，玩家提交的只有方向。
 */

/** 插件自定义校验：无特别结构，占位保持协议一致。 */
function validateConfig(config: HighLowConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (config.score + config.streakBonus <= 0) {
    issues.push({ key: "score", message: "单次分值与连击奖励不能同时为 0", severity: "warning" });
  }
  return issues;
}

const RANK_LABELS: Record<number, string> = {
  1: "A",
  11: "J",
  12: "Q",
  13: "K",
};
const SUIT_SYMBOLS = ["♠", "♥", "♦", "♣"];

function EditView({ config, mode }: GameEditViewProps<HighLowConfig>) {
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--surface)] p-3 text-xs">
        <p className="font-semibold text-[var(--color-ink)]">{config.rounds} 轮 · 猜大猜小</p>
        <p className="mt-1 text-[10px] text-[var(--color-muted)]">
          对一次 {config.score} 分 · 连对 3 次 +{config.streakBonus} 分 · 猜错即终局
        </p>
      </div>
      <p className="text-[11px] text-[var(--color-muted-soft)]">
        {mode === "basic"
          ? "左侧可调轮数与分值；平局不吃分也不掉命。"
          : "下一张牌只存在于服务端，玩家提交的只有方向（专业设置见右侧）。"}
      </p>
    </div>
  );
}

interface CardView {
  rank: number;
  suit: number;
}

interface LastView {
  direction: "up" | "down";
  prevRank: number;
  nextRank: number;
  outcome: "hit" | "miss" | "tie";
  gained: number;
}

interface HighLowPayload {
  card: CardView;
  round: number;
  rounds: number;
  streak: number;
  bestStreak: number;
  last: LastView | null;
}

function Card({ card, small }: { card: CardView; small?: boolean }) {
  const red = card.suit === 1 || card.suit === 2;
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-xl border-2 border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] font-black shadow-sm ${
        small ? "h-10 w-8 text-sm" : "h-32 w-24 text-4xl"
      } ${red ? "text-red-500" : "text-[var(--survey-heading)]"}`}
    >
      <span className="tabular-nums">{RANK_LABELS[card.rank] ?? card.rank}</span>
      <span className={small ? "text-[10px]" : "text-2xl"}>{SUIT_SYMBOLS[card.suit] ?? "♠"}</span>
    </div>
  );
}

function PlayView({ host, saved, disabled }: GamePlayViewProps<HighLowConfig>) {
  const [view, setView] = useState<Awaited<ReturnType<typeof host.start>> | null>(null);
  const [busy, setBusy] = useState(false);
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

  const pick = async (direction: "up" | "down") => {
    if (!view || busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const response = await host.act({ kind: "pick", direction });
      setView(response.view);
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
        已完成：{saved.grade ?? "—"} 级 · {saved.score} 分
      </p>
    );
  }
  if (error) return <p className="mt-4 text-sm text-red-500">{error}</p>;
  if (!view) return <p className="mt-4 text-sm text-[var(--survey-muted)]">正在洗牌…</p>;

  const payload = view.payload as unknown as HighLowPayload;
  const done = view.status !== "active";
  const miss = done && payload.last?.outcome === "miss";

  return (
    <div className="mt-4 flex flex-col items-center gap-3">
      <p className="text-xs text-[var(--survey-muted)]">
        {done ? null : (
          <>
            第 {payload.round}/{payload.rounds} 轮 · 连对{" "}
            <span className="font-bold text-[var(--survey-heading)]">{payload.streak}</span>
          </>
        )}
      </p>

      {payload.last ? (
        <div
          className={`w-full rounded-lg border px-3 py-2 text-center text-xs ${
            payload.last.outcome === "hit"
              ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300"
              : payload.last.outcome === "tie"
                ? "border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-[var(--survey-muted)]"
                : "border-red-400/50 bg-red-400/10 text-red-500"
          }`}
        >
          {payload.last.outcome === "hit"
            ? `✓ ${payload.last.prevRank} → ${payload.last.nextRank}，+${payload.last.gained} 分`
            : payload.last.outcome === "tie"
              ? `＝ ${payload.last.prevRank} 平局，不吃分不掉命`
              : `✗ ${payload.last.prevRank} → ${payload.last.nextRank}，猜错即终局`}
        </div>
      ) : null}

      <div className="flex items-center gap-4">
        {miss && payload.last ? <Card card={{ rank: payload.last.prevRank, suit: payload.card.suit }} small /> : null}
        <Card card={payload.card} />
        {miss && payload.last ? (
          <div className="flex flex-col items-center gap-1">
            <span className="text-[10px] text-[var(--survey-muted)]">其实是</span>
            <Card card={{ rank: payload.last.nextRank, suit: payload.card.suit }} small />
          </div>
        ) : null}
      </div>

      {done ? (
        <div className="w-full rounded-xl bg-[var(--survey-primary-soft)] p-4 text-center text-sm text-[var(--survey-heading)]">
          {view.status === "won" ? "🎉 撑完全场！" : "猜错了…"} · 总分 {view.score} / {view.maxScore} · 最佳连对{" "}
          {payload.bestStreak}
        </div>
      ) : (
        <div className="flex w-full gap-3">
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void pick("up")}
            className="flex-1 rounded-xl bg-[var(--survey-primary)] py-3 text-sm font-bold text-[var(--survey-primary-content)] disabled:opacity-50"
          >
            ↑ 下一张更大
          </button>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void pick("down")}
            className="flex-1 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] py-3 text-sm font-bold text-[var(--survey-heading)] disabled:opacity-50"
          >
            ↓ 下一张更小
          </button>
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
    </div>
  );
}

export default defineGamePlugin<typeof highLowProps, HighLowConfig>({
  manifest: highLowManifest,
  props: highLowProps,
  validate: validateConfig,
  EditView,
  PlayView,
  summary: (config) => `${config.rounds} 轮 · 对一次 ${config.score} 分 · 连对奖 ${config.streakBonus}`,
});
