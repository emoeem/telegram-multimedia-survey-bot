/**
 * 公开发布的文案（频道/群组那条消息的 caption）。
 *
 * 单独成模块只是为了可测：这段文字是**用户唯一能看到的"这是哪份问卷、什么时候
 * 填的、谁填的"**，而它由异步发布链路在渲染完成后拼出来——错了不会报错，只会
 * 悄悄发出一条没有来源的消息。三条硬约束都在这里，不散在调用点：
 *
 * 1. 必须带 **问卷名称** 与 **填写时间**（频道里同时有多份报告，不带时间就无法
 *    区分"同一份问卷的第几次"）。
 * 2. **匿名时彻底不出现填写者**：不是"传进来再遮盖"，而是根本不读 respondent
 *    参数——调用方即使误传了真名/`@username`/`Telegram ID: 123`，输出里也不会
 *    有它（见 public-report.service 里同时剥离了报告图片上的身份）。
 * 3. caption 有硬上限（Telegram 1024 字符，超了 API 直接拒绝整条消息），所以
 *    留言先按条目限长，最后再兜一次整体截断。
 */

/** 与 admin/src/survey/publish-choice.ts 的 PUBLISH_MESSAGE_MAX 保持一致。 */
export const PUBLIC_REPORT_MESSAGE_MAX = 200;

/** Telegram 的 caption 上限（UTF-16 前 1024 字符，超出即 400）。 */
export const PUBLIC_REPORT_CAPTION_MAX = 1024;

export interface PublicReportCaptionInput {
  surveyTitle: string | null | undefined;
  /** 匿名模式：填写者一栏固定为「匿名填写者」，respondent 一律不读。 */
  anonymous: boolean;
  /** 已格式化的开始/完成时间（调用方的 formatChinaDateTime，Asia/Shanghai）。 */
  startedAt?: string | null;
  completedAt?: string | null;
  /** 已经过匿名处理的填写者展示名（匿名时不会被读取）。 */
  respondent?: string | null;
  /** 答卷者附言，null/空串表示没有。 */
  message?: string | null;
}

/**
 * 留言归一化：去首尾空白、折叠连续空行、去掉控制字符，按码点截断。
 *
 * 按码点而不是 `slice(0, n)`：emoji 是代理对，按 UTF-16 切会切出半个字符，
 * 变成一个 `�` 直接出现在频道消息里。
 */
export function normalizePublishMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const stripped = raw
    // 只保留换行与制表，其余控制字符（含 \u0000 这类能破坏日志的）全部去掉。
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!stripped) return null;
  const points = Array.from(stripped);
  return points.length > PUBLIC_REPORT_MESSAGE_MAX ? points.slice(0, PUBLIC_REPORT_MESSAGE_MAX).join("") : stripped;
}

function formatFilledAt(startedAt: string | null | undefined, completedAt: string | null | undefined): string {
  const started = (startedAt ?? "").trim();
  const completed = (completedAt ?? "").trim();
  if (started && completed && started !== completed) return `${started} 至 ${completed}（北京时间）`;
  if (completed) return `${completed}（北京时间）`;
  if (started) return `${started}（北京时间）`;
  return "未知";
}

/** 超过 Telegram 上限时按码点截断并加省略号，保证消息能被接受。 */
export function clampPublicReportCaption(text: string): string {
  const points = Array.from(text);
  if (points.length <= PUBLIC_REPORT_CAPTION_MAX) return text;
  return `${points.slice(0, PUBLIC_REPORT_CAPTION_MAX - 1).join("")}…`;
}

export function buildPublicReportCaption(input: PublicReportCaptionInput): string {
  const lines = heading(input);
  const message = normalizePublishMessage(input.message);
  if (message) lines.push("", "💬 想说的话：", message);
  return clampPublicReportCaption(lines.join("\n"));
}

/** 按码点截断。`String.slice` 按 UTF-16 切，会把 emoji 切成半个字符——Telegram 对含孤立代理项的消息直接回 400，整批发布随之失败。 */
function truncateByCodePoints(input: string, max: number): string {
  const points = Array.from(input);
  return points.length > max ? points.slice(0, max).join("") : input;
}

/** 「问卷 / 填写时间 / 填写者」三行，两处分批文案共用。 */
function heading(input: PublicReportCaptionInput): string[] {
  const title = (input.surveyTitle ?? "").trim() || "问卷";
  const lines = [
    "📋 问卷报告",
    "",
    `问卷：${truncateByCodePoints(title, 180)}`,
    `填写时间：${formatFilledAt(input.startedAt, input.completedAt)}`,
  ];
  // 匿名分支不读 respondent：这样"忘记遮盖"在结构上就不成立。
  if (!input.anonymous) {
    const respondent = (input.respondent ?? "").trim();
    if (respondent) lines.push(`填写者：${truncateByCodePoints(respondent, 120)}`);
  } else {
    lines.push("填写者：匿名");
  }
  return lines;
}

/** Telegram sendMediaGroup 一批最多 10 张图，分批的下标步长与它保持一致。 */
export const PUBLIC_REPORT_ALBUM_BATCH_SIZE = 10;

export interface PublicReportBatch {
  /** 1-based，本批第一张的页码。 */
  pageStart: number;
  /** 1-based，本批最后一张的页码（含）。 */
  pageEnd: number;
  totalPages: number;
}

/** 「第 11–20 页，共 24 页」；单页报告不需要页码。 */
export function formatPublicReportPageMarker(batch: PublicReportBatch): string {
  if (batch.totalPages <= 1) return "";
  const range = batch.pageStart === batch.pageEnd ? `第 ${batch.pageStart}` : `第 ${batch.pageStart}–${batch.pageEnd}`;
  return `${range} 页，共 ${batch.totalPages} 页`;
}

/**
 * 一批相册的 caption。
 *
 * 之前只有第一批带 caption（`index===0 && offset===0`），于是第 11 页起的消息
 * 在频道里**没有任何来源信息**：读者不知道这是哪份问卷、什么时候填的，出了
 * 问题也没法把后半截和前半截对上。Telegram 只显示 media group 里第一张的
 * caption，所以每一批都要自己带一条：
 *
 *   - 第一批：完整文案（问卷名 + 填写时间 + 填写者 + 留言）+ 页码标记，
 *     并在还有后续批次时说明「后续分批补发」；
 *   - 后续批次：问卷名 + 填写时间 + 页码标记（留言只留在第一批，避免同一句话
 *     在频道里重复出现 N 次）。
 *
 * 两种都要过 1024 的上限——留言较长时完整文案本身就可能顶到上限。
 */
export function buildPublicReportBatchCaption(input: PublicReportCaptionInput, batch: PublicReportBatch): string {
  const marker = formatPublicReportPageMarker(batch);
  if (!marker) return buildPublicReportCaption(input);

  if (batch.pageStart === 1) {
    const lines = heading(input);
    const message = normalizePublishMessage(input.message);
    if (message) lines.push("", "💬 想说的话：", message);
    const tail = batch.pageEnd < batch.totalPages ? `${marker}（后续分批补发）` : marker;
    lines.push("", `（${tail}）`);
    return clampPublicReportCaption(lines.join("\n"));
  }

  // 后续批次：只留能定位「这是哪一份的第几页」的三项，不重复留言。
  const lines = heading(input).filter((line) => line !== "" && line !== "📋 问卷报告");
  return clampPublicReportCaption([`📋 问卷报告（${marker}）`, ...lines].join("\n"));
}
