import { useEffect, useRef, useState } from "react";
import type { ConfigIssue } from "../../../../../src/game-plugin/types";
import {
  memoryChainManifest,
  memoryChainProps,
  type MemoryChainConfig,
} from "../../../../../src/game-plugin/plugins/memory-chain/manifest";
import { defineGamePlugin } from "../../define";
import type { GameEditViewProps, GamePlayViewProps } from "../../types";

/**
 * 记忆序列 · 客户端半身。
 *
 * 编辑态只做 Schema 表达不了的部分（棋盘概览），字段本身交给 SchemaForm；
 * 答题态的节奏控制：展示阶段客户端按序列做点亮动画、播完自动 ready 切入
 * 复现；复现阶段视图里没有序列，点哪格只有服务端知道对错。
 */

/** 插件自定义校验：格子数至少 4，首轮长度不能超过格子数。 */
function validateConfig(config: MemoryChainConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (config.cells < 4) {
    issues.push({ key: "cells", message: "格子数量至少 4 个", severity: "error" });
  }
  if (config.startLength > config.cells) {
    issues.push({ key: "startLength", message: "首轮长度不能超过格子数量", severity: "error" });
  }
  return issues;
}

function EditView({ config, mode }: GameEditViewProps<MemoryChainConfig>) {
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--surface)] p-3 text-xs">
        <p className="font-semibold text-[var(--color-ink)]">
          {config.cells} 格棋盘 · {config.rounds} 轮
        </p>
        <p className="mt-1 text-[10px] text-[var(--color-muted)]">
          首轮 {config.startLength} 步 · 每轮 +1 · 第 r 轮 {config.roundScore}×r 分
        </p>
      </div>
      <p className="text-[11px] text-[var(--color-muted-soft)]">
        {mode === "basic"
          ? "左侧可调格子数、轮数与分值。"
          : "序列每轮加长一格；点错即终局并揭晓序列（专业设置见右侧）。"}
      </p>
    </div>
  );
}

interface ChainPayload {
  phase: "show" | "input" | "done";
  cells: number;
  round: number;
  rounds: number;
  /** 展示阶段与终局时下发；复现阶段绝不带出。 */
  sequence?: number[];
  progress?: number;
  length?: number;
}

/** 展示动画参数：每格点亮 420ms，间隔 260ms，播完停 700ms 再交卷。 */
const GLOW_MS = 420;
const GAP_MS = 260;
const TAIL_MS = 700;

function PlayView({ host, saved, disabled }: GamePlayViewProps<MemoryChainConfig>) {
  const [view, setView] = useState<Awaited<ReturnType<typeof host.start>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [litCell, setLitCell] = useState<number | null>(null);
  const [flashCell, setFlashCell] = useState<{ index: number; ok: boolean } | null>(null);
  const timersRef = useRef<number[]>([]);

  const clearTimers = () => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
  };

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

  const payload = (view?.payload ?? null) as ChainPayload | null;
  const phase = payload?.phase ?? null;

  // 展示阶段动画：逐格点亮，播完自动 ready（服务端切到复现阶段）。
  useEffect(() => {
    if (phase !== "show" || !payload?.sequence) return;
    clearTimers();
    setLitCell(null);
    const sequence = payload.sequence;
    sequence.forEach((cellIndex, order) => {
      timersRef.current.push(window.setTimeout(() => setLitCell(cellIndex), order * (GLOW_MS + GAP_MS)));
      timersRef.current.push(window.setTimeout(() => setLitCell(null), order * (GLOW_MS + GAP_MS) + GLOW_MS));
    });
    timersRef.current.push(
      window.setTimeout(
        () => {
          setBusy(true);
          void host
            .act({ kind: "ready" })
            .then((response) => setView(response.view))
            .catch((err: unknown) => setError(err instanceof Error ? err.message : "提交失败"))
            .finally(() => setBusy(false));
        },
        sequence.length * (GLOW_MS + GAP_MS) + TAIL_MS,
      ),
    );
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, view?.step, payload?.sequence?.length]);

  useEffect(() => clearTimers, []);

  const press = async (index: number) => {
    if (!view || busy || disabled || phase !== "input") return;
    setBusy(true);
    setError(null);
    try {
      const response = await host.act({ kind: "press", index });
      setFlashCell({ index, ok: !response.finished || response.view.status === "won" });
      window.setTimeout(() => setFlashCell(null), 260);
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
  if (!view || !payload) return <p className="mt-4 text-sm text-[var(--survey-muted)]">正在准备棋盘…</p>;

  const columns = Math.ceil(Math.sqrt(payload.cells));
  const done = phase === "done";
  const revealed = done ? (payload.sequence ?? []) : null;

  return (
    <div className="mt-4 flex flex-col gap-3">
      <p className="text-xs text-[var(--survey-muted)]">
        {done
          ? null
          : phase === "show"
            ? `第 ${payload.round}/${payload.rounds} 轮 · 看仔细…`
            : `第 ${payload.round}/${payload.rounds} 轮 · 轮到你了（${(payload.progress ?? 0) + 1}/${payload.length}）`}
      </p>

      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        aria-label="记忆棋盘"
      >
        {Array.from({ length: payload.cells }, (_, index) => {
          const lit = litCell === index || flashCell?.index === index;
          const revealedHere = revealed?.includes(index) ?? false;
          const base = "aspect-square rounded-xl border transition-colors duration-100 disabled:cursor-default";
          const tone =
            done && revealedHere
              ? "border-amber-400/60 bg-amber-400/20"
              : lit
                ? flashCell && !flashCell.ok
                  ? "border-red-400/70 bg-red-400/30"
                  : "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)] shadow-[0_0_18px_-4px_var(--survey-primary)]"
                : "border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]";
          return (
            <button
              key={index}
              type="button"
              aria-label={`格子 ${index + 1}`}
              disabled={phase !== "input" || busy || disabled}
              onClick={() => void press(index)}
              className={`${base} ${tone}`}
            />
          );
        })}
      </div>

      {done ? (
        <div className="rounded-xl bg-[var(--survey-primary-soft)] p-4 text-sm text-[var(--survey-heading)]">
          {view.status === "won" ? "🎉 全部复现成功！" : "记岔了，序列揭晓如上"} · 总分 {view.score} / {view.maxScore}
        </div>
      ) : null}
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

export default defineGamePlugin<typeof memoryChainProps, MemoryChainConfig>({
  manifest: memoryChainManifest,
  props: memoryChainProps,
  validate: validateConfig,
  EditView,
  PlayView,
  summary: (config) => `${config.cells} 格 · ${config.rounds} 轮 · 首轮 ${config.startLength} 步`,
});
