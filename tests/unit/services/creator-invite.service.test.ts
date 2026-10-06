import { describe, expect, it } from "vitest";

import {
  generateCreatorInviteCode,
  issueCreatorInvite,
  listCreatorInvitesForAdmin,
  normalizeCreatorInviteCode,
  redeemCreatorInviteForUser,
  validateIssueInput,
} from "../../../src/services/creator-invite.service";
import { createCreatorInvite } from "../../../src/db/repositories/creator-invite.repository";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

const SCHEMA = `
CREATE TABLE creator_invites (
  code TEXT PRIMARY KEY,
  days INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  note TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE creator_trial_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  granted_by INTEGER,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const base = { days: 30, maxUses: 1, expiresInDays: 7, note: null, createdBy: 1 };

describe("creator invite codes", () => {
  it("generates readable codes and normalizes sloppy input", () => {
    const code = generateCreatorInviteCode();
    expect(code).toMatch(/^CR-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // 不含易混字符
    expect(code.slice(3)).not.toMatch(/[0O1I]/);

    expect(normalizeCreatorInviteCode("cr-7f3k-9q2m")).toBe("CR-7F3K-9Q2M");
    expect(normalizeCreatorInviteCode("CR7F3K9Q2M")).toBe("CR-7F3K-9Q2M");
    expect(normalizeCreatorInviteCode("  cr 7f3k 9q2m ")).toBe("CR-7F3K-9Q2M");
    expect(normalizeCreatorInviteCode("CR-1234")).toBeNull();
    expect(normalizeCreatorInviteCode("hello")).toBeNull();
  });

  it("rejects out-of-range parameters", () => {
    expect(validateIssueInput(base)).toBeNull();
    expect(validateIssueInput({ ...base, days: 0 })).toContain("体验天数");
    expect(validateIssueInput({ ...base, maxUses: 0 })).toContain("可用次数");
    expect(validateIssueInput({ ...base, expiresInDays: 0 })).toContain("有效期");
    expect(validateIssueInput({ ...base, note: "x".repeat(61) })).toContain("备注");
  });

  it.skipIf(!sqliteD1Available)("issues, lists and redeems exactly once", async () => {
    const db = createSqliteD1(SCHEMA);
    const invite = await issueCreatorInvite(db, { ...base, note: "给若芙" });
    expect(invite.usedCount).toBe(0);

    const list = await listCreatorInvitesForAdmin(db);
    expect(list.map((item) => item.code)).toEqual([invite.code]);
    expect(list[0]?.note).toBe("给若芙");

    const first = await redeemCreatorInviteForUser(db, { code: invite.code, userId: 42, grantedBy: null });
    expect(first.ok).toBe(true);
    const firstExpiresAt = first.ok ? first.expiresAt : "";
    expect(first.ok ? first.days : 0).toBe(30);
    // 授权落到兑换者自己的 user_id 上
    const grant = await db
      .prepare("SELECT user_id userId, expires_at expiresAt FROM creator_trial_grants WHERE user_id = ?")
      .bind(42)
      .first<{ userId: number; expiresAt: string }>();
    expect(grant?.userId).toBe(42);
    expect(grant?.expiresAt).toBe(firstExpiresAt);

    // 一次性码：第二个人再来就是「已用完」
    const second = await redeemCreatorInviteForUser(db, { code: invite.code, userId: 43, grantedBy: null });
    expect(second).toEqual({ ok: false, reason: "exhausted" });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM creator_trial_grants").first<{ count: number }>()).toEqual({
      count: 1,
    });
  });

  it.skipIf(!sqliteD1Available)("honours the multi-use budget and rejects expired or unknown codes", async () => {
    const db = createSqliteD1(SCHEMA);
    const multi = await issueCreatorInvite(db, { ...base, maxUses: 2 });
    expect((await redeemCreatorInviteForUser(db, { code: multi.code, userId: 1, grantedBy: null })).ok).toBe(true);
    expect((await redeemCreatorInviteForUser(db, { code: multi.code, userId: 2, grantedBy: null })).ok).toBe(true);
    expect(await redeemCreatorInviteForUser(db, { code: multi.code, userId: 3, grantedBy: null })).toEqual({
      ok: false,
      reason: "exhausted",
    });

    await createCreatorInvite(db, {
      code: "CR-AAAA-BBBB",
      days: 30,
      maxUses: 1,
      expiresAt: "2020-01-01T00:00:00.000Z",
      note: null,
      createdBy: 1,
    });
    expect(await redeemCreatorInviteForUser(db, { code: "CR-AAAA-BBBB", userId: 4, grantedBy: null })).toEqual({
      ok: false,
      reason: "expired",
    });

    expect(await redeemCreatorInviteForUser(db, { code: "CR-ZZZZ-ZZZZ", userId: 4, grantedBy: null })).toEqual({
      ok: false,
      reason: "not_found",
    });
    // 形如垃圾的输入直接判 not_found，不查库
    expect(await redeemCreatorInviteForUser(db, { code: "随便写的", userId: 4, grantedBy: null })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});
