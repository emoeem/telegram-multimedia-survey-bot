import { useEffect, useState } from "react";
import type { ConfigIssue } from "../../../../../src/game-plugin/types";
import { drawManifest, drawProps, type DrawConfig } from "../../../../../src/game-plugin/plugins/draw/manifest";
import { defineGamePlugin } from "../../define";
import type { GameEditViewProps, GamePlayViewProps } from "../../types";

/**
 * 幸运抽取 · 客户端半身。
 *
 * 编辑态只做 Schema 表达不了的部分（奖池概览），字段本身交给 SchemaForm；
 * 答题态只渲染服务端算好的视图（已揭示条目），不自己抽、不自己判分——
 * 权重与未揭示条目从不离开服务端。
 */

const RARITY_LABELS: Record<string, string> = {
  common: "普通",
  rare: "稀有",
  epic: "史诗",
  legendary: "传说",
};

const RARITY_STYLES: Record<string, string> = {
  common: "text-[var(--survey-muted)]",
  rare: "text-sky-400",
  epic: "text-violet-400",
  legendary: "text-amber-400",
};

/** 插件自定义校验：奖池至少要有一个条目。 */
function validateConfig(config: DrawConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (config.items.length === 0) {
    issues.push({ key: "items", message: "至少配置一个奖池条目", severity: "error" });
  }
  return issues;
}

function EditView({ config, mode }: GameEditViewProps<DrawConfig>) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 overflow-x-auto rounded-xl bg-[var(--surface-muted)] p-2">
        {config.items.map((item, index) => (
          <div
            key={index}
            className="w-28 shrink-0 rounded-lg border border-[var(--color-edge)] bg-[var(--surface)] p-2 text-xs"
          >
            <p className="truncate font-semibold text-[var(--color-ink)]">{item.label || "未命名"}</p>
            <p className={`mt-1 text-[10px] font-semibold ${RARITY_STYLES[item.rarity] ?? RARITY_STYLES.common}`}>
              {RARITY_LABELS[item.rarity] ?? item.rarity}
            </p>
            <p className="mt-0.5 text-[10px] text-[var(--color-muted)]">
              权重 {item.weight} · {item.score} 分
            </p>
          </div>
        ))}
        {config.items.length === 0 ? <p className="p-2 text-xs text-[var(--color-muted-soft)]">奖池还是空的</p> : null}
      </div>
      <p className="text-[11px] text-[var(--color-muted-soft)]">
        {mode === "basic"
          ? "在右侧「奖池」里添加条目；权重越大越容易抽中。"
          : `每次抽取 ${config.drawCount} 张（专业设置见右侧）`}
      </p>
    </div>
  );
}

function PlayView({ host, saved, disabled }: GamePlayViewProps<DrawConfig>) {
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

  const reveal = async () => {
    if (!view || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await host.act({ kind: "reveal", step: view.step - 1 });
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
        已完成抽取：{saved.grade ?? "—"} 级 · {saved.score} 分
      </p>
    );
  }
  if (error) return <p className="mt-4 text-sm text-red-500">{error}</p>;
  if (!view) return <p className="mt-4 text-sm text-[var(--survey-muted)]">正在准备奖池…</p>;

  const revealed = (view.payload.revealed ?? []) as Array<{ label: string; rarity: string; score: number }>;
  const remaining = Number(view.payload.remaining ?? 0);
  const done = view.status !== "active";

  return (
    <div className="mt-4 flex flex-col gap-3">
      <p className="text-xs text-[var(--survey-muted)]">
        已揭示 {revealed.length} / {view.total} 张
      </p>
      {revealed.map((item, index) => (
        <div
          key={index}
          className="rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-bold text-[var(--survey-heading)]">{item.label}</span>
            <span className={`text-[11px] font-semibold ${RARITY_STYLES[item.rarity] ?? RARITY_STYLES.common}`}>
              {RARITY_LABELS[item.rarity] ?? item.rarity}
            </span>
          </div>
          <span className="mt-0.5 block text-xs text-[var(--survey-muted)]">+{item.score} 分</span>
        </div>
      ))}
      {done ? (
        <p className="rounded-xl bg-[var(--survey-primary-soft)] p-4 text-sm text-[var(--survey-heading)]">
          抽取完成 · 总分 {view.score} / {view.maxScore}
        </p>
      ) : (
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => void reveal()}
          className="rounded-xl bg-[var(--survey-primary)] px-4 py-3 text-sm font-bold text-[var(--survey-primary-content)] disabled:opacity-50"
        >
          {busy ? "抽取中…" : `抽取第 ${revealed.length + 1} 张（剩 ${remaining} 张）`}
        </button>
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

export default defineGamePlugin<typeof drawProps, DrawConfig>({
  manifest: drawManifest,
  props: drawProps,
  validate: validateConfig,
  EditView,
  PlayView,
  summary: (config) => `${config.items.length} 个条目 · 抽 ${config.drawCount} 张`,
});
