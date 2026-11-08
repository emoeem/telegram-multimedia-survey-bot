import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveParticipant: vi.fn(),
  createPlazaPost: vi.fn(),
  listPlazaPosts: vi.fn(),
  isPublishedPlazaImage: vi.fn(),
  listPlazaTopics: vi.fn(),
  createPlazaComment: vi.fn(),
  listPlazaComments: vi.fn(),
  checkRateLimit: vi.fn(),
  mirrorPlazaPostToChannel: vi.fn(),
  evaluateAchievements: vi.fn(),
  storePlazaPostImage: vi.fn(),
}));

vi.mock("../../../src/http/survey/participant", () => ({ resolveParticipant: mocks.resolveParticipant }));
vi.mock("../../../src/db/repositories/plaza-post.repository", () => ({
  createPlazaPost: mocks.createPlazaPost,
  listPlazaPosts: mocks.listPlazaPosts,
  isPublishedPlazaImage: mocks.isPublishedPlazaImage,
  listPlazaTopics: mocks.listPlazaTopics,
}));
vi.mock("../../../src/db/repositories/plaza-comment.repository", () => ({
  createPlazaComment: mocks.createPlazaComment,
  listPlazaComments: mocks.listPlazaComments,
}));
vi.mock("../../../src/services/rate-limit.service", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("../../../src/services/plaza-channel.service", () => ({
  mirrorPlazaPostToChannel: mocks.mirrorPlazaPostToChannel,
}));
vi.mock("../../../src/services/achievement.service", () => ({
  evaluateAchievements: mocks.evaluateAchievements,
  serializeUnlockedAchievements: (items: unknown[]) => items,
}));
vi.mock("../../../src/services/plaza-media.service", () => ({
  storePlazaPostImage: mocks.storePlazaPostImage,
  plazaImageUrl: (id: number | null) => (id === null ? null : `/api/plaza/media/${id}`),
}));

import { handlePlazaApiRequest } from "../../../src/http/plaza-api";
import type { Env } from "../../../src/index";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";
import { fullMigrationSchema } from "../../helpers/full-schema";

/** 假 D1：帖子创建路径只会问「这张图能不能用」。 */
function makeEnv(usableImage: boolean): Env {
  const db = {
    prepare() {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          return usableImage ? { found: 1 } : null;
        },
      };
      return statement;
    },
  };
  return { DB: db as unknown as D1Database, CACHE: {} as KVNamespace } as unknown as Env;
}

function post(body: unknown): Request {
  return new Request("https://example.test/api/plaza/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const URL_ = new URL("https://example.test/api/plaza/posts");

describe("plaza post creation rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveParticipant.mockResolvedValue({ kind: "telegram", participantHash: "tg_700", dbUserId: 7 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    mocks.evaluateAchievements.mockResolvedValue([]);
    mocks.mirrorPlazaPostToChannel.mockResolvedValue(undefined);
    mocks.createPlazaPost.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
      id: 31,
      imageAssetId: input.imageAssetId ?? null,
      topic: input.topic ?? null,
      anonymous: input.anonymous,
      createdAt: "2026-10-03T00:00:00.000Z",
    }));
  });

  it("allows an image-only post and parses the topic from the body", async () => {
    const env = makeEnv(true);
    const response = await handlePlazaApiRequest(
      post({ content: "#夜话# 只想发张图", anonymous: true, imageAssetId: 42 }),
      env,
      URL_,
    );
    expect(response?.status).toBe(201);
    expect(mocks.createPlazaPost).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ imageAssetId: 42, topic: "夜话" }),
    );
    await expect(response?.json()).resolves.toMatchObject({
      post: { id: 31, imageUrl: "/api/plaza/media/42", topic: "夜话" },
    });
  });

  it("still requires 5 characters when there is no image", async () => {
    const env = makeEnv(true);
    const response = await handlePlazaApiRequest(post({ content: "太短" }), env, URL_);
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({ code: "invalid_content" });
    expect(mocks.createPlazaPost).not.toHaveBeenCalled();
  });

  it("rejects an image that is already used or not a plaza upload", async () => {
    const env = makeEnv(false);
    const response = await handlePlazaApiRequest(post({ content: "借用别人的图", imageAssetId: 4242 }), env, URL_);
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({ code: "invalid_image" });
    expect(mocks.createPlazaPost).not.toHaveBeenCalled();
  });
});

/** 举报路由（0096）：服务层不打桩——举报去重/阈值下架的真值在 SQL 约束里
 * （UNIQUE(post_id|comment_id, reporter_user_id)），mock 掉服务只会自说自话。
 * 这里用 sqlite D1 shim 跑全量迁移 schema，断言走完整 HTTP → service → DB 链路。 */
describe.skipIf(!sqliteD1Available)("plaza report endpoints (0096)", () => {
  let db: D1Database;
  let nextUserId: number;

  const reportEnv = () => ({ DB: db, CACHE: {} as KVNamespace }) as unknown as Env;

  const callReport = async (path: string, dbUserId: number | null) => {
    mocks.resolveParticipant.mockResolvedValue({
      kind: "telegram",
      participantHash: `tg_${dbUserId ?? 0}`,
      dbUserId,
    });
    const request = new Request(`https://example.test${path}`, {
      method: "POST",
      body: JSON.stringify({ reason: "垃圾内容" }),
    });
    return handlePlazaApiRequest(request, reportEnv(), new URL(`https://example.test${path}`));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = createSqliteD1(`PRAGMA foreign_keys = ON;\n${fullMigrationSchema()}`);
    nextUserId = 100;
    db.prepare("INSERT INTO users (id, telegram_user_id, created_at, updated_at) VALUES (?, ?, 't', 't')")
      .bind(nextUserId, 9000 + nextUserId)
      .run();
    db.prepare(
      "INSERT INTO plaza_posts (id, user_id, content, status, created_at) VALUES (31, 100, '被举报的树洞', 'published', 't')",
    ).run();
    db.prepare(
      "INSERT INTO plaza_post_comments (id, post_id, user_id, content, status, created_at) VALUES (52, 31, 100, '被举报的评论', 'published', 't')",
    ).run();
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  });

  const newUser = () => {
    nextUserId += 1;
    db.prepare("INSERT INTO users (id, telegram_user_id, created_at, updated_at) VALUES (?, ?, 't', 't')")
      .bind(nextUserId, 9000 + nextUserId)
      .run();
    return nextUserId;
  };

  it("同人重复举报只计一次，第三人举报达到阈值自动下架（服务层真值）", async () => {
    const first = await callReport("/api/plaza/posts/31/report", 100);
    expect(first?.status).toBe(200);
    await expect(first?.json()).resolves.toMatchObject({ ok: true, hidden: false, reportCount: 1 });

    // 同一 dbUserId 再报：UNIQUE 兜底，计数不涨（复审 P1-2 的去重锚点）。
    const duplicate = await callReport("/api/plaza/posts/31/report", 100);
    await expect(duplicate?.json()).resolves.toMatchObject({ ok: true, hidden: false, reportCount: 1 });

    const second = await callReport("/api/plaza/posts/31/report", newUser());
    await expect(second?.json()).resolves.toMatchObject({ ok: true, hidden: false, reportCount: 2 });

    const third = await callReport("/api/plaza/posts/31/report", newUser());
    await expect(third?.json()).resolves.toMatchObject({ ok: true, hidden: true, reportCount: 3 });
    expect(
      (await db.prepare("SELECT status, report_count FROM plaza_posts WHERE id = 31").first<{ status: string }>())
        ?.status,
    ).toBe("removed");

    // 已下架内容不再出现在公开流，自然也不可再举报。
    const afterHide = await callReport("/api/plaza/posts/31/report", newUser());
    expect(afterHide?.status).toBe(404);
  });

  it("comment report 同款去重与计数", async () => {
    const first = await callReport("/api/plaza/comments/52/report", 100);
    expect(first?.status).toBe(200);
    await expect(first?.json()).resolves.toMatchObject({ ok: true, reportCount: 1 });
    const duplicate = await callReport("/api/plaza/comments/52/report", 100);
    await expect(duplicate?.json()).resolves.toMatchObject({ ok: true, reportCount: 1 });
    const third = await callReport("/api/plaza/comments/52/report", newUser());
    await expect(third?.json()).resolves.toMatchObject({ ok: true, reportCount: 2 });
  });

  it("无 dbUserId 一律 401 identity_required（与广场写路径同口径）", async () => {
    const response = await callReport("/api/plaza/posts/31/report", null);
    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toMatchObject({ code: "identity_required" });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    const commentResponse = await callReport("/api/plaza/comments/52/report", null);
    expect(commentResponse?.status).toBe(401);
  });

  it("限流命中返回 429 与 Retry-After", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 600 });
    const response = await callReport("/api/plaza/posts/31/report", 100);
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("600");
    await expect(response?.json()).resolves.toMatchObject({ code: "rate_limited" });
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(expect.anything(), "plaza-post-report", "100", 5, 3600);
  });

  it("目标不存在返回 404", async () => {
    const response = await callReport("/api/plaza/posts/999/report", 100);
    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toMatchObject({ code: "not_found" });
    const commentResponse = await callReport("/api/plaza/comments/999/report", 100);
    expect(commentResponse?.status).toBe(404);
  });
});
