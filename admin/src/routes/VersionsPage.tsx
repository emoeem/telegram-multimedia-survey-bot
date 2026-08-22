import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, apiSend, type SurveyVersionDiffData, type SurveyVersionListData } from "../api";
import { useApi } from "../hooks";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";
import { formatDateTime } from "../format";

export function VersionsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, error, retry } = useApi<SurveyVersionListData>(
    id ? `/api/admin/surveys/${id}/versions` : null,
  );
  const [fromVersion, setFromVersion] = useState<number | "">("");
  const [toVersion, setToVersion] = useState<number | "">("");
  const [diff, setDiff] = useState<SurveyVersionDiffData | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={6} />;

  const versions = data.versions;

  const compare = async () => {
    if (!id || fromVersion === "" || toVersion === "") return;
    setActionError(null);
    try {
      setDiff(await api<SurveyVersionDiffData>(
        `/api/admin/surveys/${id}/versions/${fromVersion}/compare/${toVersion}`,
      ));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "对比失败");
    }
  };

  const restore = async (version: number) => {
    if (!id) return;
    if (!window.confirm(`确定从版本 ${version} 恢复为新草稿？原问卷不会被修改。`)) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await apiSend<{ id: number }>(
        "POST",
        `/api/admin/surveys/${id}/versions/${version}/restore`,
        {},
      );
      navigate(`/surveys/${result.id}/editor`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "恢复失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">版本历史</h2>
        <Link className="btn btn-sm" to={`/surveys/${id}`}>← 返回问卷</Link>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        每次发布都会生成一个版本快照；历史答卷始终关联提交时的版本。
      </p>

      {versions.length ? (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">版本</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">标题</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">题目数</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">创建时间</th>
                <th className="border-b border-gray-100 px-2 py-3 text-left text-sm text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.version} className="hover:bg-slate-50">
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm font-semibold">v{version.version}</td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{version.title || "未命名问卷"}</td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{version.questionCount}</td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">{formatDateTime(version.createdAt)}</td>
                  <td className="border-b border-gray-100 px-2 py-3.5 text-sm">
                    <button className="btn btn-sm" disabled={busy} onClick={() => void restore(version.version)}>
                      恢复为新草稿
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyPanel text="还没有版本记录（发布问卷后生成）" />
      )}

      <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-4">
        <h3 className="text-sm font-semibold text-gray-700">对比版本</h3>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-sm text-gray-600">
            从
            <select className="input mt-1 block" value={fromVersion} onChange={(event) => setFromVersion(event.target.value === "" ? "" : Number(event.target.value))}>
              <option value="">选择版本</option>
              {versions.map((version) => <option key={version.version} value={version.version}>v{version.version}</option>)}
            </select>
          </label>
          <label className="text-sm text-gray-600">
            到
            <select className="input mt-1 block" value={toVersion} onChange={(event) => setToVersion(event.target.value === "" ? "" : Number(event.target.value))}>
              <option value="">选择版本</option>
              {versions.map((version) => <option key={version.version} value={version.version}>v{version.version}</option>)}
            </select>
          </label>
          <button className="btn" disabled={fromVersion === "" || toVersion === ""} onClick={() => void compare()}>
            对比
          </button>
        </div>
        {diff ? (
          <div className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <p className="font-medium text-green-700">新增（{diff.diff.added.length}）</p>
              <ul className="mt-1 list-inside list-disc text-gray-600">
                {diff.diff.added.map((title) => <li key={title}>{title}</li>)}
              </ul>
            </div>
            <div>
              <p className="font-medium text-red-700">删除（{diff.diff.removed.length}）</p>
              <ul className="mt-1 list-inside list-disc text-gray-600">
                {diff.diff.removed.map((title) => <li key={title}>{title}</li>)}
              </ul>
            </div>
            <div>
              <p className="font-medium text-amber-700">修改（{diff.diff.changed.length}）</p>
              <ul className="mt-1 space-y-1 text-gray-600">
                {diff.diff.changed.map((item) => (
                  <li key={item.id}>
                    <span className="text-gray-400 line-through">{item.from}</span> → <span>{item.to}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </div>

      {actionError ? <p className="mt-3 text-sm text-red-600">{actionError}</p> : null}
    </section>
  );
}
