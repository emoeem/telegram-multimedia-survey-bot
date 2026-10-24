import { describe, expect, it } from "vitest";

import { resolveRespondentDisplay } from "../../../src/services/report-delivery-worker.service";
import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 归档身份展示分流（真实 schema）：
 * TG 填写 → telegram（用户名 + id）；邮箱注册填写 → email（含历史 email_* 行）；
 * 合成行无邮箱账号 → web_user；匿名时代 → null。
 */

const suite = sqliteD1Available ? describe : describe.skip;

function seedUser(
  db: D1Database,
  input: { id: number; telegramUserId: number; username?: string | null; firstName?: string | null },
) {
  return db
    .prepare(
      "INSERT INTO users (id, telegram_user_id, username, first_name, system_role, created_at, updated_at) VALUES (?, ?, ?, ?, 'participant', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .bind(input.id, input.telegramUserId, input.username ?? null, input.firstName ?? null)
    .run();
}

function seedEmailAccount(db: D1Database, input: { id: number; email: string; userId: number | null }) {
  return db
    .prepare(
      `INSERT INTO email_accounts (id, email, password_hash, verified_at, session_version, user_id, created_at, updated_at)
       VALUES (?, ?, 'pbkdf2:1:x:y', '2026-01-01T00:00:00Z', 1, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    )
    .bind(input.id, input.email, input.userId)
    .run();
}

suite("resolveRespondentDisplay", () => {
  it("resolves a real Telegram user to the telegram kind", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedUser(db, { id: 7, telegramUserId: 8407924229, username: "alice", firstName: "Alice" });
    const display = await resolveRespondentDisplay(db, { userId: 7, participantHash: "user_7" });
    expect(display).toEqual({
      kind: "telegram",
      username: "alice",
      firstName: "Alice",
      telegramUserId: 8407924229,
    });
  });

  it("resolves an email account's synthetic user row to the email kind (no broken tg link)", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    // 0082：邮箱注册创建合成 users 行（telegram id 1e12+accountId）。
    await seedUser(db, { id: 10439, telegramUserId: 1_000_000_000_000 + 439 });
    await seedEmailAccount(db, { id: 439, email: "missuser@example.com", userId: 10439 });
    const display = await resolveRespondentDisplay(db, { userId: 10439, participantHash: "user_10439" });
    expect(display).toEqual({ kind: "email", email: "missuser@example.com", accountId: 439 });
  });

  it("resolves a legacy email_* response (no user row) via the account id in the hash", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedEmailAccount(db, { id: 77, email: "legacy@example.com", userId: null });
    const display = await resolveRespondentDisplay(db, { userId: null, participantHash: "email_77" });
    expect(display).toEqual({ kind: "email", email: "legacy@example.com", accountId: 77 });
  });

  it("falls back to web_user for a synthetic row without an email account", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    await seedUser(db, { id: 555, telegramUserId: 1_000_000_000_555 });
    const display = await resolveRespondentDisplay(db, { userId: 555, participantHash: "user_555" });
    expect(display).toEqual({ kind: "web_user", userId: 555 });
  });

  it("returns null for anonymous-era web_* rows", async () => {
    const db = createSqliteD1(fullMigrationSchema());
    const display = await resolveRespondentDisplay(db, {
      userId: null,
      participantHash: "web_79efce85d54b45f1845b2d8a3b626131",
    });
    expect(display).toBeNull();
  });
});
