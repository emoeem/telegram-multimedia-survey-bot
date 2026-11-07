import { useState } from "react";
import {
  ApiError,
  fetchAdminNotes,
  fetchAdminReportedMessages,
  setAdminMessageStatus,
  setAdminNoteStatus,
  type NoteAdminMessage,
  type NoteAdminSummary,
  type NoteAdminView,
} from "../api";
import { useApi } from "../hooks";
import { useDialogs } from "../components/Dialogs";
import { EmptyPanel, ErrorPanel, PageHeader, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";

/**
 * 纸条复核（T1 + T2 0094）：被举报达阈值自动 hidden、各状态纸条的运营处置，
 * 以及会话消息的举报复核（消息举报不设自动隐藏阈值，全部人工处置）。
 *
 * 纸条只调 note-api 的既有管理端点（GET /api/note/admin/notes?status=…、
 * POST /api/note/admin/notes/:id/status）；消息页签调 0094 新增的
 * GET /api/note/admin/messages?reported=1 与
 * POST /api/note/admin/messages/:id/status（服务端写 writeAudit）。
 * 页面结构沿用 PlazaPostsPage 的「列表 + 状态切换」模式；列表接口 LIMIT 50
 * 且无分页参数，所以没有翻页控件。V1 不展示配图：纸条接口 SELECT 无
 * image_asset_id。
 */

type Tab = "notes" | "messages";

/** hidden（被举报/隐藏）是复核主入口，默认落在这里。 */
const VIEWS: Array<{ id: NoteAdminView; label: string }> = [
  { id: "hidden", label: "被举报/隐藏" },
  { id: "active", label: "展示中" },
  { id: "removed", label: "已移除" },
  { id: "expired", label: "已过期" },
  { id: "withdrawn", label: "已撤回" },
];

const NOTE_STATUS_LABELS: Record<NoteAdminView, string> = {
  hidden: "被举报隐藏",
  active: "展示中",
  removed: "已移除",
  expired: "已过期",
  withdrawn: "已撤回",
};

const MESSAGE_STATUS_LABELS: Record<NoteAdminMessage["status"], string> = {
  active: "展示中",
  hidden: "已隐藏",
};

/** 与用户侧 NoteScreen 的性别文案保持一致。 */
const GENDER_LABELS: Record<string, string> = { m: "男生", f: "女生", x: "保密" };

function genderLabel(gender: string): string {
  return GENDER_LABELS[gender] ?? gender;
}

/**
 * 各状态可用的处置动作（目标状态仅支持 active / removed，note-api.ts:152）：
 * hidden/expired/withdrawn 恢复与移除都给，active 只能移除，removed 只能恢复。
 */
function actionsOf(status: NoteAdminView): Array<{ to: "active" | "removed"; label: string; primary: boolean }> {
  if (status === "active") return [{ to: "removed", label: "移除", primary: false }];
  if (status === "removed") return [{ to: "active", label: "恢复展示", primary: true }];
  return [
    { to: "active", label: "恢复展示", primary: true },
    { to: "removed", label: "移除", primary: false },
  ];
}

function NoteRow({
  note,
  busy,
  onAction,
}: {
  note: NoteAdminSummary;
  busy: boolean;
  onAction: (note: NoteAdminSummary, status: "active" | "removed") => void;
}) {
  return (
    <article className={note.status === "active" ? "card" : "card opacity-80"}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--color-ink)]">
            #{note.id}
            <span className="ml-2 badge badge-gray">{NOTE_STATUS_LABELS[note.status] ?? note.status}</span>
          </p>
          <p className="text-xs text-[var(--color-muted)]">
            {formatDateTime(note.createdAt)} · 举报 {note.reportCount} 次 · 到期 {formatDateTime(note.expiresAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actionsOf(note.status).map((action) => (
            <button
              key={action.to}
              type="button"
              disabled={busy}
              onClick={() => onAction(note, action.to)}
              className={action.primary ? "btn btn-primary btn-sm" : "btn btn-sm"}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--color-ink)]">{note.content}</p>
      <p className="mt-2 text-xs text-[var(--color-muted)]">
        {genderLabel(note.gender)} · {note.ageBand} 岁{note.region ? ` · ${note.region}` : ""}
      </p>
    </article>
  );
}

/** 消息处置动作与纸条同款（目标状态 active / hidden，note-api adminSetMessageStatus）。 */
function messageActionsOf(status: NoteAdminMessage["status"]): Array<{ to: "active" | "hidden"; label: string }> {
  return status === "active" ? [{ to: "hidden", label: "隐藏" }] : [{ to: "active", label: "恢复展示" }];
}

function MessageRow({
  message,
  busy,
  onAction,
}: {
  message: NoteAdminMessage;
  busy: boolean;
  onAction: (message: NoteAdminMessage, status: "active" | "hidden") => void;
}) {
  return (
    <article className={message.status === "active" ? "card" : "card opacity-80"}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--color-ink)]">
            消息 #{message.id}
            <span className="ml-2 badge badge-gray">{MESSAGE_STATUS_LABELS[message.status] ?? message.status}</span>
          </p>
          <p className="text-xs text-[var(--color-muted)]">
            会话 #{message.threadId} · 举报 {message.reportCount} 次 · 最近 {formatDateTime(message.lastReportAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {messageActionsOf(message.status).map((action) => (
            <button
              key={action.to}
              type="button"
              disabled={busy}
              onClick={() => onAction(message, action.to)}
              className={action.to === "active" ? "btn btn-primary btn-sm" : "btn btn-sm"}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--color-ink)]">{message.body}</p>
      {message.lastReason ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">最近举报理由：{message.lastReason}</p>
      ) : null}
    </article>
  );
}

export function NoteReviewPage() {
  const [tab, setTab] = useState<Tab>("notes");
  const [view, setView] = useState<NoteAdminView>("hidden");
  const { toast } = useDialogs();
  // 两个页签各挂一个 useApi，非当前页签传 null 暂停拉取（hooks.ts 支持 null path）。
  const notesQuery = useApi<{ ok: boolean; notes: NoteAdminSummary[] }>(
    tab === "notes" ? `/api/note/admin/notes?status=${view}` : null,
  );
  const messagesQuery = useApi<{ ok: boolean; messages: NoteAdminMessage[] }>(
    tab === "messages" ? "/api/note/admin/messages?reported=1" : null,
  );
  const [busyId, setBusyId] = useState<number | null>(null);

  const act = async (id: number, request: () => Promise<unknown>, fallbackMessage: string) => {
    if (busyId !== null) return;
    setBusyId(id);
    try {
      await request();
      if (tab === "notes") notesQuery.retry();
      else messagesQuery.retry();
    } catch (requestError) {
      // 409 owner_has_new_note：「1 人 1 张」唯一索引拦截了纸条恢复。服务端
      // 文案已明确，这里再兜一层固定提示，避免运营只看到笼统的请求失败。
      const message =
        requestError instanceof ApiError && requestError.data?.code === "owner_has_new_note"
          ? "作者已放了新纸条，不能恢复这张"
          : requestError instanceof Error
            ? requestError.message
            : fallbackMessage;
      toast({ message, variant: "error" });
      if (tab === "notes") notesQuery.retry();
      else messagesQuery.retry();
    } finally {
      setBusyId(null);
    }
  };

  const notes = notesQuery.data?.notes ?? [];
  const messages = messagesQuery.data?.messages ?? [];
  const activeQuery = tab === "notes" ? notesQuery : messagesQuery;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="纸条复核"
        actions={
          <div className="flex flex-wrap gap-2">
            {tab === "notes"
              ? VIEWS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setView(option.id)}
                    className={view === option.id ? "btn btn-sm btn-primary" : "btn btn-sm"}
                  >
                    {option.label}
                  </button>
                ))
              : null}
            <button
              type="button"
              onClick={() => setTab(tab === "messages" ? "notes" : "messages")}
              className={tab === "messages" ? "btn btn-sm btn-primary" : "btn btn-sm"}
            >
              消息举报
            </button>
          </div>
        }
      />
      {activeQuery.error ? (
        <ErrorPanel error={activeQuery.error} onRetry={activeQuery.retry} />
      ) : !activeQuery.data ? (
        <SkeletonPanel lines={6} />
      ) : tab === "notes" ? (
        notes.length === 0 ? (
          <EmptyPanel text="这个状态下暂无纸条。被举报达到阈值的纸条会自动隐藏并出现在「被举报/隐藏」里。" />
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {notes.map((note) => (
                <NoteRow
                  key={note.id}
                  note={note}
                  busy={busyId === note.id}
                  onAction={(target, status) =>
                    void act(note.id, () => setAdminNoteStatus(target.id, status), "操作失败，请重试")
                  }
                />
              ))}
            </div>
            <p className="text-xs text-[var(--color-muted)]">共 {notes.length} 条（服务端每次最多列出 50 条）</p>
          </>
        )
      ) : messages.length === 0 ? (
        <EmptyPanel text="暂无被举报的会话消息。消息不设自动隐藏阈值，举报后在这里人工复核处置。" />
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                busy={busyId === message.id}
                onAction={(target, status) =>
                  void act(message.id, () => setAdminMessageStatus(target.id, status), "操作失败，请重试")
                }
              />
            ))}
          </div>
          <p className="text-xs text-[var(--color-muted)]">
            共 {messages.length} 条（服务端每次最多列出 50 条）。隐藏为软删：用户侧立即不可见，会话内消息计数保持原值，
            随时可在这里恢复。
          </p>
        </>
      )}
    </div>
  );
}
