import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { X } from "lucide-react";
import { api, apiSend, setUserBan, userChatLink, type UserDetailData, type UserDirectoryData } from "../api";
import { useApi } from "../hooks";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";
import { useDialogs } from "../components/Dialogs";
import { formatDateTime } from "../format";

function displayName(item: {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  telegramUserId: number;
}): string {
  const name = [item.firstName, item.lastName].filter(Boolean).join(" ");
  return name || item.username || `用户 ${item.telegramUserId}`;
}

const RESPONSE_STATUS_TEXT: Record<string, string> = {
  completed: "已完成",
  in_progress: "填写中",
  abandoned: "已放弃",
  cancelled: "已取消",
  archived: "已归档",
};

export function UsersPage() {
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const { confirm } = useDialogs();

  const [detail, setDetail] = useState<UserDetailData | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [newTag, setNewTag] = useState("");
  const [banReason, setBanReason] = useState("");
  const [banBusy, setBanBusy] = useState(false);
  const detailRequestRef = useRef(0);
  const query = new URLSearchParams({
    page: String(page),
    pageSize: "20",
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(tag.trim() ? { tag: tag.trim() } : {}),
  });
  const { data, error, retry } = useApi<UserDirectoryData>(`/api/admin/users?${query}`);

  const openDetail = async (userId: number, responsePage = 1) => {
    const requestToken = ++detailRequestRef.current;
    setSelected(userId);
    setDetail(null);
    setDetailError(null);
    try {
      const result = await api<UserDetailData>(`/api/admin/users/${userId}?page=${responsePage}&pageSize=20`);
      // A slower response for an earlier click must not clobber the detail
      // panel the user is now looking at.
      if (requestToken === detailRequestRef.current) setDetail(result);
    } catch (err) {
      if (requestToken === detailRequestRef.current) {
        setDetailError(err instanceof Error ? err.message : "加载失败");
      }
    }
  };

  const requestedUser = searchParams.get("user");
  useEffect(() => {
    const userId = Number(requestedUser);
    if (Number.isInteger(userId) && userId > 0) {
      void openDetail(userId, 1);
    } else {
      setSelected(null);
      setDetail(null);
    }
    // The helper deliberately reads the latest state on each navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedUser]);

  const addTag = async (userId: number) => {
    const value = newTag.trim();
    if (!value) return;
    try {
      await apiSend("POST", `/api/admin/users/${userId}/tags`, { tag: value });
      setNewTag("");
      if (selected === userId) await openDetail(userId);
      retry();
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "添加标签失败");
    }
  };

  const removeTag = async (userId: number, tagValue: string) => {
    try {
      await apiSend("DELETE", `/api/admin/users/${userId}/tags/${encodeURIComponent(tagValue)}`);
      if (selected === userId) await openDetail(userId);
      retry();
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "删除标签失败");
    }
  };

  const changeBan = async (banned: boolean) => {
    if (!selected || !detail) return;
    if (
      banned &&
      !(await confirm({ message: `确定封禁 ${displayName(detail.user)}？封禁后该用户将无法使用机器人，且进行中的答卷会被取消。`, variant: "danger" }))
    ) {
      return;
    }
    setBanBusy(true);
    setDetailError(null);
    try {
      await setUserBan(selected, banned, banned ? banReason : undefined);
      setBanReason("");
      await openDetail(selected);
      retry();
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : banned ? "封禁失败" : "解除封禁失败");
    } finally {
      setBanBusy(false);
    }
  };

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={7} />;

  return (
    <section className="card">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">用户目录</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">共 {data.total} 位用户 · 标签与搜索由管理员维护</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            className="input"
            placeholder="搜索姓名 / @用户名 / ID"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
          <input
            className="input"
            placeholder="按标签筛选"
            value={tag}
            onChange={(event) => {
              setTag(event.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>

      {data.items.length ? (
        <div className="mt-5 overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th className="text-sm text-[var(--color-muted)]">用户</th>
                <th className="text-sm text-[var(--color-muted)]">Telegram ID</th>
                <th className="text-sm text-[var(--color-muted)]">完成答卷</th>
                <th className="text-sm text-[var(--color-muted)]">标签</th>
                <th className="text-sm text-[var(--color-muted)]">操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id} className="hover:bg-[var(--surface-hover)]">
                  <td className="text-sm">
                    <button
                      className="text-left font-semibold text-[var(--color-info)]"
                      onClick={() => void openDetail(item.id)}
                    >
                      {displayName(item)}
                    </button>
                    {item.username ? <span className="ml-1 text-[var(--color-muted)]">@{item.username}</span> : null}
                    {item.bannedAt ? (
                      <span className="ml-1 rounded-full bg-[color-mix(in_srgb,var(--color-danger)_12%,var(--surface))] px-2 py-0.5 text-xs text-[var(--color-danger)]">
                        已封禁
                      </span>
                    ) : null}
                  </td>
                  <td className="text-sm">{item.telegramUserId}</td>
                  <td className="text-sm">{item.completedResponses}</td>
                  <td className="text-sm">
                    <div className="flex max-w-56 flex-wrap gap-1">
                      {item.tags.map((value) => (
                        <button
                          key={value}
                          className="rounded-full bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))] px-2 py-0.5 text-xs text-[var(--color-primary)] hover:bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))] hover:text-[var(--color-danger)]"
                          title="点击移除标签"
                          onClick={() => void removeTag(item.id, value)}
                        >
                          #{value}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="text-sm">
                    <div className="flex gap-2">
                      <a className="btn btn-sm" href={userChatLink(item.telegramUserId)}>
                        私聊
                      </a>
                      {item.username ? (
                        <a
                          className="btn btn-sm"
                          href={`https://t.me/${item.username}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          @打开
                        </a>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyPanel text="没有匹配的用户" />
      )}

      {selected !== null ? (
        <div className="mt-5 rounded-xl border border-[color-mix(in_srgb,var(--color-primary)_30%,var(--surface))] bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">用户 #{selected} 详情</h3>
            <button className="btn btn-sm" onClick={() => setSelected(null)}>
              收起
            </button>
          </div>
          {detailError ? <p className="mt-2 text-sm text-[var(--color-danger)]">{detailError}</p> : null}
          {detail ? (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-sm text-[var(--text-soft)]">
                  注册：{formatDateTime(detail.user.createdAt)}
                  {detail.user.bannedAt ? (
                    <span className="ml-2 rounded-full bg-[color-mix(in_srgb,var(--color-danger)_12%,var(--surface))] px-2 py-0.5 text-xs text-[var(--color-danger)]">
                      已封禁（{formatDateTime(detail.user.bannedAt)}）
                    </span>
                  ) : null}
                </p>
                {detail.user.bannedAt && detail.user.banReason ? (
                  <p className="mt-1 text-sm text-[var(--color-danger)]">封禁原因：{detail.user.banReason}</p>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {detail.tags.map((value) => (
                    <button
                      key={value}
                      className="inline-flex items-center gap-0.5 rounded-full bg-[var(--surface)] px-2 py-0.5 text-xs text-[var(--color-primary)] hover:bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))] hover:text-[var(--color-danger)]"
                      onClick={() => void removeTag(selected, value)}
                    >
                      #{value} <X className="h-3 w-3" />
                    </button>
                  ))}
                  <input
                    className="input btn-sm"
                    placeholder="新标签"
                    value={newTag}
                    onChange={(event) => setNewTag(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void addTag(selected);
                    }}
                  />
                  <button className="btn btn-sm" onClick={() => void addTag(selected)}>
                    添加
                  </button>
                </div>
                <div className="mt-3 border-t border-[color-mix(in_srgb,var(--color-primary)_20%,var(--surface))] pt-3">
                  {detail.user.bannedAt ? (
                    <button className="btn btn-sm" disabled={banBusy} onClick={() => void changeBan(false)}>
                      ✅ 解除封禁
                    </button>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className="input btn-sm"
                        placeholder="封禁原因（可选）"
                        value={banReason}
                        disabled={banBusy}
                        onChange={(event) => setBanReason(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void changeBan(true);
                        }}
                      />
                      <button className="btn btn-sm btn-danger" disabled={banBusy} onClick={() => void changeBan(true)}>
                        ⛔ 封禁用户
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--text-soft)]">答卷（共 {detail.responseTotal} 份）</p>
                {detail.responses.length ? (
                  <>
                    <ul className="mt-2 space-y-1 text-sm">
                      {detail.responses.map((response) => (
                        <li key={response.responseId} className="flex items-center justify-between flex-wrap gap-2">
                          <Link
                            className="text-[var(--color-info)]"
                            to={`/surveys/${response.surveyId}/responses/${response.responseId}`}
                          >
                            {response.surveyTitle} · #{response.responseId}
                          </Link>
                          <span className="text-[var(--color-muted-soft)]">
                            {response.completedAt
                              ? formatDateTime(response.completedAt)
                              : (RESPONSE_STATUS_TEXT[response.status] ?? response.status)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {detail.responseTotalPages > 1 ? (
                      <div className="mt-2 flex items-center justify-end gap-2 text-xs text-[var(--color-muted)]">
                        <button
                          className="btn btn-sm"
                          disabled={detail.responsePage <= 1}
                          onClick={() => void openDetail(selected, detail.responsePage - 1)}
                        >
                          上一页
                        </button>
                        <span>
                          第 {detail.responsePage}/{detail.responseTotalPages} 页
                        </span>
                        <button
                          className="btn btn-sm"
                          disabled={detail.responsePage >= detail.responseTotalPages}
                          onClick={() => void openDetail(selected, detail.responsePage + 1)}
                        >
                          下一页
                        </button>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="mt-2 text-sm text-[var(--color-muted-soft)]">暂无答卷</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 flex items-center justify-end gap-2 text-sm text-[var(--color-muted)]">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
          上一页
        </button>
        <span>
          第 {data.page}/{Math.max(1, data.totalPages)} 页
        </span>
        <button className="btn btn-sm" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>
          下一页
        </button>
      </div>
    </section>
  );
}
