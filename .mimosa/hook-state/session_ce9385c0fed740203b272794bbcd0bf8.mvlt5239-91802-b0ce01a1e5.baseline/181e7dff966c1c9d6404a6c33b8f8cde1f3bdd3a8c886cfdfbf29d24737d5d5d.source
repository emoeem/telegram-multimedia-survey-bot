/**
 * 免登录投稿的表单配置 —— 从 submission-bot 的 config.js + TEMPLATES_JSON 迁来。
 *
 * 旧实现:模板与防滥用参数是投稿机器人 Worker 的环境变量/代码常量,运营用
 * 机器人命令改。并轨后配置落在本站 system_settings(JSON),默认值逐项对齐
 * 旧部署在跑的值(验证题开、3 次/小时/IP、全天 300、积压 100、单文件 10MB)。
 *
 * 配置分两层:结构(config)与模板(steps)。steps 校验规则照搬 validateTemplate:
 * step.id 进过审核展示与前端字段名,必须是安全的短标识符;choice 要有选项;
 * show_if 只能指向存在的步骤。校验失败回落默认值并告警——配置错误不能让投稿
 * 通道整个 500。
 */

import { getSystemSetting } from "../../db/repositories/system-settings.repository";

export type WebSubmitStepType = "text" | "choice" | "media";

export interface WebSubmitStep {
  id: string;
  type: WebSubmitStepType;
  label?: string;
  prompt: string;
  options?: string[] | null;
  required?: boolean;
  max_length?: number;
  show_if?: { step: string; equals?: string } | null;
}

export interface WebSubmitFormConfig {
  enabled: boolean;
  /** 未发布前草稿不可见:网页投稿没有身份,自动发布等于公开灌水位,必须审核。 */
  requireReview: boolean;
  title: string;
  intro: string;
  mainGroupUrl: string | null;
  captcha: boolean;
  minFillSeconds: number;
  rateLimitCount: number;
  rateLimitWindowSeconds: number;
  dailyLimit: number;
  pendingLimit: number;
  maxFiles: number;
  maxFileMb: number;
  maxTextLength: number;
  blockedWords: string[];
  blockLinks: boolean;
  /** 审核通过时的署名模板占位符与页脚(照搬旧 PUBLISH_TEMPLATE 的渲染语义)。 */
  publishTag: string;
  publishFooter: string;
  /** 审核通过后可选推送的 Telegram 频道/群 chat_id;空 = 只标记状态不推送。 */
  publishChannelId: string;
  steps: WebSubmitStep[];
}

/** 逐字段对齐 submission-bot 的 DEFAULT_TEMPLATE(默认模板一字未改)。 */
export const DEFAULT_WEB_SUBMIT_STEPS: WebSubmitStep[] = [
  {
    id: "category",
    type: "choice",
    prompt: "这次投稿属于哪一类？",
    options: ["图片分享", "文字分享", "提问求助", "其他"],
    label: "分类",
  },
  {
    id: "title",
    type: "text",
    prompt: "给这次投稿起个标题？（没有就点跳过）",
    required: false,
    max_length: 80,
    label: "标题",
  },
  {
    id: "body",
    type: "text",
    prompt: "写正文吧，想说的话都可以直接发给我",
    required: true,
    max_length: 2000,
    label: "正文",
  },
  {
    id: "photos",
    type: "media",
    prompt: "要配图或者附件吗？图片、视频、文件、语音、位置都行（没有就点跳过）",
    required: false,
    label: "图片",
  },
  {
    id: "author",
    type: "choice",
    prompt: "发布的时候怎么署名？",
    options: ["匿名投稿", "显示我的昵称", "自定义署名"],
    label: "署名方式",
  },
  {
    id: "signature",
    type: "text",
    prompt: "请输入想显示的署名",
    required: true,
    max_length: 32,
    label: "署名",
    show_if: { step: "author", equals: "自定义署名" },
  },
  {
    id: "contact",
    type: "text",
    prompt: "最后一步：留个联系方式吗？（可跳过）",
    required: false,
    max_length: 64,
    label: "联系方式",
  },
];

export const DEFAULT_WEB_SUBMIT_FORM: WebSubmitFormConfig = {
  enabled: true,
  requireReview: true,
  title: "📮 投稿",
  intro: "在这里直接投稿，不用注册、也不用装 Telegram。\n提交后会先经过管理员审核，通过后才会发布。",
  mainGroupUrl: null,
  captcha: true,
  minFillSeconds: 3,
  rateLimitCount: 3,
  rateLimitWindowSeconds: 3600,
  dailyLimit: 300,
  pendingLimit: 100,
  maxFiles: 6,
  maxFileMb: 10,
  maxTextLength: 2000,
  blockedWords: [],
  blockLinks: false,
  publishTag: "#投稿",
  publishFooter: "",
  publishChannelId: "",
  steps: DEFAULT_WEB_SUBMIT_STEPS,
};

export const WEB_SUBMIT_FORM_SETTING_KEY = "web_submit_form";

export class WebSubmitConfigError extends Error {}

/**
 * 从 system_settings 读表单配置;键不存在或损坏都回落默认(调用方拿 problems
 * 打日志)。配置错误绝不能让投稿通道 500。
 */
export async function loadWebSubmitFormSetting(db: D1Database): Promise<WebSubmitFormConfig> {
  let raw: string | null = null;
  try {
    raw = await getSystemSetting(db, WEB_SUBMIT_FORM_SETTING_KEY);
  } catch (error) {
    console.warn("web_submit_form setting unreadable; using defaults", { error: String(error) });
    return DEFAULT_WEB_SUBMIT_FORM;
  }
  const { config, problems } = mergeWebSubmitForm(raw);
  if (problems.length > 0) {
    console.warn("web_submit_form config problems; merged what is valid", { problems });
  }
  return config;
}

const STEP_TYPES = new Set<WebSubmitStepType>(["text", "choice", "media"]);

/** 校验模板结构;返回错误文案列表,空数组 = 合法。 */
export function validateWebSubmitSteps(steps: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    return ["steps 必须是非空数组"];
  }
  const ids = new Set<string>();
  steps.forEach((step, index) => {
    if (!step || typeof step !== "object") {
      problems.push(`第 ${index + 1} 个步骤不是对象`);
      return;
    }
    const entry = step as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id)) {
      problems.push(`步骤 id 只能用 1-24 位字母/数字/下划线/连字符：${id || "(空)"}`);
    }
    if (ids.has(id)) problems.push(`步骤 id 重复：${id}`);
    ids.add(id);
    const type = (entry.type ?? "text") as WebSubmitStepType;
    if (!STEP_TYPES.has(type)) problems.push(`步骤 ${id} 的 type 只能是 text / choice / media`);
    if (typeof entry.prompt !== "string" || !entry.prompt) problems.push(`步骤 ${id} 缺少 prompt`);
    if (type === "choice") {
      const options = entry.options;
      if (!Array.isArray(options) || options.length === 0) problems.push(`选项步骤 ${id} 需要至少一个 options`);
      else if (options.length > 8) problems.push(`选项步骤 ${id} 最多 8 个选项`);
    }
  });
  for (const step of steps as WebSubmitStep[]) {
    if (step?.show_if && !ids.has(step.show_if.step)) {
      problems.push(`步骤 ${step.id} 的 show_if 指向了不存在的步骤 ${step.show_if.step}`);
    }
  }
  return problems;
}

function intOr(value: unknown, fallback: number, min: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return fallback;
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * 把系统设置里的 JSON 合并到默认配置上。整段 steps 一起替换(局部合并会让
 * 「删掉一步」的运营操作不可能),其余字段逐个覆盖;结构非法的步骤数组整体
 * 回默认。任何一级失败都回默认并返回问题列表,让调用方有得日志可打。
 */
export function mergeWebSubmitForm(raw: string | null | undefined): {
  config: WebSubmitFormConfig;
  problems: string[];
} {
  if (!raw || !raw.trim()) return { config: DEFAULT_WEB_SUBMIT_FORM, problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: DEFAULT_WEB_SUBMIT_FORM, problems: ["web_submit_form 不是合法 JSON,已回落默认配置"] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { config: DEFAULT_WEB_SUBMIT_FORM, problems: ["web_submit_form 不是对象,已回落默认配置"] };
  }
  const input = parsed as Record<string, unknown>;
  const problems: string[] = [];
  const base = DEFAULT_WEB_SUBMIT_FORM;

  let steps = base.steps;
  if (input.steps !== undefined) {
    const stepProblems = validateWebSubmitSteps(input.steps);
    if (stepProblems.length === 0) {
      steps = input.steps as WebSubmitStep[];
    } else {
      problems.push(...stepProblems.map((item) => `steps.${item}`));
    }
  }

  const config: WebSubmitFormConfig = {
    enabled: boolOr(input.enabled, base.enabled),
    requireReview: boolOr(input.requireReview, base.requireReview),
    title: strOr(input.title, base.title) || base.title,
    intro: strOr(input.intro, base.intro),
    mainGroupUrl:
      typeof input.mainGroupUrl === "string" && input.mainGroupUrl.trim() ? input.mainGroupUrl.trim() : null,
    captcha: boolOr(input.captcha, base.captcha),
    minFillSeconds: intOr(input.minFillSeconds, base.minFillSeconds, 0),
    rateLimitCount: intOr(input.rateLimitCount, base.rateLimitCount, 0),
    rateLimitWindowSeconds: intOr(input.rateLimitWindowSeconds, base.rateLimitWindowSeconds, 0),
    dailyLimit: intOr(input.dailyLimit, base.dailyLimit, 0),
    pendingLimit: intOr(input.pendingLimit, base.pendingLimit, 0),
    maxFiles: intOr(input.maxFiles, base.maxFiles, 0),
    maxFileMb: intOr(input.maxFileMb, base.maxFileMb, 1),
    maxTextLength: intOr(input.maxTextLength, base.maxTextLength, 1),
    blockedWords: Array.isArray(input.blockedWords)
      ? (input.blockedWords as unknown[]).filter((item): item is string => typeof item === "string" && item.length > 0)
      : base.blockedWords,
    blockLinks: boolOr(input.blockLinks, base.blockLinks),
    publishTag: strOr(input.publishTag, base.publishTag),
    publishFooter: strOr(input.publishFooter, base.publishFooter),
    publishChannelId: strOr(input.publishChannelId, base.publishChannelId),
    steps,
  };
  return { config, problems };
}

/** 按步骤配置渲染出给前端的表单 schema(与旧 submitFormSchema 逐字段对齐)。 */
export function submitFormSchema(config: WebSubmitFormConfig) {
  return {
    title: config.title,
    intro: config.intro,
    captcha: config.captcha,
    maxFiles: config.maxFiles,
    maxFileMb: config.maxFileMb,
    minFillSeconds: config.minFillSeconds,
    submitUrl: "/api/submit",
    captchaUrl: "/api/submit/captcha",
    inboxUrl: "/submissions?tab=inbox",
    mainGroupUrl: config.mainGroupUrl,
    steps: config.steps.map((step) => ({
      id: step.id,
      type: step.type,
      label: step.label ?? step.id,
      prompt: step.prompt ?? "",
      options: Array.isArray(step.options) ? step.options : null,
      required: step.required !== false,
      maxLength: Math.min(step.max_length ?? config.maxTextLength, config.maxTextLength),
      showIf: step.show_if ? { step: step.show_if.step, equals: step.show_if.equals ?? "" } : null,
    })),
  };
}

/** 按 show_if 过滤可见步骤(移植 wizard.js 的 visibleSteps)。 */
export function visibleSteps(steps: WebSubmitStep[], data: Record<string, unknown>): WebSubmitStep[] {
  return steps.filter((step) => {
    const cond = step.show_if;
    if (!cond) return true;
    return String(data?.[cond.step] ?? "") === String(cond.equals ?? "");
  });
}

/** 步骤值的可读文本(文本步骤存的是 {plain, html})(移植 textOf)。 */
export function textOf(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => textOf(item)).join("、");
  if (value && typeof value === "object") {
    const plain = (value as { plain?: unknown }).plain;
    return plain === undefined ? "" : String(plain);
  }
  if (value === undefined || value === null) return "";
  return String(value);
}

/** 附件统一形状:新投稿带 mediaAssetId,旧迁移数据带 legacy fileId。 */
export interface WebSubmitAttachment {
  kind: "photo" | "video" | "document" | "audio" | "voice";
  name?: string | null;
  mediaAssetId?: number;
  mimeType?: string | null;
  fileSize?: number | null;
  /** 旧库迁移来的 Telegram file_id:由旧机器人 token 只读代取,不可再发布。 */
  legacyFileId?: string;
}

/** 取一条投稿 data 里的附件列表(移植 attachmentsOf)。 */
export function attachmentsOf(data: Record<string, unknown>, steps: WebSubmitStep[]): WebSubmitAttachment[] {
  const step = steps.find((item) => item.type === "media");
  const value = step ? data?.[step.id] : undefined;
  if (!Array.isArray(value)) return [];
  /* 迁移数据的附件引用键是旧库的 fileId(uniqueId 并存);新投稿用
   * mediaAssetId。这里统一归一成 legacyFileId,消费端(管理端预览、作者
   * 回复)只认这一个键。exactOptionalPropertyTypes 下 undefined 不能显式赋。 */
  return (value as Array<Record<string, unknown>>).map((item) => {
    const legacy =
      typeof item.legacyFileId === "string"
        ? item.legacyFileId
        : typeof (item as { fileId?: unknown }).fileId === "string"
          ? ((item as { fileId?: unknown }).fileId as string)
          : null;
    const normalized = { ...(item as unknown as WebSubmitAttachment) };
    if (legacy) normalized.legacyFileId = legacy;
    else delete normalized.legacyFileId;
    return normalized;
  });
}

const LINK_PATTERN = /https?:\/\/|t\.me\/|@[A-Za-z0-9_]{4,}/;

/** 敏感词/链接筛查(移植 screenSubmission 的纯文本部分,不做重复检测)。 */
export async function screenWebSubmission(
  config: WebSubmitFormConfig,
  data: Record<string, unknown>,
): Promise<{ blocked: string | null; flags: string[]; hash: string }> {
  const plain = [textOf(data.title), textOf(data.body), textOf(data.signature), textOf(data.contact)]
    .filter(Boolean)
    .join("\n");
  const flags: string[] = [];
  const lower = plain.toLowerCase();
  for (const word of config.blockedWords) {
    if (word && lower.includes(word.toLowerCase())) flags.push(`word:${word}`);
  }
  if (config.blockLinks && LINK_PATTERN.test(plain)) flags.push("link");
  return { blocked: null, flags, hash: await hashText(plain) };
}

export async function hashText(plain: string): Promise<string> {
  const bytes = new TextEncoder().encode(plain);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** 分类等中文词 → Telegram hashtag(移植 toHashtag:去掉空格与 # 字符)。 */
export function toHashtag(value: string): string {
  const cleaned = value.replaceAll(/[\s#]+/g, "");
  return cleaned ? `#${cleaned}` : "";
}

function hashtagsFor(config: WebSubmitFormConfig, data: Record<string, unknown>): string {
  const tags = [config.publishTag];
  const categoryStep = config.steps.find((step) => step.type === "choice");
  const category = categoryStep ? String(data[categoryStep.id] ?? "") : "";
  if (category) tags.push(toHashtag(category));
  const attachments = attachmentsOf(data, config.steps);
  const kinds = new Set(attachments.map((item) => item.kind));
  if (kinds.size === 0) tags.push("#文字");
  else if (kinds.has("photo")) tags.push("#图片");
  else if (kinds.has("video")) tags.push("#视频");
  else if (kinds.has("voice") || kinds.has("audio")) tags.push("#语音");
  else tags.push("#文件");
  return [...new Set(tags.filter(Boolean))].join(" ");
}

/**
 * 组装审核详情里"拿去就能发布"的正文(移植 composeSubmission 的核心路径)。
 * 附件不再进 Telegram 渲染,以「附件 N 个」一行带过。
 */
export function composeWebSubmissionText(
  config: WebSubmitFormConfig,
  data: Record<string, unknown>,
  submissionId: number,
): string {
  const categoryStep = config.steps.find((step) => step.type === "choice");
  const category = categoryStep ? String(data[categoryStep.id] ?? "") : "";
  const title = textOf(data.title).trim();
  const body = textOf(data.body);
  const attachments = attachmentsOf(data, config.steps);

  const authorChoice = String(data.author ?? "");
  const displayName =
    authorChoice === "匿名投稿" || !authorChoice
      ? ""
      : authorChoice === "显示我的昵称"
        ? String(data.__nickname ?? "")
        : textOf(data.signature) || authorChoice;
  let from = "";
  if (displayName) from = `投稿者：${escapeHtml(displayName)}`;
  else if (authorChoice) from = "投稿者：匿名";
  const contact = textOf(data.contact).trim();
  const meta = [contact ? `联系方式：${escapeHtml(contact)}` : "", from].filter(Boolean).join("\n");
  const attachmentLine = attachments.length > 0 ? `附件 ${attachments.length} 个\n` : "";

  const lines = [
    hashtagsFor(config, data),
    category ? escapeHtml(category) : "",
    title ? `<b>${escapeHtml(title)}</b>` : "",
    escapeHtml(body),
    attachmentLine + meta,
    config.publishFooter,
    `#${submissionId}`,
  ];
  return lines
    .filter((line) => line !== "")
    .join("\n\n")
    .trim();
}
