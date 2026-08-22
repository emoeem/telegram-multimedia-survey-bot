import { nowIso } from "../client";

export async function getSystemSetting(
  db: D1Database,
  key: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM system_settings WHERE key = ? LIMIT 1")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function listSystemSettings(
  db: D1Database,
): Promise<Record<string, string>> {
  const rows = await db
    .prepare("SELECT key, value FROM system_settings ORDER BY key ASC")
    .all<{ key: string; value: string }>();
  return Object.fromEntries((rows.results ?? []).map((row) => [row.key, row.value]));
}

export async function setSystemSetting(
  db: D1Database,
  key: string,
  value: string,
  updatedBy: number | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO system_settings (key, value, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .bind(key, value, updatedBy, nowIso())
    .run();
}
