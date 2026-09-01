import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listIdentityProfiles: vi.fn(),
  getIdentityProfileById: vi.fn(),
  setIdentityProfileGalleryPublished: vi.fn(),
  getMediaAssetById: vi.fn(),
  buildMediaResponse: vi.fn(),
}));

vi.mock("../../../src/db/repositories/identity-card.repository", () => ({
  listIdentityProfiles: mocks.listIdentityProfiles,
  getIdentityProfileById: mocks.getIdentityProfileById,
  setIdentityProfileGalleryPublished: mocks.setIdentityProfileGalleryPublished,
}));
vi.mock("../../../src/db/repositories/media.repository", () => ({
  getMediaAssetById: mocks.getMediaAssetById,
}));
vi.mock("../../../src/services/media/media-serve.service", () => ({
  buildMediaResponse: mocks.buildMediaResponse,
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

function makeDb() {
  const allRules: Array<[string, () => unknown[]]> = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      const statement = {
        bind: () => statement,
        first: async () => null,
        all: async () => {
          for (const [pattern, value] of allRules) if (sql.includes(pattern)) return { results: value() };
          return { results: [] };
        },
        run: async () => ({ meta: { changes: 1 } }),
      };
      return statement;
    }),
    allOn: (pattern: string, rows: unknown[]) => {
      allRules.push([pattern, () => rows]);
    },
  };
  return db;
}

function makeEnv(db: ReturnType<typeof makeDb>): Env {
  return {
    DB: db as unknown as D1Database,
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

const CARD = {
  id: 9,
  userId: 7,
  name: "暮色蔷薇",
  nickname: "蔷薇",
  age: 27,
  identityLabel: "夜行者",
  description: null,
  frontAssetId: 1,
  backAssetId: null,
  backgroundAssetId: null,
  templateStyle: "identity",
  galleryPublished: true,
  galleryPublishedAt: "2026-08-29T10:00:00.000Z",
  cardAssetId: 55,
  createdAt: "2026-08-29T10:00:00.000Z",
  updatedAt: "2026-08-29T10:00:00.000Z",
};

describe("admin identity card endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listIdentityProfiles.mockResolvedValue({ items: [CARD], total: 1 });
    mocks.buildMediaResponse.mockResolvedValue(new Response("png-bytes", { status: 200 }));
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

  it("rejects non-admin card listings", async () => {
    const db = makeDb();
    db.allOn("FROM users", []);
    const response = await handleAdminApi(apiRequest("/api/admin/identity-cards", { userId: "7" }), makeEnv(db));
    expect(response.status).toBe(403);
    expect(mocks.listIdentityProfiles).not.toHaveBeenCalled();
  });

  it("lists all cards with owner info for admins", async () => {
    const db = makeDb();
    db.allOn("FROM users", [{ id: 7, telegram_user_id: 777, username: "rose", first_name: "Rose" }]);
    const response = await handleAdminApi(
      apiRequest("/api/admin/identity-cards?view=all&offset=0&limit=20", { userId: "111" }),
      makeEnv(db),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]?.name).toBe("暮色蔷薇");
    expect(body.items[0]?.cardImageUrl).toBe("/api/admin/identity-cards/9/image");
    expect((body.items[0]?.owner as Record<string, unknown>)?.username).toBe("rose");
    expect(mocks.listIdentityProfiles).toHaveBeenCalledWith(expect.anything(), { limit: 20, offset: 0, view: "all" });
  });

  it("lets admins publish and unpublish a card", async () => {
    const db = makeDb();
    mocks.setIdentityProfileGalleryPublished.mockResolvedValue({
      ...CARD,
      galleryPublished: false,
      galleryPublishedAt: null,
    });
    const response = await handleAdminApi(
      apiRequest("/api/admin/identity-cards/publish", {
        method: "POST",
        userId: "111",
        body: { id: 9, published: false },
      }),
      makeEnv(db),
    );
    expect(response.status).toBe(200);
    expect(mocks.setIdentityProfileGalleryPublished).toHaveBeenCalledWith(expect.anything(), 9, false);
    const body = (await response.json()) as { card: { galleryPublished: boolean } };
    expect(body.card.galleryPublished).toBe(false);
  });

  it("serves the stored card image and 404s when absent", async () => {
    const db = makeDb();
    mocks.getIdentityProfileById.mockResolvedValue(CARD);
    mocks.getMediaAssetById.mockResolvedValue({ id: 55, storageKind: "temporary" });
    const image = await handleAdminApi(apiRequest("/api/admin/identity-cards/9/image", { userId: "111" }), makeEnv(db));
    expect(image.status).toBe(200);
    expect(mocks.buildMediaResponse).toHaveBeenCalled();

    mocks.getIdentityProfileById.mockResolvedValue({ ...CARD, cardAssetId: null });
    const missing = await handleAdminApi(
      apiRequest("/api/admin/identity-cards/9/image", { userId: "111" }),
      makeEnv(db),
    );
    expect(missing.status).toBe(404);
  });
});
