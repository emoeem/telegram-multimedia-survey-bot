import { describe, expect, it } from "vitest";
import { decideDrawKind, drawPoolWhere, validateNoteDraft } from "../../src/services/note-chat.service";

describe("纸条聊天 · 纯规则", () => {
  describe("decideDrawKind（免费额 → 金币）", () => {
    it("当日未抽/未满免费额时走 free 并递减剩余次数", () => {
      expect(decideDrawKind(0)).toEqual({ kind: "free", freeLeft: 2, costCoins: 0 });
      expect(decideDrawKind(2)).toEqual({ kind: "free", freeLeft: 0, costCoins: 0 });
    });
    it("免费额用完即转 coin，不再有剩余免费额", () => {
      const decision = decideDrawKind(3);
      expect(decision.kind).toBe("coin");
      expect(decision.freeLeft).toBe(0);
      expect(decision.costCoins).toBeGreaterThan(0);
    });
    it("超额计数（防御性）也稳定落在 coin", () => {
      expect(decideDrawKind(99).kind).toBe("coin");
    });
  });

  describe("validateNoteDraft", () => {
    it("合法草稿通过并裁剪地区空白", () => {
      const clean = validateNoteDraft({ gender: "f", ageBand: "25-30", region: "  上海  ", content: "  你好呀  " });
      expect(clean).toEqual({ gender: "f", ageBand: "25-30", region: "上海", content: "你好呀" });
    });
    it("非法性别/年龄段被拒", () => {
      expect(() => validateNoteDraft({ gender: "robot", ageBand: "25-30", region: "", content: "hi" })).toThrowError(
        /性别/,
      );
      expect(() => validateNoteDraft({ gender: "m", ageBand: "under-18", region: "", content: "hi" })).toThrowError(
        /年龄段/,
      );
    });
    it("空内容与超长内容被拒", () => {
      expect(() => validateNoteDraft({ gender: "m", ageBand: "18-24", region: "", content: "   " })).toThrowError();
      expect(() =>
        validateNoteDraft({ gender: "m", ageBand: "18-24", region: "", content: "字".repeat(301) }),
      ).toThrowError(/300/);
    });
  });

  describe("drawPoolWhere（抽取池边界）", () => {
    it("排除自己、非可抽状态、已聊过的纸条，并以当前时刻为界", () => {
      const { sql, params } = drawPoolWhere("hash_a", "2026-10-24T00:00:00Z");
      expect(sql).toContain("owner_hash != ?");
      expect(sql).toContain("status = 'active'");
      expect(sql).toContain("expires_at > ?");
      expect(sql).toContain("id NOT IN (SELECT note_id FROM note_threads WHERE drawer_hash = ?)");
      expect(params).toEqual(["2026-10-24T00:00:00Z", "hash_a", "hash_a"]);
    });
  });
});
