import { useEffect, useState } from "react";
import type { ConfigIssue } from "../../../../../src/game-plugin/types";
import {
  guessManifest,
  guessProps,
  type GuessConfig,
  type GuessHistoryEntry,
} from "../../../../../src/game-plugin/plugins/guess/manifest";
import { defineGamePlugin } from "../../define";
import type { GameEditViewProps, GamePlayViewProps } from "../../types";

/**
 * 猜数字 · 客户端半身。
 *
 * 编辑态只做 Schema 表达不了的部分（区间概览），字段本身交给 SchemaForm；
 * 答题态只渲染服务端算好的视图（历史提示），谜底终局前不下发，玩家提交的
 * 只有猜测值。
 */

/** 插件自定义校验：上界必须大于下界。 */
function validateConfig(config: GuessConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (config.rangeMax <= config.rangeMin) {
    issues.push({ key: "rangeMax", message: "范围上界必须大于下界", severity: "error" });
  }
  return issues;
}

const HINT_LABELS: Record<GuessHistoryEntry["hint"], string> = {
  up: "小了，谜底更大",
  down: "大了，谜底更小",
  hit: "猜中了！",
};

function EditView({ config, mode }: GameEditViewProps<GuessConfig>) {
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--surface)] p-3 text-xs">
        <p className="font-semibold text-[var(--color-ink)]">
          猜 {config.rangeMin}–{config.rangeMax} 之间的数
        </p>
        <p className="mt-1 text-[10px] text-[var(--color-muted)]">
          {config.attempts} 次机会 · 满分 {config.score} 分
        </p>
      </div>
      <p className="text-[11px] text-[var(--color-muted-soft)]">
        {mode === "basic"
          ? "左侧可调范围、机会次数与满分。"
          : "满分按剩余机会比例折算，越早猜中得分越高（专业设置见右侧）。"}
      </p>
    </div>
  );
}

interface GuessPayload {
  range: [number, number];
  attempts: number;
  attemptsLeft: number;
  history: GuessHistoryEntry[];
  secret?: number;
}

function PlayView({ host, saved, disabled }: GamePlayViewProps<GuessConfig>) {
  const [view, setView] = useState<Awaited<ReturnType<typeof host.start>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

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

  const submit = async () => {
    if (!view || busy || draft === "") return;
    const value = Number(draft);
    if (!Number.isInteger(value)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await host.act({ kind: "guess", value });
      setView(response.view);
      setDraft("");
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
  if (!view) return <p className="mt-4 text-sm text-[var(--survey-muted)]">正在出题…</p>;

  const payload = view.payload as unknown as GuessPayload;
  const done = view.status !== "active";
  const [min, max] = payload.range;

  return (
    <div className="mt-4 flex flex-col gap-3">
      <p className="text-xs text-[var(--survey-muted)]">
        在{" "}
        <span className="font-bold text-[var(--survey-heading)]">
          {min}–{max}
        </span>{" "}
        里猜一个数 · 剩 {payload.attemptsLeft}/{payload.attempts} 次机会
      </p>

      <div className="space-y-1.5">
        {payload.history.map((entry, index) => (
          <div
            key={index}
            className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm ${
              entry.hint === "hit"
                ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300"
                : "border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-[var(--survey-body)]"
            }`}
          >
            <span className="font-black tabular-nums">{entry.value}</span>
            <span className="text-xs">{HINT_LABELS[entry.hint]}</span>
          </div>
        ))}
      </div>

      {done ? (
        <div className="rounded-xl bg-[var(--survey-primary-soft)] p-4 text-sm text-[var(--survey-heading)]">
          {view.status === "won" ? "🎉 猜中了！" : "机会用完了…"} 谜底是{" "}
          <span className="font-black tabular-nums">{payload.secret}</span> · 总分 {view.score} / {view.maxScore}
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={draft}
            disabled={disabled || busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            placeholder={`${min}–${max}`}
            aria-label="你的猜测"
            className="input input-bordered w-full border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-sm tabular-nums"
          />
          <button
            type="button"
            disabled={disabled || busy || draft === ""}
            onClick={() => void submit()}
            className="shrink-0 rounded-xl bg-[var(--survey-primary)] px-5 py-2.5 text-sm font-bold text-[var(--survey-primary-content)] disabled:opacity-50"
          >
            {busy ? "…" : "猜"}
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

export default defineGamePlugin<typeof guessProps, GuessConfig>({
  manifest: guessManifest,
  props: guessProps,
  validate: validateConfig,
  EditView,
  PlayView,
  summary: (config) => `猜 ${config.rangeMin}–${config.rangeMax} · ${config.attempts} 次机会`,
});
