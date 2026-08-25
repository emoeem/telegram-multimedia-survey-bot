import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import {
  Archive,
  ArrowLeft,
  BarChart3,
  FilePenLine,
  History,
  Inbox,
  Rocket,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { apiSend, authHeaders, type ReportTemplateOption, type SurveyDetailData } from "../api";
import { useApi } from "../hooks";
import { ErrorPanel, SkeletonPanel, StatusBadge } from "../components/ui";
import { formatDateTime } from "../format";

function ThemeSwatch({ presetId }: { presetId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState<{ base: string; primary: string; content: string } | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const style = getComputedStyle(ref.current);
    setColors({
      base: style.getPropertyValue("--color-base-100").trim() || "#ffffff",
      primary: style.getPropertyValue("--color-primary").trim() || "#4f46e5",
      content: style.getPropertyValue("--color-base-content").trim() || "#111827",
    });
  }, [presetId]);

  return (
    <div ref={ref} data-theme={presetId} className="h-10 w-full overflow-hidden rounded-lg border border-black/10">
      {colors ? (
        <div
          className="flex h-full items-center gap-1.5 px-2"
          style={{ backgroundColor: colors.base, color: colors.content }}
        >
          <span className="h-4 w-4 shrink-0 rounded-full" style={{ backgroundColor: colors.primary }} />
          <span className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: colors.content, opacity: 0.45 }} />
        </div>
      ) : null}
    </div>
  );
}

export function SurveyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, retry } = useApi<SurveyDetailData>(
    id ? `/api/admin/surveys/${id}` : null,
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [preset, setPreset] = useState("");
  const [customJson, setCustomJson] = useState("");
  const [bgmUrl, setBgmUrl] = useState("");
  const [themeBusy, setThemeBusy] = useState(false);
  const bgmFileRef = useRef<HTMLInputElement>(null);
  const templates = useApi<{ templates: ReportTemplateOption[] }>("/api/admin/report-templates");

  useEffect(() => {
    if (!data) return;
    setPreset(data.theme?.preset ?? "");
    if (data.theme) {
      const { preset: _preset, ...custom } = data.theme;
      setCustomJson(Object.keys(custom).length ? JSON.stringify(custom, null, 2) : "");
      setBgmUrl(data.theme.audio?.url ?? "");
    } else {
      setCustomJson("");
      setBgmUrl("");
    }
  }, [data]);

  const runAction = async (action: string, confirmText?: string) => {
    if (!id) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiSend(action === "delete" ? "DELETE" : "POST", `/api/admin/surveys/${id}${action === "delete" ? "" : `/${action}`}`);
      retry();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const setReportTemplate = async (value: string) => {
    if (!id) return;
    setTemplateBusy(true);
    setActionError(null);
    try {
      await apiSend("PATCH", `/api/admin/surveys/${id}`, { reportTemplateId: value || null });
      retry();
      templates.retry();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "模板设置失败");
    } finally {
      setTemplateBusy(false);
    }
  };

  const saveTheme = async (clear: boolean) => {
    if (!id) return;
    setThemeBusy(true);
    setActionError(null);
    try {
      const theme: Record<string, unknown> = {};
      if (!clear) {
        if (preset) theme.preset = preset;
        if (bgmUrl.trim()) theme.audio = { url: bgmUrl.trim() };
        const customText = customJson.trim();
        if (customText) {
          try {
            const parsed = JSON.parse(customText) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              Object.assign(theme, parsed);
            } else {
              throw new Error("必须是 JSON 对象");
            }
          } catch (error) {
            setActionError(error instanceof Error ? error.message : "自定义主题 JSON 无效");
            return;
          }
        }
      }
      await apiSend("PATCH", `/api/admin/surveys/${id}`, { theme: Object.keys(theme).length ? theme : null });
      retry();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "主题保存失败");
    } finally {
      setThemeBusy(false);
    }
  };

  const uploadBgm = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("audio/")) {
      setActionError("仅支持音频文件");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setActionError("背景音乐不能超过 20MB");
      return;
    }
    setThemeBusy(true);
    setActionError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/admin/media/audio", {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "上传失败");
      }
      const result = (await response.json()) as { url: string };
      setBgmUrl(result.url);
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "上传失败");
    } finally {
      setThemeBusy(false);
    }
  };

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={6} />;

  const owner = data.firstName || data.username || data.owner_id || "-";
  const fields: [string, string | number | undefined][] = [
    ["状态", data.status],
    ["创建者", owner],
    ["题目数量", `${data.questionCount} 题`],
    ["答卷数量", `${data.responseCount} 答卷（完成 ${data.completedCount} 份）`],
    ["创建时间", formatDateTime(data.created_at)],
    ["更新时间", formatDateTime(data.updated_at)],
    ["公开状态", data.status === "published" ? "公开" : "未公开"],
    ["密码保护", data.access_code ? "已启用" : "未启用"],
  ];

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{data.title || "未命名问卷"}</h2>
        <StatusBadge status={data.status} />
      </div>
      {data.description ? <p className="mt-1 text-sm text-gray-500">{data.description}</p> : null}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
        {fields.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-sm text-gray-500">{label}</div>
            <div className="mt-1.5 font-semibold">
              {label === "状态" ? <StatusBadge status={data.status} /> : String(value ?? "-")}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link to="/surveys" className="btn">
          <ArrowLeft className="h-4 w-4" />返回问卷
        </Link>
        <Link to={`/surveys/${data.id}/editor`} className="btn">
          <FilePenLine className="h-4 w-4" />打开编辑器
        </Link>
        <Link to={`/surveys/${data.id}/responses`} className="btn">
          <Inbox className="h-4 w-4" />查看答卷
        </Link>
        <Link to={`/surveys/${data.id}/analytics`} className="btn">
          <BarChart3 className="h-4 w-4" />查看统计
        </Link>
        <Link to={`/surveys/${data.id}/versions`} className="btn">
          <History className="h-4 w-4" />版本历史
        </Link>
      </div>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-gray-100 pt-4">
        {data.status === "published" ? (
          <button className="btn" disabled={busy} onClick={() => void runAction("close", "确定关闭该问卷？填写中的答卷会被中止。")}>
            <Square className="h-4 w-4" />关闭
          </button>
        ) : null}
        {data.status === "closed" ? (
          <button className="btn" disabled={busy} onClick={() => void runAction("reopen", "确定重新发布该问卷？")}>
            <Rocket className="h-4 w-4" />重新发布
          </button>
        ) : null}
        {data.status !== "archived" ? (
          <button className="btn" disabled={busy} onClick={() => void runAction("archive", "确定归档该问卷？")}>
            <Archive className="h-4 w-4" />归档
          </button>
        ) : null}
        <button
          className="btn btn-danger"
          disabled={busy || (data.responseCount > 0 && !data.isAdmin)}
          title={
            data.responseCount > 0 && !data.isAdmin
              ? "已有答卷的问卷不能删除，请先归档"
              : data.responseCount > 0
                ? "管理员可强制删除（含全部答卷）"
                : undefined
          }
          onClick={() =>
            void runAction(
              "delete",
              data.responseCount > 0
                ? `确定永久删除该问卷？将同时删除 ${data.responseCount} 份答卷及其答案、媒体和报告，此操作不可恢复！`
                : "确定永久删除该问卷？此操作不可恢复。",
            )
          }
        >
          <Trash2 className="h-4 w-4" />删除
        </button>
      </div>
      {data.responseCount > 0 && !data.isAdmin ? (
        <p className="mt-2 text-xs text-gray-400">已有答卷的问卷禁止删除（历史答卷保护）。</p>
      ) : data.responseCount > 0 && data.isAdmin ? (
        <p className="mt-2 text-xs text-amber-600">
          管理员可强制删除该问卷，删除将同时移除 {data.responseCount} 份答卷。
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-100 pt-4">
        <span className="text-sm text-gray-600">报告模板</span>
        {templates.data ? (
          <select
            className="select"
            disabled={templateBusy}
            value={data.report_template_id ?? ""}
            onChange={(event) => void setReportTemplate(event.target.value)}
          >
            <option value="">默认（经典）</option>
            {templates.data.templates.map((template) => (
              <option key={template.id} value={template.id}>{template.name}</option>
            ))}
          </select>
        ) : (
          <span className="text-sm text-gray-400">加载中…</span>
        )}
        <span className="text-xs text-gray-400">Web 报告与 PDF 归档共用该模板</span>
      </div>

      <div className="mt-4 border-t border-gray-100 pt-4">
        <div className="text-sm text-gray-600">问卷主题</div>
        <p className="mt-1 text-xs text-gray-400">
          预设来自 DaisyUI 主题库，可直接选用；也可以叠加自定义令牌（JSON）。
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button
            type="button"
            className={`rounded-xl border p-2 text-left transition ${
              preset === ""
                ? "border-indigo-500 bg-indigo-50"
                : "border-gray-200 bg-white"
            }`}
            onClick={() => setPreset("")}
          >
            <div className="h-10 w-full rounded-lg bg-gray-100" />
            <div className="mt-1.5 text-sm font-medium text-gray-700">默认</div>
          </button>
          {data.themePresets.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`rounded-xl border p-2 text-left transition ${
                preset === item.id
                  ? "border-indigo-500 bg-indigo-50"
                  : "border-gray-200 bg-white"
              }`}
              onClick={() => setPreset(item.id)}
            >
              <ThemeSwatch presetId={item.id} />
              <div className="mt-1.5 text-sm font-medium text-gray-700">{item.name}</div>
            </button>
          ))}
        </div>
        <div className="mt-3">
          <div className="text-xs text-gray-400">自定义令牌（可选，覆盖预设）</div>
          <textarea
            className="input mt-1 w-full min-h-24 font-mono text-xs"
            placeholder='{"background":{"color":"#1a1025"},"audio":{"url":"https://…/bgm.mp3"},"primaryColor":"#e54d9b"}'
            value={customJson}
            onChange={(event) => setCustomJson(event.target.value)}
          />
        </div>
        <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="text-sm font-medium text-gray-700">背景音乐（BGM）</div>
          <p className="mt-1 text-xs text-gray-400">
            上传音频文件，或粘贴直链（mp3/m4a/ogg；网易云等平台的外链需真实可访问）。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              ref={bgmFileRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(event) => void uploadBgm(event.target.files?.[0])}
            />
            <button className="btn btn-sm" disabled={themeBusy} onClick={() => bgmFileRef.current?.click()}>
              {themeBusy ? "上传中…" : <><Upload className="h-4 w-4" />上传音频</>}
            </button>
            <input
              className="input min-w-0 flex-1 text-xs"
              value={bgmUrl}
              onChange={(event) => setBgmUrl(event.target.value.trim())}
              placeholder="https://…/bgm.mp3"
            />
            {bgmUrl ? (
              <button className="btn btn-sm text-red-600" onClick={() => setBgmUrl("")}>
                清除
              </button>
            ) : null}
          </div>
          {bgmUrl ? (
            <audio className="mt-2 w-full" src={bgmUrl} controls preload="none" />
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            className="btn btn-primary"
            disabled={themeBusy}
            onClick={() => void saveTheme(false)}
          >
            {themeBusy ? "保存中…" : "保存主题"}
          </button>
          <button
            className="btn"
            disabled={themeBusy}
            onClick={() => void saveTheme(true)}
          >
            清除主题
          </button>
        </div>
      </div>

      {actionError ? <p className="mt-2 text-sm text-red-600">{actionError}</p> : null}
    </section>
  );
}
