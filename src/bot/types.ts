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
  db: D1Database;
  cache?: KVNamespace;
  session: SurveySessionNamespace;
  ui?: UiSessionNamespace;
  builder: SurveyBuilderNamespace;
  adminIds: number[];
  exportQueue: Queue;
  origin?: string;
  licenseServerUrl?: string;
  licenseAdminEnabled?: boolean;
  browser?: BrowserWorker;
  webhookSecret?: string;
}
