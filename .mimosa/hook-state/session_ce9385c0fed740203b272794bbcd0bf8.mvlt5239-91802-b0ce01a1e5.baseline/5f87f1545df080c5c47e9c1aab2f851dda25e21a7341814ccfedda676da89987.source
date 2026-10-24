import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPlazaPosts: vi.fn(),
  setPlazaPostStatus: vi.fn(),
}));

vi.mock("../../../src/db/repositories/plaza-post.repository", () => ({
  listPlazaPosts: mocks.listPlazaPosts,
  setPlazaPostStatus: mocks.setPlazaPostStatus,
}));

const userMocks = vi.hoisted(() => ({
  getUserByTelegramId: vi.fn(),
}));

vi.mock("../../../src/db/repositories/user.repository", () => ({
  getUserByTelegramId: userMocks.getUserByTelegramId,
}));

import { handleAdminApi } from "../../../src/http/admin-api";
import type { Env } from "../../../src/index";

const DEV_AUTH_SECRET = "test-dev-auth-secret";

function makeEnv(): Env {
  return {
    DB: {} as D1Database,
    BOT_TOKEN: "test-bot-token",
    ADMIN_IDS: "111",
    ENVIRONMENT: "development",
    ADMIN_DEV_AUTH_SECRET: DEV_AUTH_SECRET,
  } as unknown as Env;
}

function apiRequest(path: string, options: { method?: string; userId?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.userId !== undefined) {
    headers["x-telegram-user-id"] = options.userId;
    headers["x-dev-auth-secret"] = DEV_AUTH_SECRET;
  }
  return new Request(`https://example.test${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

const POST = {
  id: 4,
  userId: 7,
  content: "今天也想被听见。",
  anonymous: true,
  status: "published",
  createdAt: "2026-08-29T10:00:00.000Z",
  owner: { telegramUserId: 777, username: "rose", firstName: "Rose" },
};

describe("admin plaza post endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPlazaPosts.mockResolvedValue({ items: [POST], total: 1 });
    userMocks.getUserByTelegramId.mockImplementation(async (_db, telegramUserId: number) =>
      telegramUserId === 111
        ? { id: 1, telegramUserId: 111, username: "root", firstName: "Root", lastName: null, systemRole: "admin" }
        : {
            id: 7,
            telegramUserId: 777,
            username: "rose",
            firstName: "Rose",
            lastName: null,
            systemRole: "participant",
          },
    );
  });

  it("rejects non-admin plaza listings", async () => {
    const response = await handleAdminApi(apiRequest("/api/admin/plaza/posts", { userId: "7" }), makeEnv());
    expect(response.status).toBe(403);
    expect(mocks.listPlazaPosts).not.toHaveBeenCalled();
  });

  it("lists plaza posts for admins with owner attribution", async () => {
    const response = await handleAdminApi(
      apiRequest("/api/admin/plaza/posts?view=all&offset=0&limit=20", { userId: "111" }),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]?.content).toBe("今天也想被听见。");
    expect((body.items[0]?.owner as Record<string, unknown>)?.username).toBe("rose");
    expect(mocks.listPlazaPosts).toHaveBeenCalledWith(expect.anything(), { limit: 20, offset: 0, view: "all" });
  });

  it("removes and restores posts by status toggle", async () => {
    mocks.setPlazaPostStatus.mockResolvedValue({ ...POST, status: "removed" });
    const response = await handleAdminApi(
      apiRequest("/api/admin/plaza/posts/status", {
        method: "POST",
        userId: "111",
        body: { id: 4, status: "removed" },
      }),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(mocks.setPlazaPostStatus).toHaveBeenCalledWith(expect.anything(), 4, "removed");
    const body = (await response.json()) as { post: { status: string } };
    expect(body.post.status).toBe("removed");

    mocks.setPlazaPostStatus.mockResolvedValue(null);
    const missing = await handleAdminApi(
      apiRequest("/api/admin/plaza/posts/status", {
        method: "POST",
        userId: "111",
        body: { id: 999, status: "removed" },
      }),
      makeEnv(),
    );
    expect(missing.status).toBe(404);
  });
});
