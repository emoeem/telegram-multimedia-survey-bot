import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  Coins as CoinsIcon,
  CornerDownLeft,
  Flag,
  Gift,
  History,
  Images,
  Loader2,
  MailCheck,
  Music,
  RefreshCw,
  ScrollText,
  Sparkles,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { BottomNav } from "./BottomNav";
import { closeWebApp } from "./navigation";
import {
  drawNote as drawNoteApi,
  fetchNoteMe,
  reportNote as reportNoteApi,
  NoteApiError,
  type NoteCardDto,
} from "./note-api";
import { makeThumbnailFile, prepareImageForPublish } from "../lib/image-publish";
import {
  coinApi,
  coinUnlockKey,
  type CoinChallengeDto,
  type CoinOverview,
  type CoinTransactionDto,
  type GachaCollectionItem,
  type GachaPoolDetail,
  type GachaPoolDto,
  type GachaPullResult,
  type SubmissionDto,
} from "./api";

/**
 * 金币经济 · 用户侧三屏（/coins、/gacha、/submissions）。
 *
 * 交互约束（需求 10.x）：所有动画都是纯 CSS 揭示层，业务请求在确认那一刻
 * 就已发出；「跳过动画」只移除视觉层，绝不取消请求、不重复提交。系统开启
 * "减少动态效果"时动画自动禁用（全局 CSS 已处理）。
 */

/** 音频时长探测：仅用于展示与提示；读不出就返回 null，不影响投稿。 */
async function probeAudioDuration(file: File): Promise<number | null> {
  try {
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    const seconds = await new Promise<number | null>((resolve) => {
      const done = (value: number | null) => {
        URL.revokeObjectURL(url);
        resolve(value);
      };
      audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? Math.round(audio.duration) : null);
      audio.onerror = () => done(null);
      window.setTimeout(() => done(null), 5000);
      audio.src = url;
    });
    return seconds;
  } catch {
    return null;
  }
}

function CoinPageShell(props: { title: string; subtitle: string; embedded?: boolean; children: React.ReactNode }) {
  /* embedded = 已经嵌在 /submissions 投稿中心里，外壳（顶栏 / 底部导航 /
   * survey-glow）由投稿中心统一提供。不这样的话页面上会出现两条 header。 */
  if (props.embedded) return <>{props.children}</>;
  return (
    <div className="survey-glow min-h-dvh pb-24">
      <header className="sticky top-0 z-10 border-b border-[var(--survey-card-border)] bg-[var(--survey-header-bg)] backdrop-blur-md">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-2 px-5 py-3 lg:max-w-3xl">
          <div>
            <p className="text-[15px] font-bold text-[var(--survey-heading)]">{props.title}</p>
            <p className="mt-0.5 text-[11px] text-[var(--survey-muted)]">{props.subtitle}</p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            title="关闭"
            className="survey-icon-btn"
            onClick={() => closeWebApp()}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-xl space-y-4 px-5 py-5 lg:max-w-3xl">{props.children}</main>
      <BottomNav />
    </div>
  );
}

function Loading() {
  return <p className="py-16 text-center text-sm text-[var(--survey-muted)]">加载中…</p>;
}

function ErrorBox(props: { message: string }) {
  return (
    <div className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-5 text-center text-sm text-[var(--survey-body)]">
      {props.message}
    </div>
  );
}

const KIND_LABELS: Record<string, string> = {
  checkin: "每日签到",
  challenge: "挑战奖励",
  submission_reward: "投稿奖励",
  survey_unlock: "解锁问卷",
  gacha_pull: "报告抽卡",
  admin_adjust: "平台调整",
};

/** 近 30 天签到日历；补签只在管理员开启时出现（点击漏签日补齐）。 */
function CheckinCalendar({
  days,
  today,
  backfill,
  onBackfilled,
}: {
  days: string[];
  today: string;
  backfill?: { enabled: boolean; cost: number; maxDays: number };
  onBackfilled: () => void;
}) {
  const [busyDay, setBusyDay] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const signed = new Set(days);
  const cells: Array<{ day: string; signed: boolean; backfillable: boolean }> = [];
  for (let offset = 29; offset >= 0; offset -= 1) {
    const day = new Date(Date.parse(today + "T00:00:00Z") - offset * 86_400_000).toISOString().slice(0, 10);
    const eligible =
      Boolean(backfill?.enabled) &&
      day < today &&
      Date.parse(today + "T00:00:00Z") - Date.parse(day + "T00:00:00Z") <= (backfill?.maxDays ?? 0) * 86_400_000;
    cells.push({ day, signed: signed.has(day), backfillable: eligible && !signed.has(day) });
  }

  const backfillDay = async (day: string) => {
    setBusyDay(day);
    setError(null);
    try {
      await coinApi.backfillCheckin(day);
      setDone(day);
      onBackfilled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "补签失败");
    } finally {
      setBusyDay(null);
    }
  };

  return (
    <section className="coin-card">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--survey-muted)]">近 30 天签到</p>
      <div className="coin-calendar">
        {cells.map((cell) => (
          <button
            key={cell.day}
            type="button"
            className={`coin-calendar-cell ${cell.signed ? "is-signed" : ""} ${cell.backfillable ? "is-backfillable" : ""}`}
            title={
              cell.signed
                ? `${cell.day} 已签到`
                : cell.backfillable
                  ? `${cell.day} 漏签，点击补签（${backfill?.cost ?? 0} 金币）`
                  : `${cell.day} 未签到`
            }
            disabled={!cell.backfillable || busyDay !== null}
            onClick={() => void backfillDay(cell.day)}
          >
            {cell.day.slice(8)}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-[var(--survey-muted)]">
        {backfill?.enabled
          ? `补签开放：点击最近 ${backfill.maxDays} 天内的漏签日补签（每次 ${backfill.cost} 金币）。`
          : "补签未开放。"}
      </p>
      {done ? (
        <p className="coin-claim-flash" role="status">
          已补签 {done} ✓
        </p>
      ) : null}
      {error ? <p className="mt-1 text-[11px] text-rose-500">{error}</p> : null}
    </section>
  );
}

// ---- /coins：余额、签到、挑战、明细 ------------------------------------

export function CoinsScreen() {
  const [overview, setOverview] = useState<CoinOverview | null>(null);
  const [challenges, setChallenges] = useState<CoinChallengeDto[] | null>(null);
  const [transactions, setTransactions] = useState<CoinTransactionDto[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [tab, setTab] = useState<"pocket" | "log">("pocket");
  const [error, setError] = useState<string | null>(null);
  const [checkinBusy, setCheckinBusy] = useState(false);
  const [claimedId, setClaimedId] = useState<number | null>(null);

  const reloadOverview = useCallback(() => {
    coinApi
      .overview()
      .then(setOverview)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "加载失败"));
  }, []);

  useEffect(() => {
    reloadOverview();
    coinApi
      .challenges()
      .then((data) => setChallenges(data.challenges))
      .catch(() => setChallenges([]));
    coinApi
      .transactions(1)
      .then((data) => {
        setTransactions(data.items);
        setHasMore(data.hasMore);
        setPage(1);
      })
      .catch(() => undefined);
  }, [reloadOverview]);

  const doCheckin = async () => {
    setCheckinBusy(true);
    setError(null);
    try {
      await coinApi.checkin();
      reloadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "签到失败");
    } finally {
      setCheckinBusy(false);
    }
  };

  const claim = async (challenge: CoinChallengeDto) => {
    setError(null);
    try {
      const result = await coinApi.claimChallenge(challenge.id);
      setClaimedId(challenge.id);
      setChallenges((prev) =>
        (prev ?? []).map((entry) =>
          entry.id === challenge.id
            ? { ...entry, claimed: true, progress: result.reward > 0 ? entry.progress : entry.progress }
            : entry,
        ),
      );
      reloadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "领取失败");
    }
  };

  const loadMore = async () => {
    const next = page + 1;
    const data = await coinApi.transactions(next);
    setTransactions((prev) => [...prev, ...data.items]);
    setHasMore(data.hasMore);
    setPage(next);
  };

  const checkin = overview?.checkin;

  return (
    <CoinPageShell title="我的金币" subtitle="签到、做任务、赚金币；解锁问卷与抽报告都花在这里">
      {error ? <ErrorBox message={error} /> : null}
      {overview === null ? (
        <Loading />
      ) : (
        <>
          <section className="coin-balance-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[color-mix(in_srgb,var(--survey-primary-content)_72%,transparent)]">
                  当前余额
                </p>
                <p className="mt-1 text-4xl font-black tabular-nums text-[var(--survey-primary-content)]">
                  {overview.balance}
                  <span className="ml-1.5 text-sm font-bold text-[color-mix(in_srgb,var(--survey-primary-content)_85%,transparent)]">
                    金币
                  </span>
                </p>
                <p className="mt-1 text-[11px] text-[color-mix(in_srgb,var(--survey-primary-content)_72%,transparent)]">
                  累计获得 {overview.totalEarned} · 累计消费 {overview.totalSpent}
                </p>
              </div>
              <CoinsIcon
                className="h-14 w-14 text-[color-mix(in_srgb,var(--survey-primary-content)_55%,transparent)]"
                aria-hidden
              />
            </div>
            {overview.features.checkin ? (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-white/10 p-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-[var(--survey-primary-content)]">
                    {checkin?.checkedInToday ? `今日已签到 +${checkin.todayAmount ?? 0}` : "今日未签到"}
                  </p>
                  <p className="mt-0.5 text-[11px] text-[color-mix(in_srgb,var(--survey-primary-content)_72%,transparent)]">
                    连续 {checkin?.streak ?? 0} 天 ·{" "}
                    {checkin
                      ? checkin.checkedInToday
                        ? `明天 +${checkin.nextAmount}`
                        : `今日 +${checkin.nextAmount}`
                      : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className="coin-checkin-btn"
                  disabled={checkinBusy || checkin?.checkedInToday}
                  onClick={() => void doCheckin()}
                >
                  {checkin?.checkedInToday ? "已签到" : checkinBusy ? "…" : "签到"}
                </button>
              </div>
            ) : null}
            <p className="mt-2 text-[10px] leading-4 text-[color-mix(in_srgb,var(--survey-primary-content)_55%,transparent)]">
              今日已获得 {overview.earnedToday}/{overview.dailyRewardCap}（投稿奖励每日上限）·
              金币为站内虚拟积分，不可兑换现金
            </p>
          </section>

          <CheckinCalendar
            days={overview.checkin.days ?? []}
            today={overview.checkin.today}
            {...(overview.checkin.backfill ? { backfill: overview.checkin.backfill } : {})}
            onBackfilled={reloadOverview}
          />

          <div className="flex gap-2" role="tablist" aria-label="金币页面切换">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "pocket"}
              className={`coin-tab ${tab === "pocket" ? "is-active" : ""}`}
              onClick={() => setTab("pocket")}
            >
              <Sparkles className="h-3.5 w-3.5" />
              签到与任务
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "log"}
              className={`coin-tab ${tab === "log" ? "is-active" : ""}`}
              onClick={() => setTab("log")}
            >
              <History className="h-3.5 w-3.5" />
              收支明细
            </button>
          </div>

          {tab === "pocket" ? (
            <section className="space-y-2.5">
              {challenges === null ? (
                <Loading />
              ) : challenges.length === 0 ? (
                <ErrorBox message="暂无进行中的挑战任务" />
              ) : (
                challenges.map((challenge) => (
                  <article key={challenge.id} className="coin-card">
                    <div className="flex items-start gap-3">
                      <span className="coin-challenge-icon" aria-hidden>
                        {challenge.icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 text-sm font-bold text-[var(--survey-heading)]">
                          {challenge.title}
                          <span className="coin-reward-chip">+{challenge.reward}</span>
                        </p>
                        <p className="mt-0.5 text-[11px] leading-4 text-[var(--survey-muted)]">
                          {challenge.description}
                        </p>
                        <div
                          className="coin-progress-track"
                          role="progressbar"
                          aria-valuenow={challenge.progress}
                          aria-valuemin={0}
                          aria-valuemax={challenge.goalTarget}
                        >
                          <div
                            className="coin-progress-bar"
                            style={{
                              width: `${Math.min(100, Math.round((challenge.progress / Math.max(1, challenge.goalTarget)) * 100))}%`,
                            }}
                          />
                        </div>
                        <p className="mt-1 text-[11px] text-[var(--survey-muted)]">
                          {challenge.progress}/{challenge.goalTarget}
                          {challenge.period !== "once" ? ` · ${challenge.period === "daily" ? "每日" : "每周"}` : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="coin-claim-btn"
                        disabled={!challenge.completed || challenge.claimed || !challenge.withinWindow}
                        onClick={() => void claim(challenge)}
                      >
                        {challenge.claimed ? "已领取" : challenge.completed ? "领取" : "未达成"}
                      </button>
                    </div>
                    {claimedId === challenge.id ? (
                      <p className="coin-claim-flash" role="status">
                        奖励已到账 ✓
                      </p>
                    ) : null}
                  </article>
                ))
              )}
              <div className="grid grid-cols-2 gap-2.5">
                <a className="coin-entry" href="/gacha">
                  <Sparkles className="h-5 w-5 text-[var(--survey-primary)]" />
                  <span>报告抽卡</span>
                  <ChevronRight className="h-4 w-4 text-[var(--survey-muted)]" />
                </a>
                <a className="coin-entry" href="/submissions">
                  <Upload className="h-5 w-5 text-[var(--survey-primary)]" />
                  <span>投稿中心</span>
                  <ChevronRight className="h-4 w-4 text-[var(--survey-muted)]" />
                </a>
              </div>
            </section>
          ) : (
            <section className="space-y-2">
              {transactions.length === 0 ? (
                <ErrorBox message="还没有金币收支记录" />
              ) : (
                transactions.map((txn) => (
                  <div key={txn.id} className="coin-txn-row">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-[var(--survey-heading)]">
                        {KIND_LABELS[txn.kind] ?? txn.kind}
                        {txn.note ? (
                          <span className="ml-1.5 font-normal text-[var(--survey-muted)]">{txn.note}</span>
                        ) : null}
                      </p>
                      <p className="text-[11px] text-[var(--survey-muted)]">
                        {txn.createdAt.replace("T", " ").slice(0, 16)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p
                        className={`text-sm font-black ${txn.amount > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500"}`}
                      >
                        {txn.amount > 0 ? "+" : ""}
                        {txn.amount}
                      </p>
                      <p className="text-[10px] text-[var(--survey-muted)]">余 {txn.balanceAfter}</p>
                    </div>
                  </div>
                ))
              )}
              {hasMore ? (
                <button type="button" className="coin-load-more" onClick={() => void loadMore()}>
                  加载更多
                </button>
              ) : null}
            </section>
          )}
        </>
      )}
    </CoinPageShell>
  );
}

// ---- 抽奖中心 · 缘分纸条区（0089 整合）---------------------------------
// 抽纸条与报告抽卡共用「抽奖中心」一个入口：纸条在顶部（每天 3 次免费，
// 之后 5 金币/次，服务端判定），报告奖池在下方。抽中即建会话，去 /notes 回信。

const NOTE_CARD_CLS =
  "rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)]";

function genderLabelOf(id: string): string {
  return id === "m" ? "男生" : id === "f" ? "女生" : "保密";
}

function NoteDrawCard() {
  const [noteMe, setNoteMe] = useState<{
    hasNote: boolean;
    balance: number;
    freeDrawsPerDay: number;
    drawCostCoins: number;
  } | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [hit, setHit] = useState<{
    threadId: number;
    note: NoteCardDto;
    kind: "free" | "coin";
    freeLeft: number;
  } | null>(null);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reported, setReported] = useState(false);

  useEffect(() => {
    void fetchNoteMe()
      .then((data) =>
        setNoteMe({
          hasNote: Boolean(data.note),
          balance: data.balance,
          freeDrawsPerDay: data.freeDrawsPerDay,
          drawCostCoins: data.drawCostCoins,
        }),
      )
      .catch(() => setNoteMe(null));
  }, []);

  const draw = async () => {
    setDrawing(true);
    setError(null);
    setEmpty(false);
    setHit(null);
    setReported(false);
    try {
      const result = await drawNoteApi();
      if (result.empty) {
        setEmpty(true);
      } else {
        setHit({
          threadId: result.threadId ?? 0,
          note: result.note!,
          kind: result.kind ?? "free",
          freeLeft: result.freeLeft ?? 0,
        });
      }
    } catch (err) {
      setError(err instanceof NoteApiError ? err.message : "抽取失败，请重试");
    } finally {
      setDrawing(false);
    }
  };

  return (
    <section className={`${NOTE_CARD_CLS} p-4`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-1.5 text-sm font-bold text-[var(--survey-heading)]">
            <MailCheck className="h-4 w-4 text-[var(--survey-primary)]" aria-hidden="true" />
            缘分纸条
          </p>
          <p className="mt-0.5 text-[11px] leading-4 text-[var(--survey-muted)]">
            {noteMe
              ? `每天前 ${noteMe.freeDrawsPerDay} 次免费，之后 ${noteMe.drawCostCoins} 金币/次 · 余额 ${noteMe.balance} 金币`
              : "抽到同路人的纸条，抽中就能开始私聊"}
          </p>
        </div>
        <a href="/notes" className="shrink-0 text-[11px] font-semibold text-[var(--survey-primary)]">
          我的纸条 →
        </a>
      </div>

      {hit ? (
        <div className="mt-3 rounded-[var(--survey-radius)] border border-[var(--survey-primary)]/40 bg-[var(--survey-primary-soft)] p-3.5">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--survey-primary)] px-2 py-0.5 text-[10px] font-black text-[var(--survey-primary-content)]">
              {hit.kind === "free" ? "免费抽取" : "金币抽取"}
              {hit.freeLeft > 0 ? ` · 今日还可免费抽 ${hit.freeLeft} 次` : ""}
            </span>
            <button type="button" aria-label="收起" className="survey-icon-btn h-7 w-7" onClick={() => setHit(null)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-2.5 flex gap-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--survey-card-bg)] text-xs font-black text-[var(--survey-primary)]">
              {hit.note.gender === "m" ? "他" : hit.note.gender === "f" ? "她" : "?"}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1 text-[11px] text-[var(--survey-muted)]">
                <span>{genderLabelOf(hit.note.gender)}</span>
                <span>·</span>
                <span>{hit.note.ageBand} 岁</span>
                {hit.note.region ? (
                  <>
                    <span>·</span>
                    <span>{hit.note.region}</span>
                  </>
                ) : null}
              </p>
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-5 text-[var(--survey-heading)]">
                {hit.note.content}
              </p>
            </div>
          </div>
          {reported ? (
            <p className="mt-2 text-[11px] text-[var(--survey-muted)]">已收到举报，感谢反馈。</p>
          ) : (
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--survey-muted)] underline"
              onClick={() => {
                void reportNoteApi(hit.note.id, "用户举报").then(() => setReported(true));
              }}
            >
              <Flag className="h-3 w-3" aria-hidden="true" />
              举报这张纸条
            </button>
          )}
          <div className="mt-3 flex gap-2">
            <a
              href={`/notes?thread=${hit.threadId}&tab=chat`}
              className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] px-3 py-2 text-[13px] font-bold text-[var(--survey-primary-content)]"
            >
              <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
              去回信
            </a>
            <button
              type="button"
              className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] px-3 py-2 text-[13px] font-semibold text-[var(--survey-body)] disabled:opacity-50"
              disabled={drawing}
              onClick={() => void draw()}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              再抽一张
            </button>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="coin-pull-btn mt-3 w-full"
            disabled={drawing || (noteMe !== null && !noteMe.hasNote)}
            onClick={() => void draw()}
          >
            {drawing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                抽取中…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                {noteMe !== null && !noteMe.hasNote ? "先放一张纸条才能抽" : "抽一张纸条"}
              </>
            )}
          </button>
          {empty ? (
            <p className="mt-2 text-center text-[11px] text-[var(--survey-muted)]">
              池子里的纸条都被你聊过啦，晚点再来看看。
            </p>
          ) : null}
          {error ? <p className="mt-2 text-center text-[11px] text-[var(--app-danger)]">{error}</p> : null}
          {noteMe !== null && !noteMe.hasNote ? (
            <p className="mt-2 text-center text-[11px] text-[var(--survey-muted)]">
              先去{" "}
              <a href="/notes" className="font-semibold text-[var(--survey-primary)] underline">
                放一张纸条
              </a>{" "}
              —— 放纸条的人才有回信。
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

// ---- /gacha：奖池、抽取、收藏 -------------------------------------------

const RARITY_STYLES: Record<string, string> = {
  N: "coin-rarity-n",
  R: "coin-rarity-r",
  SR: "coin-rarity-sr",
  SSR: "coin-rarity-ssr",
};

export function GachaScreen() {
  const [pools, setPools] = useState<GachaPoolDto[] | null>(null);
  const [detail, setDetail] = useState<GachaPoolDetail | null>(null);
  const [collection, setCollection] = useState<GachaCollectionItem[] | null>(null);
  const [tab, setTab] = useState<"pools" | "collection">("pools");
  const [pulling, setPulling] = useState(false);
  const [reveal, setReveal] = useState<GachaPullResult | null>(null);
  const [skipReveal, setSkipReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [viewingItem, setViewingItem] = useState<{ title: string; body: string } | null>(null);

  useEffect(() => {
    coinApi
      .pools()
      .then((data) => setPools(data.pools))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "加载失败"));
    coinApi
      .overview()
      .then((data) => setBalance(data.balance))
      .catch(() => undefined);
  }, []);

  const openPool = (slug: string) => {
    coinApi
      .pool(slug)
      .then(setDetail)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "加载失败"));
  };

  const showCollection = () => {
    setTab("collection");
    coinApi
      .collection()
      .then((data) => setCollection(data.items))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "加载失败"));
  };

  const doPull = async (count: number) => {
    if (!detail || pulling) return;
    setPulling(true);
    setError(null);
    setSkipReveal(false);
    try {
      const result = await coinApi.pull(detail.pool.slug, count, coinUnlockKey(Date.now()));
      setReveal(result);
      setBalance(result.balance);
      void coinApi
        .overview()
        .then((data) => setBalance(data.balance))
        .catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "抽取失败");
    } finally {
      setPulling(false);
    }
  };

  const viewItem = async (itemId: number) => {
    try {
      const content = await coinApi.itemContent(itemId);
      setViewingItem({
        title: content.title,
        body:
          content.text ??
          content.summary ??
          (content.reportUrl
            ? `查看报告：${content.reportUrl}`
            : content.mediaUrl
              ? `媒体：${content.mediaUrl}`
              : content.description),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "内容加载失败");
    }
  };

  if (detail) {
    return (
      <CoinPageShell
        title={detail.pool.name}
        subtitle={`单抽 ${detail.pool.costSingle} 金币${detail.pool.costMulti ? ` · ${detail.pool.costMulti} 金币十连` : ""}`}
      >
        {error ? <ErrorBox message={error} /> : null}
        {balance !== null ? <p className="text-xs text-[var(--survey-muted)]">当前余额 {balance} 金币</p> : null}
        <section className="coin-card">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--survey-muted)]">概率公示</p>
          <ul className="mt-2 space-y-1.5">
            {detail.items.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-2 text-[13px] text-[var(--survey-body)]"
              >
                <span className="min-w-0 truncate">
                  <span
                    className={`${RARITY_STYLES[item.rarity] ?? "coin-rarity-n"} mr-1.5 inline-block rounded px-1 text-[10px] font-black`}
                  >
                    {item.rarity}
                  </span>
                  {item.title}
                  {item.soldOut ? <span className="ml-1 text-[10px] text-rose-500">已抽完</span> : null}
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-[var(--survey-muted)]">{item.rate}%</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-4 text-[var(--survey-muted)]">
            {detail.rules.pity ? `${detail.rules.pity}。` : ""}
            {detail.rules.access}。{detail.rules.currency}。
          </p>
        </section>
        <div className="flex gap-2.5">
          <button type="button" className="coin-pull-btn flex-1" disabled={pulling} onClick={() => void doPull(1)}>
            {pulling ? "抽取中…" : `单抽 ${detail.pool.costSingle}`}
          </button>
          {detail.pool.costMulti ? (
            <button
              type="button"
              className="coin-pull-btn coin-pull-multi flex-1"
              disabled={pulling}
              onClick={() => void doPull(10)}
            >
              {pulling ? "抽取中…" : `十连 ${detail.pool.costMulti}`}
            </button>
          ) : null}
        </div>
        <button type="button" className="coin-back-link" onClick={() => setDetail(null)}>
          ← 返回奖池列表
        </button>

        {pulling || reveal ? (
          <div
            className="coin-reveal-layer"
            role="dialog"
            aria-label="抽卡结果"
            data-skipped={skipReveal ? "true" : undefined}
          >
            {!skipReveal ? <div className="coin-reveal-glow" aria-hidden /> : null}
            <div className="coin-reveal-panel">
              {reveal ? (
                <>
                  <p className="text-sm font-bold text-[var(--survey-heading)]">获得 {reveal.results.length} 份内容</p>
                  <ul className="mt-3 space-y-2">
                    {reveal.results.map((entry, index) => (
                      <li
                        key={`${entry.itemId}-${index}`}
                        className={`coin-reveal-card ${RARITY_STYLES[entry.rarity] ?? "coin-rarity-n"}`}
                      >
                        <span className="rounded px-1.5 py-0.5 text-[10px] font-black">{entry.rarity}</span>
                        <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[11px] text-[var(--survey-muted)]">已存入收藏，可随时查看</p>
                </>
              ) : (
                <p className="py-6 text-sm text-[var(--survey-muted)]">抽取中…</p>
              )}
              {reveal ? (
                <div className="mt-3 flex gap-2">
                  <button type="button" className="coin-pull-btn flex-1" onClick={() => setReveal(null)}>
                    收下
                  </button>
                  {!skipReveal ? (
                    <button type="button" className="coin-skip-btn" onClick={() => setSkipReveal(true)}>
                      跳过动画
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </CoinPageShell>
    );
  }

  return (
    <CoinPageShell title="抽奖中心" subtitle="缘分纸条每天前 3 次免费；报告奖池用金币抽取">
      {error ? <ErrorBox message={error} /> : null}
      {balance !== null ? <p className="text-xs text-[var(--survey-muted)]">当前余额 {balance} 金币</p> : null}
      <div className="flex gap-2" role="tablist" aria-label="抽卡页面切换">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "pools"}
          className={`coin-tab ${tab === "pools" ? "is-active" : ""}`}
          onClick={() => setTab("pools")}
        >
          <Sparkles className="h-3.5 w-3.5" />
          奖池
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "collection"}
          className={`coin-tab ${tab === "collection" ? "is-active" : ""}`}
          onClick={() => void showCollection()}
        >
          <UserRound className="h-3.5 w-3.5" />
          我的收藏
        </button>
      </div>

      {tab === "pools" ? (
        <div className="mb-3">
          <NoteDrawCard />
        </div>
      ) : null}

      {tab === "pools" ? (
        pools === null ? (
          <Loading />
        ) : pools.length === 0 ? (
          <ErrorBox message="暂无开放的奖池，欢迎参与投稿" />
        ) : (
          pools.map((pool) => (
            <button
              key={pool.slug}
              type="button"
              className="coin-card w-full text-left"
              onClick={() => openPool(pool.slug)}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[var(--survey-heading)]">{pool.name}</p>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-[var(--survey-muted)]">
                    {pool.description}
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--survey-primary)]">
                    单抽 {pool.costSingle}
                    {pool.costMulti ? ` · 十连 ${pool.costMulti}` : ""}
                    {pool.endAt ? ` · ${pool.endAt.slice(0, 10)} 截止` : ""}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
              </div>
            </button>
          ))
        )
      ) : collection === null ? (
        <Loading />
      ) : collection.length === 0 ? (
        <ErrorBox message="还没有抽到过内容" />
      ) : (
        collection.map((item) => (
          <button
            key={item.pullId}
            type="button"
            className="coin-card w-full text-left"
            onClick={() => void viewItem(item.itemId)}
          >
            <div className="flex items-center gap-3">
              <span
                className={`${RARITY_STYLES[item.rarity] ?? "coin-rarity-n"} rounded px-1.5 py-0.5 text-[10px] font-black`}
              >
                {item.rarity}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-[var(--survey-heading)]">{item.title}</p>
                <p className="text-[11px] text-[var(--survey-muted)]">
                  {item.poolName} · {item.createdAt.slice(0, 10)}
                  {Number(item.isOwn) === 1 ? " · 自己的内容" : ""}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
            </div>
          </button>
        ))
      )}

      {viewingItem ? (
        <div className="coin-reveal-layer" role="dialog" aria-label="内容详情">
          <div className="coin-reveal-panel">
            <p className="text-sm font-bold text-[var(--survey-heading)]">{viewingItem.title}</p>
            <p className="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-[var(--survey-body)]">
              {viewingItem.body}
            </p>
            <button type="button" className="coin-pull-btn mt-3 w-full" onClick={() => setViewingItem(null)}>
              关闭
            </button>
          </div>
        </div>
      ) : null}
    </CoinPageShell>
  );
}

// ---- /submissions：投稿中心 ---------------------------------------------

const SUBMISSION_TYPE_META: Array<{ type: string; label: string; hint: string; icon: typeof ScrollText }> = [
  { type: "text", label: "原创文字", hint: "故事、随笔、小短文", icon: ScrollText },
  { type: "image", label: "图片", hint: "你拥有权利的照片或画作", icon: Images },
  { type: "audio", label: "音频", hint: "你录制的声音内容", icon: Music },
  { type: "survey_report", label: "我的答卷报告", hint: "公开你自己的报告（不含他人数据）", icon: UserRound },
];

const STATUS_LABELS: Record<string, string> = {
  pending: "审核中",
  changes_requested: "需要修改",
  approved: "已通过",
  in_pool: "已进奖池",
  rejected: "已拒绝",
  withdrawn: "已撤回",
  removed: "已下架",
};

export function SubmissionsScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const [mine, setMine] = useState<SubmissionDto[] | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [contentText, setContentText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [responseId, setResponseId] = useState("");
  const [publishToPool, setPublishToPool] = useState(false);
  const [confirmOwn, setConfirmOwn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reload = useCallback(() => {
    coinApi
      .mySubmissions()
      .then((data) => setMine(data.submissions))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "加载失败"));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const submit = async () => {
    if (busy || type === null) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const authorization = { confirmOwn, publishToPool, allowCollection: true };
      if (type === "image" || type === "audio") {
        if (!file) throw new Error("请选择文件");
        // 图片在提交前归一化（最长边 1600 / WebP）；音视频原样上传。
        // 与答卷附件、树洞配图、认证卡共用 admin/src/lib/image-publish.ts。
        const upload = type === "image" ? await prepareImageForPublish(file) : file;
        const form = new FormData();
        form.set("type", type);
        form.set("title", title);
        form.set("description", description);
        form.set("publishToPool", String(publishToPool));
        form.set("confirmOwn", String(confirmOwn));
        form.set("file", upload);
        if (type === "image") {
          // 缩略图在客户端生成；生成失败不阻塞投稿（服务端会退回原图）。
          const thumb = await makeThumbnailFile(upload);
          if (thumb) form.set("thumb", thumb);
        }
        if (type === "audio") {
          const seconds = await probeAudioDuration(file);
          if (seconds !== null) form.set("durationSeconds", String(seconds));
        }
        await coinApi.createSubmissionWithFile(form);
      } else {
        await coinApi.createSubmission({
          type,
          title,
          description: description || null,
          contentText: type === "text" ? contentText : null,
          responseId: type === "survey_report" || type === "profile_card" ? Number(responseId) || null : null,
          authorization,
        });
      }
      setSuccess("投稿已提交，等待审核；通过后奖励自动到账。");
      setTitle("");
      setDescription("");
      setContentText("");
      setFile(null);
      setResponseId("");
      setConfirmOwn(false);
      setPublishToPool(false);
      setType(null);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "投稿失败");
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (id: number) => {
    try {
      await coinApi.withdraw(id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "撤回失败");
    }
  };

  const selectedMeta = SUBMISSION_TYPE_META.find((entry) => entry.type === type);

  return (
    <CoinPageShell title="投稿中心" subtitle="审核通过可获得金币奖励，并有机会进入报告抽卡池" embedded={embedded}>
      {error ? <ErrorBox message={error} /> : null}
      {success ? (
        <div className="coin-success-box" role="status">
          {success}
        </div>
      ) : null}

      {type === null ? (
        <>
          <section className="grid grid-cols-2 gap-2.5">
            {SUBMISSION_TYPE_META.map((meta) => (
              <button
                key={meta.type}
                type="button"
                className="coin-entry flex-col items-start"
                onClick={() => setType(meta.type)}
              >
                <meta.icon className="h-5 w-5 text-[var(--survey-primary)]" />
                <span className="text-[13px] font-bold text-[var(--survey-heading)]">{meta.label}</span>
                <span className="text-[11px] leading-4 text-[var(--survey-muted)]">{meta.hint}</span>
              </button>
            ))}
          </section>
          <p className="text-[11px] leading-4 text-[var(--survey-muted)]">
            投稿前请确认内容为你本人拥有。涉及个人资料的内容默认仅以展示版本公开，不含内部编号与私密数据；撤回后立即停止展示。
          </p>
        </>
      ) : (
        <section className="coin-card space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-[var(--survey-heading)]">投稿 · {selectedMeta?.label}</p>
            <button type="button" className="text-xs text-[var(--survey-muted)]" onClick={() => setType(null)}>
              换类型
            </button>
          </div>
          <label className="block">
            <span className="coin-field-label">标题</span>
            <input
              className="coin-input"
              value={title}
              maxLength={80}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="coin-field-label">简介（可选）</span>
            {/* 300 与服务端 maxDescriptionLength 默认值一致；超限会在服务端被拒。 */}
            <input
              className="coin-input"
              value={description}
              maxLength={300}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          {type === "text" ? (
            <label className="block">
              <span className="coin-field-label">正文</span>
              <textarea
                className="coin-input min-h-32"
                value={contentText}
                maxLength={5000}
                onChange={(event) => setContentText(event.target.value)}
              />
            </label>
          ) : null}
          {type === "image" || type === "audio" ? (
            <label className="block">
              <span className="coin-field-label">文件（图片 ≤5MB / 音频 ≤8MB）</span>
              <input
                className="coin-input"
                type="file"
                accept={
                  type === "image"
                    ? "image/jpeg,image/png,image/webp,image/gif"
                    : "audio/mpeg,audio/mp4,audio/ogg,audio/wav,audio/flac"
                }
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
          ) : null}
          {type === "survey_report" || type === "profile_card" ? (
            <label className="block">
              <span className="coin-field-label">答卷编号（在「我的答卷」里可查看）</span>
              <input
                className="coin-input"
                type="number"
                value={responseId}
                onChange={(event) => setResponseId(event.target.value)}
                placeholder="例如 123"
              />
              <span className="mt-1 block text-[11px] text-[var(--survey-muted)]">
                公开的是你本人的答卷报告；其他答题者的内容不会被公开。
              </span>
            </label>
          ) : null}
          <label className="flex items-start gap-2 text-[12px] leading-4 text-[var(--survey-body)]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={publishToPool}
              onChange={(event) => setPublishToPool(event.target.checked)}
            />
            <span>希望进入报告抽卡池（进入前仍需审核；管理员配置后生效）</span>
          </label>
          <label className="flex items-start gap-2 text-[12px] leading-4 text-[var(--survey-body)]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={confirmOwn}
              onChange={(event) => setConfirmOwn(event.target.checked)}
            />
            <span>
              我确认此内容由我本人创作/拥有权利，且理解公开后其他用户可通过抽卡查看（可随时撤回，已抽走的用户按平台规则保留查看权）。
            </span>
          </label>
          <button
            type="button"
            className="coin-pull-btn w-full"
            disabled={busy || !title.trim() || !confirmOwn}
            onClick={() => void submit()}
          >
            {busy ? "提交中…" : "提交审核"}
          </button>
        </section>
      )}

      <section className="space-y-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--survey-muted)]">
          <Gift className="h-3.5 w-3.5" />
          我的投稿
        </p>
        {mine === null ? (
          <Loading />
        ) : mine.length === 0 ? (
          <ErrorBox message="还没有投稿记录" />
        ) : (
          mine.map((submission) => (
            <div key={submission.id} className="coin-card">
              <div className="flex items-start gap-2.5">
                {submission.thumbMediaAssetId ? (
                  <img
                    src={`/api/submissions/media/${submission.thumbMediaAssetId}`}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded-lg object-cover"
                    loading="lazy"
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-[var(--survey-heading)]">{submission.title}</p>
                  <p className="mt-0.5 text-[11px] text-[var(--survey-muted)]">
                    {STATUS_LABELS[submission.status] ?? submission.status} · {submission.createdAt.slice(0, 10)}
                    {submission.rewardAmount ? ` · 奖励 +${submission.rewardAmount}` : ""}
                  </p>
                  {submission.reviewNote ? (
                    <p className="mt-1 text-[11px] leading-4 text-[var(--survey-muted)]">
                      审核备注：{submission.reviewNote}
                    </p>
                  ) : null}
                </div>
                {["pending", "approved", "in_pool", "changes_requested"].includes(submission.status) ? (
                  <button type="button" className="coin-skip-btn shrink-0" onClick={() => void withdraw(submission.id)}>
                    撤回
                  </button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </section>
    </CoinPageShell>
  );
}

// ---- 问卷解锁门（/s/:id 的金币访问层） ----------------------------------

export function CoinGateScreen(props: {
  surveyId: number;
  title: string;
  description?: string;
  price: number;
  busy?: boolean;
  onUnlocked: () => void;
  onSkip: () => void;
}) {
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    coinApi
      .overview()
      .then((data) => setBalance(data.balance))
      .catch(() => undefined);
  }, []);

  const unlock = async () => {
    if (busy || done) return;
    setBusy(true);
    setError(null);
    try {
      await coinApi.unlock(props.surveyId, coinUnlockKey(props.surveyId));
      // 请求已成功；动画只做视觉过渡，跳过不影响结果。
      setDone(true);
      window.setTimeout(() => props.onUnlocked(), 900);
    } catch (err) {
      setError(err instanceof Error ? err.message : "解锁失败");
    } finally {
      setBusy(false);
    }
  };

  const affordable = balance !== null && balance >= props.price;

  return (
    <div className="coin-gate-layer" role="dialog" aria-label="解锁问卷">
      <div className={`coin-gate-card ${done ? "coin-gate-open" : ""}`}>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--survey-muted)]">金币解锁</p>
        <p className="mt-1 text-lg font-black text-[var(--survey-heading)]">{props.title}</p>
        {props.description ? (
          <p className="mt-1 line-clamp-3 text-[12px] text-[var(--survey-muted)]">{props.description}</p>
        ) : null}
        <p className="coin-gate-price">
          <CoinsIcon className="h-5 w-5" />
          {props.price} 金币
        </p>
        <p className="text-[11px] text-[var(--survey-muted)]">
          {balance === null ? "余额查询中…" : `当前余额 ${balance} 金币`}
          {balance !== null && !affordable ? " · 余额不足，可在「我的」中签到赚金币" : ""}
        </p>
        {error ? <p className="mt-2 text-[12px] text-rose-500">{error}</p> : null}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="coin-pull-btn flex-1"
            disabled={busy || done || !affordable}
            onClick={() => void unlock()}
          >
            {done ? "已解锁 ✓" : busy ? "解锁中…" : "确认解锁"}
          </button>
          <button type="button" className="coin-skip-btn" onClick={props.onSkip}>
            返回
          </button>
        </div>
        <p className="mt-2 text-[10px] leading-4 text-[var(--survey-muted)]">
          解锁后可永久填写该问卷；密码问卷仍需输入作者设置的密码。金币为站内虚拟积分。
        </p>
      </div>
    </div>
  );
}
