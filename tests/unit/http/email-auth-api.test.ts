import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEmailAccountByEmail: vi.fn(),
  createEmailAccount: vi.fn(),
}));

vi.mock("../../../src/db/repositories/email-account.repository", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEmailAccountByEmail: mocks.getEmailAccountByEmail,
  createEmailAccount: mocks.createEmailAccount,
}));

import { handleEmailAuthApiRequest } from "../../../src/http/email-auth-api";
import { issueEmailCode } from "../../../src/services/email-auth.service";
import type { EmailCodeStore } from "../../../src/services/email-auth.service";
import type { Env } from "../../../src/index";

/**
 * 邮箱注册的并发冲突语义（通宵批次 B7）：两个并发注册同邮箱都能通过
 * 「先查」，INSERT 的 UNIQUE(email) 只有一方能赢，输的一方必须归一为
 * 409 email_taken，而不是冒泡成 500 internal_error。同进程 shim 无法真
 * 并发，用「先查通过 + INSERT 撞 UNIQUE」模拟输家分支（与真并发等价）。
 */

const EMAIL = "racer@example.dev";

/** 内存 KV 验证码存储（EmailCodeStore 最小实现）。 */
function memoryCodeStore(): EmailCodeStore & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
      return undefined;
    },
    delete: async (key: string) => {
      store.delete(key);
      return undefined;
    },
  } as unknown as EmailCodeStore & { store: Map<string, string> };
}

function makeEnv(codeStore: EmailCodeStore): Env {
  return {
    // 注册 409 路径不触库：loadBlockedEmailDomainsSetting 的 prepare 抛错会被
    // 它自己的 catch 吞掉（回退空黑名单），其余读库都被 mock 掉。
    DB: {
      prepare: () => {
        throw new Error("db not used in this test");
      },
    } as unknown as D1Database,
    CACHE: codeStore,
  } as unknown as Env;
}

function registerRequest(email: string, code: string): Request {
  return new Request("https://example.test/api/auth/email/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123", code }),
  });
}

describe("邮箱注册并发冲突（UNIQUE(email)）", () => {
  let codeStore: ReturnType<typeof memoryCodeStore>;

  beforeEach(() => {
    codeStore = memoryCodeStore();
    mocks.getEmailAccountByEmail.mockReset();
    mocks.createEmailAccount.mockReset();
    mocks.getEmailAccountByEmail.mockResolvedValue(null);
  });

  it("INSERT 撞 UNIQUE → 409 email_taken（不再冒泡 500）", async () => {
    const env = makeEnv(codeStore);
    const code = await issueEmailCode(codeStore, EMAIL, "register");
    mocks.createEmailAccount.mockRejectedValue(new Error("UNIQUE constraint failed: email_accounts.email"));

    const response = (await handleEmailAuthApiRequest(
      registerRequest(EMAIL, code),
      env,
      new URL("https://example.test/api/auth/email/register"),
    )) as Response;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, code: "email_taken" });
    // 验证码已消费：输家也必须付出验证码成本（防探测）。
    expect(codeStore.store.size).toBe(0);
  });

  it("非 UNIQUE 的建号异常照常抛出（不吞真实故障）", async () => {
    const env = makeEnv(codeStore);
    const code = await issueEmailCode(codeStore, EMAIL, "register");
    mocks.createEmailAccount.mockRejectedValue(new Error("db down"));
    await expect(
      handleEmailAuthApiRequest(
        registerRequest(EMAIL, code),
        env,
        new URL("https://example.test/api/auth/email/register"),
      ),
    ).rejects.toThrow("db down");
  });

  it("既有先查后建的 409 路径不回归：已验证账号直接 409，不触 createEmailAccount", async () => {
    const env = makeEnv(codeStore);
    const code = await issueEmailCode(codeStore, EMAIL, "register");
    mocks.getEmailAccountByEmail.mockResolvedValue({
      id: 1,
      email: EMAIL,
      passwordHash: "pbkdf2:x",
      userId: null,
      verifiedAt: "2026-01-01T00:00:00.000Z",
      sessionVersion: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const response = (await handleEmailAuthApiRequest(
      registerRequest(EMAIL, code),
      env,
      new URL("https://example.test/api/auth/email/register"),
    )) as Response;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, code: "email_taken" });
    expect(mocks.createEmailAccount).not.toHaveBeenCalled();
  });
});
