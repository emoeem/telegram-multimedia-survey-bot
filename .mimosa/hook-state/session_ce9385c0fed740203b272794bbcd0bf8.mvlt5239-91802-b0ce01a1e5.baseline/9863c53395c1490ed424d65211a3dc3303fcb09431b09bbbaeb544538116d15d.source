import { getSystemSetting, listSystemSettings, setSystemSetting } from "../db/repositories/system-settings.repository";

export const SYSTEM_SETTING_KEYS = [
  "report_channel_id",
  "cert_share_channel_id",
  "plaza_channel_id",
  "default_report_template",
  "media_ttl_seconds",
  "max_upload_mb",
  "max_response_media_mb",
  "pdf_max_mb",
  "report_watermark",
  "profile_gallery_survey_id",
] as const;

export type SystemSettingKey = (typeof SYSTEM_SETTING_KEYS)[number] | "admin_password_hash" | "admin_session_epoch";

export const ADMIN_SESSION_EPOCH_KEY = "admin_session_epoch";

/** Reads the admin-session epoch, defaulting to 0 when unset. */
export async function loadAdminSessionEpoch(db: D1Database): Promise<number> {
  const raw = await getSystemSettingValue(db, ADMIN_SESSION_EPOCH_KEY);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export interface SystemSettings {
  reportChannelId: string;
  /**
   * 认证卡生成器的发布目标。留空即「继承报告归档频道」——两者在语义上不同
   * （归档频道收的是答卷 ZIP，这里收的是访客自己生成的照片），所以能单独覆盖，
   * 但不覆盖时不该要求管理员再填一遍同一个 id。
   */
  certShareChannelId: string;
  plazaChannelId: string;
  defaultReportTemplate: string;
  mediaTtlSeconds: number;
  maxUploadMb: number;
  maxResponseMediaMb: number;
  pdfMaxMb: number;
  reportWatermark: string;
  profileGallerySurveyId: string;
}

export const SYSTEM_SETTING_DEFAULTS: SystemSettings = {
  reportChannelId: "",
  certShareChannelId: "",
  plazaChannelId: "",
  defaultReportTemplate: "classic",
  mediaTtlSeconds: 7 * 24 * 60 * 60,
  maxUploadMb: 10,
  maxResponseMediaMb: 50,
  pdfMaxMb: 15,
  reportWatermark: "更多问卷 @hnhgggfj_bot",
  profileGallerySurveyId: "",
};

export async function loadSystemSettings(db: D1Database): Promise<SystemSettings> {
  const rows = (await db.prepare("SELECT key, value FROM system_settings ORDER BY key ASC").all()).results as Array<{
    key: string;
    value: string;
  }>;
  return settingsFromRows(rows);
}

/**
 * Builds the settings projection from raw (key, value) rows. Split from
 * {@link loadSystemSettings} so a caller that already read the rows inside its
 * own batch (the public definition handler) skips the extra round trip.
 */
export function settingsFromRows(rows: Array<{ key: string; value: string }>): SystemSettings {
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const number = (key: string, fallback: number): number => {
    const value = Number(stored[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    reportChannelId: stored["report_channel_id"] ?? SYSTEM_SETTING_DEFAULTS.reportChannelId,
    certShareChannelId: stored["cert_share_channel_id"] ?? SYSTEM_SETTING_DEFAULTS.certShareChannelId,
    plazaChannelId: stored["plaza_channel_id"] ?? SYSTEM_SETTING_DEFAULTS.plazaChannelId,
    defaultReportTemplate: stored["default_report_template"] ?? SYSTEM_SETTING_DEFAULTS.defaultReportTemplate,
    mediaTtlSeconds: number("media_ttl_seconds", SYSTEM_SETTING_DEFAULTS.mediaTtlSeconds),
    maxUploadMb: number("max_upload_mb", SYSTEM_SETTING_DEFAULTS.maxUploadMb),
    maxResponseMediaMb: number("max_response_media_mb", SYSTEM_SETTING_DEFAULTS.maxResponseMediaMb),
    pdfMaxMb: number("pdf_max_mb", SYSTEM_SETTING_DEFAULTS.pdfMaxMb),
    reportWatermark: stored["report_watermark"] ?? SYSTEM_SETTING_DEFAULTS.reportWatermark,
    profileGallerySurveyId: stored["profile_gallery_survey_id"] ?? SYSTEM_SETTING_DEFAULTS.profileGallerySurveyId,
  };
}

export async function getSystemSettingValue(db: D1Database, key: SystemSettingKey): Promise<string | null> {
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
