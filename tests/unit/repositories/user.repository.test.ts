import { describe, expect, it, vi } from "vitest";

import { upsertUser } from "../../../src/db/repositories/user.repository";

interface StatementMock {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

function createD1Mock(firstRow: unknown): D1Database {
  const statement: StatementMock = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => firstRow),
    run: vi.fn(async () => ({ success: true })),
  };

  return {
    prepare: vi.fn(() => statement),
  } as unknown as D1Database;
}

describe("user repository", () => {
  it("creates and returns a user", async () => {
    const now = "2026-08-14T00:00:00.000Z";
    const db = createD1Mock({
      id: 5,
      telegram_user_id: 111,
      username: "alice",
      first_name: "Alice",
      last_name: null,
      language_code: "zh-CN",
      system_role: "participant",
      created_at: now,
      updated_at: now,
    });

    const user = await upsertUser(db, {
      telegramUserId: 111,
      username: "alice",
      firstName: "Alice",
      languageCode: "zh-CN",
    });

    expect(user.id).toBe(5);
    expect(user.telegramUserId).toBe(111);
    expect(user.systemRole).toBe("participant");
  });
});
