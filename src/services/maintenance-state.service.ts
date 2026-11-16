import { getSystemSetting, setSystemSetting } from "../db/repositories/system-settings.repository";

/**
 * 每日维护任务的持久化状态（每个部署自己的 D1，一行一个 key）。
 *
 * 1. 孤儿清扫游标（P2）：预算截断后旧实现每天从 id=0 重扫——老素材库一旦
 *    变大就是"烧满预算 → 扫不完 → 天天告警 → 永远删不了"的死循环。把扫描
 *    窗口起点持久化，截断处续扫，扫完重置。
 * 2. 最近一次维护摘要（P1a）：心跳（每 30 分钟）把它捎带给 license center，
 *    vendor 后台才能看见每个客户实例的维护健康——2026-11-16 那次客户侧事故
 *    vendor 完全盲，只能靠恰好是管理员的 Telegram DM 才知道。
 *
 * 走 system_settings 的通用 key-value 存取：这两份状态是运行时数据，不是
 * 管理员可编辑配置，不进 SYSTEM_SETTING_KEYS 的强类型门面。
 */
const SWEEP_CURSOR_KEY = "maintenance_sweep_cursor";
const LAST_SUMMARY_KEY = "maintenance_last_summary";

const CURSOR_MAX_AGE_MS = 30 * 86_400_000;

export async function loadSweepCursor(db: D1Database, now = Date.now()): Promise<number> {
  const raw = await getSystemSetting(db, SWEEP_CURSOR_KEY);
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as { windowStart?: number; savedAt?: string };
    const windowStart = Number(parsed.windowStart);
    // 游标过期（30 天没写回 = 扫描早已完成或环境变化）时从头扫，避免永久跳过前缀。
    if (!Number.isInteger(windowStart) || windowStart < 0) return 0;
    if (parsed.savedAt && now - Date.parse(parsed.savedAt) > CURSOR_MAX_AGE_MS) return 0;
    return windowStart;
  } catch {
    return 0;
  }
}

/** truncated=true 记下续扫点；false（扫完或本轮没跑扫描）重置为 0。 */
export async function saveSweepCursor(db: D1Database, windowStart: number, truncated: boolean): Promise<void> {
  const value = truncated && windowStart > 0 ? JSON.stringify({ windowStart, savedAt: new Date().toISOString() }) : "0";
  await setSystemSetting(db, SWEEP_CURSOR_KEY, value, null);
}

export interface MaintenanceHealth {
  at: string;
  rowsRead: number;
  truncated: boolean;
  parked: boolean;
  orphanAssets: number;
}

export async function loadLastMaintenanceHealth(db: D1Database): Promise<MaintenanceHealth | null> {
  const raw = await getSystemSetting(db, LAST_SUMMARY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MaintenanceHealth>;
    if (typeof parsed.at !== "string" || !Number.isFinite(Number(parsed.rowsRead))) return null;
    return {
      at: parsed.at,
      rowsRead: Number(parsed.rowsRead),
      truncated: parsed.truncated === true,
      parked: parsed.parked === true,
      orphanAssets: Number(parsed.orphanAssets ?? 0),
    };
  } catch {
    return null;
  }
}

export async function saveLastMaintenanceHealth(db: D1Database, health: MaintenanceHealth): Promise<void> {
  await setSystemSetting(db, LAST_SUMMARY_KEY, JSON.stringify(health), null);
}
