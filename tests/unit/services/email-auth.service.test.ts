import { describe, expect, it } from "vitest";
import {
  createEmailSessionToken,
  hashPassword,
  issueEmailCode,
  isValidEmail,
  isValidPassword,
  verifyEmailCode,
  verifyEmailSessionToken,
  verifyPassword,
} from "../../../src/services/email-auth.service";

describe("email auth service", () => {
  it("hashes and verifies passwords with per-hash salts", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^pbkdf2:100000:/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
    // A second hash must use a different salt.
    const second = await hashPassword("correct horse battery");
    expect(second).not.toBe(hash);
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2:abc:!!!:!!!")).toBe(false);
  });

  it("round-trips session tokens and rejects tampering", async () => {
    const token = await createEmailSessionToken("secret", 42, 3);
    expect(await verifyEmailSessionToken("secret", token)).toEqual({ accountId: 42, version: 3 });
    expect(await verifyEmailSessionToken("other-secret", token)).toBeNull();
    expect(await verifyEmailSessionToken("secret", `${token}x`)).toBeNull();
    expect(await verifyEmailSessionToken("secret", "garbage")).toBeNull();
  });

  it("validates emails and passwords", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidPassword("12345678")).toBe(true);
    expect(isValidPassword("short")).toBe(false);
  });
});

/* ---- 邮箱验证码生命周期（审计 1B · 一次性使用与爆破上限） ----
 *
 * verifyEmailCode 的三个安全属性此前无测试：验证成功即失效（一次性）、
 * 错误次数达到上限后连同正确码一起锁死（防 6 位数字暴力枚举）、purpose
 * 绑定（注册码不能当重置码用）。TTL 过期由 KV expirationTtl 保证，本替身
 * 不模拟时钟，只模拟 get/put/delete 语义。
 */
function makeCodeStore() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    has(key: string) {
      return store.has(key);
    },
  };
}

describe("email verification code lifecycle", () => {
  it("验证成功后码立即失效：同一码第二次验证必须失败", async () => {
    const store = makeCodeStore();
    const code = await issueEmailCode(store, "user@example.com", "register");
    expect(code).toMatch(/^\d{6}$/);
    await expect(verifyEmailCode(store, "user@example.com", "register", code)).resolves.toBe(true);
    await expect(verifyEmailCode(store, "user@example.com", "register", code)).resolves.toBe(false);
    expect(store.has("email-code:register:user@example.com")).toBe(false);
  });

  it("错误次数达到上限后锁死：之后连正确码也被拒绝", async () => {
    const store = makeCodeStore();
    const code = await issueEmailCode(store, "user@example.com", "register");
    const wrong = code === "000000" ? "111111" : "000000";
    // 与实现里的 CODE_MAX_ATTEMPTS（未导出）一致；上限改动时这里会失败提醒。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(verifyEmailCode(store, "user@example.com", "register", wrong)).resolves.toBe(false);
    }
    await expect(verifyEmailCode(store, "user@example.com", "register", code)).resolves.toBe(false);
    // 锁死时清空存储：后续即使放行正确码也不存在残余状态。
    expect(store.has("email-code:register:user@example.com")).toBe(false);
  });

  it("purpose 绑定：注册码不能用于重置，反之亦然", async () => {
    const store = makeCodeStore();
    const registerCode = await issueEmailCode(store, "user@example.com", "register");
    const resetCode = await issueEmailCode(store, "user@example.com", "reset");
    expect(registerCode).not.toBe(resetCode);
    await expect(verifyEmailCode(store, "user@example.com", "reset", registerCode)).resolves.toBe(false);
    await expect(verifyEmailCode(store, "user@example.com", "register", resetCode)).resolves.toBe(false);
    await expect(verifyEmailCode(store, "user@example.com", "reset", resetCode)).resolves.toBe(true);
  });
});
