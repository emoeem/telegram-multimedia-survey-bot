import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Palette, X } from "lucide-react";
import { safeGet, safeSet, safeRemove } from "./storage";
import { safeCopy } from "./clipboard";
import { vibrateSuccess, vibrateFail, vibrateLight, notify, requestNotificationPermission } from "./haptics";
import { useDialogs } from "../components/Dialogs";
import { loadGlobalPreset, saveGlobalPreset, themeBackgroundStyle, themeCssVars, ThemePickerSheet, useResolvedPreset } from "./theme-ui";
import { createTrialShare } from "./plaza-api";
import { BottomNav } from "./BottomNav";
import {
  fetchTrialActiveRun,
  fetchTrialHistory,
  fetchTrialLeaderboard,
  fetchTrialMe,
  fetchTrialPacks,
  confirmTrialShop,
  rerollTrialCoins,
  sendTrialAction,
  startTrialRun,
  TRIAL_SHOP_CONFIG,
  type TrialGrade,
  type TrialGradeCopy,
  type TrialHistoryItem,
  type TrialLeaderboardEntry,
  type TrialMode,
  type TrialPack,
  type TrialPersona,
  type TrialRun,
  type TrialRunStatus,
  type TrialTask,
} from "./trial-api";

const AGREEMENT_KEY = "trialAdultAgreement:v1";

const PERSONA_OPTIONS: { id: TrialPersona; label: string; hint: string }[] = [
  { id: "male", label: "公", hint: "任务按公向文案抽取" },
  { id: "female", label: "母", hint: "任务按母向文案抽取" },
];

const MODE_OPTIONS: { id: TrialMode; label: string; hint: string }[] = [
  { id: "normal", label: "普通", hint: "标准楼层，按部就班" },
  { id: "hell", label: "地狱", hint: "更多楼层，混入惩罚任务" },
];

const GRADE_STYLE: Record<TrialGrade, { ring: string; badge: string }> = {
  S: {
    ring: "from-amber-300 to-yellow-600",
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  },
  A: {
    ring: "from-emerald-300 to-teal-600",
    badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  B: {
    ring: "from-sky-300 to-indigo-600",
    badge: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  },
  C: {
    ring: "from-slate-300 to-slate-500",
    badge: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  },
};

type HomeTab = "home" | "runs" | "board";
type Screen = "gate" | "home" | "shop" | "run" | "done";

const SHOP_PRICES: Record<string, number> = Object.fromEntries(
  TRIAL_SHOP_CONFIG.items.map((item) => [item.kind, item.price]),
);

function closeTrialPage(): void {
  if (window.Telegram?.WebApp?.close) {
    window.Telegram.WebApp.close();
    return;
  }
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  // Standalone tab (deep link / browser preview): go back to the survey hub.
  window.location.replace("/s");
}

function formatDayTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isNaN(date.getTime())) {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return iso.slice(0, 16).replace("T", " ");
}

function statusLabel(status: TrialRunStatus): string {
  if (status === "completed") return "已通关";
  if (status === "abandoned") return "已放弃";
  return "进行中";
}

function personaLabel(persona: TrialPersona): string {
  return persona === "male" ? "公" : "母";
}

function modeLabel(mode: TrialMode): string {
  return mode === "hell" ? "地狱" : "普通";
}

export function TrialScreen() {
  const [screen, setScreen] = useState<Screen>(() => (safeGet(AGREEMENT_KEY) === "1" ? "home" : "gate"));
  const [activeTab, setActiveTab] = useState<HomeTab>("home");
  const [packs, setPacks] = useState<TrialPack[] | null>(null);
  const [packsError, setPacksError] = useState<string | null>(null);
  const [persona, setPersona] = useState<TrialPersona | null>(null);
  const [mode, setMode] = useState<TrialMode>("normal");
  const [packId, setPackId] = useState<number | null>(null);
  const [startFloor, setStartFloor] = useState("1");
  const [starting, setStarting] = useState(false);
  const [shopQty, setShopQty] = useState({ skipTickets: 0, boosters: 0, shields: 0 });
  const [shopBusy, setShopBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [activeRun, setActiveRun] = useState<TrialRun | null>(null);
  const [activeTask, setActiveTask] = useState<TrialTask | null>(null);
  const [activeLoading, setActiveLoading] = useState(true);
  const [busyActive, setBusyActive] = useState(false);

  const [run, setRun] = useState<TrialRun | null>(null);
  const [task, setTask] = useState<TrialTask | null>(null);
  const [acting, setActing] = useState(false);
  const [earnedFlash, setEarnedFlash] = useState<string | null>(null);

  const [settlement, setSettlement] = useState<{
    grade: TrialGrade;
    copy: TrialGradeCopy;
    run: TrialRun;
  } | null>(null);
  const lastConfigRef = useRef<{ packId: number; persona: TrialPersona; mode: TrialMode; startFloor: number } | null>(
    null,
  );

  const [history, setHistory] = useState<TrialHistoryItem[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [boardPackId, setBoardPackId] = useState<number | null>(null);
  const [boardMode, setBoardMode] = useState<TrialMode>("normal");
  const [boardEntries, setBoardEntries] = useState<TrialLeaderboardEntry[] | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [sharedPostId, setSharedPostId] = useState<number | null>(null);
  const [themePreset, setThemePreset] = useState<string | null>(() => loadGlobalPreset());
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [me, setMe] = useState<{ telegram: boolean; isAdmin: boolean } | null>(null);
  const [warningAckId, setWarningAckId] = useState<number | null>(null);

  const { confirm, toast } = useDialogs();

  const resolvedPreset = useResolvedPreset(themePreset);
  const themeVars = useMemo(() => {
    const theme = resolvedPreset ? { preset: resolvedPreset } : null;
    return { vars: themeCssVars(theme), background: themeBackgroundStyle(theme) };
  }, [resolvedPreset]);

  useEffect(() => {
    let cancelled = false;
    void fetchTrialMe()
      .then((me) => {
        if (!cancelled) setMe(me);
      })
      .catch(() => {
        // Role info is non-critical: hide management shortcuts on failure.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setWarningAckId(null);
  }, [task?.id]);

  const selectTheme = (preset: string | null) => {
    setThemePreset(preset);
    saveGlobalPreset(preset);
  };

  const refreshHome = useCallback(async () => {
    setActiveLoading(true);
    try {
      const response = await fetchTrialActiveRun();
      setActiveRun(response.run);
      setActiveTask(response.task);
    } catch {
      setActiveRun(null);
      setActiveTask(null);
    } finally {
      setActiveLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchTrialPacks();
        if (cancelled) return;
        setPacks(response.packs);
        if (response.packs.length > 0) {
          setPackId((current) => current ?? response.packs[0]?.id ?? null);
        }
      } catch (error) {
        if (!cancelled) setPacksError(error instanceof Error ? error.message : "任务包加载失败");
      }
    })();
    void refreshHome();
    return () => {
      cancelled = true;
    };
  }, [refreshHome]);

  const selectedPack = packs?.find((pack) => pack.id === packId) ?? null;
  const floorCount = selectedPack ? (mode === "hell" ? selectedPack.hellFloors : selectedPack.normalFloors) : 0;
  const floorOptions = Array.from({ length: floorCount }, (_, index) => index + 1);
  const normalizedStartFloor = Math.min(Math.max(Number(startFloor) || 1, 1), Math.max(floorCount, 1));

  const agree = () => {
    safeSet(AGREEMENT_KEY, "1");
    setScreen("home");
  };

  const goHome = useCallback(() => {
    setScreen("home");
    setNotice(null);
    void refreshHome();
  }, [refreshHome]);

  const startGame = async (config?: { packId: number; persona: TrialPersona; mode: TrialMode; startFloor: number }) => {
    const effective = config ?? {
      packId: packId ?? selectedPack?.id ?? 0,
      persona: persona ?? "male",
      mode,
      startFloor: normalizedStartFloor,
    };
    if (!effective.packId) {
      setNotice("请先选择一个任务包");
      return;
    }
    if (!persona && !config) {
      setNotice("请选择你的身份（公 / 母）");
      return;
    }
    setStarting(true);
    setNotice(null);
    void requestNotificationPermission();
    try {
      const response = await startTrialRun({
        packId: effective.packId,
        persona: effective.persona,
        mode: effective.mode,
        startingFloor: effective.startFloor,
      });
      lastConfigRef.current = effective;
      setRun(response.run);
      setTask(response.task);
      setEarnedFlash(null);
      setShopQty({ skipTickets: 0, boosters: 0, shields: 0 });
      setScreen(response.run.phase === "shop" ? "shop" : "run");
    } catch (error) {
      const message = error instanceof Error ? error.message : "开局失败";
      if (message.includes("进行中")) {
        try {
          const active = await fetchTrialActiveRun();
          if (active.run) {
            lastConfigRef.current = {
              packId: active.run.packId,
              persona: active.run.persona,
              mode: active.run.mode,
              startFloor: active.run.startingFloor ?? 1,
            };
            setRun(active.run);
            setTask(active.task);
            setShopQty({ skipTickets: 0, boosters: 0, shields: 0 });
            setScreen(active.run.phase === "shop" ? "shop" : "run");
            return;
          }
        } catch {
          // fall through to the error banner below
        }
      }
      setNotice(message);
    } finally {
      setStarting(false);
    }
  };

  const resumeRun = async () => {
    if (!activeRun) return;
    setBusyActive(true);
    try {
      lastConfigRef.current = {
        packId: activeRun.packId,
        persona: activeRun.persona,
        mode: activeRun.mode,
        startFloor: activeRun.startingFloor ?? 1,
      };
      setRun(activeRun);
      setTask(activeTask);
      setShopQty({ skipTickets: 0, boosters: 0, shields: 0 });
      setScreen(activeRun.phase === "shop" ? "shop" : "run");
    } finally {
      setBusyActive(false);
    }
  };

  const abandonFromHome = async () => {
    if (!activeRun) return;
    if (!(await confirm({ message: "确定要放弃这一局吗？进度会保留在历史记录里。", variant: "danger" }))) return;
    setBusyActive(true);
    try {
      await sendTrialAction(activeRun.id, "abandon");
      setNotice("已放弃这一局");
      await refreshHome();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusyActive(false);
    }
  };

  const act = async (action: "complete" | "skip" | "abandon" | "boost" | "shield_exit") => {
    if (!run || acting) return;
    if (
      action === "abandon" &&
      !(await confirm({ message: "确定要放弃这一局吗？进度会保留在历史记录里。", variant: "danger" }))
    )
      return;
    if (action === "shield_exit" && !(await confirm({ message: "使用 1 个护盾提前结算本局？将以当前成绩记为通关。" })))
      return;
    setActing(true);
    setNotice(null);
    setEarnedFlash(null);
    try {
      const response = await sendTrialAction(run.id, action);
      if (response.run.status === "completed" && response.grade && response.gradeCopy) {
        vibrateSuccess();
        notify(`挑战完成 · ${response.grade}`, response.gradeCopy.title);
        setSettlement({ grade: response.grade, copy: response.gradeCopy, run: response.run });
        setHistory(null);
        setScreen("done");
      } else if (response.run.status === "abandoned") {
        vibrateFail();
        goHome();
        setNotice("已放弃这一局");
      } else {
        setRun(response.run);
        setTask(response.task);
        if (action === "complete") {
          vibrateSuccess();
          if (response.earned > 0) setEarnedFlash(`本层完成 +${response.earned} 分`);
        } else if (action === "abandon") {
          vibrateFail();
        } else {
          vibrateLight();
        }
        if (action === "boost") setNotice("本层已加倍，完成时积分 ×2");
        if (action === "skip") setNotice(`已使用跳过券（剩余 ${response.run.inventory.skipTickets} 张）`);
      }
    } catch (error) {
      vibrateFail();
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setActing(false);
    }
  };

  const shopTotal = () =>
    shopQty.skipTickets * (SHOP_PRICES.skipTicket ?? 0) +
    shopQty.boosters * (SHOP_PRICES.booster ?? 0) +
    shopQty.shields * (SHOP_PRICES.shield ?? 0);

  const adjustShopQty = (kind: "skipTickets" | "boosters" | "shields", delta: number) => {
    setShopQty((current) => {
      const capKey = kind === "skipTickets" ? "skipTicket" : kind === "boosters" ? "booster" : "shield";
      const cap = TRIAL_SHOP_CONFIG.items.find((item) => item.kind === capKey)?.cap ?? 0;
      const next = Math.min(Math.max(current[kind] + delta, 0), cap);
      const candidate = { ...current, [kind]: next };
      const candidateCost =
        candidate.skipTickets * (SHOP_PRICES.skipTicket ?? 0) +
        candidate.boosters * (SHOP_PRICES.booster ?? 0) +
        candidate.shields * (SHOP_PRICES.shield ?? 0);
      if (run && candidateCost > run.coins) return current;
      return candidate;
    });
  };

  const rerollCoins = async () => {
    if (!run || shopBusy) return;
    setShopBusy(true);
    setNotice(null);
    try {
      const response = await rerollTrialCoins(run.id);
      vibrateLight();
      setRun(response.run);
      setNotice("金币已重摇，重新挑选道具吧");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "重摇失败");
    } finally {
      setShopBusy(false);
    }
  };

  const confirmShop = async () => {
    if (!run || shopBusy) return;
    const total = shopTotal();
    if (total > run.coins) {
      setNotice("金币不够，减少购买或先重摇");
      return;
    }
    setShopBusy(true);
    setNotice(null);
    try {
      const response = await confirmTrialShop(run.id, {
        skipTickets: shopQty.skipTickets,
        boosters: shopQty.boosters,
        shields: shopQty.shields,
      });
      vibrateSuccess();
      setRun(response.run);
      setTask(response.task);
      setEarnedFlash(null);
      setScreen("run");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "出发失败");
    } finally {
      setShopBusy(false);
    }
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await fetchTrialHistory();
      setHistory(response.runs);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "记录加载失败");
    } finally {
      setHistoryLoading(false);
    }
  };

  const loadBoard = async (targetPackId: number, targetMode: TrialMode) => {
    setBoardLoading(true);
    setBoardError(null);
    try {
      const response = await fetchTrialLeaderboard(targetPackId, targetMode);
      setBoardEntries(response.entries);
    } catch (error) {
      setBoardError(error instanceof Error ? error.message : "排行榜加载失败");
    } finally {
      setBoardLoading(false);
    }
  };

  const changeTab = (tab: HomeTab) => {
    setActiveTab(tab);
    if (tab === "runs" && history === null) void loadHistory();
    if (tab === "board") {
      const targetPackId = boardPackId ?? packId ?? packs?.[0]?.id ?? null;
      if (targetPackId) {
        setBoardPackId(targetPackId);
        if (boardEntries === null) void loadBoard(targetPackId, boardMode);
      }
    }
  };

  const changeBoardPack = (nextPackId: number) => {
    setBoardPackId(nextPackId);
    setBoardEntries(null);
    void loadBoard(nextPackId, boardMode);
  };

  const changeBoardMode = (nextMode: TrialMode) => {
    setBoardMode(nextMode);
    setBoardEntries(null);
    if (boardPackId) void loadBoard(boardPackId, nextMode);
  };

  const choosePersona = (value: TrialPersona) => {
    setPersona(value);
    setNotice(null);
  };

  const chooseMode = (value: TrialMode) => {
    setMode(value);
    setStartFloor("1");
    setNotice(null);
  };

  const choosePack = (value: number) => {
    setPackId(value);
    setStartFloor("1");
    setNotice(null);
  };

  const copySummary = async () => {
    if (!settlement) return;
    const { grade, copy, run: finishedRun } = settlement;
    const text = [
      `【挑战任务 · ${finishedRun.packName}】`,
      `结局评级：${grade} · ${copy.title}`,
      copy.text,
      `完成 ${finishedRun.completedTasks} 层 · 积分 ${finishedRun.score} · ${modeLabel(finishedRun.mode)} · ${personaLabel(finishedRun.persona)}`,
      "",
      "网页挑战任务 · 虚构角色扮演",
    ].join("\n");
    try {
      const ok = await safeCopy(text);
      if (!ok) {
        setNotice("复制失败，请手动截图分享");
        return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setNotice("复制失败，请手动截图分享");
    }
  };

  const shareToTreehole = async (finishedRun: TrialRun) => {
    if (shareBusy) return;
    setShareBusy(true);
    setNotice(null);
    try {
      const response = await createTrialShare(finishedRun.id);
      setSharedPostId(response.post.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "晒进度失败");
    } finally {
      setShareBusy(false);
    }
  };

  const renderHeader = (title: string, subtitle: string, showBack: boolean) => (
    <header className="sticky top-0 z-10 border-b border-[var(--survey-card-border)] bg-[var(--survey-header-bg)] backdrop-blur-md">
      <div className="mx-auto flex max-w-xl items-center justify-between gap-2 px-5 py-3 lg:max-w-2xl">
        <div className="flex min-w-0 items-center gap-2">
          {showBack ? (
            <button type="button" aria-label="返回" className="survey-icon-btn h-8 w-8 shrink-0" onClick={goHome}>
              <ArrowLeft className="h-4 w-4" />
            </button>
          ) : null}
          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold text-[var(--survey-heading)]">{title}</p>
            <p className="truncate text-[11px] text-[var(--survey-muted)]">{subtitle}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-label="选择主题"
            title="选择主题"
            className="survey-icon-btn"
            onClick={() => setThemePickerOpen(true)}
          >
            <Palette className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="退出挑战"
            title="退出挑战"
            className="survey-icon-btn"
            onClick={closeTrialPage}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );

  const renderTabs = () => (
    <div className="mx-auto max-w-xl px-5 lg:max-w-2xl">
      <div className="flex gap-1.5 overflow-x-auto border-b border-[var(--survey-card-border)] py-2.5">
        {(
          [
            { id: "home", label: "🏠 开局" },
            { id: "runs", label: "📜 我的记录" },
            { id: "board", label: "🏆 排行榜" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => changeTab(tab.id)}
            className={`rounded-full px-4 py-1.5 text-[13px] font-semibold transition-colors ${
              activeTab === tab.id
                ? "bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                : "text-[var(--survey-muted)] hover:bg-[var(--survey-primary-soft)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );

  const renderGate = () => (
    <div className="grid min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-md overflow-hidden rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] shadow-xl">
        <div className="bg-gradient-to-br from-[color-mix(in_srgb,var(--survey-primary)_25%,transparent)] to-[var(--survey-bg)] px-6 py-8 text-center">
          <p className="text-5xl">🏮</p>
          <h1 className="mt-3 text-center text-2xl font-black tracking-tight text-[var(--survey-heading)]">挑战任务</h1>
          <p className="mt-1 text-center text-sm text-[var(--survey-muted)]">文字扮演 · 逐层上行 · 每层一个任务</p>
        </div>
        <div className="p-6">
          <div className="rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-bg)] p-4 text-[13px] leading-6 text-[var(--survey-body)]">
            <p>
              ⚠️ 本页面为 <b>18+ 成人向</b>虚构文字任务游戏，含羞耻与服从主题内容。
            </p>
            <p className="mt-1">全部场景均为想象中的虚拟情境，请遵守当地法律，切勿在现实公共场所实施任何内容。</p>
          </div>
          <button
            type="button"
            onClick={agree}
            className="mt-6 w-full rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-3 text-sm font-bold text-[var(--survey-primary-content)] shadow-lg shadow-[color-mix(in_srgb,var(--survey-primary)_35%,transparent)] transition-transform hover:scale-[1.01] active:scale-[0.99]"
          >
            我已年满 18 周岁，同意进入
          </button>
          <button
            type="button"
            onClick={closeTrialPage}
            className="mt-2 w-full rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] py-2.5 text-sm font-medium text-[var(--survey-muted)]"
          >
            离开
          </button>
        </div>
      </div>
    </div>
  );

  const renderHomeContent = () => (
    <main className="mx-auto max-w-xl space-y-4 px-5 py-5 lg:max-w-2xl">
      {me?.isAdmin ? (
        <section className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-[var(--survey-heading)]">⚙️ 管理员快捷入口</p>
              <p className="mt-0.5 text-[11px] text-[var(--survey-muted)]">
                在这里手动编写任务包与任务文案，保存后玩家端实时生效
              </p>
            </div>
            <a
              href="/admin/task-packs"
              className="shrink-0 rounded-full bg-[var(--survey-primary)] px-4 py-2 text-xs font-bold text-[var(--survey-primary-content)]"
            >
              打开任务编辑器
            </a>
          </div>
        </section>
      ) : null}
      {notice ? (
        <div className="rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-primary-soft)] px-4 py-2.5 text-[13px] font-medium text-[var(--survey-primary)]">
          {notice}
        </div>
      ) : null}

      {activeLoading ? (
        <div className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4 text-sm text-[var(--survey-muted)]">
          检查进行中的挑战…
        </div>
      ) : activeRun ? (
        <div className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-bold text-[var(--survey-heading)]">进行中 · {activeRun.packName}</p>
              <p className="mt-0.5 text-xs text-[var(--survey-muted)]">
                {activeRun.phase === "shop"
                  ? "还在开局商店，挑好道具就能出发"
                  : `第 ${activeRun.currentFloor}/${activeRun.maxFloor} 层 · 积分 ${activeRun.score}`}
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
              未完成
            </span>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busyActive}
              onClick={() => void resumeRun()}
              className="flex-1 rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-2 text-sm font-semibold text-[var(--survey-primary-content)] disabled:opacity-50"
            >
              {activeRun.phase === "shop" ? "进入商店" : "继续挑战"}
            </button>
            {activeRun.phase !== "shop" ? (
              <button
                type="button"
                disabled={busyActive}
                onClick={() => void abandonFromHome()}
                className="rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] px-4 py-2 text-sm font-medium text-[var(--survey-muted)] disabled:opacity-50"
              >
                放弃
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <section className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
        <h2 className="text-[15px] font-bold text-[var(--survey-heading)]">开局设置</h2>

        <p className="mt-4 text-xs font-semibold text-[var(--survey-muted)]">身份</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {PERSONA_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => choosePersona(option.id)}
              className={`rounded-xl border p-3 text-left transition-colors ${
                persona === option.id
                  ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)]"
                  : "border-[var(--survey-card-border)]"
              }`}
            >
              <span className="text-base font-bold text-[var(--survey-heading)]">{option.label}</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-[var(--survey-muted)]">{option.hint}</span>
            </button>
          ))}
        </div>

        <p className="mt-4 text-xs font-semibold text-[var(--survey-muted)]">模式</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {MODE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => chooseMode(option.id)}
              className={`rounded-xl border p-3 text-left transition-colors ${
                mode === option.id
                  ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)]"
                  : "border-[var(--survey-card-border)]"
              }`}
            >
              <span className="text-base font-bold text-[var(--survey-heading)]">{option.label}</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-[var(--survey-muted)]">{option.hint}</span>
            </button>
          ))}
        </div>

        <p className="mt-4 text-xs font-semibold text-[var(--survey-muted)]">任务包</p>
        {packsError ? <p className="mt-2 text-xs text-red-500">{packsError}</p> : null}
        {packs === null ? (
          <div className="mt-2 space-y-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="animate-pulse rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-3"
              >
                <div className="h-4 w-28 rounded bg-[var(--survey-card-border)]" />
                <div className="mt-2 h-3 w-2/3 rounded bg-[var(--survey-card-border)]" />
              </div>
            ))}
          </div>
        ) : packs.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--survey-muted)]">暂无可用任务包，请联系管理员。</p>
        ) : (
          <div className="mt-2 space-y-2">
            {packs.map((pack) => (
              <button
                key={pack.id}
                type="button"
                onClick={() => choosePack(pack.id)}
                className={`block w-full rounded-xl border p-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-md ${
                  packId === pack.id
                    ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)] shadow-sm"
                    : "border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-bold text-[var(--survey-heading)]">{pack.name}</span>
                  <span className="shrink-0 rounded-full bg-[var(--survey-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--survey-muted)]">
                    {pack.normalFloors}/{pack.hellFloors} 层
                  </span>
                </div>
                <span className="mt-1 block text-xs leading-5 text-[var(--survey-muted)]">
                  {pack.description ?? "（暂无描述）"}
                </span>
              </button>
            ))}
          </div>
        )}

        {selectedPack ? (
          <>
            <p className="mt-4 text-xs font-semibold text-[var(--survey-muted)]">起始层（1–{floorCount}）</p>
            <select
              value={String(normalizedStartFloor)}
              onChange={(event) => setStartFloor(event.target.value)}
              className="select mt-2 w-full border-[var(--survey-card-border)] text-sm"
            >
              {floorOptions.map((floor) => (
                <option key={floor} value={floor}>
                  第 {floor} 层开始
                </option>
              ))}
            </select>
            {selectedPack.prepItems.length > 0 || selectedPack.prepText ? (
              <div className="mt-4 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-3 text-left">
                <p className="text-xs font-bold text-[var(--survey-heading)]">🧳 开始前请准备好</p>
                {selectedPack.prepText ? (
                  <p className="mt-1 text-[11px] leading-5 text-[var(--survey-muted)]">{selectedPack.prepText}</p>
                ) : null}
                {selectedPack.prepItems.length > 0 ? (
                  <ul className="mt-2 space-y-1.5">
                    {selectedPack.prepItems.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-xs text-[var(--survey-body)]">
                        <span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border border-[var(--survey-card-border)]" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        <button
          type="button"
          disabled={starting || packs === null || packs.length === 0 || !persona}
          onClick={() => void startGame()}
          className="mt-5 w-full rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-3 text-sm font-bold text-[var(--survey-primary-content)] shadow-lg shadow-[color-mix(in_srgb,var(--survey-primary)_30%,transparent)] disabled:opacity-40"
        >
          {starting ? "正在开局…" : persona ? `以「${personaLabel(persona)} · ${modeLabel(mode)}」开始` : "先选择身份"}
        </button>
        <p className="mt-2 text-center text-[11px] text-[var(--survey-muted)]">
          开局获得随机金币，可在商店买跳过券 / 加倍券 / 护盾 · 进度自动云端保存
        </p>
      </section>
    </main>
  );

  const renderShop = () => {
    if (!run) return null;
    const coinRange = run.mode === "hell" ? TRIAL_SHOP_CONFIG.hellCoins : TRIAL_SHOP_CONFIG.normalCoins;
    const total = shopTotal();
    const remaining = Math.max(0, run.coins - total);
    return (
      <>
        {renderHeader("开局商店", `${run.packName} · ${personaLabel(run.persona)} · ${modeLabel(run.mode)}`, true)}
        <main className="mx-auto max-w-xl space-y-4 px-5 py-5 lg:max-w-2xl">
          {notice ? (
            <div className="rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-primary-soft)] px-4 py-2.5 text-[13px] font-medium text-[var(--survey-primary)]">
              {notice}
            </div>
          ) : null}

          <section className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-[var(--survey-heading)]">
                  🪙 开局金币 <span className="text-xl font-black text-[var(--survey-primary)]">{run.coins}</span>
                </p>
                <p className="mt-1 text-[11px] leading-4 text-[var(--survey-muted)]">
                  {modeLabel(run.mode)}模式范围 {coinRange[0]}–{coinRange[1]}，可反复重摇
                </p>
              </div>
              <button
                type="button"
                disabled={shopBusy}
                onClick={() => void rerollCoins()}
                className="shrink-0 rounded-full border border-[var(--survey-card-border)] px-4 py-2 text-xs font-semibold text-[var(--survey-body)] disabled:opacity-50"
              >
                {shopBusy ? "重摇中…" : "🎲 重摇金币"}
              </button>
            </div>
          </section>

          <section className="space-y-2.5">
            {TRIAL_SHOP_CONFIG.items.map((item) => {
              const qtyKey =
                item.kind === "skipTicket" ? "skipTickets" : item.kind === "booster" ? "boosters" : "shields";
              const qty = shopQty[qtyKey];
              const price = SHOP_PRICES[item.kind] ?? 0;
              const canAdd = qty < item.cap && (!run || total + price <= run.coins);
              return (
                <article
                  key={item.kind}
                  className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-[var(--survey-heading)]">{item.label}</p>
                      <p className="mt-1 text-xs leading-5 text-[var(--survey-muted)]">{item.description}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-[var(--survey-primary-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--survey-primary)]">
                      {price} 币
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-[11px] text-[var(--survey-muted)]">单局上限 {item.cap}</span>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        aria-label="减少"
                        disabled={shopBusy || qty <= 0}
                        onClick={() => adjustShopQty(qtyKey, -1)}
                        className="h-8 w-8 rounded-full border border-[var(--survey-card-border)] text-base font-bold text-[var(--survey-body)] disabled:opacity-40"
                      >
                        −
                      </button>
                      <span className="w-6 text-center text-base font-black text-[var(--survey-heading)]">{qty}</span>
                      <button
                        type="button"
                        aria-label="增加"
                        disabled={shopBusy || !canAdd}
                        onClick={() => adjustShopQty(qtyKey, 1)}
                        className="h-8 w-8 rounded-full bg-[var(--survey-primary)] text-base font-bold text-[var(--survey-primary-content)] disabled:opacity-40"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </section>

          <section className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-[var(--survey-muted)]">合计</span>
              <span className="font-bold text-[var(--survey-heading)]">{total} 币</span>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-sm">
              <span className="text-[var(--survey-muted)]">购买后剩余</span>
              <span className="font-bold text-[var(--survey-primary)]">{remaining} 币</span>
            </div>
            <button
              type="button"
              disabled={shopBusy}
              onClick={() => void confirmShop()}
              className="mt-4 w-full rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-3 text-sm font-bold text-[var(--survey-primary-content)] disabled:opacity-50"
            >
              {shopBusy ? "出发中…" : total === 0 ? "不买东西，直接出发" : "购买并出发"}
            </button>
            {selectedPack && (selectedPack.prepItems.length > 0 || selectedPack.prepText) ? (
              <p className="mt-3 rounded-lg border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-2.5 text-[11px] leading-5 text-[var(--survey-muted)]">
                🧳 出发前记得按准备清单确认：{selectedPack.prepItems.join("、")}
                {selectedPack.prepText ? `。${selectedPack.prepText}` : ""}
              </p>
            ) : null}
          </section>
        </main>
      </>
    );
  };

  const renderRunsContent = () => (
    <main className="mx-auto max-w-xl px-5 py-5 lg:max-w-2xl">
      {historyLoading && history === null ? (
        <p className="text-sm text-[var(--survey-muted)]">加载中…</p>
      ) : historyError ? (
        <p className="text-sm text-red-500">{historyError}</p>
      ) : history === null ? (
        <button
          type="button"
          onClick={() => void loadHistory()}
          className="text-sm font-medium text-[var(--survey-primary)]"
        >
          加载记录
        </button>
      ) : history.length === 0 ? (
        <div className="rounded-[var(--survey-radius)] border border-dashed border-[var(--survey-card-border)] p-8 text-center text-sm text-[var(--survey-muted)]">
          还没有挑战记录，去开一局吧
        </div>
      ) : (
        <div className="space-y-2">
          {history.map((item) => (
            <article
              key={item.id}
              className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-bold text-[var(--survey-heading)]">{item.packName}</p>
                {item.status === "completed" && item.grade ? (
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-black ${GRADE_STYLE[item.grade].badge}`}
                  >
                    {item.grade} 级
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full bg-[var(--survey-bg)] px-2.5 py-0.5 text-[11px] text-[var(--survey-muted)]">
                    {statusLabel(item.status)}
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-xs leading-5 text-[var(--survey-muted)]">
                {personaLabel(item.persona)} · {modeLabel(item.mode)} · 到达第 {item.maxFloor} 层 · 积分 {item.score} ·{" "}
                {formatDayTime(item.startedAt)}
              </p>
            </article>
          ))}
        </div>
      )}
    </main>
  );

  const renderBoardContent = () => {
    const targetPackId = boardPackId ?? packId ?? packs?.[0]?.id ?? null;
    return (
      <main className="mx-auto max-w-xl space-y-4 px-5 py-5 lg:max-w-2xl">
        <div className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
          <p className="text-xs font-semibold text-[var(--survey-muted)]">任务包</p>
          <select
            value={String(targetPackId ?? "")}
            disabled={packs === null || packs.length === 0}
            onChange={(event) => changeBoardPack(Number(event.target.value))}
            className="select mt-2 w-full border-[var(--survey-card-border)] text-sm"
          >
            {packs?.map((pack) => (
              <option key={pack.id} value={pack.id}>
                {pack.name}
              </option>
            ))}
          </select>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {MODE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => changeBoardMode(option.id)}
                className={`rounded-xl border py-2 text-sm font-semibold ${
                  boardMode === option.id
                    ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]"
                    : "border-[var(--survey-card-border)] text-[var(--survey-muted)]"
                }`}
              >
                {option.label}模式
              </button>
            ))}
          </div>
        </div>

        <p className="mt-1 text-[11px] text-[var(--survey-muted)]">
          仅统计 Telegram 登录玩家的最好成绩，匿名挑战不上榜
        </p>
        {boardLoading && boardEntries === null ? (
          <p className="text-sm text-[var(--survey-muted)]">加载中…</p>
        ) : boardError ? (
          <p className="text-sm text-red-500">{boardError}</p>
        ) : boardEntries === null ? (
          <button
            type="button"
            onClick={() => targetPackId && void loadBoard(targetPackId, boardMode)}
            className="text-sm font-medium text-[var(--survey-primary)]"
          >
            加载排行榜
          </button>
        ) : boardEntries.length === 0 ? (
          <div className="rounded-[var(--survey-radius)] border border-dashed border-[var(--survey-card-border)] p-8 text-center text-sm text-[var(--survey-muted)]">
            该模式下还没有通关记录
          </div>
        ) : (
          <div className="space-y-2">
            {boardEntries.map((entry, index) => (
              <article
                key={entry.runId}
                className={`flex items-center gap-3 rounded-[var(--survey-radius)] border p-3.5 ${
                  entry.mine
                    ? "border-[var(--survey-primary)] bg-[var(--survey-primary-soft)]"
                    : "border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]"
                }`}
              >
                <span className="w-7 shrink-0 text-center text-lg font-black text-[var(--survey-heading)]">
                  {index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-[var(--survey-heading)]">
                    {entry.displayName}
                    {entry.mine ? (
                      <span className="ml-1.5 text-[10px] font-semibold text-[var(--survey-primary)]">（我）</span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-[11px] text-[var(--survey-muted)]">
                    完成 {entry.completedTasks} 层 · {formatDayTime(entry.finishedAt)}
                  </p>
                </div>
                <span className="shrink-0 text-right">
                  <span className="text-lg font-black text-[var(--survey-heading)]">{entry.score}</span>
                  <span className="text-[10px] text-[var(--survey-muted)]"> 分</span>
                </span>
              </article>
            ))}
          </div>
        )}
        <p className="text-center text-[11px] text-[var(--survey-muted)]">
          只展示已完成并结算的挑战 · 匿名玩家仅显示尾号
        </p>
      </main>
    );
  };

  const renderRun = () => {
    if (!run) return null;
    const warningUnacked = Boolean(task?.warning && warningAckId !== task.id);
    const progress = Math.min(100, Math.round(((run.currentFloor - 1) / Math.max(1, run.maxFloor - 1)) * 100));
    return (
      <>
        {renderHeader(run.packName, `${personaLabel(run.persona)} · ${modeLabel(run.mode)}`, true)}
        {warningUnacked && task ? (
          <div className="fixed inset-0 z-40">
            <button
              aria-label="关闭提醒遮罩"
              className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
              onClick={() => {}}
            />
            <div className="absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-amber-300/40 bg-[var(--survey-card-bg)] p-5 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-[0_-16px_50px_-20px_rgba(180,83,9,.45)]">
              <p className="text-center text-3xl">⚠️</p>
              <h2 className="mt-2 text-center text-lg font-black text-[var(--survey-heading)]">开始前请先阅读提醒</h2>
              <p className="mt-1 text-center text-[11px] text-[var(--survey-muted)]">
                第 {run.currentFloor} 层任务「{task.title}」
              </p>
              <div className="mt-4 whitespace-pre-wrap rounded-2xl border border-amber-200/60 bg-amber-50 p-4 text-[13px] leading-6 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                {task.warning}
              </div>
              <button
                type="button"
                onClick={() => setWarningAckId(task.id)}
                className="mt-4 w-full rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-3 text-sm font-bold text-[var(--survey-primary-content)]"
              >
                我已阅读并知晓（虚构扮演，注意安全）
              </button>
            </div>
          </div>
        ) : null}
        <main className="mx-auto max-w-xl space-y-4 px-5 py-5 lg:max-w-2xl">
          {notice ? (
            <div className="rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-primary-soft)] px-4 py-2.5 text-[13px] font-medium text-[var(--survey-primary)]">
              {notice}
            </div>
          ) : null}
          {earnedFlash ? (
            <div className="rounded-xl bg-emerald-100 px-4 py-2.5 text-center text-[13px] font-bold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
              {earnedFlash} · 已到第 {run.currentFloor} 层
            </div>
          ) : null}

          <section className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
            <div className="flex items-center justify-between text-xs font-medium text-[var(--survey-muted)]">
              <span>楼层进度</span>
              <span>
                第 {run.currentFloor} / {run.maxFloor} 层
              </span>
            </div>
            <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-[var(--survey-bg)]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[var(--survey-primary)] to-[var(--survey-secondary)] transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-[var(--survey-muted)]">
              <span>
                积分 <b className="text-base font-black text-[var(--survey-heading)]">{run.score}</b>
              </span>
              <span className="flex items-center gap-2 text-[var(--survey-heading)]">
                <span title="跳过券">🎫{run.inventory.skipTickets}</span>
                <span title="加倍券">⚡{run.inventory.boosters}</span>
                <span title="护盾">🛡{run.inventory.shields}</span>
              </span>
            </div>
          </section>

          {task ? (
            <section className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold tracking-wide text-[var(--survey-muted)]">
                  第 {run.currentFloor} 层任务
                </p>
                <span className="shrink-0 rounded-full bg-[var(--survey-primary-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--survey-primary)]">
                  {run.boosted ? `×2 · ${task.score * 2} 分` : `+${task.score} 分`}
                </span>
              </div>
              <h2 className="mt-2 text-xl font-black leading-7 text-[var(--survey-heading)]">
                {run.boosted ? "⚡ " : ""}
                {task.title}
              </h2>
              <p className="mt-3 whitespace-pre-wrap text-[15px] leading-7 text-[var(--survey-body)]">
                {task.description}
              </p>
            </section>
          ) : (
            <section className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-5 text-center text-sm text-[var(--survey-muted)]">
              正在抽取本层任务…
            </section>
          )}

          <section className="space-y-2">
            <div className="flex gap-2">
              <button
                type="button"
                disabled={acting || !task}
                onClick={() => void act("complete")}
                className="flex-1 rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-3.5 text-sm font-bold text-[var(--survey-primary-content)] shadow-lg shadow-[color-mix(in_srgb,var(--survey-primary)_30%,transparent)] disabled:opacity-50"
              >
                {acting ? "处理中…" : task ? `完成 · +${run.boosted ? task.score * 2 : task.score} 分` : "完成"}
              </button>
              {!run.boosted && run.inventory.boosters > 0 && task ? (
                <button
                  type="button"
                  disabled={acting}
                  onClick={() => void act("boost")}
                  className="shrink-0 rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] px-4 py-3.5 text-sm font-semibold text-[var(--survey-body)] disabled:opacity-50"
                  title="本层完成后积分 ×2"
                >
                  ⚡ 加倍
                </button>
              ) : null}
            </div>
            <button
              type="button"
              disabled={acting || !task || run.inventory.skipTickets <= 0}
              onClick={() => void act("skip")}
              className="w-full rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] py-2.5 text-sm font-semibold text-[var(--survey-body)] disabled:opacity-40"
              title={run.inventory.skipTickets <= 0 ? "商店里买跳过券后可用" : "跳过本层，不拿积分"}
            >
              {run.inventory.skipTickets > 0 ? `🎫 跳过本层 ×${run.inventory.skipTickets}` : "没有跳过券"}
            </button>
            {run.inventory.shields > 0 ? (
              <button
                type="button"
                disabled={acting}
                onClick={() => void act("shield_exit")}
                className="w-full rounded-[var(--survey-button-radius)] border border-emerald-200 py-2.5 text-[13px] font-semibold text-emerald-600 dark:border-emerald-900 dark:text-emerald-400"
              >
                🛡 用护盾提前结算（保留成绩）
              </button>
            ) : null}
          </section>
          <button
            type="button"
            disabled={acting}
            onClick={() => void act("abandon")}
            className="w-full rounded-[var(--survey-button-radius)] py-2 text-center text-[13px] font-medium text-red-400 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950/30"
          >
            放弃挑战并结算
          </button>
        </main>
      </>
    );
  };

  const renderDone = () => {
    if (!settlement) return null;
    const { grade, copy, run: finishedRun } = settlement;
    const style = GRADE_STYLE[grade];
    return (
      <>
        {renderHeader("挑战完成", finishedRun.packName, true)}
        <main className="mx-auto max-w-xl px-5 py-8 text-center lg:max-w-2xl">
          {notice ? (
            <div className="mb-5 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-primary-soft)] px-4 py-2.5 text-[13px] font-medium text-[var(--survey-primary)]">
              {notice}
            </div>
          ) : null}
          <div
            className={`mx-auto grid h-24 w-24 place-items-center rounded-full bg-gradient-to-br text-white shadow-xl ${style.ring}`}
          >
            <span className="text-5xl font-black tracking-tight">{grade}</span>
          </div>
          <h1 className="mt-5 text-2xl font-black text-[var(--survey-heading)]">{copy.title}</h1>
          <p className="mx-auto mt-3 max-w-md text-[15px] leading-7 text-[var(--survey-body)]">{copy.text}</p>

          <div className="mx-auto mt-6 grid max-w-md grid-cols-3 gap-2">
            <div className="rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-3">
              <p className="text-lg font-black text-[var(--survey-heading)]">{finishedRun.completedTasks}</p>
              <p className="text-[11px] text-[var(--survey-muted)]">完成层数</p>
            </div>
            <div className="rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-3">
              <p className="text-lg font-black text-[var(--survey-heading)]">{finishedRun.score}</p>
              <p className="text-[11px] text-[var(--survey-muted)]">积分</p>
            </div>
            <div className="rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-3">
              <p className="text-lg font-black text-[var(--survey-heading)]">{modeLabel(finishedRun.mode)}</p>
              <p className="text-[11px] text-[var(--survey-muted)]">模式</p>
            </div>
          </div>

          <div className="mx-auto mt-6 flex max-w-md flex-col gap-2">
            <button
              type="button"
              disabled={shareBusy}
              onClick={() => void shareToTreehole(finishedRun)}
              className={
                sharedPostId
                  ? "rounded-[var(--survey-button-radius)] border border-emerald-200 bg-emerald-50 py-2.5 text-sm font-semibold text-emerald-600 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400"
                  : "rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-2.5 text-sm font-bold text-[var(--survey-primary-content)] disabled:opacity-60"
              }
            >
              {shareBusy
                ? "发布中…"
                : sharedPostId
                  ? `已匿名晒到树洞 ✅ #${sharedPostId}`
                  : "📢 匿名晒进度到树洞（自动同步频道）"}
            </button>
            {sharedPostId ? (
              <a
                href="/plaza?tab=treehole"
                className="rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] py-2.5 text-center text-sm font-semibold text-[var(--survey-body)]"
              >
                去树洞广场看看
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => void copySummary()}
              className="rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] py-2.5 text-sm font-semibold text-[var(--survey-body)]"
            >
              {copied ? "已复制 ✓" : "复制结局文字"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPackId(finishedRun.packId);
                setBoardPackId(finishedRun.packId);
                setBoardMode(finishedRun.mode);
                setBoardEntries(null);
                setScreen("home");
                setActiveTab("board");
                void loadBoard(finishedRun.packId, finishedRun.mode);
              }}
              className="rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] py-2.5 text-sm font-semibold text-[var(--survey-body)]"
            >
              🏆 看看这个任务包的排行榜
            </button>
            <button
              type="button"
              disabled={starting}
              onClick={() => {
                if (lastConfigRef.current) void startGame(lastConfigRef.current);
              }}
              className="rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-3 text-sm font-bold text-[var(--survey-primary-content)] disabled:opacity-60"
            >
              {starting ? "正在开局…" : "再来一局"}
            </button>
            <button
              type="button"
              onClick={() => {
                setHistory(null);
                goHome();
              }}
              className="rounded-[var(--survey-button-radius)] py-2 text-sm font-medium text-[var(--survey-muted)]"
            >
              返回大厅
            </button>
          </div>
          <p className="mt-3 text-[11px] text-[var(--survey-muted)]">
            晒进度需从 Telegram 机器人打开；匿名展示，不会带你的昵称。
          </p>
        </main>
      </>
    );
  };

  const renderThemePicker = () => (
    <ThemePickerSheet
      open={themePickerOpen}
      onClose={() => setThemePickerOpen(false)}
      selected={themePreset}
      onSelect={selectTheme}
      defaultLabel="默认主题"
    />
  );

  if (screen === "gate") {
    return (
      <div
        className="min-h-dvh"
        data-theme={resolvedPreset ?? undefined}
        style={{ ...themeVars.vars, ...themeVars.background }}
      >
        {renderGate()}
        {renderThemePicker()}
      </div>
    );
  }

  if (screen === "run") {
    return (
      <div
        className="min-h-dvh"
        data-theme={resolvedPreset ?? undefined}
        style={{ ...themeVars.vars, ...themeVars.background }}
      >
        {renderRun()}
        {renderThemePicker()}
      </div>
    );
  }

  if (screen === "shop") {
    return (
      <div
        className="min-h-dvh"
        data-theme={resolvedPreset ?? undefined}
        style={{ ...themeVars.vars, ...themeVars.background }}
      >
        {renderShop()}
        {renderThemePicker()}
      </div>
    );
  }

  if (screen === "done") {
    return (
      <div
        className="min-h-dvh"
        data-theme={resolvedPreset ?? undefined}
        style={{ ...themeVars.vars, ...themeVars.background }}
      >
        {renderDone()}
        {renderThemePicker()}
      </div>
    );
  }

  return (
    <div
      className="min-h-dvh pb-24"
      data-theme={resolvedPreset ?? undefined}
      style={{ ...themeVars.vars, ...themeVars.background }}
    >
      {renderHeader("🌆 挑战任务", "选一个任务包，从第一层开始往上爬", false)}
      {renderTabs()}
      {activeTab === "home" ? renderHomeContent() : activeTab === "runs" ? renderRunsContent() : renderBoardContent()}
      {renderThemePicker()}
      <BottomNav />
    </div>
  );
}
