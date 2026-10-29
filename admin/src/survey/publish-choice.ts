/**
 * 「公开发布」的三项选择（纯逻辑，不碰 React / DOM）。
 *
 * 抽出来是因为这三项要跨越三处：弹窗（收集）→ 提交请求体（字段名与限长）→
 * 频道消息（文案）。任何一处单独改都会静默漂移——最坏的情况是"匿名"在前端被
 * 藏起来、后端却没收到，于是名字照样发进公开频道。所以规则只写在这里：
 *
 *   - 是否公开：`publishToTelegram`（false = 仅自己可见 / 取消发布）
 *   - 是否匿名：`anonymous`（true = 发布内容里没有任何 Telegram 身份）
 *   - 想说的话：`message`（可空，限长与服务端一致）
 */

/** 与服务端 `PUBLISH_MESSAGE_MAX`（src/services/public-report-caption.ts）一致。 */
export const PUBLISH_MESSAGE_MAX = 200;

export interface PublishChoice {
  /** 是否公开发布到 Telegram 频道/群组；false = 仅自己可见（或取消发布）。 */
  publishToTelegram: boolean;
  /** 匿名发布：发布内容（caption + 报告图片）不得出现任何 Telegram 身份。 */
  anonymous: boolean;
  /** 想说的话，会作为发布消息的配文；空串表示没有。 */
  message: string;
}

/**
 * 默认值：不发布 + 匿名。
 *
 * 匿名默认开是有意的——频道消息发出去就收不回来，而"不匿名"是答卷者主动放弃
 * 隐私的动作，应该是他点出来的一次选择，不是默认结果。
 */
export const DEFAULT_PUBLISH_CHOICE: PublishChoice = {
  publishToTelegram: false,
  anonymous: true,
  message: "",
};

/** 弹窗里的"是否公布"三态：公开 / 仅自己可见。取消发布直接用 publishToTelegram=false 表达。 */
export type PublishVisibility = "public" | "private";

export interface PublishChoiceDraft {
  visibility: PublishVisibility;
  anonymous: boolean;
  message: string;
}

export function toPublishDraft(choice: PublishChoice): PublishChoiceDraft {
  return {
    visibility: choice.publishToTelegram ? "public" : "private",
    anonymous: choice.anonymous,
    message: choice.message,
  };
}

/**
 * 按码点截断并归一化（去首尾空白、折叠 3 个以上连续空行、去掉控制字符）。
 * 与服务端 `normalizePublishMessage` 同一套规则，只是这里允许"边打边截"：
 * 用 `slice` 按 UTF-16 切会把 emoji 切成半个字符，界面上直接是一个 `�`。
 */
export function clampPublishMessage(raw: string): string {
  const stripped = raw
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  const points = Array.from(stripped);
  return points.length > PUBLISH_MESSAGE_MAX ? points.slice(0, PUBLISH_MESSAGE_MAX).join("") : stripped;
}

export function publishMessageLength(message: string): number {
  return Array.from(clampPublishMessage(message)).length;
}

export function fromPublishDraft(draft: PublishChoiceDraft): PublishChoice {
  return {
    publishToTelegram: draft.visibility === "public",
    anonymous: draft.anonymous,
    // 「仅自己可见」时留言不会被发布，但草稿里保留：用户切回「公开」时
    // 不该发现自己写的话没了（真正的发布裁剪在 publishChoiceRequestFields）。
    message: clampPublishMessage(draft.message).trim(),
  };
}

/** 发布请求体：字段名只有这里一处，前后端对不上时单测会先红。 */
export function publishChoiceRequestFields(choice: PublishChoice): {
  publishToTelegram: boolean;
  publishAnonymous: boolean;
  publishMessage: string;
} {
  return {
    publishToTelegram: choice.publishToTelegram,
    // 未公开时不承诺匿名与否也没有意义，但照实传出——后端仍会落库这三项。
    publishAnonymous: choice.anonymous,
    publishMessage: clampPublishMessage(choice.message).trim(),
  };
}

/**
 * 勾选框下方的当次选择摘要：让"我到底选了什么"在提交前一眼可见，
 * 不用再点开弹窗确认。
 */
export function describePublishChoice(choice: PublishChoice): string {
  if (!choice.publishToTelegram) return "仅自己可见 · 不会发布到频道";
  const identity = choice.anonymous ? "匿名（不显示 Telegram 信息）" : "显示 Telegram 身份";
  const length = publishMessageLength(choice.message.trim());
  return `公开发布 · ${identity} · ${length > 0 ? `留言 ${length} 字` : "无留言"}`;
}
