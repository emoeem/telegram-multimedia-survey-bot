import { describe, expect, it } from "vitest";

import {
  loadLastMaintenanceHealth,
  loadSweepCursor,
  saveLastMaintenanceHealth,
  saveSweepCursor,
} from "../../../src/services/maintenance-state.service";

/** 只实现 system_settings 读写用到的两个语句的最小 D1 假体。 */
function createSettingsDb(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          bound = args;
          return statement;
        },
        first: async () => (sql.includes("SELECT value") ? { value: store.get(String(bound[0])) ?? null } : null),
        run: async () => {
          if (sql.includes("INSERT INTO system_settings")) {
            store.set(String(bound[0]), String(bound[1]));
          }
          return { meta: { changes: 1, rows_read: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, store };
}

describe("maintenance state", () => {
  it("round-trips the sweep cursor: truncate saves the resume point, completion resets to zero", async () => {
    const { db } = createSettingsDb();
    await saveSweepCursor(db, 5_000, true);
    expect(await loadSweepCursor(db)).toBe(5_000);
    await saveSweepCursor(db, 9_000, false);
    expect(await loadSweepCursor(db)).toBe(0);
    await saveSweepCursor(db, 0, true);
    expect(await loadSweepCursor(db)).toBe(0);
  });

  it("expires a stale cursor and tolerates corrupt values instead of failing the run", async () => {
    const staleSavedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const { db } = createSettingsDb({
      maintenance_sweep_cursor: JSON.stringify({ windowStart: 9_000, savedAt: staleSavedAt }),
    });
    expect(await loadSweepCursor(db)).toBe(0);

    const corrupt = createSettingsDb({ maintenance_sweep_cursor: "not-json{" });
    expect(await loadSweepCursor(corrupt.db)).toBe(0);
  });

  it("round-trips the maintenance health snapshot and rejects malformed payloads", async () => {
    const { db } = createSettingsDb();
    await saveLastMaintenanceHealth(db, {
      at: "2026-11-17T01:15:00.000Z",
      rowsRead: 123_456,
      truncated: true,
      parked: false,
      orphanAssets: 2,
    });
    expect(await loadLastMaintenanceHealth(db)).toEqual({
      at: "2026-11-17T01:15:00.000Z",
      rowsRead: 123_456,
      truncated: true,
      parked: false,
      orphanAssets: 2,
    });

    const corrupt = createSettingsDb({ maintenance_last_summary: "{{bad" });
    expect(await loadLastMaintenanceHealth(corrupt.db)).toBeNull();
    expect(await loadLastMaintenanceHealth(createSettingsDb().db)).toBeNull();
  });
});
