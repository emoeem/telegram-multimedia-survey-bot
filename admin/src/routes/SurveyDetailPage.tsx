import { useEffect, useRef, useState } from "react";
import { EChart } from "../components/EChart";
import { Link, useParams } from "react-router";
import {
  Archive,
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  Copy,
  FilePenLine,
  History,
  Inbox,
  Rocket,
  Send,
  Share2,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { histogramOption, useChartColors } from "../charts";
import { apiSend, authHeaders, type ReportTemplateOption, type SurveyAnalyticsData, type SurveyDetailData } from "../api";
import { useApi } from "../hooks";
import { ErrorPanel, SkeletonPanel, StatusBadge } from "../components/ui";
import { useDialogs } from "../components/Dialogs";
import { formatDateTime } from "../format";
import { PresetSwatch } from "../survey/theme-ui";

const REPORT_TEMPLATE_META: Record<string, { description: string; icon: string }> = {
  classic: { description: "均衡呈现摘要、分数与答案，适合大多数个人问卷。", icon: "◌" },
  transcript: { description: "以完整问答为主，适合需要保留填写内容的记录型问卷。", icon: "≡" },
  "magazine-dark": { description: "暗色杂志式信息卡片，强调视觉层次与重点结论。", icon: "◈" },
  data: { description: "偏数据分析，突出统计、指标和结构化结果。", icon: "▦" },
  identity: { description: "档案式布局，突出身份信息与个人画像。", icon: "◇" },
  "art-archive": { description: "复古艺术档案风格，更强调图片、标签与收藏感。", icon: "✦" },
  magazine: { description: "杂志长页叙事，适合图文并重的结果。", icon: "▤" },
  minimal: { description: "轻量极简，只保留核心结果与关键答案。", icon: "—" },
  gallery: { description: "影集式展示，适合图片较多的问卷。", icon: "▧" },
};
function reportTemplateDescription(template: ReportTemplateOption) {
  return REPORT_TEMPLATE_META[template.id] ?? { description: template.isCustom ? "自定义报告模板。" : "系统报告模板。", icon: template.isCustom ? "✎" : "◆" };
}

export function SurveyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { confirm } = useDialogs();
  const colors = useChartColors();
  const analytics = useApi<SurveyAnalyticsData>(id ? `/api/admin/surveys/${id}/analytics` : null);

  const { data, error, retry } = useApi<SurveyDetailData>(id ? `/api/admin/surveys/${id}` : null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [preset, setPreset] = useState("");
  const [customJson, setCustomJson] = useState("");
  const [bgmUrl, setBgmUrl] = useState("");
  const [completionMessage, setCompletionMessage] = useState("");
  const [completionRedirect, setCompletionRedirect] = useState("");
  const [completionRestart, setCompletionRestart] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [themeBusy, setThemeBusy] = useState(false);
  const bgmFileRef = useRef<HTMLInputElement>(null);
  const templates = useApi<{ templates: ReportTemplateOption[] }>("/api/admin/report-templates");

  useEffect(() => {
    if (!data) return;
    setPreset(data.theme?.preset ?? "");
    if (data.theme) {
      // preset/audio/completion get dedicated fields; the rest stays as raw
      // custom tokens in the JSON area.
      const { preset: _preset, audio, completion, ...custom } = data.theme;
      setCustomJson(Object.keys(custom).length ? JSON.stringify(custom, null, 2) : "");
      setBgmUrl(audio?.url ?? "");
      setCompletionMessage(completion?.message ?? "");
      setCompletionRedirect(completion?.redirectUrl ?? "");
      setCompletionRestart(completion?.showRestart === true);
    } else {
      setCustomJson("");
      setBgmUrl("");
      setCompletionMessage("");
      setCompletionRedirect("");
      setCompletionRestart(false);
    }
  }, [data]);

  const runAction = async (action: string, confirmText?: string) => {
    if (!id) return;
    if (confirmText && !await confirm({ message: confirmText, variant: "danger" })) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiSend(
        action === "delete" ? "DELETE" : "POST",
        `/api/admin/surveys/${id}${action === "delete" ? "" : `/${action}`}`,
      );
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
        const completion: Record<string, unknown> = {};
        if (completionMessage.trim()) completion.message = completionMessage.trim();
        if (completionRedirect.trim()) completion.redirectUrl = completionRedirect.trim();
        if (completionRestart) completion.showRestart = true;
        if (Object.keys(completion).length) theme.completion = completion;
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
    <>
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{data.title || "未命名问卷"}</h2>
        <StatusBadge status={data.status} />
      </div>
      {data.description ? <p className="mt-1 text-sm text-[var(--color-muted)]">{data.description}</p> : null}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
        {fields.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-[var(--color-edge)] bg-[var(--surface)] p-4">
            <div className="text-sm text-[var(--color-muted)]">{label}</div>
            <div className="mt-1.5 font-semibold">
              {label === "状态" ? <StatusBadge status={data.status} /> : String(value ?? "-")}
            </div>
          </div>
        ))}
      </div>

      {analytics.data?.completionTimeBuckets && analytics.data.completionTimeBuckets.length >= 2 ? (
        <div className="mt-5 rounded-xl border border-[var(--color-edge)] p-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm font-medium text-[var(--color-muted)] min-w-0 flex-1 truncate">近 {analytics.data.completionTimeBuckets.length} 天完成趋势</div>
            <Link to={`/surveys/${data.id}/analytics`} className="text-xs text-[var(--color-info)] hover:underline">
              查看详情 →
            </Link>
          </div>
          <EChart
            option={histogramOption(analytics.data.completionTimeBuckets, colors.primary, colors.muted) ?? {}}
            style={{ height: 140, width: "100%" }}
            opts={{ renderer: "svg" }}
          />
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        <Link to="/surveys" className="btn">
          <ArrowLeft className="h-4 w-4" />
          返回问卷
        </Link>
        <Link to={`/surveys/${data.id}/editor`} className="btn">
          <FilePenLine className="h-4 w-4" />
          打开编辑器
        </Link>
        <Link to={`/surveys/${data.id}/responses`} className="btn">
          <Inbox className="h-4 w-4" />
          查看答卷
        </Link>
        <Link to={`/surveys/${data.id}/analytics`} className="btn">
          <BarChart3 className="h-4 w-4" />
          查看统计
        </Link>
        <Link to={`/surveys/${data.id}/versions`} className="btn">
          <History className="h-4 w-4" />
          版本历史
        </Link>
        <a
          href={`/s/${data.id}`}
          target="_blank"
          rel="noreferrer"
          className="btn btn-outline"
          title="在新标签页打开线上问卷"
        >
          <ArrowUpRight className="h-4 w-4" />
          预览线上
        </a>
        <button className="btn btn-primary" onClick={() => setShareOpen(true)}>
          <Share2 className="h-4 w-4" />
          分享
        </button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--color-edge-soft)] pt-4">
        {data.status === "published" ? (
          <button
            className="btn"
            disabled={busy}
            onClick={() => void runAction("close", "确定关闭该问卷？填写中的答卷会被中止。")}
          >
            <Square className="h-4 w-4" />
            关闭
          </button>
        ) : null}
        {data.status === "closed" ? (
          <button className="btn" disabled={busy} onClick={() => void runAction("reopen", "确定重新发布该问卷？")}>
            <Rocket className="h-4 w-4" />
            重新发布
          </button>
        ) : null}
        {data.status !== "archived" ? (
          <button className="btn" disabled={busy} onClick={() => void runAction("archive", "确定归档该问卷？")}>
            <Archive className="h-4 w-4" />
            归档
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
          <Trash2 className="h-4 w-4" />
          删除
        </button>
      </div>
      {data.responseCount > 0 && !data.isAdmin ? (
        <p className="mt-2 text-xs text-[var(--color-muted-soft)]">已有答卷的问卷禁止删除（历史答卷保护）。</p>
      ) : data.responseCount > 0 && data.isAdmin ? (
        <p className="mt-2 text-xs text-[var(--color-warning)]">
          管理员可强制删除该问卷，删除将同时移除 {data.responseCount} 份答卷。
        </p>
      ) : null}
      <div className="mt-4 border-t border-[var(--color-edge-soft)] pt-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div><div className="text-sm text-[var(--text-soft)]">报告模板</div><p className="mt-1 text-xs text-[var(--color-muted-soft)]">模板只改变报告的结构、排版与视觉主题，不改变答案和结果计算。</p></div>
          {templateBusy ? <span className="text-xs text-[var(--color-primary)]">正在切换…</span> : null}
        </div>
        {templates.data ? <div className="report-template-picker mt-3">
          <button type="button" disabled={templateBusy} className={`report-template-option ${!data.report_template_id ? "is-selected" : ""}`} onClick={() => void setReportTemplate("")}><span className="report-template-icon">◌</span><span><strong>默认（经典）</strong><small>使用系统默认报告样式。</small></span></button>
          {templates.data.templates.map((template) => { const meta = reportTemplateDescription(template); const selected = data.report_template_id === template.id; return <button key={template.id} type="button" disabled={templateBusy} className={`report-template-option ${selected ? "is-selected" : ""}`} onClick={() => void setReportTemplate(template.id)}><span className="report-template-icon">{meta.icon}</span><span><strong>{template.name}</strong><small>{meta.description}</small><em>{template.layout ?? "自动布局"} · {template.theme}</em></span></button>; })}
        </div> : <span className="text-sm text-[var(--color-muted-soft)]">加载中…</span>}
      </div>
      <div className="mt-4 border-t border-[var(--color-edge-soft)] pt-4">
        <div className="text-sm text-[var(--text-soft)]">问卷主题</div>
        <p className="mt-1 text-xs text-[var(--color-muted-soft)]">
          预设来自 DaisyUI 主题库，可直接选用；也可以叠加自定义令牌（JSON）。
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button
            type="button"
            className={`rounded-xl border p-2 text-left transition ${
              preset === ""
                ? "border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))]"
                : "border-[var(--color-edge)] bg-[var(--surface)]"
            }`}
            onClick={() => setPreset("")}
          >
            <div className="h-10 w-full rounded-lg bg-[var(--surface-muted)]" />
            <div className="mt-1.5 text-sm font-medium text-[var(--text-soft)]">默认</div>
          </button>
          {data.themePresets.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`rounded-xl border p-2 text-left transition ${
                preset === item.id
                  ? "border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))]"
                  : "border-[var(--color-edge)] bg-[var(--surface)]"
              }`}
              onClick={() => setPreset(item.id)}
            >
              <PresetSwatch presetId={item.id} size="md" />
              <div className="mt-1.5 text-sm font-medium text-[var(--text-soft)]">{item.name}</div>
            </button>
          ))}
        </div>
        <div className="mt-3">
          <div className="text-xs text-[var(--color-muted-soft)]">自定义令牌（可选，覆盖预设）</div>
          <textarea
            className="input mt-1 w-full min-h-24 font-mono text-xs"
            placeholder='{"background":{"color":"#1a1025"},"audio":{"url":"https://…/bgm.mp3"},"primaryColor":"#e54d9b"}'
            value={customJson}
            onChange={(event) => setCustomJson(event.target.value)}
          />
        </div>
        <div className="mt-3 rounded-lg border border-[var(--color-edge)] bg-[var(--surface-muted)] p-3">
          <div className="text-sm font-medium text-[var(--text-soft)]">提交完成页</div>
          <p className="mt-1 text-xs text-[var(--color-muted-soft)]">
            参与者提交成功后看到的致谢文案、跳转链接与"再填一次"按钮。
          </p>
          <textarea
            className="input mt-2 w-full min-h-16 text-xs"
            maxLength={600}
            placeholder="感谢参与！关注我们的频道获取结果…"
            value={completionMessage}
            onChange={(event) => setCompletionMessage(event.target.value)}
          />
          <input
            className="input mt-2 w-full text-xs"
            placeholder="跳转链接（https://… 或站内 /…，可选）"
            value={completionRedirect}
            onChange={(event) => setCompletionRedirect(event.target.value.trim())}
          />
          <label className="mt-2 flex items-center gap-2 text-xs text-[var(--text-soft)]">
            <input
              type="checkbox"
              checked={completionRestart}
              onChange={(event) => setCompletionRestart(event.target.checked)}
            />
            显示"再填一次"按钮（仅允许重复填写的问卷生效）
          </label>
        </div>
        <div className="mt-3 rounded-lg border border-[var(--color-edge)] bg-[var(--surface-muted)] p-3">
          <div className="text-sm font-medium text-[var(--text-soft)]">背景音乐（BGM）</div>
          <p className="mt-1 text-xs text-[var(--color-muted-soft)]">
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
              {themeBusy ? (
                "上传中…"
              ) : (
                <>
                  <Upload className="h-4 w-4" />
                  上传音频
                </>
              )}
            </button>
            <input
              className="input min-w-0 flex-1 text-xs"
              value={bgmUrl}
              onChange={(event) => setBgmUrl(event.target.value.trim())}
              placeholder="https://…/bgm.mp3"
            />
            {bgmUrl ? (
              <button className="btn btn-sm text-[var(--color-danger)]" onClick={() => setBgmUrl("")}>
                清除
              </button>
            ) : null}
          </div>
          {bgmUrl ? <audio className="mt-2 w-full" src={bgmUrl} controls preload="none" /> : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={themeBusy} onClick={() => void saveTheme(false)}>
            {themeBusy ? "保存中…" : "保存主题"}
          </button>
          <button className="btn" disabled={themeBusy} onClick={() => void saveTheme(true)}>
            清除主题
          </button>
        </div>
      </div>

      {actionError ? <p className="mt-2 text-sm text-[var(--color-danger)]">{actionError}</p> : null}
    </section>

    {shareOpen ? <ShareSurveyDialog survey={data} onClose={() => setShareOpen(false)} /> : null}
    </>
  );
}

function ShareSurveyDialog({ survey, onClose }: { survey: SurveyDetailData; onClose: () => void }) {
  const shareUrl = `${window.location.origin}/s/${survey.id}`;
  const ogImageUrl = `${window.location.origin}/s/${survey.id}/og.png`;
  const coverUrl = survey.coverUrl ? (survey.coverUrl.startsWith("http") ? survey.coverUrl : `${window.location.origin}${survey.coverUrl}`) : null;
  const displayImage = coverUrl ?? ogImageUrl;
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = shareUrl;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const telegramShare = `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(survey.title)}`;

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/50 px-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-[var(--color-edge)] bg-[var(--surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between flex-wrap gap-2 border-b border-[var(--color-edge-soft)] px-5 py-3">
          <h3 id="share-title" className="text-base font-bold tracking-tight">分享问卷</h3>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--color-muted)] hover:bg-black/5">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div className="overflow-hidden rounded-xl border border-[var(--color-edge)]">
            {displayImage ? (
              <img src={displayImage} alt="问卷封面" className="aspect-[16/7] w-full object-cover" />
            ) : (
              <div className="grid aspect-[16/7] w-full place-items-center bg-gradient-to-br from-indigo-100 to-purple-100 text-4xl font-bold text-indigo-300 dark:from-indigo-900/40 dark:to-purple-900/40 dark:text-indigo-600">
                {survey.title.slice(0, 1)}
              </div>
            )}
            <div className="px-3 py-2">
              <div className="truncate text-sm font-semibold">{survey.title}</div>
              {survey.description ? (
                <p className="mt-0.5 line-clamp-2 text-xs text-[var(--color-muted)]">{survey.description}</p>
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--surface-muted)]/50 p-3">
            <div className="mb-1 text-xs font-medium text-[var(--color-muted)]">公开链接</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg bg-[var(--surface)] px-3 py-2 text-xs font-mono">
                {shareUrl}
              </code>
              <button
                onClick={copyLink}
                className={`btn ${copied ? "btn-success" : ""} px-3 py-2 text-xs`}
                title="复制链接"
              >
                <Copy className="h-3.5 w-3.5" />
                {copied ? "已复制" : "复制"}
              </button>
            </div>
          </div>

          <div className="flex items-start gap-4 rounded-xl border border-[var(--color-edge)] p-4">
            <div className="shrink-0 rounded-lg bg-white p-2">
              <QRCodeSVG value={shareUrl} size={120} level="M" includeMargin={false} />
            </div>
            <div className="flex-1 space-y-2">
              <div className="text-xs text-[var(--color-muted)]">用手机扫描即可填写</div>
              <a
                href={telegramShare}
                target="_blank"
                rel="noreferrer"
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#2AABEE] px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1e95d4]"
              >
                <Send className="h-4 w-4" />
                分享到 Telegram
              </a>
              {typeof navigator.share === "function" ? (
                <button
                  onClick={async () => {
                    try {
                      await navigator.share({ title: survey.title, text: survey.description ?? undefined, url: shareUrl });
                    } catch {
                      /* user cancelled */
                    }
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--color-edge)] px-3 py-2 text-sm font-semibold transition-colors hover:bg-black/5"
                >
                  <Share2 className="h-4 w-4" />
                  其他方式分享
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
