const IDENTITY_CARD_FEATURE = "identity_card";

interface FeatureAccessSettingRow {
  feature: string;
  access_code: string;
  version: number;
  updated_at: string;
}

export interface FeatureAccessSetting {
  feature: string;
  accessCode: string;
  version: number;
  updatedAt: string;
}

function mapSetting(row: FeatureAccessSettingRow): FeatureAccessSetting {
  return {
    feature: row.feature,
    accessCode: row.access_code,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

export async function getIdentityCardAccessSetting(
  db: D1Database,
): Promise<FeatureAccessSetting | null> {
  const row = await db.prepare(
    "SELECT feature, access_code, version, updated_at FROM feature_access_settings WHERE feature = ? LIMIT 1",
  ).bind(IDENTITY_CARD_FEATURE).first<FeatureAccessSettingRow>();
  return row ? mapSetting(row) : null;
}

export async function setIdentityCardAccessCode(
  db: D1Database,
  accessCode: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO feature_access_settings (feature, access_code, version, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(feature) DO UPDATE SET
       access_code = excluded.access_code,
       version = feature_access_settings.version + 1,
       updated_at = excluded.updated_at`,
  ).bind(IDENTITY_CARD_FEATURE, accessCode, new Date().toISOString()).run();
}

export async function clearIdentityCardAccessCode(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM feature_access_grants WHERE feature = ?").bind(IDENTITY_CARD_FEATURE),
    db.prepare("DELETE FROM feature_access_settings WHERE feature = ?").bind(IDENTITY_CARD_FEATURE),
  ]);
}

export async function grantIdentityCardAccess(
  db: D1Database,
  userId: number,
  settingVersion: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO feature_access_grants (feature, user_id, setting_version, granted_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(feature, user_id) DO UPDATE SET
       setting_version = excluded.setting_version,
       granted_at = excluded.granted_at`,
  ).bind(IDENTITY_CARD_FEATURE, userId, settingVersion, new Date().toISOString()).run();
}

export async function hasIdentityCardAccess(
  db: D1Database,
  userId: number,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS allowed
     FROM feature_access_grants grant
     JOIN feature_access_settings setting ON setting.feature = grant.feature
     WHERE grant.feature = ? AND grant.user_id = ?
       AND grant.setting_version = setting.version
     LIMIT 1`,
  ).bind(IDENTITY_CARD_FEATURE, userId).first<{ allowed: number }>();
  return Boolean(row?.allowed);
}
