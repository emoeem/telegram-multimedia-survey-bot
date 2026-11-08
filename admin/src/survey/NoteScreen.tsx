import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Ban,
  CornerDownLeft,
  EyeOff,
  Flag,
  ImagePlus,
  Loader2,
  MoreHorizontal,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { PageHeader } from "./PageHeader";
import { ScreenShell, usePublicTheme } from "./ScreenShell";
import { ErrorState, LoadingState } from "./PublicPrimitives";
import { SURVEY_CARD } from "./ui";
import { useDialogs } from "../components/Dialogs";
import {
  noteImageUrl,
  blockThreadPartner,
  drawNote,
  fetchNoteMe,
  fetchNoteMessages,
  fetchNoteThreads,
  putNote,
  reportNote,
  reportThreadMessage,
  sendNoteMessage,
  unblockThreadPartner,
  uploadNoteImage,
  withdrawMyNote,
  NoteApiError,
  type NoteCardDto,
  type NoteMeDto,
  type NoteMessageDto,
  type NoteThreadDto,
} from "./note-api";
import { REPORT_REASON_MAX, chatInputGate, validateReportReason } from "./note-chat-actions";
import { NOTE_POLL_BASE_MS, nextPollInterval } from "./note-poll";
import { initialNoteTab, threadIdFromSearch, type NoteTab } from "./note-tab";

/**
 * 纸条聊天（0089）——页签：我的纸条 / 对话（抽纸条在抽奖中心 /gacha）。
 *
 * 额度观（用户点名的玩法）：每日 3 次免费抽取（服务端按参与者当日已抽次数
 * 判定），用完后每次 5 金币——余额不足时按钮直接给出「去签到」的去处，
 * 不让用户撞到报错才知道没钱。轮询只在对话屏打开时进行（可见性感知退避，
 * 无新消息 15s→30s→60s，见 note-poll.ts），离开页面/切后台即停，
 * 这是成本红线（docs/ops/COST-GUARDRAILS.md）。
 */

type Tab = NoteTab;

const GENDERS = [
  { id: "m", label: "男生" },
  { id: "f", label: "女生" },
  { id: "x", label: "保密" },
];
const AGE_BANDS = ["18-24", "25-30", "31-40", "40+"];

function genderLabel(id: string): string {
  return GENDERS.find((entry) => entry.id === id)?.label ?? id;
}

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

const CARD = SURVEY_CARD;
const CHIP =
  "inline-flex items-center gap-1 rounded-full bg-[var(--survey-bg)] px-2.5 py-0.5 text-[11px] text-[var(--survey-muted)]";
const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-1.5 rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] px-4 py-2.5 text-sm font-bold text-[var(--survey-primary-content)] disabled:opacity-50";
const BTN_GHOST =
  "inline-flex items-center justify-center gap-1.5 rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] px-4 py-2.5 text-sm font-semibold text-[var(--survey-body)] disabled:opacity-50";

function NoteAvatar({ gender, size = "h-10 w-10" }: { gender: string; size?: string }) {
  const tone =
    gender === "m"
      ? "bg-[color-mix(in_srgb,var(--survey-primary)_22%,var(--survey-card-bg))] text-[var(--survey-primary)]"
      : gender === "f"
        ? "bg-[color-mix(in_srgb,#e592a6_22%,var(--survey-card-bg))] text-[#c96d87]"
        : "bg-[var(--survey-bg)] text-[var(--survey-muted)]";
  return (
    <span className={`grid ${size} shrink-0 place-items-center rounded-2xl text-sm font-black ${tone}`}>
      {gender === "m" ? "他" : gender === "f" ? "她" : "?"}
    </span>
  );
}

function NoteCardBody({ note, compact }: { note: NoteCardDto; compact?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={CHIP}>{genderLabel(note.gender)}</span>
        <span className={CHIP}>{note.ageBand} 岁</span>
        {note.region ? <span className={CHIP}>{note.region}</span> : null}
      </div>
      <p
        className={`mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--survey-heading)] ${compact ? "line-clamp-4" : ""}`}
      >
        {note.content}
      </p>
      {note.imageAssetId ? (
        <img
          src={noteImageUrl(note.imageAssetId)}
          alt="纸条配图"
          loading="lazy"
          className="mt-2 max-h-56 w-full rounded-xl object-cover"
        />
      ) : null}
      <p className="mt-2 text-[11px] text-[var(--survey-muted)]">
        {formatDay(note.createdAt)} 放出 · {formatDay(note.expiresAt)} 到期
      </p>
    </div>
  );
}

/* ---------------- 我的纸条 ---------------- */

function MineTab({ me, onReload }: { me: NoteMeDto; onReload: () => void }) {
  const dialogs = useDialogs();
  const [gender, setGender] = useState("x");
  const [ageBand, setAgeBand] = useState("18-24");
  const [region, setRegion] = useState("");
  const [content, setContent] = useState("");
  const [imageAssetId, setImageAssetId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  const canPreview = gender && ageBand && content.trim().length > 0 && content.trim().length <= 300;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await putNote({ gender, ageBand, region: region.trim(), content: content.trim(), imageAssetId });
      setPreview(false);
      setContent("");
      setRegion("");
      setImageAssetId(null);
      onReload();
    } catch (err) {
      setError(err instanceof NoteApiError ? err.message : "放入失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    const ok = await dialogs.confirm({
      title: "下架纸条",
      message: "下架后别人抽不到你，已有会话保留但不能再发新消息。确定下架？",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await withdrawMyNote();
      onReload();
    } finally {
      setBusy(false);
    }
  };

  if (!me.note) {
    return (
      <div className={`${CARD} p-5`}>
        <h2 className="text-[15px] font-bold text-[var(--survey-heading)]">放一张纸条</h2>
        <a
          href="/gacha"
          className="mt-2 flex items-center justify-between rounded-[var(--survey-button-radius)] bg-[var(--survey-primary-soft)] px-3 py-2 text-xs font-semibold text-[var(--survey-primary)]"
        >
          <span>想抽别人的纸条？去抽奖中心</span>
          <span aria-hidden="true">→</span>
        </a>
        <p className="mt-1 text-xs leading-5 text-[var(--survey-muted)]">
          写下你想说的话，它会随机被同路的人抽到；抽中你们就能开始私聊。每人同时只有一张有效纸条，7 天后自动下架。
        </p>
        <div className="mt-4">
          <p className="text-xs font-semibold text-[var(--survey-muted)]">我是</p>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            {GENDERS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={gender === entry.id}
                onClick={() => setGender(entry.id)}
                className={`min-h-10 rounded-[var(--survey-button-radius)] border px-3 text-[13px] font-semibold transition-colors ${
                  gender === entry.id
                    ? "border-transparent bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                    : "border-[var(--survey-card-border)] text-[var(--survey-body)]"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3">
          <p className="text-xs font-semibold text-[var(--survey-muted)]">年龄段</p>
          <div className="mt-1.5 grid grid-cols-4 gap-1.5">
            {AGE_BANDS.map((band) => (
              <button
                key={band}
                type="button"
                aria-pressed={ageBand === band}
                onClick={() => setAgeBand(band)}
                className={`min-h-10 rounded-[var(--survey-button-radius)] border px-1 text-[12px] font-semibold transition-colors ${
                  ageBand === band
                    ? "border-transparent bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                    : "border-[var(--survey-card-border)] text-[var(--survey-body)]"
                }`}
              >
                {band}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3">
          <p className="text-xs font-semibold text-[var(--survey-muted)]">地区（可选）</p>
          <input
            value={region}
            maxLength={24}
            onChange={(event) => setRegion(event.target.value)}
            placeholder="如：上海"
            className="mt-1.5 min-h-10 w-full rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-bg)] px-3 text-sm text-[var(--survey-body)] outline-none focus:border-[var(--survey-primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--survey-primary)_30%,transparent)]"
          />
        </div>
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-[var(--survey-muted)]">想说的话</p>
            <span className="text-[11px] tabular-nums text-[var(--survey-muted)]">{content.trim().length}/300</span>
          </div>
          <textarea
            value={content}
            maxLength={300}
            rows={4}
            onChange={(event) => setContent(event.target.value)}
            placeholder="写点什么，让抽到的人愿意回你…"
            className="mt-1.5 w-full resize-none rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-bg)] p-3 text-sm leading-6 text-[var(--survey-body)] outline-none focus:border-[var(--survey-primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--survey-primary)_30%,transparent)]"
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <label className={`${BTN_GHOST} min-h-10 cursor-pointer text-[13px]`}>
            <ImagePlus className="h-4 w-4" aria-hidden="true" />
            {imageAssetId ? "换图" : "配图"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setBusy(true);
                setError(null);
                try {
                  const result = await uploadNoteImage(file);
                  setImageAssetId(result.assetId);
                } catch (err) {
                  setError(err instanceof NoteApiError ? err.message : "图片上传失败");
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
          {imageAssetId ? (
            <button
              type="button"
              className="text-xs text-[var(--survey-muted)] underline"
              onClick={() => setImageAssetId(null)}
            >
              移除图片
            </button>
          ) : null}
        </div>
        {error ? <p className="mt-2 text-xs text-[var(--app-danger)]">{error}</p> : null}
        <button
          type="button"
          className={`${BTN_PRIMARY} mt-4 w-full`}
          disabled={!canPreview || busy}
          onClick={() => setPreview(true)}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          )}
          预览我的纸条
        </button>

        {preview ? (
          <div
            className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-5"
            role="dialog"
            aria-label="纸条预览"
          >
            <div className={`${CARD} w-full max-w-sm p-5 shadow-2xl`}>
              <div className="flex items-start justify-between">
                <h3 className="text-sm font-bold text-[var(--survey-heading)]">这就是别人抽到的样子</h3>
                <button
                  type="button"
                  aria-label="关闭预览"
                  className="survey-icon-btn h-8 w-8"
                  onClick={() => setPreview(false)}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-3 flex gap-3">
                <NoteAvatar gender={gender} />
                <NoteCardBody
                  note={{
                    id: 0,
                    gender,
                    ageBand,
                    region: region.trim(),
                    content: content.trim(),
                    imageAssetId,
                    createdAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
                  }}
                />
              </div>
              <p className="mt-3 text-[11px] leading-5 text-[var(--survey-muted)]">
                放出后 7 天内可被随机抽到；随时可以下架。请不要写联系方式——被举报多次会被下架。
              </p>
              <button
                type="button"
                className={`${BTN_PRIMARY} mt-3 w-full`}
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? "放入中…" : "正式放入"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`${CARD} p-5`}>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-[15px] font-bold text-[var(--survey-heading)]">我的纸条</h2>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--app-danger)]"
          disabled={busy}
          onClick={() => void withdraw()}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          下架
        </button>
      </div>
      <div className="mt-3 flex gap-3">
        <NoteAvatar gender={me.note.gender} />
        <NoteCardBody note={me.note} />
      </div>
      <a
        href="/gacha"
        className="mt-3 flex items-center justify-between rounded-[var(--survey-button-radius)] bg-[var(--survey-primary-soft)] px-3 py-2 text-xs font-semibold text-[var(--survey-primary)]"
      >
        <span>每天 3 次免费抽取，去抽奖中心试试手气</span>
        <span aria-hidden="true">→</span>
      </a>
    </div>
  );
}

/* ---------------- 对话 ---------------- */

/** 会话内动作菜单（0094 举报/拉黑的用户端入口）：点击遮罩关闭，
 * 样式对齐 MineTab 的预览弹层（fixed 遮罩 + CARD 面板）。 */
function ChatActionSheet({
  title,
  actions,
  onClose,
}: {
  title: string;
  actions: { label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; onClick: () => void }[];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-5 sm:items-center"
      role="dialog"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className={`${CARD} w-full max-w-sm p-2 shadow-2xl`}
        role="presentation"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="max-w-full truncate px-3 pb-1 pt-2 text-[11px] text-[var(--survey-muted)]">{title}</p>
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            disabled={action.disabled}
            className={`flex w-full items-center gap-2 rounded-[var(--survey-button-radius)] px-3 py-3 text-left text-sm font-semibold transition-colors hover:bg-[var(--survey-bg)] disabled:opacity-50 ${
              action.danger ? "text-[var(--app-danger)]" : "text-[var(--survey-body)]"
            }`}
            onClick={action.onClick}
          >
            {action.icon}
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatView({
  thread,
  onBack,
  onUnblocked,
}: {
  thread: NoteThreadDto;
  onBack: () => void;
  onUnblocked: () => void;
}) {
  const dialogs = useDialogs();
  const [messages, setMessages] = useState<NoteMessageDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [peerGone, setPeerGone] = useState(thread.noteStatus !== "active");
  const [draft, setDraft] = useState("");
  const [imageAssetId, setImageAssetId] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 拉黑态本地判定：服务端不回传 blocked（零迁移），而 listThreads 读侧双向
  // 过滤已把被拉黑会话挡在列表外（note-chat.service.ts）——能打开本会话说明
  // 当前未拉黑，之后的置位/复位都由本会话内的操作驱动。
  const [blocked, setBlocked] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [headerMenu, setHeaderMenu] = useState(false);
  const [messageMenu, setMessageMenu] = useState<{ id: number; body: string } | null>(null);
  const [reportTarget, setReportTarget] = useState<{ id: number; body: string } | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [reportError, setReportError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastIdRef = useRef(0);
  const pressTimerRef = useRef<number | null>(null);

  /** 长按（450ms）对方消息 → 消息菜单；桌面端右键同入口（onContextMenu）。 */
  const clearPress = useCallback(() => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearPress, [clearPress]);

  const startPress = useCallback(
    (message: NoteMessageDto) => {
      if (message.mine || blocked) return;
      clearPress();
      pressTimerRef.current = window.setTimeout(() => {
        pressTimerRef.current = null;
        setMessageMenu({ id: message.id, body: message.body });
      }, 450);
    },
    [blocked, clearPress],
  );

  /** 拉增量消息；返回本轮是否拉到新消息（退避决策的输入）。 */
  const poll = useCallback(async (): Promise<boolean> => {
    try {
      const result = await fetchNoteMessages(thread.id, lastIdRef.current);
      setPeerGone(result.peerGone);
      if (result.messages.length === 0) return false;
      lastIdRef.current = result.messages[result.messages.length - 1]!.id;
      setMessages((current) => {
        const seen = new Set(current.map((item) => item.id));
        const fresh = result.messages.filter((item) => !seen.has(item.id));
        return fresh.length > 0 ? [...current, ...fresh] : current;
      });
      return true;
    } catch {
      /* 瞬时失败静默：下一轮退避后再拉。 */
      return false;
    } finally {
      setLoading(false);
    }
  }, [thread.id]);

  useEffect(() => {
    lastIdRef.current = 0;
    setMessages([]);
    setLoading(true);
    let cancelled = false;
    let inFlight = false;
    let timer: number | null = null;
    let intervalMs = NOTE_POLL_BASE_MS;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    // 拉一次 → 决定下一档间隔 → 排程下一轮。隐藏时不再排程（挂起），
    // 回到可见由 onVisibility 立即补拉一次再恢复。
    const tick = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      const gotNew = await poll();
      inFlight = false;
      if (cancelled || document.hidden) return;
      intervalMs = nextPollInterval(intervalMs, gotNew);
      timer = window.setTimeout(() => {
        timer = null;
        void tick();
      }, intervalMs);
    };

    // 成本红线：只在对话屏可见时轮询——隐藏即停，可见立即拉一次再从最快档起跳。
    const onVisibility = () => {
      if (document.hidden) {
        clearTimer();
        return;
      }
      clearTimer();
      intervalMs = NOTE_POLL_BASE_MS;
      void tick();
    };

    void tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimer();
    };
  }, [poll]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const send = async () => {
    const text = draft.trim();
    if ((!text && !imageAssetId) || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await sendNoteMessage(thread.id, { body: text, imageAssetId });
      setDraft("");
      setImageAssetId(null);
      setMessages((current) => [...current, result.message]);
      lastIdRef.current = Math.max(lastIdRef.current, result.message.id);
    } catch (err) {
      setError(err instanceof NoteApiError ? err.message : "发送失败，请重试");
    } finally {
      setSending(false);
    }
  };

  /* 拉黑对方：确认弹层 → POST 成功即置本地 blocked。POST 语义是 blockThread
     幂等恒 true（仅 not_participant 抛错），blocked 返回值不作判定依据；
     会话从列表消失由 listThreads 读侧双向过滤在返回列表时兑现。 */
  const blockPartner = async () => {
    const ok = await dialogs.confirm({
      title: "拉黑对方",
      message: "拉黑后这个会话会从你的会话列表消失，对方也无法再给你发消息。确定拉黑？",
      confirmLabel: "拉黑",
      variant: "danger",
    });
    if (!ok) return;
    setActionBusy(true);
    try {
      await blockThreadPartner(thread.id);
      setBlocked(true);
      dialogs.toast({ message: "已拉黑对方", variant: "success" });
    } catch (err) {
      dialogs.toast({
        message: err instanceof NoteApiError ? err.message : "操作失败，请重试",
        variant: "error",
      });
    } finally {
      setActionBusy(false);
    }
  };

  /* 解除拉黑：DELETE 成功即视为已解除（返回 blocked 仅用于反馈文案，不作状态
     判定），并让会话列表按服务端双向过滤重新拉取。 */
  const unblockPartner = async () => {
    setActionBusy(true);
    try {
      await unblockThreadPartner(thread.id);
      setBlocked(false);
      onUnblocked();
      dialogs.toast({ message: "已解除拉黑", variant: "success" });
    } catch (err) {
      dialogs.toast({
        message: err instanceof NoteApiError ? err.message : "操作失败，请重试",
        variant: "error",
      });
    } finally {
      setActionBusy(false);
    }
  };

  const openReport = (target: { id: number; body: string }) => {
    setReportReason("");
    setReportError(null);
    setReportTarget(target);
  };

  const submitReport = async () => {
    if (!reportTarget || actionBusy) return;
    const problem = validateReportReason(reportReason);
    if (problem === "empty") {
      setReportError("请填写举报理由");
      return;
    }
    if (problem === "too_long") {
      setReportError(`理由不超过 ${REPORT_REASON_MAX} 字`);
      return;
    }
    setActionBusy(true);
    setReportError(null);
    try {
      await reportThreadMessage(thread.id, reportTarget.id, reportReason.trim());
      setReportTarget(null);
      setReportReason("");
      dialogs.toast({ message: "已提交举报，我们会尽快复核", variant: "success" });
    } catch (err) {
      setReportError(err instanceof NoteApiError ? err.message : "提交失败，请重试");
    } finally {
      setActionBusy(false);
    }
  };

  const gate = chatInputGate({ blocked, peerGone });
  const peerLabel = thread.role === "drawer" ? "纸条主人" : "抽中你的人";

  return (
    <div className="flex min-h-[70dvh] flex-col">
      <div className={`${CARD} flex items-center gap-2.5 px-4 py-3`}>
        <button type="button" className="survey-icon-btn h-8 w-8" aria-label="返回会话列表" onClick={onBack}>
          <CornerDownLeft className="h-4 w-4 rotate-180" />
        </button>
        <NoteAvatar gender={thread.peerNote?.gender ?? "x"} size="h-9 w-9" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-[var(--survey-heading)]">{peerLabel}</p>
          <p className="truncate text-[11px] text-[var(--survey-muted)]">
            {thread.peerNote
              ? `${genderLabel(thread.peerNote.gender)} · ${thread.peerNote.ageBand} 岁${thread.peerNote.region ? ` · ${thread.peerNote.region}` : ""}`
              : "匿名纸条"}
          </p>
        </div>
        <button
          type="button"
          className="survey-icon-btn h-8 w-8 shrink-0"
          aria-label="会话操作"
          onClick={() => setHeaderMenu(true)}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>

      {/* 对方的原纸条，聊天的锚点 */}
      {thread.peerNote ? (
        <div className={`${CARD} mt-3 px-4 py-3`}>
          <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-[var(--survey-body)]">
            {thread.peerNote.content}
          </p>
          {thread.peerNote.imageAssetId ? (
            <img
              src={noteImageUrl(thread.peerNote.imageAssetId)}
              alt="纸条配图"
              loading="lazy"
              className="mt-2 max-h-40 rounded-lg object-cover"
            />
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex-1 space-y-2.5 pb-4">
        {loading ? (
          <p className="py-8 text-center text-sm text-[var(--survey-muted)]">加载中…</p>
        ) : messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--survey-muted)]">还没有人说话，打个招呼吧</p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={message.mine ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-sm leading-6 ${
                  message.mine
                    ? "bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                    : "border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-[var(--survey-body)] select-none"
                }`}
                /* 对方消息可长按（移动端）/右键（桌面）呼出「举报此消息 / 拉黑对方」；
                   自己的消息与已拉黑态不响应。 */
                onPointerDown={message.mine ? undefined : () => startPress(message)}
                onPointerUp={message.mine ? undefined : clearPress}
                onPointerLeave={message.mine ? undefined : clearPress}
                onPointerCancel={message.mine ? undefined : clearPress}
                onContextMenu={
                  message.mine
                    ? undefined
                    : (event) => {
                        event.preventDefault();
                        if (!blocked) setMessageMenu({ id: message.id, body: message.body });
                      }
                }
              >
                {message.body ? <p className="whitespace-pre-wrap break-words">{message.body}</p> : null}
                {message.imageAssetId ? (
                  <img
                    src={noteImageUrl(message.imageAssetId)}
                    alt="消息图片"
                    loading="lazy"
                    className="mt-1 max-h-48 rounded-lg object-cover"
                  />
                ) : null}
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-20 lg:bottom-2">
        {gate.readonly ? (
          <div className={`${CARD} px-4 py-3 text-center text-xs text-[var(--survey-muted)]`}>
            <p>{gate.reason === "blocked" ? "已拉黑对方，会话只读。" : "这张纸条已下架，会话只读。"}</p>
            {gate.unblockable ? (
              <button
                type="button"
                className={`${BTN_GHOST} mt-2 text-xs`}
                disabled={actionBusy}
                onClick={() => void unblockPartner()}
              >
                {actionBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                解除拉黑
              </button>
            ) : null}
          </div>
        ) : (
          <div className={`${CARD} flex items-end gap-2 p-2`}>
            <label className="survey-icon-btn h-9 w-9 shrink-0 cursor-pointer" aria-label="发送图片">
              <ImagePlus className="h-4 w-4" />
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  setSending(true);
                  setError(null);
                  try {
                    const result = await uploadNoteImage(file);
                    setImageAssetId(result.assetId);
                  } catch (err) {
                    setError(err instanceof NoteApiError ? err.message : "图片上传失败");
                  } finally {
                    setSending(false);
                  }
                }}
              />
            </label>
            <textarea
              value={draft}
              rows={1}
              maxLength={500}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={imageAssetId ? "图片已就绪，可补一句话…" : "说点什么…"}
              className="max-h-24 min-h-9 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm text-[var(--survey-body)] outline-none"
            />
            <button
              type="button"
              className="survey-icon-btn h-9 w-9 shrink-0"
              aria-label="发送"
              disabled={sending || (!draft.trim() && !imageAssetId)}
              onClick={() => void send()}
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        )}
        {error ? <p className="mt-1 text-center text-xs text-[var(--app-danger)]">{error}</p> : null}
      </div>

      {/* 头部「⋯」：会话级动作（拉黑/解除拉黑）。 */}
      {headerMenu ? (
        <ChatActionSheet
          title="会话操作"
          onClose={() => setHeaderMenu(false)}
          actions={
            blocked
              ? [
                  {
                    label: "解除拉黑对方",
                    icon: <ShieldCheck className="h-4 w-4" aria-hidden="true" />,
                    disabled: actionBusy,
                    onClick: () => {
                      setHeaderMenu(false);
                      void unblockPartner();
                    },
                  },
                ]
              : [
                  {
                    label: "拉黑对方",
                    icon: <Ban className="h-4 w-4" aria-hidden="true" />,
                    danger: true,
                    disabled: actionBusy,
                    onClick: () => {
                      setHeaderMenu(false);
                      void blockPartner();
                    },
                  },
                ]
          }
        />
      ) : null}

      {/* 长按对方消息：举报单条 + 会话级拉黑。 */}
      {messageMenu ? (
        <ChatActionSheet
          title={messageMenu.body ? `消息：${messageMenu.body.slice(0, 40)}` : "对方的消息"}
          onClose={() => setMessageMenu(null)}
          actions={[
            {
              label: "举报此消息",
              icon: <Flag className="h-4 w-4" aria-hidden="true" />,
              disabled: actionBusy,
              onClick: () => {
                const target = messageMenu;
                setMessageMenu(null);
                if (target) openReport(target);
              },
            },
            {
              label: "拉黑对方",
              icon: <Ban className="h-4 w-4" aria-hidden="true" />,
              danger: true,
              disabled: actionBusy,
              onClick: () => {
                setMessageMenu(null);
                void blockPartner();
              },
            },
          ]}
        />
      ) : null}

      {/* 举报理由弹层：必填、≤200 字（与服务端截断口径一致）。 */}
      {reportTarget ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-5"
          role="dialog"
          aria-label="举报此消息"
        >
          <div className={`${CARD} w-full max-w-sm p-5 shadow-2xl`}>
            <div className="flex items-start justify-between">
              <h3 className="text-sm font-bold text-[var(--survey-heading)]">举报此消息</h3>
              <button
                type="button"
                aria-label="关闭举报"
                className="survey-icon-btn h-8 w-8"
                disabled={actionBusy}
                onClick={() => setReportTarget(null)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {reportTarget.body ? (
              <p className="mt-2 line-clamp-3 rounded-xl bg-[var(--survey-bg)] px-3 py-2 text-xs leading-5 text-[var(--survey-muted)]">
                {reportTarget.body}
              </p>
            ) : null}
            <div className="mt-3 flex items-center justify-between">
              <p className="text-xs font-semibold text-[var(--survey-muted)]">举报理由（必填）</p>
              <span className="text-[11px] tabular-nums text-[var(--survey-muted)]">
                {reportReason.trim().length}/{REPORT_REASON_MAX}
              </span>
            </div>
            <textarea
              value={reportReason}
              rows={3}
              maxLength={REPORT_REASON_MAX}
              onChange={(event) => {
                setReportReason(event.target.value);
                setReportError(null);
              }}
              placeholder="说说这条消息的问题…"
              className="mt-1.5 w-full resize-none rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-bg)] p-3 text-sm leading-6 text-[var(--survey-body)] outline-none focus:border-[var(--survey-primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--survey-primary)_30%,transparent)]"
            />
            {reportError ? <p className="mt-1 text-xs text-[var(--app-danger)]">{reportError}</p> : null}
            <button
              type="button"
              className={`${BTN_PRIMARY} mt-3 w-full`}
              disabled={actionBusy}
              onClick={() => void submitReport()}
            >
              {actionBusy ? "提交中…" : "提交举报"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChatTab() {
  const [threads, setThreads] = useState<NoteThreadDto[] | null>(null);
  // 深链会话 id 解析走 note-tab.ts 纯函数（与 initialNoteTab 同口径）。
  const [openThreadId, setOpenThreadId] = useState<number | null>(() => threadIdFromSearch(window.location.search));

  const reload = useCallback(() => {
    void fetchNoteThreads()
      .then((result) => setThreads(result.threads))
      .catch(() => setThreads([]));
  }, []);

  useEffect(reload, [reload]);

  const openThread = useMemo(
    () => threads?.find((thread) => thread.id === openThreadId) ?? null,
    [threads, openThreadId],
  );

  if (openThreadId !== null) {
    if (!threads) return <p className="py-10 text-center text-sm text-[var(--survey-muted)]">加载中…</p>;
    if (openThread)
      return (
        <ChatView
          thread={openThread}
          onBack={() => {
            // 返回列表即重拉：拉黑后 listThreads 读侧双向过滤会让会话消失，
            // 解除拉黑后恢复可见（ChatView 解除时也经 onUnblocked 触发同一 reload）。
            setOpenThreadId(null);
            reload();
          }}
          onUnblocked={reload}
        />
      );
  }

  return (
    <div className="space-y-3">
      {threads === null ? (
        <p className="py-10 text-center text-sm text-[var(--survey-muted)]">加载中…</p>
      ) : threads.length === 0 ? (
        <div className={`${CARD} p-8 text-center`}>
          <p className="text-sm text-[var(--survey-body)]">还没有会话</p>
          <p className="mt-1 text-xs text-[var(--survey-muted)]">抽到别人的纸条后，这里就会出现对话。</p>
        </div>
      ) : (
        threads.map((thread) => (
          <button
            key={thread.id}
            type="button"
            onClick={() => setOpenThreadId(thread.id)}
            className={`${CARD} flex w-full items-center gap-3 px-4 py-3.5 text-left transition-[transform,box-shadow] duration-[var(--fx-dur)] ease-[var(--fx-ease)] hover:-translate-y-0.5 hover:shadow-[var(--fx-glow-md)]`}
          >
            <NoteAvatar gender={thread.role === "drawer" ? (thread.peerNote?.gender ?? "x") : "x"} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-[13px] font-bold text-[var(--survey-heading)]">
                  {thread.role === "drawer" ? "你抽中的纸条" : "你的纸条被抽中了"}
                </span>
                {thread.unread > 0 ? (
                  <span className="rounded-full bg-[var(--survey-primary)] px-1.5 py-0.5 text-[10px] font-black tabular-nums text-[var(--survey-primary-content)]">
                    {thread.unread}
                  </span>
                ) : null}
                {thread.noteStatus !== "active" ? (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-[var(--survey-muted)]">
                    <EyeOff className="h-3 w-3" aria-hidden="true" />
                    只读
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block truncate text-xs text-[var(--survey-muted)]">
                {thread.lastBody ?? "（还没有消息）"}
              </span>
            </span>
          </button>
        ))
      )}
    </div>
  );
}

/* ---------------- 屏幕外壳 ---------------- */

export function NoteScreen() {
  const [me, setMe] = useState<NoteMeDto | null>(null);
  const [loadError, setLoadError] = useState(false);
  // 深链修正（T2）：?thread= 存在即落 chat——此前页签默认 mine，CoinCenter
  // 抽中后的 /notes?thread=X 深链会落在「我的纸条」页。
  const [tab, setTab] = useState<Tab>(() => initialNoteTab(window.location.search));

  const reload = useCallback(() => {
    void fetchNoteMe()
      .then(setMe)
      .catch(() => setLoadError(true));
  }, []);

  useEffect(reload, [reload]);
  const themeState = usePublicTheme();

  return (
    <ScreenShell themeState={themeState}>
      <PageHeader title="纸条聊天" subtitle="放一张纸条 · 抽一段缘分 · 聊聊看" wide={false} />
      <main className="mx-auto max-w-xl px-5 pt-4 lg:max-w-3xl">
        {loadError ? (
          <ErrorState message="纸条功能加载失败" onRetry={reload} retryLabel="重新加载" />
        ) : me === null ? (
          <LoadingState label="正在加载纸条" rows={2} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-1.5" role="tablist" aria-label="纸条页面切换">
              {(
                [
                  { id: "mine", label: "我的纸条" },
                  { id: "chat", label: "对话" },
                ] as const
              ).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.id}
                  onClick={() => setTab(entry.id)}
                  className={`min-h-10 rounded-[var(--survey-button-radius)] border text-[13px] font-semibold transition-colors ${
                    tab === entry.id
                      ? "border-transparent bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                      : "border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] text-[var(--survey-body)]"
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            {/* 对话页签挂载 ChatTab（此前遗漏过：页签可点但内容空白）；
                深链落 chat 的推导见 note-tab.ts（?thread= 存在即落 chat）。 */}
            <div className="mt-4">{tab === "mine" ? <MineTab me={me} onReload={reload} /> : <ChatTab />}</div>
          </>
        )}
      </main>
    </ScreenShell>
  );
}
