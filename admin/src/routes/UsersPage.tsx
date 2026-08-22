import { useState } from "react";
import { Link } from "react-router";
import { api, apiSend, userChatLink, type UserDetailData, type UserDirectoryData } from "../api";
import { useApi } from "../hooks";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";

function displayName(item: UserDirectoryData["items"][number]): string {
  const name = [item.firstName, item.lastName].filter(Boolean).join(" ");
  return name || item.username || `用户 ${item.telegramUserId}`;
}

export function UsersPage() {
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<UserDetailData | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [newTag, setNewTag] = useState("");
  const query = new URLSearchParams({
    page: String(page),
    pageSize: "20",
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(tag.trim() ? { tag: tag.trim() } : {}),
  });
  const { data, error, retry } = useApi<UserDirectoryData>(`/api/admin/users?${query}`);

  const openDetail = async (userId: number) => {
    setSelected(userId);
    setDetail(null);
    setDetailError(null);
    try {
      setDetail(await api<UserDetailData>(`/api/admin/users/${userId}`));
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "加载失败");
    }
  };

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

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={7} />;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">用户目录</h2>
          <p className="mt-1 text-sm text-gray-500">共 {data.total} 位用户 · 标签与搜索由管理员维护</p>
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
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">用户</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">Telegram ID</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">完成答卷</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">标签</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50">
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                    <button className="text-left font-semibold text-blue-700" onClick={() => void openDetail(item.id)}>
                      {displayName(item)}
                    </button>
                    {item.username ? (
                      <span className="ml-1 text-gray-500">@{item.username}</span>
                    ) : null}
                  </td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{item.telegramUserId}</td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{item.completedResponses}</td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                    <div className="flex max-w-56 flex-wrap gap-1">
                      {item.tags.map((value) => (
                        <button
                          key={value}
                          className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 hover:bg-red-50 hover:text-red-600"
                          title="点击移除标签"
                          onClick={() => void removeTag(item.id, value)}
                        >
                          #{value}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                    <div className="flex gap-2">
                      <a className="btn btn-sm" href={userChatLink(item.telegramUserId)}>私聊</a>
                      {item.username ? (
                        <a className="btn btn-sm" href={`https://t.me/${item.username}`} target="_blank" rel="noreferrer">@打开</a>
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
        <div className="mt-5 rounded-xl border border-indigo-200 bg-indigo-50/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">用户 #{selected} 详情</h3>
            <button className="btn btn-sm" onClick={() => setSelected(null)}>收起</button>
          </div>
          {detailError ? <p className="mt-2 text-sm text-red-600">{detailError}</p> : null}
          {detail ? (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-sm text-gray-600">
                  注册：{formatDateTime(detail.user.createdAt)}
                  {detail.user.bannedAt ? ` · 已于 ${formatDateTime(detail.user.bannedAt)} 封禁` : ""}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {detail.tags.map((value) => (
                    <button
                      key={value}
                      className="rounded-full bg-white px-2 py-0.5 text-xs text-indigo-700 hover:bg-red-50 hover:text-red-600"
                      onClick={() => void removeTag(selected, value)}
                    >
                      #{value} ✕
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
                  <button className="btn btn-sm" onClick={() => void addTag(selected)}>添加</button>
                </div>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-600">最近答卷</p>
                {detail.responses.length ? (
                  <ul className="mt-2 space-y-1 text-sm">
                    {detail.responses.map((response) => (
                      <li key={response.responseId} className="flex items-center justify-between gap-2">
                        <Link
                          className="text-blue-700"
                          to={`/surveys/${response.surveyId}/responses/${response.responseId}`}
                        >
                          {response.surveyTitle} · #{response.responseId}
                        </Link>
                        <span className="text-gray-400">{response.completedAt ? formatDateTime(response.completedAt) : response.status}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-gray-400">暂无答卷</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 flex items-center justify-end gap-2 text-sm text-gray-500">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
        <span>第 {data.page}/{Math.max(1, data.totalPages)} 页</span>
        <button className="btn btn-sm" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>下一页</button>
      </div>
    </section>
  );
}
