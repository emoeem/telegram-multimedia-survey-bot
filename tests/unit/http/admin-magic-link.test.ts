import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeAdminMagicLink: vi.fn(),
  getUserById: vi.fn(),
  getUserByTelegramId: vi.fn(),
  getFirstAdminUser: vi.fn(),
  hasActiveCreatorTrial: vi.fn(),
  getBotUsername: vi.fn(async () => "test_bot"),
  downloadTelegramFile: vi.fn(),
}));

vi.mock("../../../src/services/admin-magic-link.service", () => ({
  consumeAdminMagicLink: mocks.consumeAdminMagicLink,
  createAdminMagicLink: vi.fn(),
  isAdminMagicLinkToken: () => true,
  ADMIN_MAGIC_LINK_TTL_SECONDS: 1800,
}));
vi.mock("../../../src/db/repositories/user.repository", () => ({
  getUserById: mocks.getUserById,
  getUserByTelegramId: mocks.getUserByTelegramId,
  getFirstAdminUser: mocks.getFirstAdminUser,
}));
vi.mock("../../../src/db/repositories/creator-trial.repository", () => ({
  hasActiveCreatorTrial: mocks.hasActiveCreatorTrial,
}));
vi.mock("../../../src/bot/telegram", () => ({
  getBotUsername: mocks.getBotUsername,
  downloadTelegramFile: mocks.downloadTelegramFile,
}));

import { handleAdminApi } from "../../../src/http/admin-api";
import type { Env } from "../../../src/index";

/** 只服务两条查询：系统设置（会话 epoch）与限流写入。 */
function makeDb(): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          if (sql.includes("system_settings")) return { value: null };
          // 限流计数：始终放行。
          return { count: 1 };
        },
        async run() {
          return { meta: { changes: 0, last_row_id: 0 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function makeEnv(): Env {
  return {
    DB: makeDb(),
    CACHE: { get: vi.fn(async () => null), put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) } as unknown as KVNamespace,
    BOT_TOKEN: "test-bot-token",
    ADMIN_IDS: "111",
    ENVIRONMENT: "test",
    WEBHOOK_SECRET: "test-secret",
  } as unknown as Env;
}

function linkRequest(token = "AbC-123_xyz890abcdefghij") {
  return new Request(`https://example.test/api/admin/auth/link?t=${token}`, { method: "GET" });
}

const ADMIN_USER = { id: 5, systemRole: "admin", telegramUserId: 111 };
const CREATOR_USER = { id: 6, systemRole: "participant", telegramUserId: 222 };

describe("one-time admin login link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasActiveCreatorTrial.mockResolvedValue(false);
  });

  it("redeems into a session cookie for an admin", async () => {
    mocks.consumeAdminMagicLink.mockResolvedValue(5);
    mocks.getUserById.mockResolvedValue(ADMIN_USER);
    const response = await handleAdminApi(linkRequest(), makeEnv());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin");
    expect(response.headers.get("set-cookie")).toContain("admin_session=");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("opens the panel for an active creator trial too", async () => {
    mocks.consumeAdminMagicLink.mockResolvedValue(6);
    mocks.getUserById.mockResolvedValue(CREATOR_USER);
    mocks.hasActiveCreatorTrial.mockResolvedValue(true);
    const response = await handleAdminApi(linkRequest(), makeEnv());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin");
    expect(mocks.hasActiveCreatorTrial).toHaveBeenCalledWith(expect.anything(), 6);
  });

  it("bounces a used or expired link back to the login page with a reason", async () => {
    mocks.consumeAdminMagicLink.mockResolvedValue(null);
    const response = await handleAdminApi(linkRequest("used-token-12345678"), makeEnv());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/login?reason=link_invalid");
    expect(mocks.getUserById).not.toHaveBeenCalled();
  });

  it("refuses a link whose account lost panel access", async () => {
    mocks.consumeAdminMagicLink.mockResolvedValue(6);
    mocks.getUserById.mockResolvedValue(CREATOR_USER);
    mocks.hasActiveCreatorTrial.mockResolvedValue(false);
    const response = await handleAdminApi(linkRequest(), makeEnv());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/login?reason=no_access");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
