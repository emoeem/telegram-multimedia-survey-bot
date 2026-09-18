import { useState } from "react";
import { Link, useParams } from "react-router";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  FileDown,
  FileText,
  Globe,
  Package,
  Palette,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { apiPostBlob, apiSend, type ReportTemplateOption } from "../api";
import { useApi } from "../hooks";
import type { ResponseDetailData } from "../api";
import { ErrorPanel, SkeletonPanel } from "../components/ui";
import { useDialogs } from "../components/Dialogs";
import { formatDateTime } from "../format";
import { ResponseMediaPreview } from "../components/ResponseMediaPreview";

function respondentName(data: ResponseDetailData): string {
  if (!data.response.respondent) {
    return data.response.participantKey ? `网页参与 · ${data.response.participantKey}` : "网页参与（未登录）";
  }
  const respondent = data.response.respondent;
  const name = [respondent.firstName, respondent.lastName].filter(Boolean).join(" ");
  return [name, respondent.username ? `@${respondent.username}` : "", String(respondent.telegramUserId)]
    .filter(Boolean)
    .join(" · ");
}

interface EnvRow {
  label: string;
  value: string;
  source: "无感采集" | "服务端推断";
}

interface EnvGroup {
  title: string;
  rows: EnvRow[];
}

function envGroups(response: ResponseDetailData["response"]): EnvGroup[] {
  const groups: EnvGroup[] = [];
  const add = (title: string, rows: EnvRow[]) => {
    if (rows.length) groups.push({ title, rows });
  };
  if (response.browserInfo) {
    let info: Record<string, unknown> = {};
    try {
      info = JSON.parse(response.browserInfo) as Record<string, unknown>;
    } catch {
      add("浏览器信息", [{ label: "原始数据", value: response.browserInfo.slice(0, 500), source: "无感采集" }]);
      return groups;
    }
    const geo = (info.geo && typeof info.geo === "object" ? info.geo : {}) as Record<string, string>;
    const webgl = (info.webgl && typeof info.webgl === "object" ? info.webgl : {}) as Record<string, unknown>;

    const network: EnvRow[] = [];
    if (response.ipAddress) network.push({ label: "IP 地址", value: response.ipAddress, source: "服务端推断" });
    const location = [geo.country, geo.region, geo.city].filter(Boolean).join(" · ");
    if (location) network.push({ label: "IP 地理位置", value: location, source: "服务端推断" });
    if (geo.asn) network.push({ label: "运营商 ASN", value: `AS${geo.asn}`, source: "服务端推断" });
    if (geo.colo) network.push({ label: "接入节点", value: geo.colo, source: "服务端推断" });
    if (typeof info.connection === "string" && info.connection)
      network.push({ label: "网络类型", value: info.connection, source: "无感采集" });
    if (typeof info.connectionType === "string" && info.connectionType)
      network.push({ label: "连接类型", value: info.connectionType, source: "无感采集" });
    if (typeof info.rtt === "number" && info.rtt > 0)
      network.push({ label: "网络延迟 RTT", value: `${info.rtt} ms`, source: "无感采集" });
    if (typeof info.downlink === "number" && info.downlink > 0)
      network.push({ label: "下行速率", value: `${info.downlink} Mbps`, source: "无感采集" });
    if (typeof info.online === "boolean")
      network.push({ label: "在线状态", value: info.online ? "在线" : "离线", source: "无感采集" });
    add("网络", network);

    const browser: EnvRow[] = [];
    if (typeof info.ua === "string" && info.ua) {
      const parsed = /(Chrome|Firefox|Safari|Edg|OPR|Mobile)\/([\d.]+)/.exec(info.ua);
      if (parsed) browser.push({ label: "浏览器", value: `${parsed[1]} ${parsed[2]}`, source: "无感采集" });
      browser.push({ label: "User-Agent", value: info.ua, source: "无感采集" });
    }
    if (typeof info.language === "string" && info.language)
      browser.push({ label: "语言", value: info.language, source: "无感采集" });
    if (Array.isArray(info.languages) && info.languages.length) {
      browser.push({ label: "全部语言", value: (info.languages as string[]).join(", "), source: "无感采集" });
    }
    if (typeof info.acceptLanguage === "string" && info.acceptLanguage)
      browser.push({ label: "Accept-Language", value: info.acceptLanguage, source: "服务端推断" });
    if (typeof info.secChUa === "string" && info.secChUa)
      browser.push({ label: "客户端提示", value: info.secChUa, source: "服务端推断" });
    if (typeof info.doNotTrack === "string" && info.doNotTrack)
      browser.push({ label: "Do Not Track", value: info.doNotTrack, source: "无感采集" });
    if (typeof info.cookiesEnabled === "boolean")
      browser.push({ label: "Cookie 启用", value: info.cookiesEnabled ? "是" : "否", source: "无感采集" });
    if (typeof info.plugins === "number")
      browser.push({ label: "浏览器插件数", value: String(info.plugins), source: "无感采集" });
    if (typeof info.navigationType === "string" && info.navigationType)
      browser.push({ label: "进入方式", value: info.navigationType, source: "无感采集" });
    add("浏览器", browser);

    const device: EnvRow[] = [];
    if (typeof info.platform === "string" && info.platform)
      device.push({ label: "操作系统", value: info.platform, source: "无感采集" });
    if (typeof info.mobile === "boolean")
      device.push({ label: "移动设备", value: info.mobile ? "是" : "否", source: "无感采集" });
    if (typeof info.screen === "string" && info.screen)
      device.push({ label: "屏幕", value: info.screen, source: "无感采集" });
    if (typeof info.screenAvailable === "string" && info.screenAvailable)
      device.push({ label: "可用屏幕", value: info.screenAvailable, source: "无感采集" });
    if (typeof info.viewport === "string" && info.viewport)
      device.push({ label: "视口", value: info.viewport, source: "无感采集" });
    if (typeof info.dpr === "number" && info.dpr > 0)
      device.push({ label: "屏幕倍率", value: `×${info.dpr}`, source: "无感采集" });
    if (typeof info.cores === "number" && info.cores > 0)
      device.push({ label: "CPU 内核", value: String(info.cores), source: "无感采集" });
    if (typeof info.memory === "number" && info.memory > 0)
      device.push({ label: "设备内存", value: `${info.memory} GB`, source: "无感采集" });
    if (typeof info.touch === "boolean")
      device.push({ label: "触摸屏", value: info.touch ? "支持" : "不支持", source: "无感采集" });
    if (typeof info.touchPoints === "number")
      device.push({ label: "触点数", value: String(info.touchPoints), source: "无感采集" });
    if (webgl.renderer) {
      device.push({ label: "GPU 渲染器", value: String(webgl.renderer), source: "无感采集" });
      if (webgl.vendor) device.push({ label: "GPU 厂商", value: String(webgl.vendor), source: "无感采集" });
      if (webgl.version) device.push({ label: "WebGL 版本", value: String(webgl.version), source: "无感采集" });
      if (typeof webgl.extensions === "number")
        device.push({ label: "WebGL 扩展数", value: String(webgl.extensions), source: "无感采集" });
    }
    add("设备", device);

    const context: EnvRow[] = [];
    if (typeof info.timezone === "string" && info.timezone)
      context.push({ label: "时区", value: info.timezone, source: "无感采集" });
    if (geo.timezone) context.push({ label: "Geo 时区", value: geo.timezone, source: "服务端推断" });
    if (typeof info.referrer === "string" && info.referrer)
      context.push({ label: "来源页面", value: info.referrer, source: "无感采集" });
    if (typeof info.url === "string" && info.url)
      context.push({ label: "当前 URL", value: info.url, source: "无感采集" });
    if (typeof info.query === "string" && info.query)
      context.push({ label: "URL 参数", value: info.query, source: "无感采集" });
    add("上下文", context);
  }
  if (response.deviceFingerprint) {
    add("设备指纹", [{ label: "FingerprintJS 指纹", value: response.deviceFingerprint, source: "无感采集" }]);
  }
  return groups;
}

export function ResponseDetailPage() {
  const { id, responseId } = useParams<{ id: string; responseId: string }>();
  const { confirm } = useDialogs();

  const { data, error, retry } = useApi<ResponseDetailData>(
    id && responseId ? `/api/admin/surveys/${id}/responses/${responseId}` : null,
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState<number | null>(null);
  const [previewTemplateId, setPreviewTemplateId] = useState("");
  const templates = useApi<{ templates: ReportTemplateOption[] }>("/api/admin/report-templates");

  const runAction = async (path: string, confirmText?: string) => {
    if (!id || !responseId) return;
    if (confirmText && !await confirm({ message: confirmText, variant: "danger" })) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await apiSend<{ reportUrl?: string }>("POST", path, {});
      if (result.reportUrl) {
        window.open(result.reportUrl, "_blank");
      } else {
        retry();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const downloadPdf = async () => {
    if (!id || !responseId) return;
    setBusy(true);
    setActionError(null);
    try {
      const blob = await apiPostBlob(`/api/admin/surveys/${id}/responses/${responseId}/pdf`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `report-${responseId}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "PDF 下载失败");
    } finally {
      setBusy(false);
    }
  };

  const previewWithTemplate = async () => {
    if (!id || !responseId) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await apiSend<{ reportUrl: string }>(
        "POST",
        `/api/admin/surveys/${id}/responses/${responseId}/report-link`,
        {},
      );
      const separator = result.reportUrl.includes("?") ? "&" : "?";
      const url = previewTemplateId
        ? `${result.reportUrl}${separator}template=${encodeURIComponent(previewTemplateId)}`
        : result.reportUrl;
      window.open(url, "_blank");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "预览失败");
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorPanel error={error} onRetry={retry} />;
  if (!data) return <SkeletonPanel lines={8} />;

  return (
    <div className="space-y-5">
      <div className="admin-page-intro"><div><h2>答卷详情</h2><p>{data.survey.title} · #{data.response.id}</p></div><Link className="btn" to={`/surveys/${data.survey.id}/responses`}><ArrowLeft className="h-4 w-4" />返回列表</Link></div>
      <section className="card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">答卷 #{data.response.id}</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {data.survey.title} · {respondentName(data)}
            </p>
          </div>
          <span className="badge badge-gray">{data.response.statusLabel}</span>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-edge-soft)] pt-3">
          <Link
            className={`btn btn-sm ${data.response.previousResponseId === null ? "pointer-events-none opacity-40" : ""}`}
            to={
              data.response.previousResponseId === null
                ? "#"
                : `/surveys/${data.survey.id}/responses/${data.response.previousResponseId}`
            }
            aria-disabled={data.response.previousResponseId === null}
          >
            <ArrowLeft className="h-4 w-4" />
            上一份
          </Link>
          <span className="text-xs text-[var(--color-muted)]">按答卷编号浏览</span>
          <Link
            className={`btn btn-sm ${data.response.nextResponseId === null ? "pointer-events-none opacity-40" : ""}`}
            to={
              data.response.nextResponseId === null
                ? "#"
                : `/surveys/${data.survey.id}/responses/${data.response.nextResponseId}`
            }
            aria-disabled={data.response.nextResponseId === null}
          >
            下一份
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <span className="text-[var(--color-muted)]">开始：</span>
            {formatDateTime(data.response.startedAt)}
          </div>
          <div>
            <span className="text-[var(--color-muted)]">完成：</span>
            {data.response.completedAt ? formatDateTime(data.response.completedAt) : "—"}
          </div>
          <div>
            <span className="text-[var(--color-muted)]">更新：</span>
            {formatDateTime(data.response.updatedAt)}
          </div>
          <div>
            <span className="text-[var(--color-muted)]">问卷版本：</span>
            <Link className="text-[var(--color-primary)] hover:underline" to="../../versions">
              v{data.response.version}
            </Link>
          </div>
        </div>
      </section>

      <section className="card mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">答卷者信息</h3>
          {data.response.respondent ? (
            <Link className="btn btn-sm" to={`/users?user=${data.response.respondent.userId}`}>
              看 TA 的全部答卷
            </Link>
          ) : null}
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          {data.response.respondent ? (
            <>
              <div className="flex gap-2">
                <dt className="shrink-0 text-[var(--color-muted)]">姓名</dt>
                <dd className="min-w-0 break-all text-[var(--color-ink)]">
                  {[data.response.respondent.firstName, data.response.respondent.lastName].filter(Boolean).join(" ") ||
                    "—"}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-[var(--color-muted)]">用户名</dt>
                <dd className="min-w-0 break-all text-[var(--color-ink)]">
                  {data.response.respondent.username ? `@${data.response.respondent.username}` : "—"}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-[var(--color-muted)]">Telegram ID</dt>
                <dd className="min-w-0 break-all text-[var(--color-ink)]">{data.response.respondent.telegramUserId}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-[var(--color-muted)]">来源</dt>
                <dd className="min-w-0 break-all text-[var(--color-ink)]">Telegram</dd>
              </div>
            </>
          ) : (
            <div className="flex gap-2">
              <dt className="shrink-0 text-[var(--color-muted)]">参与方式</dt>
              <dd className="min-w-0 break-all text-[var(--color-ink)]">
                {data.response.participantKey ? `网页参与 · ${data.response.participantKey}` : "网页参与（未登录）"}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {(() => {
        const groups = envGroups(data.response);
        if (!groups.length) return null;
        let envRisk: { score?: number | null; signals?: string[] } | null = null;
        try {
          const parsed = data.response.browserInfo
            ? (JSON.parse(data.response.browserInfo) as Record<string, unknown>)
            : {};
          const risk = parsed.envRisk;
          if (risk && typeof risk === "object") {
            envRisk = risk as { score?: number | null; signals?: string[] };
          }
        } catch {
          // ignore malformed browser info
        }
        return (
          <section className="card mt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">环境画像（无感采集）</h3>
              {envRisk && typeof envRisk.score === "number" ? (
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    envRisk.score >= 80
                      ? "bg-[color-mix(in_srgb,var(--color-success)_12%,var(--surface))] text-[var(--color-success)]"
                      : envRisk.score >= 50
                        ? "bg-[color-mix(in_srgb,var(--color-warning)_12%,var(--surface))] text-[var(--color-warning)]"
                        : "bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))] text-[var(--color-danger)]"
                  }`}
                >
                  环境一致性 {envRisk.score}%
                </span>
              ) : null}
            </div>
            {envRisk?.signals?.length ? (
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {envRisk.signals.map((signal) => (
                  <span
                    key={signal}
                    className={`rounded-full px-2.5 py-1 ${
                      signal.includes("一致")
                        ? "bg-[color-mix(in_srgb,var(--color-success)_12%,var(--surface))] text-[var(--color-success)]"
                        : "bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))] text-[var(--color-danger)]"
                    }`}
                  >
                    {signal}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="mt-3 space-y-4">
              {groups.map((group) => (
                <div key={group.title}>
                  <div className="text-xs font-semibold text-[var(--color-muted-soft)]">{group.title}</div>
                  <dl className="mt-1.5 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                    {group.rows.map((row) => (
                      <div key={row.label} className="flex gap-2">
                        <dt className="shrink-0 text-[var(--color-muted)]">{row.label}</dt>
                        <dd className="min-w-0 break-all text-[var(--color-ink)]">{row.value}</dd>
                        <span className="ml-auto shrink-0 text-[11px] text-[var(--color-muted-soft)]">
                          {row.source === "服务端推断" ? "服务端" : "无感"}
                        </span>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </section>
        );
      })()}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            void runAction(`/api/admin/surveys/${data.survey.id}/responses/${data.response.id}/report-link`)
          }
        >
          <Globe className="h-4 w-4" />
          打开 Web 报告
        </button>
        <select
          className="select sm:w-44"
          value={previewTemplateId}
          onChange={(event) => setPreviewTemplateId(event.target.value)}
        >
          <option value="">报告模板：默认</option>
          {templates.data?.templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
        <button className="btn" disabled={busy} onClick={() => void previewWithTemplate()}>
          <Palette className="h-4 w-4" />
          用所选模板预览
        </button>
        {data.response.status === "completed" ? (
          <button
            className="btn"
            disabled={busy}
            onClick={() => void runAction(`/api/admin/surveys/${data.survey.id}/responses/${data.response.id}/report`)}
          >
            <RefreshCw className="h-4 w-4" />
            重新生成报告
          </button>
        ) : null}
        {data.response.status === "completed" ? (
          <button className="btn" disabled={busy} onClick={() => void downloadPdf()}>
            <FileDown className="h-4 w-4" />
            下载 PDF
          </button>
        ) : null}
        {data.response.status === "completed" ? (
          <button
            className="btn"
            disabled={busy}
            onClick={() => void runAction(`/api/admin/surveys/${data.survey.id}/responses/${data.response.id}/resend`)}
          >
            <Package className="h-4 w-4" />
            导出到私人频道（PDF+图片打包）
          </button>
        ) : null}
        {data.response.status !== "archived" ? (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void runAction(
                `/api/admin/surveys/${data.survey.id}/responses/${data.response.id}/archive`,
                "确定归档该答卷？",
              )
            }
          >
            <Archive className="h-4 w-4" />
            归档
          </button>
        ) : null}
        <button
          className="btn text-[var(--color-danger)]"
          disabled={busy || data.response.status === "completed"}
          title={data.response.status === "completed" ? "已完成答卷是永久数据，禁止删除" : undefined}
          onClick={() =>
            void runAction(
              `/api/admin/surveys/${data.survey.id}/responses/${data.response.id}/delete`,
              "确定删除该答卷？此操作不可恢复。",
            )
          }
        >
          <Trash2 className="h-4 w-4" />
          删除
        </button>
        {actionError ? <span className="text-sm text-[var(--color-danger)]">{actionError}</span> : null}
      </div>

      <section className="mt-5 space-y-3">
        {data.answers.map((answer) => (
          <article key={answer.questionId} className="card">
            <div className="text-xs font-medium text-[var(--color-muted-soft)]">
              第 {answer.order + 1} 题 · {answer.questionType}
            </div>
            <h3 className="mt-1 font-semibold">{answer.questionTitle}</h3>
            <div
              className={`mt-3 whitespace-pre-wrap text-sm ${answer.answered ? "text-[var(--color-ink)]" : "text-[var(--color-muted-soft)]"}`}
            >
              {answer.answered ? answer.value || "已作答" : "未作答"}
            </div>
            {answer.raw && answer.answered ? (
              <button
                className="mt-2 text-xs text-[var(--color-primary)] hover:underline"
                onClick={() => setRawOpen(rawOpen === answer.questionId ? null : answer.questionId)}
              >
                {rawOpen === answer.questionId ? "收起原始数据" : "查看原始数据"}
              </button>
            ) : null}
            {rawOpen === answer.questionId && answer.raw ? (
              <pre className="pre mt-2 max-h-64">{JSON.stringify(answer.raw, null, 2)}</pre>
            ) : null}
            {answer.media.length ? (
              <div className="mt-3 grid gap-3">
                {answer.media.map((media) => (
                  <ResponseMediaPreview
                    key={media.mediaAssetId}
                    surveyId={data.survey.id}
                    responseId={data.response.id}
                    media={media}
                  />
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </section>

      <div className="mt-5">
        <Link className="btn inline-block" to={`/surveys/${data.survey.id}/responses`}>
          <ArrowLeft className="h-4 w-4" />
          返回答卷列表
        </Link>
      </div>
    </div>
  );
}
