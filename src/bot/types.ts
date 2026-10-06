import type { SurveyBuilderNamespace } from "../services/survey-builder.service";
import type { SurveySessionNamespace } from "../services/session.service";
import type { UiSessionNamespace } from "../services/ui-session.service";
import type { BrowserWorker } from "@cloudflare/puppeteer";

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type?: string;
  title?: string;
}

export interface TelegramMediaFile {
  file_id: string;
  file_unique_id: string;
  mime_type?: string;
  file_size?: number;
  width?: number;
  height?: number;
  duration?: number;
  file_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  /** Forum-topic thread the message was posted in; absent outside topic groups. */
  message_thread_id?: number;
  forward_from_chat?: {
    id: number;
    type?: string;
    username?: string;
    title?: string;
  };
  text?: string;
  caption?: string;
  photo?: TelegramMediaFile[];
  video?: TelegramMediaFile;
  audio?: TelegramMediaFile;
  voice?: TelegramMediaFile;
  animation?: TelegramMediaFile;
  sticker?: TelegramMediaFile;
  document?: TelegramMediaFile;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  channel_post?: TelegramMessage;
}

export interface BotContext {
  botToken: string;
  /**
   * 本条 update 所在的会话，由 router 在分发前填好。
   *
   * 论坛群（话题群）里不带 message_thread_id 的消息会落到 General 话题，而该
   * 话题一旦被关闭，Telegram 直接返回 400 Bad Request: TOPIC_CLOSED。回复本条
   * update 所在的会话时必须带回话题 id —— 统一走 ./reply.ts 的 replyXxx，不要
   * 直接调用 ./telegram.ts 的发送函数。
   */
  incoming?: { chatId: number; threadId?: number };
  db: D1Database;
  cache?: KVNamespace;
  /** Media KV store; used to serve stored identity card renders. */
  mediaKv?: KVNamespace;
  session: SurveySessionNamespace;
  ui?: UiSessionNamespace;
  builder: SurveyBuilderNamespace;
  adminIds: number[];
  exportQueue: Queue;
  origin?: string;
  /** Public link for the submission bot (投稿机器人); renders as a jump button. */
  submissionBotUrl?: string | null;
  /** Community invite shown in the welcome text; defaults to the hosted group. */
  communityGroupUrl?: string | null;
  licenseServerUrl?: string;
  licenseAdminEnabled?: boolean;
  browser?: BrowserWorker;
  webhookSecret?: string;
}
