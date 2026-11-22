import { useEffect, useState } from "react";
import {
  BookOpen,
  ChevronRight,
  CircleHelp,
  FileCheck2,
  Images,
  LayoutGrid,
  Link2,
  MailCheck,
  Target,
  UserRound,
  Volume2,
  X,
} from "lucide-react";
import { AchievementWall } from "./AchievementWall";
import { PageHeader } from "./PageHeader";
import { ScreenShell, ThemeAction, usePublicTheme } from "./ScreenShell";
import { EntryRow, ErrorState, LoadingState, SectionHeader } from "./PublicPrimitives";
import {
  coinApi,
  createMyShowcase,
  createReportShare,
  fetchMyOverview,
  fetchMyReports,
  markAchievementsSeen,
  createProfileShare,
  fetchProfileShare,
  revokeProfileShare,
  revokeReportShare,
  type CoinOverview,
  type MyOverview,
  type MyReportItem,
} from "./api";
import { safeGet } from "./storage";
import { closeWebApp } from "./navigation";
import { armGameSoundGestureUnlock, playGameSound, useGameSoundSettings } from "./game-sound";
import { NotificationCenter } from "./SeriesScreen";

/** 金币卡片（独立取数：金币服务不可用时不影响「我的」其他区块）。 */
function CoinCard() {
  const [overview, setOverview] = useState<CoinOverview | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    coinApi
      .overview()
      .then(setOverview)
      .catch(() => undefined);
  };

  useEffect(() => {
    reload();
  }, []);

  const doCheckin = async () => {
    setBusy(true);
    try {
      await coinApi.checkin();
      reload();
    } catch {
      // 重复签到等错误静默；余额刷新即为反馈。
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="coin-balance-card">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[color-mix(in_srgb,var(--survey-primary-content)_72%,transparent)]">
            我的金币
          </p>
          <p className="mt-0.5 text-3xl font-black tabular-nums text-[var(--survey-primary-content)]">
            {overview ? overview.balance : "—"}
            <span className="ml-1.5 text-xs font-bold text-[color-mix(in_srgb,var(--survey-primary-content)_85%,transparent)]">
              金币
            </span>
          </p>
          {overview ? (
            <p className="mt-0.5 text-[11px] text-[color-mix(in_srgb,var(--survey-primary-content)_72%,transparent)]">
              连续签到 {overview.checkin.streak} 天 · 累计获得 {overview.totalEarned}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="coin-checkin-btn"
          disabled={busy || Boolean(overview?.checkin.checkedInToday)}
          onClick={() => void doCheckin()}
        >
          {overview?.checkin.checkedInToday ? "已签到" : busy ? "…" : "签到"}
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <a className="coin-entry-compact" href="/coins">
          明细 / 任务
        </a>
        <a className="coin-entry-compact" href="/gacha">
          报告抽卡
        </a>
        <a className="coin-entry-compact" href="/submissions">
          投稿中心
        </a>
      </div>
    </section>
  );
}

/**
 * 「我的报告」：已完成答卷的报告入口。
 *
 * 完成页带 token 的报告链接是一次性的——离开之后就找不回来了，用户明确反馈
 * 「填完之后无法查看自己的报告」。这里按参与者身份列出全部已完成答卷，服务端
 * 为每条现铸 30 天 token；匿名浏览器身份也适用（身份就是本机保存的 key）。
 * 与金币卡一样独立取数：报告接口出错不影响「我的」其他区块。
 */
function ReportList() {
  const [reports, setReports] = useState<MyReportItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMyReports()
      .then((data) => {
        if (!cancelled) setReports(data.reports);
      })
      .catch(() => {
        if (!cancelled) setReports([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 还在加载不占版面；没有报告时渲染空态而不是整块消失（B2 死路修复）：
  // 欢迎卡承诺「报告都在『我的』里」，新用户第一次进来这里必须有话可说。
  if (!reports) return null;

  return (
    <section className="survey-card p-4">
      <SectionHeader icon={FileCheck2} title="我的报告" count={reports.length > 0 ? reports.length : undefined} />
      {reports.length === 0 ? (
        <div className="py-3 text-center">
          <p className="text-[13px] leading-6 text-[var(--survey-muted)]">
            还没有报告。填完一份问卷，报告就会出现在这里。
          </p>
          <a
            href="/s"
            className="mt-3 inline-flex rounded-full border border-[var(--survey-card-border)] px-4 py-1.5 text-[12px] font-semibold text-[var(--survey-primary)]"
          >
            去答题 →
          </a>
        </div>
      ) : (
        <ul className="mt-1 divide-y divide-[var(--survey-card-border)]">
          {reports.map((report) => (
            <li key={report.responseId} className="flex items-center gap-2 py-2.5">
              <a href={report.reportUrl} className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold text-[var(--survey-heading)]">
                    {report.title}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-[var(--survey-muted)]">
                    {report.completedAt ? `${report.completedAt.slice(0, 10)} 完成` : "已完成"}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
              </a>
              <a
                href={report.pdfUrl}
                download
                className="shrink-0 rounded-full border border-[var(--survey-card-border)] px-2.5 py-1 text-[11px] font-semibold text-[var(--survey-primary)]"
              >
                下载 PDF
              </a>
              <ReportShareButton responseId={report.responseId} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 答卷足迹（Wrapped，0085）：跨问卷足迹的可分享公开页。创建幂等——
 * 同一个人的足迹页永远只有一个链接，重新生成只是刷新快照。
 * （B5 命名合一：卡片名不再与「档案」口径撞车——答卷公开档案统一叫「答卷档案」。）
 */
function ProfileShareCard() {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchProfileShare()
      .then((data) => {
        if (!cancelled && data.share) {
          setShareUrl(new URL(data.share.url, window.location.origin).toString());
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const act = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (shareUrl) {
        await revokeProfileShare();
        setShareUrl(null);
        setCopied(false);
      } else {
        const result = await createProfileShare();
        setShareUrl(new URL(result.share.url, window.location.origin).toString());
      }
    } catch {
      // 失败回位。
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="survey-card p-4">
      <SectionHeader icon={UserRound} title="答卷足迹" />
      <p className="mt-1 text-xs text-[var(--survey-muted)]">
        把你的答卷足迹（完成卷数、结局收集、成就）做成一张可分享的公开页。只含聚合数字，不含任何答案。
      </p>
      {shareUrl ? (
        <>
          <p className="mt-2 break-all rounded-lg bg-black/5 px-2.5 py-1.5 text-[11px] text-[var(--survey-muted)]">
            {shareUrl}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-full border border-[var(--survey-card-border)] px-3 py-1 text-[11px] font-semibold text-[var(--survey-primary)]"
              disabled={busy}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(shareUrl);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2000);
                } catch {
                  // 剪贴板不可用时链接可见可手动复制。
                }
              }}
            >
              {copied ? "已复制" : "复制链接"}
            </button>
            <button
              type="button"
              className="rounded-full border border-[var(--survey-card-border)] px-3 py-1 text-[11px] font-semibold text-[var(--survey-primary)]"
              disabled={busy}
              onClick={act}
            >
              {busy ? "…" : "撤销分享"}
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className="mt-2 rounded-full border border-[var(--survey-card-border)] px-3 py-1 text-[11px] font-semibold text-[var(--survey-primary)] disabled:opacity-50"
          disabled={busy}
          onClick={act}
        >
          {busy ? "生成中…" : "生成我的答卷足迹"}
        </button>
      )}
    </section>
  );
}

/**
 * 单条报告的结局卡分享按钮（0081）：点按创建/复制链接，再点撤销。
 * 与完成页的 ShareEndingCard 同一后端，这里做成行内轻量控件。
 */
function ReportShareButton({ responseId }: { responseId: number }) {
  const [state, setState] = useState<"idle" | "busy" | "shared" | "copied">("idle");
  const act = async () => {
    if (state === "busy") return;
    setState("busy");
    try {
      if (state === "shared" || state === "copied") {
        await revokeReportShare(responseId);
        setState("idle");
        return;
      }
      const result = await createReportShare(responseId);
      const absolute = new URL(result.share.url, window.location.origin).toString();
      try {
        await navigator.clipboard.writeText(absolute);
        setState("copied");
      } catch {
        setState("shared");
      }
    } catch {
      setState("idle");
    }
  };
  const label =
    state === "busy" ? "…" : state === "copied" ? "已复制·撤销" : state === "shared" ? "已分享·撤销" : "分享";
  return (
    <button
      type="button"
      onClick={act}
      disabled={state === "busy"}
      className="shrink-0 rounded-full border border-[var(--survey-card-border)] px-2.5 py-1 text-[11px] font-semibold text-[var(--survey-primary)] disabled:opacity-50"
    >
      {label}
    </button>
  );
}

/**
 * 游戏音效设置（五款联机游戏共用的提示音/音效层）：总开关与音量滑条，与
 * 对局页头的小喇叭同一状态源（useGameSoundSettings 订阅引擎）。开启瞬间给
 * 一声「轮到你」作试听——点击本身就是手势，满足自动播放合规。
 */
function GameSoundSettings() {
  const sound = useGameSoundSettings();
  useEffect(() => armGameSoundGestureUnlock(), []);
  return (
    <section className="survey-card p-4">
      <SectionHeader icon={Volume2} title="游戏音效" />
      <div className="mt-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-[var(--survey-heading)]">对局提示音</p>
            <p className="mt-0.5 text-[11px] leading-4 text-[var(--survey-muted)]">
              落子、骰子、回合与结算等音效（联机对战共用）
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={sound.enabled}
            aria-label="对局提示音"
            onClick={() => {
              sound.setEnabled(!sound.enabled);
              if (!sound.enabled) playGameSound("turn_you");
            }}
            className={`relative h-6 w-11 shrink-0 rounded-full transition ${
              sound.enabled ? "bg-[var(--survey-primary)]" : "bg-[var(--survey-card-border)]"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                sound.enabled ? "left-[22px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
        <label className="flex items-center gap-3">
          <span className="shrink-0 text-[12px] font-semibold text-[var(--survey-muted)]">音量</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={sound.volume}
            onChange={(event) => sound.setVolume(Number(event.target.value))}
            className="h-1.5 min-w-0 flex-1 accent-[var(--survey-primary)]"
            aria-label="对局音效音量"
          />
          <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-[var(--survey-muted)]">
            {Math.round(sound.volume * 100)}%
          </span>
        </label>
      </div>
    </section>
  );
}

/**
 * 「我的」个人中心（/me）：当前参与者身份下的答卷、答卷档案、徽章、挑战数据与
 * 外观设置的统一入口。
 */
export function MyScreen() {
  const [overview, setOverview] = useState<MyOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [showcaseBusy, setShowcaseBusy] = useState(false);
  const [showcaseError, setShowcaseError] = useState<string | null>(null);
  const [hasTelegramIdentity] = useState<boolean>(
    () => safeGet("tg:linked") === "1" || Boolean(safeGet("tg:identity")),
  );
  const themeState = usePublicTheme();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchMyOverview()
      .then((data) => {
        if (!cancelled) setOverview(data);
        // 打开「我的」即为"已读"：先渲染带小红点的数据，再清标记。
        if (data.achievements?.unseen) {
          void markAchievementsSeen().catch(() => undefined);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  /** 用当前答卷档案提交展示区草稿；展示区是策展空间，公开与否归管理员。 */
  const generateShowcase = async () => {
    setShowcaseBusy(true);
    setShowcaseError(null);
    try {
      const result = await createMyShowcase();
      setOverview((prev) =>
        prev
          ? { ...prev, showcase: { personId: result.showcase.personId, published: result.showcase.published } }
          : prev,
      );
    } catch (err) {
      setShowcaseError(err instanceof Error ? err.message : "生成失败，请稍后重试");
    } finally {
      setShowcaseBusy(false);
    }
  };

  return (
    <ScreenShell themeState={themeState}>
      <PageHeader
        helpKey="me"
        title="我的"
        subtitle="你的答卷、档案与挑战记录"
        titleIcon={<UserRound className="h-4 w-4" />}
        backHref={null}
        wide
        actions={
          <>
            <ThemeAction themeState={themeState} />
            <button
              type="button"
              aria-label="关闭"
              title="关闭"
              className="survey-icon-btn"
              onClick={() => closeWebApp()}
            >
              <X className="h-4 w-4" />
            </button>
          </>
        }
      />

      <main className="mx-auto max-w-xl space-y-4 px-5 py-5 lg:max-w-[1200px] lg:grid lg:grid-cols-12 lg:items-stretch lg:gap-4 lg:space-y-0">
        {error ? (
          <div className="lg:col-span-12">
            <ErrorState message={error} onRetry={() => setRetryKey((key) => key + 1)} />
          </div>
        ) : overview === null ? (
          <div className="lg:col-span-12">
            <LoadingState label="正在加载我的资料" rows={4} />
          </div>
        ) : (
          <>
            {/* M9 分组栅格：DOM 顺序不变，仅 ≥lg 分列（身份 5 + 金币 7，互动/内容双列 6+6）。
                手机端包装 div 不产生任何视觉差（space-y 语义不变）。 */}
            <div className="lg:col-span-5">
              {/* 身份 */}
              <section className="flex h-full items-center gap-3 survey-card p-4">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]">
                  <UserRound className="h-6 w-6" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-[var(--survey-heading)]">
                    {overview.identity.telegram
                      ? "Telegram 身份"
                      : overview.identity.email
                        ? `邮箱账号 · ${overview.identity.emailMasked ?? "已登录"}`
                        : "匿名访客身份"}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-4 text-[var(--survey-muted)]">
                    {overview.identity.telegram
                      ? "答卷、挑战与档案都会归属到这个身份"
                      : overview.identity.email
                        ? "已注册登录，答卷与进度都归属这个账号；绑定 Telegram 后成绩可上榜"
                        : "注册或登录（邮箱即可）后答卷进度才能找回"}
                  </p>
                </div>
                {overview.identity.telegram || overview.identity.email ? (
                  <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--app-success)_14%,transparent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--app-success)]">
                    {overview.identity.telegram ? "已认证" : "已登录"}
                  </span>
                ) : (
                  <a
                    href="/auth"
                    className="shrink-0 rounded-full bg-[var(--survey-primary)] px-2.5 py-1 text-[11px] font-semibold text-[var(--survey-primary-content)] no-underline"
                  >
                    去注册 / 登录
                  </a>
                )}
              </section>
            </div>
            <div className="lg:col-span-7 [&>div]:h-full">
              <CoinCard />
            </div>
            {/* 纸条聊天（0089）：个人中心的一等入口。 */}
            <div className="lg:col-span-6 [&>*]:h-full">
              <EntryRow href="/notes" icon={MailCheck} title="纸条聊天" subtitle="放一张纸条，抽到同路的人就开始私聊" />
            </div>
            {/* 动态与通知（B5）：纸条配对、审核结果、连载更新等全站动态，与书架无关——
                独立成卡，不再嵌在「系列书架」卡片里渲染。 */}
            <div className="lg:col-span-6 [&>section]:h-full">
              <NotificationCenter />
            </div>
            {/* 系列书架入口保留原位：分组重排不动入口取舍。 */}
            <div className="lg:col-span-6 [&>*]:h-full">
              <EntryRow href="/series" icon={BookOpen} title="系列书架" subtitle="像追小说一样追问卷连载" />
            </div>
            <div className="lg:col-span-6 [&>div]:h-full">
              <ProfileShareCard />
            </div>
            {/* 游戏音效：联机对局提示音总开关与音量（与对局页头小喇叭同源）。 */}
            <div className="lg:col-span-6 [&>div]:h-full">
              <GameSoundSettings />
            </div>
            <div className="lg:col-span-6 [&>div]:h-full">
              <ReportList />
            </div>
            {/* 数据总览 */}
            <div className="lg:col-span-6">
              <section className="grid grid-cols-2 gap-3 h-full">
                <div className="survey-card p-4">
                  <SectionHeader icon={FileCheck2} title="已完成问卷" />
                  <p className="mt-1.5 text-2xl font-black text-[var(--survey-heading)]">
                    {overview.completedSurveys}
                    <span className="ml-1 text-xs font-semibold text-[var(--survey-muted)]">份</span>
                  </p>
                </div>
                <div className="survey-card p-4">
                  <SectionHeader icon={Target} title="挑战通关" />
                  <p className="mt-1.5 text-2xl font-black text-[var(--survey-heading)]">
                    {overview.trial.completed}
                    <span className="ml-1 text-xs font-semibold text-[var(--survey-muted)]">
                      / {overview.trial.runs} 局
                    </span>
                  </p>
                </div>
              </section>
            </div>
            {/* 我的答卷档案（B5 命名合一）：答卷公开档案统一叫「答卷档案」，
                与广场页签、档案详情页同一口径。成就墙缺席时占满整行。 */}
            <div className="lg:col-span-6">
              <section className="survey-card p-4 h-full">
                <SectionHeader icon={Link2} title="我的答卷档案" />
                {overview.myProfile ? (
                  <a
                    href={`/plaza/profile/${overview.myProfile.responseId}`}
                    className="mt-2.5 flex items-center gap-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-bold text-[var(--survey-heading)]">
                        {overview.myProfile.heading ?? "未命名答卷档案"}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-[var(--survey-muted)]">
                        已发布于 {(overview.myProfile.publishedAt || "").slice(0, 10)} · 点击查看
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
                  </a>
                ) : overview.profileSurveyId ? (
                  <a
                    href={`/s/${overview.profileSurveyId}`}
                    className="mt-3 block rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-2.5 text-center text-[13px] font-semibold text-[var(--survey-primary-content)]"
                  >
                    填写答卷档案问卷，生成我的答卷档案
                  </a>
                ) : (
                  <p className="mt-2 text-[13px] text-[var(--survey-muted)]">
                    答卷档案功能还未开放，先去逛逛
                    <a className="text-[var(--survey-primary)] underline" href="/plaza">
                      广场
                    </a>
                    吧。
                  </p>
                )}

                {overview.myProfile ? (
                  <div className="mt-3 border-t border-[var(--survey-card-border)] pt-3">
                    {/* 展示区（B5 命名合一）：与 screen-help.ts 的 showcase intro 同一叫法。 */}
                    <SectionHeader icon={Images} title="展示区" />
                    {overview.showcase?.published ? (
                      <a href={`/showcase?p=${overview.showcase.personId}`} className="mt-2 flex items-center gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-semibold text-[var(--survey-heading)]">
                            已在展示区公开
                          </span>
                          <span className="mt-0.5 block text-[11px] text-[var(--survey-muted)]">点击查看</span>
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
                      </a>
                    ) : overview.showcase ? (
                      <a href="/showcase" className="mt-2 flex items-center gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-semibold text-[var(--survey-heading)]">
                            已提交展示区
                          </span>
                          <span className="mt-0.5 block text-[11px] text-[var(--survey-muted)]">
                            管理员审核通过后就会公开 · 去展示区逛逛
                          </span>
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--survey-muted)]" />
                      </a>
                    ) : (
                      <button
                        type="button"
                        disabled={showcaseBusy}
                        onClick={() => void generateShowcase()}
                        className="mt-2 w-full rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] py-2.5 text-[13px] font-semibold text-[var(--survey-body)] transition hover:bg-[var(--survey-primary-soft)] disabled:opacity-60"
                      >
                        {showcaseBusy ? "生成中…" : "把我的答卷档案提交到展示区"}
                      </button>
                    )}
                    {showcaseError ? (
                      <p className="mt-1.5 text-[11px] text-[var(--app-danger)]">{showcaseError}</p>
                    ) : null}
                  </div>
                ) : null}
              </section>
            </div>
            {/* 成就徽章墙（目录与解锁状态都来自服务端） */}
            {overview.achievements?.items?.length ? (
              <div className="lg:col-span-12 [&>div]:h-full">
                <AchievementWall overview={overview.achievements} />
              </div>
            ) : null}
            {/* 入口（M9 视觉重排）：三行合一张分组卡，bare 行式 */}{" "}
            <div className="lg:col-span-12">
              <section className="survey-card p-2">
                <EntryRow bare href="/trial" icon={Target} title="挑战任务" subtitle="查看完整对局记录与排行榜" />
                <div className="mx-3 my-1 border-t border-[var(--survey-card-border)]" role="presentation" />
                {/* 应用中心（2026-11-20 P0 加固批次 M1）：四功能区聚合入口，
                后续新入口统一挂到 /app，不再各自散进「我的」。 */}
                <EntryRow bare href="/app" icon={LayoutGrid} title="应用中心" subtitle="问卷、小游戏、网页导航与社区" />
                <div className="mx-3 my-1 border-t border-[var(--survey-card-border)]" role="presentation" />
                {/* 帮助中心（2026-11-19 通宵批次 B3）：？ 弹层的整页版，一跳可达。 */}
                <EntryRow
                  bare
                  href="/help"
                  icon={CircleHelp}
                  title="帮助中心"
                  subtitle="每一屏是什么、新手第一步点哪里"
                />
              </section>
            </div>
          </>
        )}
      </main>
    </ScreenShell>
  );
}
