import { useState } from "react";
import { ApiError, fetchAdminNotes, setAdminNoteStatus, type NoteAdminSummary, type NoteAdminView } from "../api";
import { useApi } from "../hooks";
import { useDialogs } from "../components/Dialogs";
import { EmptyPanel, ErrorPanel, PageHeader, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";

/**
 * 纸条复核（T1）：被举报达阈值自动 hidden、以及各状态纸条的运营处置页。
 *
 * 只调 note-api 的既有管理端点（GET /api/note/admin/notes?status=…、
 * POST /api/note/admin/notes/:id/status），零新服务端 API。页面结构沿用
 * PlazaPostsPage 的「列表 + 状态切换」模式；列表接口 LIMIT 50 且无分页参数，
 * 所以没有翻页控件。V1 不展示配图：该接口 SELECT 无 image_asset_id。
 */

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

export function NoteReviewPage() {
  const [view, setView] = useState<NoteAdminView>("hidden");
  const { toast } = useDialogs();
  const { data, error, retry } = useApi<{ ok: boolean; notes: NoteAdminSummary[] }>(
    `/api/note/admin/notes?status=${view}`,
  );
  const [busyId, setBusyId] = useState<number | null>(null);

  const act = async (note: NoteAdminSummary, status: "active" | "removed") => {
    if (busyId !== null) return;
    setBusyId(note.id);
    try {
      await setAdminNoteStatus(note.id, status);
      retry();
    } catch (requestError) {
      // 409 owner_has_new_note：「1 人 1 张」唯一索引拦截了恢复。服务端
      // 文案已明确，这里再兜一层固定提示，避免运营只看到笼统的请求失败。
      const message =
        requestError instanceof ApiError && requestError.data?.code === "owner_has_new_note"
          ? "作者已放了新纸条，不能恢复这张"
          : requestError instanceof Error
            ? requestError.message
            : "操作失败，请重试";
      toast({ message, variant: "error" });
      retry();
    } finally {
      setBusyId(null);
    }
  };

  const notes = data?.notes ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="纸条复核"
        actions={
          <div className="flex flex-wrap gap-2">
            {VIEWS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setView(option.id)}
                className={view === option.id ? "btn btn-sm" : "btn btn-sm"}
              >
                {option.label}
              </button>
            ))}
          </div>
        }
      />
      {error ? (
        <ErrorPanel error={error} onRetry={retry} />
      ) : !data ? (
        <SkeletonPanel lines={6} />
      ) : notes.length === 0 ? (
        <EmptyPanel text="这个状态下暂无纸条。被举报达到阈值的纸条会自动隐藏并出现在「被举报/隐藏」里。" />
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {notes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                busy={busyId === note.id}
                onAction={(target, status) => void act(target, status)}
              />
            ))}
          </div>
          <p className="text-xs text-[var(--color-muted)]">共 {notes.length} 条（服务端每次最多列出 50 条）</p>
        </>
      )}
    </div>
  );
}
