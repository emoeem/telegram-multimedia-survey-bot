/**
 * 网页投稿审核（免登录投稿，来自投稿机器人 Worker）。
 *
 * 这条审核流原本**只**存在于 Telegram 审核群里：投稿机器人把卡片发到
 * ADMIN_CHAT_ID，管理员点「通过 / 拒绝」。现在这里也有一个入口，但审核逻辑
 * 没有第二份 —— 全部走投稿机器人的 `/api/admin/review/*`，而它内部调的还是
 * `bot.approveSubmission`，和群里点按钮共用同一套投稿级租约。
 *
 * 之所以要共用：如果两边各实现一遍「标记通过 + 发布到频道」，群里点一次、后台
 * 点一次就会发两条。租约是为跨端并发设计的，不能被绕过。
 *
 * 浏览器拿不到那把共享密钥：请求先到本站 Worker，它验证管理员会话，再带
 * `x-review-secret` 转发（见 src/http/admin/web-submission.ts）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiBlob, apiSend } from "../api";
import { useApi } from "../hooks";
import { useDialogs } from "../components/Dialogs";
import { EmptyPanel, ErrorPanel, Modal, PageHeader, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";

interface WebSubmissionSummary {
  id: number;
  status: string;
  nickname: string;
  fullName: string;
  email: string;
  flags: string[];
  createdAt: number | null;
  publishedAt: number | null;
  attachments: { kind: string; name: string | null }[];
  preview: string;
}

interface WebSubmissionList {
  ok: boolean;
  total: number;
  limit: number;
  offset: number;
  items: WebSubmissionSummary[];
}

interface WebSubmissionDetail {
  ok: boolean;
  submission: {
    id: number;
    status: string;
    nickname: string;
    fullName: string;
    email: string;
    ip: string;
    flags: string[];
    createdAt: number | null;
    publishedAt: number | null;
    attachments: { kind: string; name: string | null }[];
    text: string;
  };
}

type StatusFilter = "pending" | "published" | "rejected" | "all";

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "pending", label: "待审" },
  { id: "published", label: "已发布" },
  { id: "rejected", label: "已驳回" },
  { id: "all", label: "全部" },
];

const STATUS_LABEL: Record<string, string> = {
  pending: "待审",
  published: "已发布",
  rejected: "已驳回",
  publishing: "发布中",
  failed: "发布失败",
  recalled: "已撤回",
};

function statusTone(status: string): string {
  switch (status) {
    case "pending":
      return "bg-amber-500/12 text-amber-700 dark:text-amber-400";
    case "published":
      return "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400";
    case "rejected":
      return "bg-rose-500/12 text-rose-700 dark:text-rose-400";
    default:
      return "bg-slate-500/12 text-slate-600 dark:text-slate-300";
  }
}

const MEDIA_LABEL: Record<string, string> = {
  photo: "图片",
  video: "视频",
  document: "文件",
  audio: "音频",
  voice: "语音",
  location: "位置",
  poll: "投票",
};

function mediaLabel(kind: string): string {
  return MEDIA_LABEL[kind] ?? kind;
}

function mediaEndpoint(submissionId: number, index: number): string {
  return `/api/admin/web-submissions/media?submission=${submissionId}&index=${index}`;
}

/**
 * 一个附件格子。
 *
 * 为什么要绕一层 Blob：后端鉴权走的是自定义请求头（x-telegram-init-data 等），
 * `<img src="…">` 带不了请求头，直接写 URL 必然 401。所以先 fetch 成 Blob，再
 * `URL.createObjectURL`。代价是必须自己 revoke —— 不然每展开一条投稿就多一份
 * 完整图片的内存，翻十条就能把标签页拖垮。
 *
 * 只有 photo / video 会预取。document / audio 这类点开才拉，一份 15MB 的 PDF
 * 不该因为展开详情就被无条件下载一遍。
 */
/**
 * 附件字节的唯一持有者。只做三件事：懒加载、复用、释放。
 *
 * - 懒加载：只有 photo 在展开详情时自动拉。一个带 6 段 10MB 视频的投稿，如果
 *   6 个格子同时预取，就是 60MB 一口气进内存，标签页会直接卡住。
 * - 复用：点「下载」不再重新请求一次 —— 请求带自定义鉴权头，浏览器的 HTTP
 *   缓存基本命中不了，重拉就是实打实的第二次下载。
 * - 释放：objectURL 不 revoke 就是一份永不回收的完整文件。
 */
function useMediaBlob(submissionId: number, index: number) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const urlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

  const load = useCallback(async () => {
    if (urlRef.current) return urlRef.current;
    setState("loading");
    try {
      const blob = await apiBlob(mediaEndpoint(submissionId, index));
      const objectUrl = URL.createObjectURL(blob);
      urlRef.current = objectUrl;
      setUrl(objectUrl);
      setState("ready");
      return objectUrl;
    } catch {
      setState("error");
      return null;
    }
  }, [submissionId, index]);

  return { url, state, load };
}

function AttachmentTile({
  submissionId,
  index,
  kind,
  name,
}: {
  submissionId: number;
  index: number;
  kind: string;
  name: string | null;
}) {
  const { url, state, load } = useMediaBlob(submissionId, index);
  const [zoom, setZoom] = useState(false);
  const isPhoto = kind === "photo";
  const isVideo = kind === "video";

  /* 图片自动拉：它本身就是审核要看的东西，等一次点击太慢。
   * 视频不自动拉 —— 点播放的时候人已经知道自己在要什么了。 */
  useEffect(() => {
    if (isPhoto) void load();
  }, [isPhoto, load]);

  const download = useCallback(async () => {
    const target = await load();
    if (!target) return;
    const anchor = document.createElement("a");
    anchor.href = target;
    anchor.download = name ?? `attachment-${index + 1}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }, [load, name, index]);

  const caption = name || `${mediaLabel(kind)} ${index + 1}`;
  const hint =
    state === "loading" ? "加载中…" : state === "error" ? "预览失败" : isVideo ? "点击播放" : "点此下载";

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--surface-muted)]">
      {url && isPhoto ? (
        <button type="button" className="block w-full" onClick={() => setZoom(true)} title="点击看大图">
          <img src={url} alt={caption} className="h-28 w-full object-cover" />
        </button>
      ) : url && isVideo ? (
        <video
          src={url}
          className="h-28 w-full bg-black object-contain"
          controls
          playsInline
          preload="metadata"
        />
      ) : (
        <button
          type="button"
          className="flex h-28 w-full items-center justify-center text-[12px] text-[var(--color-muted)] disabled:opacity-60"
          disabled={state === "loading"}
          onClick={() => void (isPhoto || isVideo ? load() : download())}
        >
          {hint}
        </button>
      )}
      <div className="flex items-center justify-between gap-1 px-2 py-1 text-[11px] text-[var(--color-muted)]">
        <span className="truncate" title={caption}>
          {caption}
        </span>
        <button type="button" className="shrink-0 underline" onClick={() => void download()}>
          下载
        </button>
      </div>

      {isPhoto ? (
        <Modal open={zoom} onClose={() => setZoom(false)} title={caption} size="xl">
          {url ? <img src={url} alt={caption} className="mx-auto max-h-[70vh] object-contain" /> : null}
        </Modal>
      ) : null}
    </div>
  );
}

/** 附件网格。列表里只给数量，展开详情才渲染 —— 缩略图是要真去拉字节的。 */
function AttachmentGrid({ submissionId, attachments }: { submissionId: number; attachments: { kind: string; name: string | null }[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-[13px] text-[var(--color-muted)]">
        附件 {attachments.length} 个
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {attachments.map((item, index) => (
          <AttachmentTile
            // 附件没有稳定 id，同一投稿内序号就是身份。
            key={`${submissionId}-${index}`}
            submissionId={submissionId}
            index={index}
            kind={item.kind}
            name={item.name}
          />
        ))}
      </div>
    </div>
  );
}

function authorLabel(item: { nickname: string; fullName: string; email: string }): string {
  return item.nickname || item.fullName || item.email || "网页访客";
}

/** 投稿机器人把时间存成 unix 秒（D1 的 INTEGER），formatDateTime 认 ISO 字符串。 */
function formatUnix(seconds: number | null): string {
  if (!seconds) return "-";
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? "-" : formatDateTime(date.toISOString());
}

/** 一条投稿的详情（展开时才拉，列表里不带全文）。 */
function DetailBlock({ id, onChanged }: { id: number; onChanged: () => void }) {
  const { data, error, loading, retry } = useApi<WebSubmissionDetail>(`/api/admin/web-submissions/detail?id=${id}`);
  const { toast } = useDialogs();
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [replyText, setReplyText] = useState("");

  const detail = data?.submission;

  const act = useCallback(
    async (path: "/approve" | "/reject" | "/reply", body: Record<string, unknown>, done: string) => {
      setBusy(true);
      try {
        await apiSend("POST", `/api/admin/web-submissions${path}`, body);
        toast({ message: done, variant: "success" });
        onChanged();
      } catch (actionError) {
        toast({
          message: actionError instanceof Error ? actionError.message : "操作失败",
          variant: "error",
        });
      } finally {
        setBusy(false);
      }
    },
    [onChanged, toast],
  );

  if (loading && !detail) return <SkeletonPanel lines={3} />;
  if (error && !detail) return <ErrorPanel error={error} onRetry={retry} />;
  if (!detail) return null;

  const actionable = detail.status === "pending" || detail.status === "failed";

  return (
    <div className="mt-4 space-y-3 border-t border-[var(--color-edge)] pt-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-4">
        <div>
          <dt className="text-[var(--color-muted)]">投稿人</dt>
          <dd className="truncate font-medium">{authorLabel(detail)}</dd>
        </div>
        <div>
          <dt className="text-[var(--color-muted)]">邮箱</dt>
          <dd className="truncate font-medium">{detail.email || "（未留）"}</dd>
        </div>
        <div>
          <dt className="text-[var(--color-muted)]">来源 IP</dt>
          <dd className="truncate font-medium">{detail.ip || "—"}</dd>
        </div>
        <div>
          <dt className="text-[var(--color-muted)]">时间</dt>
          <dd className="truncate font-medium">{formatUnix(detail.createdAt)}</dd>
        </div>
      </dl>

      {detail.flags.length > 0 ? (
        <p className="text-[13px] text-rose-600 dark:text-rose-400">
          命中：{detail.flags.join("、")}
        </p>
      ) : null}

      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-[var(--surface-muted)] p-3 text-[13px] leading-relaxed">
        {detail.text || "（没有正文）"}
      </pre>

      <AttachmentGrid submissionId={detail.id} attachments={detail.attachments} />

      <div className="flex flex-wrap gap-2">
        {actionable ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => void act("/approve", { id: detail.id }, "已通过并发布")}
            >
              通过并发布
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setRejectOpen(true)}>
              驳回
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => {
            setReplyText("");
            setReplyOpen(true);
          }}
        >
          回复投稿者
        </button>
      </div>

      <Modal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title={`驳回投稿 #${detail.id}`}
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn-sm" onClick={() => setRejectOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => {
                void act("/reject", { id: detail.id, reason }, "已驳回").then(() => setRejectOpen(false));
              }}
            >
              确认驳回
            </button>
          </>
        }
      >
        <label className="block text-[13px] font-medium" htmlFor="reject-reason">
          理由（会发给投稿者，可留空）
        </label>
        <textarea
          id="reject-reason"
          className="input mt-2 min-h-24 w-full p-2"
          value={reason}
          maxLength={300}
          onChange={(event) => setReason(event.target.value)}
          placeholder="例如：内容不符合栏目定位"
        />
      </Modal>

      <Modal
        open={replyOpen}
        onClose={() => setReplyOpen(false)}
        title={`回复投稿 #${detail.id}`}
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn-sm" onClick={() => setReplyOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || replyText.trim().length === 0}
              onClick={() => {
                void act("/reply", { id: detail.id, text: replyText }, "已发送").then(() => setReplyOpen(false));
              }}
            >
              发送
            </button>
          </>
        }
      >
        <label className="block text-[13px] font-medium" htmlFor="reply-text">
          内容（投稿者会在收件箱看到；留了邮箱还会收到邮件）
        </label>
        <textarea
          id="reply-text"
          className="input mt-2 min-h-24 w-full p-2"
          value={replyText}
          maxLength={800}
          onChange={(event) => setReplyText(event.target.value)}
          placeholder="例如：照片很清晰，能补一张竖版的吗？"
        />
      </Modal>
    </div>
  );
}

export function WebSubmissionsPage() {
  const [filter, setFilter] = useState<StatusFilter>("pending");
  const [expanded, setExpanded] = useState<number | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: "50" });
    if (filter !== "all") params.set("status", filter);
    return `/api/admin/web-submissions/list?${params.toString()}`;
  }, [filter]);

  const { data, error, loading, retry } = useApi<WebSubmissionList>(query);
  const counts = useApi<{ ok: boolean; pending: number; total: number }>("/api/admin/web-submissions/count");

  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="📥 网页投稿"
        actions={
          <>
            {counts.data ? (
              <span className="text-[13px] text-[var(--color-muted)]">
                待审 {counts.data.pending} · 共 {counts.data.total}
              </span>
            ) : null}
            <button type="button" className="btn btn-sm" onClick={retry}>
              刷新
            </button>
          </>
        }
      />

      <p className="mb-4 text-[13px] text-[var(--color-muted)]">
        免登录投稿（<code>/submit</code>）。审核逻辑和 Telegram 审核群共用同一套：
        在这里点「通过」，群里那张卡片会失效，不会重复发布。
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={filter === entry.id ? "btn btn-primary btn-sm" : "btn btn-sm"}
            onClick={() => {
              setFilter(entry.id);
              setExpanded(null);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {error ? <ErrorPanel error={error} onRetry={retry} /> : null}
      {!error && loading && !data ? <SkeletonPanel lines={5} /> : null}

      {!error && data && items.length === 0 ? (
        <EmptyPanel
          text={
            filter === "pending" ? "没有待审的网页投稿。" : "这个筛选下还没有投稿。"
          }
        />
      ) : null}

      <div className="space-y-3">
        {items.map((item) => {
          const open = expanded === item.id;
          return (
            <article key={item.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`badge px-2 py-0.5 text-[12px] font-semibold ${statusTone(item.status)}`}>
                      {STATUS_LABEL[item.status] ?? item.status}
                    </span>
                    <span className="text-[13px] font-semibold">#{item.id}</span>
                    <span className="truncate text-[13px]">{authorLabel(item)}</span>
                    {item.attachments.length > 0 ? (
                      <span className="text-[12px] text-[var(--color-muted)]">
                        {item.attachments.length} 个附件
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[13px] text-[var(--color-muted)]">{item.preview}</p>
                  <p className="mt-1 text-[12px] text-[var(--color-muted)]">
                    {formatUnix(item.createdAt)}
                    {item.email ? ` · ${item.email}` : ""}
                  </p>
                </div>
                <button type="button" className="btn btn-sm shrink-0" onClick={() => setExpanded(open ? null : item.id)}>
                  {open ? "收起" : "查看"}
                </button>
              </div>
              {open ? <DetailBlock id={item.id} onChanged={retry} /> : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
