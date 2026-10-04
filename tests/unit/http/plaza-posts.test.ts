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
vi.mock("../../../src/services/plaza-channel.service", () => ({ mirrorPlazaPostToChannel: mocks.mirrorPlazaPostToChannel }));
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
    expect(mocks.createPlazaPost).toHaveBeenCalledWith(env.DB, expect.objectContaining({ imageAssetId: 42, topic: "夜话" }));
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
    const response = await handlePlazaApiRequest(
      post({ content: "借用别人的图", imageAssetId: 4242 }),
      env,
      URL_,
    );
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({ code: "invalid_image" });
    expect(mocks.createPlazaPost).not.toHaveBeenCalled();
  });
});
