import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listShowcasePersons: vi.fn(),
  countShowcasePersons: vi.fn(),
  createShowcasePerson: vi.fn(),
  updateShowcasePerson: vi.fn(),
  deleteShowcasePerson: vi.fn(),
  getShowcasePersonById: vi.fn(),
  getShowcaseItemById: vi.fn(),
  createShowcaseItem: vi.fn(),
  updateShowcaseItem: vi.fn(),
  deleteShowcaseItem: vi.fn(),
  reorderShowcasePersons: vi.fn(),
}));

vi.mock("../../../src/db/repositories/showcase.repository", () => mocks);

const userMocks = vi.hoisted(() => ({ getUserByTelegramId: vi.fn() }));
vi.mock("../../../src/db/repositories/user.repository", () => ({
  getUserByTelegramId: userMocks.getUserByTelegramId,
}));

import { handleAdminApi } from "../../../src/http/admin-api";
import type { Env } from "../../../src/index";
import type { ShowcasePersonWithItems } from "../../../src/db/schema";

const DEV_AUTH_SECRET = "test-dev-auth-secret";

function makeEnv(): Env {
  return {
    DB: {
      // mediaAssetsExist / surveyExists run two small lookups.
      prepare: () => ({
        bind: () => ({
          first: async () => ({ count: 0, ok: 1 }),
          all: async () => ({ results: [] }),
          // The audit log is best-effort by design; the stub still has to
          // accept the write so the test output stays clean.
          run: async () => ({ meta: { changes: 1 }, success: true }),
        }),
      }),
      batch: async () => [],
    } as unknown as D1Database,
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

function person(overrides: Partial<ShowcasePersonWithItems> = {}): ShowcasePersonWithItems {
  return {
    id: 3,
    name: "月见",
    subtitle: null,
    description: null,
    accentColor: null,
    backgroundFrom: null,
    backgroundTo: null,
    backgroundMediaId: null,
    illustrationMediaId: null,
    avatarMediaId: null,
    backgroundUrl: null,
    illustrationUrl: null,
    tags: [],
    links: [],
    surveyId: null,
    responseId: null,
    ownerUserId: null,
    featureRank: 0,
    published: false,
    sortOrder: 0,
    createdBy: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    items: [],
    ...overrides,
  };
}

describe("admin showcase endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listShowcasePersons.mockResolvedValue({ persons: [person()], total: 1 });
    mocks.countShowcasePersons.mockResolvedValue({ total: 1, published: 0 });
    mocks.getShowcasePersonById.mockResolvedValue(person());
    mocks.createShowcasePerson.mockResolvedValue(3);
    mocks.updateShowcasePerson.mockResolvedValue(true);
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

  it("refuses the management surface to non-admins", async () => {
    const read = await handleAdminApi(apiRequest("/api/admin/showcase", { userId: "7" }), makeEnv());
    expect(read.status).toBe(403);
    expect(mocks.listShowcasePersons).not.toHaveBeenCalled();

    const write = await handleAdminApi(
      apiRequest("/api/admin/showcase/persons", { method: "POST", userId: "7", body: { name: "偷偷加一个" } }),
      makeEnv(),
    );
    expect(write.status).toBe(403);
    expect(mocks.createShowcasePerson).not.toHaveBeenCalled();
  });

  it("lists every person, including unpublished drafts, for an admin", async () => {
    const response = await handleAdminApi(apiRequest("/api/admin/showcase", { userId: "111" }), makeEnv());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { persons: Array<Record<string, unknown>>; publishedTotal: number };
    expect(body.persons).toHaveLength(1);
    // The admin view carries the media ids the edit form needs.
    expect(body.persons[0]).toHaveProperty("backgroundMediaId");
    expect(body.persons[0]?.published).toBe(false);
    expect(body.publishedTotal).toBe(0);
  });

  it("validates the payload before writing anything", async () => {
    const response = await handleAdminApi(
      apiRequest("/api/admin/showcase/persons", { method: "POST", userId: "111", body: { name: "" } }),
      makeEnv(),
    );
    expect(response.status).toBe(400);
    expect(mocks.createShowcasePerson).not.toHaveBeenCalled();
  });

  it("creates a person and audits it", async () => {
    const response = await handleAdminApi(
      apiRequest("/api/admin/showcase/persons", {
        method: "POST",
        userId: "111",
        body: { name: "月见", tags: ["插画"], published: true, surveyId: 12 },
      }),
      makeEnv(),
    );
    expect(response.status).toBe(201);
    expect(mocks.createShowcasePerson).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "月见", tags: ["插画"], published: true, createdBy: 1 }),
    );
  });

  it("reorders by the submitted id list", async () => {
    const response = await handleAdminApi(
      apiRequest("/api/admin/showcase/persons/reorder", {
        method: "POST",
        userId: "111",
        body: { ids: [5, 3] },
      }),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(mocks.reorderShowcasePersons).toHaveBeenCalledWith(expect.anything(), [5, 3]);
  });

  it("404s an unknown person instead of silently succeeding", async () => {
    mocks.getShowcasePersonById.mockResolvedValue(null);
    const response = await handleAdminApi(
      apiRequest("/api/admin/showcase/persons/99", { method: "DELETE", userId: "111" }),
      makeEnv(),
    );
    expect(response.status).toBe(404);
    expect(mocks.deleteShowcasePerson).not.toHaveBeenCalled();
  });
});
