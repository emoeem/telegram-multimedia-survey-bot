import { describe, expect, it, vi } from "vitest";

import { handleSurveyApiRequest } from "../../../src/http/survey-api";
import type { Env } from "../../../src/index";

/**
 * 公开目录的分类投影（0087）。
 *
 * 这里刻意用一个只认几条 SQL 的假 D1：目录列表是产品的第一屏，它的形状
 * （条目带 category、顶层带 categories、`?category=` 能筛）一旦回退，
 * 前端会静默退化成「一张长列表」——没有异常、没有 500，只是用户又找不到
 * 东西了。所以要有一条测试钉住返回结构。
 */

interface ListRow {
  id: number;
  title: string;
  description: string | null;
  accessCode: string | null;
  publishedAt: string;
  closedAt: string | null;
  anonymous: number;
  contentRating: string;
  settingsJson: string | null;
  categoryId: number | null;
  categoryName: string | null;
  categorySlug: string | null;
  coverMediaId: number | null;
  coverUrl: string | null;
  questionCount: number;
  responseCount: number;
}

const LIST_ROWS: ListRow[] = [
  {
    id: 1,
    title: "情景-雨夜",
    description: null,
    accessCode: null,
    publishedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    anonymous: 0,
    contentRating: "all",
    settingsJson: null,
    categoryId: 7,
    categoryName: "情景剧情",
    categorySlug: "scenario",
    coverMediaId: null,
    coverUrl: null,
    questionCount: 12,
    responseCount: 3,
  },
  {
    id: 2,
    title: "指令游戏-起居室",
    description: null,
    accessCode: null,
    publishedAt: "2026-10-02T00:00:00.000Z",
    closedAt: null,
    anonymous: 0,
    contentRating: "all",
    settingsJson: null,
    categoryId: 3,
    categoryName: "指令任务",
    categorySlug: "command",
    coverMediaId: null,
    coverUrl: null,
    questionCount: 8,
    responseCount: 1,
  },
  {
    id: 3,
    title: "还没归类的问卷",
    description: null,
    accessCode: null,
    publishedAt: "2026-10-03T00:00:00.000Z",
    closedAt: null,
    anonymous: 0,
    contentRating: "all",
    settingsJson: null,
    categoryId: null,
    categoryName: null,
    categorySlug: null,
    coverMediaId: null,
    coverUrl: null,
    questionCount: 5,
    responseCount: 0,
  },
];

const CATEGORY_ROWS = [
  { id: 3, name: "指令任务", slug: "command", description: "", sortOrder: 20, count: 1 },
  { id: 7, name: "情景剧情", slug: "scenario", description: "", sortOrder: 10, count: 1 },
];

function makeDb() {
  return {
    prepare: vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn(() => statement),
        run: vi.fn(async () => ({ success: true, meta: { changes: 0 } })),
        first: vi.fn(async (): Promise<unknown> => {
          // 列表 stamp：count + 最近一次 updated_at。
          if (sql.includes("COUNT(*) AS total"))
            return { total: LIST_ROWS.length, updatedAt: "2026-10-03T00:00:00.000Z" };
          // r18 计数（未确认年龄时提示「还有 N 份」）。
          if (sql.includes("content_rating = 'r18'")) return { n: 0 };
          return null;
        }),
        all: vi.fn(async (): Promise<unknown> => {
          if (sql.includes("FROM survey_categories c")) return { results: CATEGORY_ROWS };
          if (sql.includes("FROM surveys s")) return { results: LIST_ROWS };
          // 金币解锁 / 关注 / 其它旁路查询：一律空集。
          return { results: [] };
        }),
      };
      return statement;
    }),
  } as unknown as D1Database;
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    BOT_TOKEN: "test-token",
    PUBLIC_ORIGIN: "https://worker.test",
    ADMIN_IDS: "",
    MEDIA_KV: { put: vi.fn(async () => {}), get: vi.fn(async () => null) } as unknown as KVNamespace,
    CACHE: { put: vi.fn(async () => {}), get: vi.fn(async () => null) } as unknown as KVNamespace,
    EXPORT_QUEUE: { send: vi.fn(async () => {}) } as unknown as Queue,
  } as unknown as Env;
}

async function list(path: string) {
  const response = await handleSurveyApiRequest(
    new Request(`https://worker.test${path}`),
    makeEnv(makeDb()),
    new URL(`https://worker.test${path}`),
  );
  expect(response?.status).toBe(200);
  return (await response?.json()) as {
    surveys: Array<{ id: number; category: { id: number; name: string; slug: string } | null }>;
    categories: Array<{ id: number; name: string; slug: string; sortOrder: number }>;
  };
}

describe("public survey list · categories", () => {
  it("每条问卷带自己的分类，未归类的给 null", async () => {
    const body = await list("/api/surveys");
    expect(body.surveys).toHaveLength(3);
    expect(body.surveys[0]?.category).toEqual({ id: 7, name: "情景剧情", slug: "scenario" });
    expect(body.surveys[1]?.category).toEqual({ id: 3, name: "指令任务", slug: "command" });
    expect(body.surveys[2]?.category).toBeNull();
  });

  it("顶层带筛选条的分类（按 sort_order 排好，不带 count）", async () => {
    const body = await list("/api/surveys");
    expect(body.categories).toEqual([
      { id: 3, name: "指令任务", slug: "command", sortOrder: 20 },
      { id: 7, name: "情景剧情", slug: "scenario", sortOrder: 10 },
    ]);
    // count 依赖查看者年龄，必须由前端按过滤后的数组自算，服务端不给。
    expect(Object.keys(body.categories[0] ?? {})).not.toContain("count");
  });

  it("?category=<slug> 只回该分类的问卷，并保留分类清单", async () => {
    const body = await list("/api/surveys?category=scenario");
    expect(body.surveys.map((item) => item.id)).toEqual([1]);
    expect(body.categories).toHaveLength(2);
  });

  it("?category= 未知 slug 回空列表（不是 500、也不是全量）", async () => {
    const body = await list("/api/surveys?category=does-not-exist");
    expect(body.surveys).toHaveLength(0);
  });
});
