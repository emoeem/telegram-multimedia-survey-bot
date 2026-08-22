import {
  getSystemSetting,
  listSystemSettings,
  setSystemSetting,
} from "../db/repositories/system-settings.repository";

export const SYSTEM_SETTING_KEYS = [
  "report_channel_id",
  "default_report_template",
  "media_ttl_seconds",
  "max_upload_mb",
  "max_response_media_mb",
  "pdf_max_mb",
] as const;

export type SystemSettingKey = (typeof SYSTEM_SETTING_KEYS)[number];

export interface SystemSettings {
  reportChannelId: string;
  defaultReportTemplate: string;
  mediaTtlSeconds: number;
  maxUploadMb: number;
  maxResponseMediaMb: number;
  pdfMaxMb: number;
}

export const SYSTEM_SETTING_DEFAULTS: SystemSettings = {
  reportChannelId: "",
  defaultReportTemplate: "classic",
  mediaTtlSeconds: 7 * 24 * 60 * 60,
  maxUploadMb: 10,
  maxResponseMediaMb: 50,
  pdfMaxMb: 15,
};

export async function loadSystemSettings(
  db: D1Database,
): Promise<SystemSettings> {
  const stored = await listSystemSettings(db);
  const number = (key: string, fallback: number): number => {
    const value = Number(stored[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    reportChannelId: stored["report_channel_id"] ?? SYSTEM_SETTING_DEFAULTS.reportChannelId,
    defaultReportTemplate: stored["default_report_template"] ?? SYSTEM_SETTING_DEFAULTS.defaultReportTemplate,
    mediaTtlSeconds: number("media_ttl_seconds", SYSTEM_SETTING_DEFAULTS.mediaTtlSeconds),
    maxUploadMb: number("max_upload_mb", SYSTEM_SETTING_DEFAULTS.maxUploadMb),
    maxResponseMediaMb: number("max_response_media_mb", SYSTEM_SETTING_DEFAULTS.maxResponseMediaMb),
    pdfMaxMb: number("pdf_max_mb", SYSTEM_SETTING_DEFAULTS.pdfMaxMb),
  };
}

export async function getSystemSettingValue(
  db: D1Database,
  key: SystemSettingKey,
): Promise<string | null> {
  return getSystemSetting(db, key);
}

export async function saveSystemSetting(
  db: D1Database,
  key: string,
  value: string,
  updatedBy: number | null,
): Promise<void> {
  await setSystemSetting(db, key, value, updatedBy);
}
