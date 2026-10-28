import { useCallback, useEffect, useState } from "react";
import { Coins, Dices, Shield, Ticket, TriangleAlert, Trophy, Zap } from "lucide-react";
import { safeGet, safeSet } from "./storage";
import { vibrateFail, vibrateLight, vibrateSuccess } from "./haptics";
import {
  confirmTrialShop,
  fetchTrialActiveRun,
  rerollTrialCoins,
  sendTrialAction,
  startTrialRun,
  TRIAL_SHOP_CONFIG,
  type TrialGrade,
  type TrialMode,
  type TrialPersona,
  type TrialRun,
  type TrialTask,
} from "./trial-api";
import type { AnswerValue } from "./api";

/**
 * 问卷内嵌的小游戏挑战（game 题）：复用 /trial 的服务端 API 与引擎
 * （开局商店 → 逐层任务 → 结算评级），只保留紧凑的呈现层。
 * 结束（通关/放弃/护盾结算）后通过 onResult 把挑战局写回答卷——
 * 服务端会按 runId 从 task_runs 重算分数，客户端值仅用于展示与本地跳转。
 *
 * 与 TrialScreen 的完整版共用同一个 18+ 门禁 localStorage 键：同意过一次，
 * 两个入口都不再重复询问。
 */

export const TRIAL_AGREEMENT_KEY = "trialAdultAgreement:v1";

export type GameAnswerValue = Extract<AnswerValue, { kind: "game" }>;

const PERSONA_OPTIONS: { id: TrialPersona; label: string; hint: string }[] = [
  { id: "male", label: "公", hint: "公向文案" },
  { id: "female", label: "母", hint: "母向文案" },
];

const MODE_OPTIONS: { id: TrialMode; label: string; hint: string }[] = [
  { id: "normal", label: "普通", hint: "标准楼层" },
  { id: "hell", label: "地狱", hint: "更多楼层" },
];

const GRADE_BADGE: Record<TrialGrade, string> = {
  S: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  A: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  B: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  C: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

type Phase = "gate" | "setup" | "shop" | "run" | "done";

export function GamePlayer({
  packId,
  value,
  disabled,
  onResult,
}: {
  packId: number | null;
  /** 已保存的答案：有且已通关时直接展示成绩，可重打。 */
  value: AnswerValue | undefined;
  disabled?: boolean;
  onResult: (value: GameAnswerValue) => void;
}) {
  const saved: GameAnswerValue | null =
    value && typeof value === "object" && !Array.isArray(value) && (value as { kind?: unknown }).kind === "game"
      ? (value as GameAnswerValue)
      : null;
  const [phase, setPhase] = useState<Phase>(() => (safeGet(TRIAL_AGREEMENT_KEY) === "1" ? "setup" : "gate"));
  const [persona, setPersona] = useState<TrialPersona>("male");
  const [mode, setMode] = useState<TrialMode>("normal");
  const [run, setRun] = useState<TrialRun | null>(null);
  const [task, setTask] = useState<TrialTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settlement, setSettlement] = useState<{ grade: TrialGrade; title: string; text: string } | null>(null);
  const [shopQty, setShopQty] = useState({ skipTickets: 0, boosters: 0, shields: 0 });

  const settle = useCallback(
    (finished: TrialRun, grade: TrialGrade, title: string, text: string) => {
      setSettlement({ grade, title, text });
      setPhase("done");
      onResult({
        kind: "game",
        runId: finished.id,
        score: finished.score,
        grade,
        completed: finished.status === "completed",
      });
    },
    [onResult],
  );

  // 有进行中的局时自动接上（换题/刷新不断档）；找不到就停在开局设置。
  useEffect(() => {
    if (phase !== "setup" || run) return;
    let cancelled = false;
    void (async () => {
      try {
        const active = await fetchTrialActiveRun();
        if (cancelled || !active.run) return;
        setRun(active.run);
        setTask(active.task);
        setPhase(active.run.phase === "shop" ? "shop" : "run");
      } catch {
        // 无进行中的局：留在开局设置。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, run]);

  const start = async () => {
    if (!packId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await startTrialRun({ packId, persona, mode, startingFloor: 1 });
      setRun(response.run);
      setTask(response.task);
      setShopQty({ skipTickets: 0, boosters: 0, shields: 0 });
      setPhase(response.run.phase === "shop" ? "shop" : "run");
    } catch (err) {
      setError(err instanceof Error ? err.message : "开局失败");
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: "complete" | "skip" | "abandon" | "boost" | "shield_exit") => {
    if (!run || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await sendTrialAction(run.id, action);
      if (response.run.status === "completed" && response.grade && response.gradeCopy) {
        vibrateSuccess();
        setRun(response.run);
        settle(response.run, response.grade, response.gradeCopy.title, response.gradeCopy.text);
      } else if (response.run.status === "abandoned") {
        vibrateFail();
        setRun(response.run);
        settle(response.run, "C", "已放弃", "这一局记为未通关，可以重新挑战。");
      } else {
        setRun(response.run);
        setTask(response.task);
        vibrateLight();
        if (action === "boost") setNotice("本层已加倍，完成时积分 ×2");
        if (action === "skip") setNotice(`已跳过（剩余 ${response.run.inventory.skipTickets} 张）`);
      }
    } catch (err) {
      vibrateFail();
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const confirmShop = async () => {
    if (!run || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await confirmTrialShop(run.id, shopQty);
      setRun(response.run);
      setTask(response.task);
      setPhase("run");
    } catch (err) {
      setError(err instanceof Error ? err.message : "出发失败");
    } finally {
      setBusy(false);
    }
  };

  const reroll = async () => {
    if (!run || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await rerollTrialCoins(run.id);
      setRun(response.run);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重摇失败");
    } finally {
      setBusy(false);
    }
  };

  const agree = () => {
    safeSet(TRIAL_AGREEMENT_KEY, "1");
    setPhase("setup");
  };

  if (!packId) {
    return (
      <div className="mt-4 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4 text-sm text-[var(--survey-muted)]">
        这道题还没有配置小游戏包，请联系问卷创建者。
      </div>
    );
  }

  if (phase === "gate") {
    return (
      <div className="mt-4 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
        <p className="flex items-start gap-1.5 text-[13px] leading-6 text-[var(--survey-body)]">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
          <span>
            小游戏挑战为 <b>18+ 成人向</b>虚构文字游戏，全部内容为想象中的虚拟情境。
          </span>
        </p>
        <button
          type="button"
          disabled={disabled}
          onClick={agree}
          className="mt-3 w-full rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-2.5 text-sm font-bold text-[var(--survey-primary-content)] disabled:opacity-50"
        >
          我已年满 18 周岁，同意进入
        </button>
      </div>
    );
  }

  if (phase === "setup") {
    return (
      <div className="mt-4 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
        {saved ? (
          <p className="mb-3 rounded-lg bg-[var(--survey-primary-soft)] px-3 py-2 text-xs text-[var(--survey-primary)]">
            已有挑战成绩：{saved.completed ? `${saved.grade} 级 · ${saved.score} 分` : "未通关"}
            （重新挑战会以新一局为准）
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          {PERSONA_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              onClick={() => setPersona(option.id)}
              className={`rounded-xl border p-2.5 text-left text-sm font-bold ${
                persona === option.id
                  ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)] text-[var(--survey-heading)]"
                  : "border-[var(--survey-card-border)] text-[var(--survey-muted)]"
              }`}
            >
              {option.label}
              <span className="mt-0.5 block text-[11px] font-medium">{option.hint}</span>
            </button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {MODE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              onClick={() => setMode(option.id)}
              className={`rounded-xl border p-2.5 text-left text-sm font-bold ${
                mode === option.id
                  ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)] text-[var(--survey-heading)]"
                  : "border-[var(--survey-card-border)] text-[var(--survey-muted)]"
              }`}
            >
              {option.label}
              <span className="mt-0.5 block text-[11px] font-medium">{option.hint}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => void start()}
          className="mt-3 w-full rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-2.5 text-sm font-bold text-[var(--survey-primary-content)] disabled:opacity-50"
        >
          {busy ? "正在开局…" : "开始挑战"}
        </button>
        {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
      </div>
    );
  }

  if (phase === "shop" && run) {
    const rerollsLeft = Math.max(0, 3 - (run.coinRerolls ?? 0));
    const total = shopQty.skipTickets * 45 + shopQty.boosters * 35 + shopQty.shields * 60;
    return (
      <div className="mt-4 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
        <div className="flex items-center justify-between">
          <p className="inline-flex items-center gap-1.5 text-sm font-bold text-[var(--survey-heading)]">
            <Coins className="h-4 w-4 text-[var(--survey-primary)]" aria-hidden="true" />
            开局金币 <span className="text-lg font-black text-[var(--survey-primary)]">{run.coins}</span>
          </p>
          <button
            type="button"
            disabled={busy || rerollsLeft <= 0}
            onClick={() => void reroll()}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--survey-card-border)] px-3 py-1.5 text-xs font-semibold text-[var(--survey-body)] disabled:opacity-50"
          >
            <Dices className="h-3.5 w-3.5" aria-hidden="true" />
            重摇（{rerollsLeft}）
          </button>
        </div>
        <div className="mt-3 space-y-2">
          {TRIAL_SHOP_CONFIG.items.map((item) => {
            const qtyKey =
              item.kind === "skipTicket" ? "skipTickets" : item.kind === "booster" ? "boosters" : "shields";
            const qty = shopQty[qtyKey];
            return (
              <div key={item.kind} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-[var(--survey-body)]">
                  {item.label} <span className="text-xs text-[var(--survey-muted)]">· {item.price} 币</span>
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="减少"
                    disabled={busy || qty <= 0}
                    onClick={() => setShopQty((current) => ({ ...current, [qtyKey]: Math.max(0, qty - 1) }))}
                    className="h-7 w-7 rounded-full border border-[var(--survey-card-border)] font-bold text-[var(--survey-body)] disabled:opacity-40"
                  >
                    −
                  </button>
                  <span className="w-5 text-center font-bold text-[var(--survey-heading)]">{qty}</span>
                  <button
                    type="button"
                    aria-label="增加"
                    disabled={busy || qty >= item.cap || total + item.price > run.coins}
                    onClick={() => setShopQty((current) => ({ ...current, [qtyKey]: qty + 1 }))}
                    className="h-7 w-7 rounded-full bg-[var(--survey-primary)] font-bold text-[var(--survey-primary-content)] disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirmShop()}
          className="mt-3 w-full rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-2.5 text-sm font-bold text-[var(--survey-primary-content)] disabled:opacity-50"
        >
          {busy ? "出发中…" : total === 0 ? "不买东西，直接出发" : `购买并出发（${total} 币）`}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act("abandon")}
          className="mt-2 w-full py-1.5 text-center text-xs font-medium text-red-400 disabled:opacity-50"
        >
          放弃这一局
        </button>
        {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
      </div>
    );
  }

  if (phase === "run" && run) {
    const progress = Math.min(
      100,
      Math.max(
        0,
        Math.round(
          ((run.currentFloor - (run.startingFloor ?? 1)) / Math.max(1, run.maxFloor - (run.startingFloor ?? 1))) * 100,
        ),
      ),
    );
    return (
      <div className="mt-4 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
        <div className="flex items-center justify-between text-xs text-[var(--survey-muted)]">
          <span>
            第 {run.currentFloor} / {run.maxFloor} 层 · 积分 {run.score}
          </span>
          <span className="inline-flex gap-2">
            <span className="inline-flex items-center gap-0.5">
              <Ticket className="h-3.5 w-3.5" aria-hidden="true" />×{run.inventory.skipTickets}
            </span>
            <span className="inline-flex items-center gap-0.5">
              <Zap className="h-3.5 w-3.5" aria-hidden="true" />×{run.inventory.boosters}
            </span>
            <span className="inline-flex items-center gap-0.5">
              <Shield className="h-3.5 w-3.5" aria-hidden="true" />×{run.inventory.shields}
            </span>
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--survey-bg)]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[var(--survey-primary)] to-[var(--survey-secondary)] transition-[width] duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        {notice ? <p className="mt-2 text-xs text-[var(--survey-primary)]">{notice}</p> : null}
        {task ? (
          <>
            <div className="mt-3 rounded-lg bg-[var(--survey-bg)] p-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-[var(--survey-heading)]">{task.title}</h4>
                <span className="shrink-0 rounded-full bg-[var(--survey-primary-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--survey-primary)]">
                  {run.boosted ? `×2 · ${task.score * 2} 分` : `+${task.score} 分`}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-[var(--survey-body)]">
                {task.description}
              </p>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void act("complete")}
                className="flex-1 rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-2.5 text-sm font-bold text-[var(--survey-primary-content)] disabled:opacity-50"
              >
                {busy ? "处理中…" : `完成 · +${run.boosted ? task.score * 2 : task.score} 分`}
              </button>
              {!run.boosted && run.inventory.boosters > 0 ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act("boost")}
                  className="rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] px-3 py-2.5 text-sm font-semibold text-[var(--survey-body)] disabled:opacity-50"
                  title="本层完成后积分 ×2"
                >
                  <Zap className="h-4 w-4 text-[var(--survey-primary)]" aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={busy || run.inventory.skipTickets <= 0}
                onClick={() => void act("skip")}
                className="flex-1 rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] py-2 text-xs font-semibold text-[var(--survey-body)] disabled:opacity-40"
              >
                跳过本层 ×{run.inventory.skipTickets}
              </button>
              {run.inventory.shields > 0 ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act("shield_exit")}
                  className="flex-1 rounded-[var(--survey-button-radius)] border border-emerald-200 py-2 text-xs font-semibold text-emerald-600 disabled:opacity-40 dark:border-emerald-900 dark:text-emerald-400"
                >
                  护盾结算
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="mt-3 text-center text-sm text-[var(--survey-muted)]">正在抽取本层任务…</p>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void act("abandon")}
          className="mt-2 w-full py-1.5 text-center text-xs font-medium text-red-400 disabled:opacity-50"
        >
          放弃挑战并结算
        </button>
        {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
      </div>
    );
  }

  if (phase === "done" && settlement) {
    return (
      <div className="mt-4 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4 text-center">
        <span
          className={`inline-grid h-14 w-14 place-items-center rounded-full text-2xl font-black text-white ${
            settlement.grade === "S"
              ? "bg-gradient-to-br from-amber-300 to-yellow-600"
              : "bg-gradient-to-br from-sky-300 to-indigo-600"
          }`}
        >
          {settlement.grade}
        </span>
        <p className="mt-2 text-base font-black text-[var(--survey-heading)]">{settlement.title}</p>
        <p className="mt-1 text-[13px] leading-6 text-[var(--survey-body)]">{settlement.text}</p>
        {run ? (
          <p className="mt-1 text-xs text-[var(--survey-muted)]">
            积分 {run.score} · 完成 {run.completedTasks} 层
          </p>
        ) : null}
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setRun(null);
            setTask(null);
            setSettlement(null);
            setNotice(null);
            setError(null);
            setPhase("setup");
          }}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-[var(--survey-card-border)] px-4 py-2 text-xs font-semibold text-[var(--survey-body)] disabled:opacity-50"
        >
          <Trophy className="h-3.5 w-3.5 text-[var(--survey-primary)]" aria-hidden="true" />
          重新挑战（以新一局为准）
        </button>
      </div>
    );
  }

  return null;
}
