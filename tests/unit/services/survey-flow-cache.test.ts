import { describe, expect, it, vi } from "vitest";

import type { Env } from "../../../src/index";
import {
  beginPublishedFlowRead,
  publishedFlowCacheKey,
  resolvePublishedFlow,
  SURVEY_FLOW_CACHE_VERSION,
} from "../../../src/http/survey/catalog";

/**
 * 已发布问卷 flow 缓存（v2）：键只含问卷 id，版本戳在 payload 里，用「同一次
 * 请求刚读到的 survey 行」做权威校验。因此三条语义必须成立：
 *  - 戳一致 → 用缓存，不再碰数据库；
 *  - 戳不一致（编辑后的第一个请求）→ 回退数据库读，并把新戳写回缓存；
 *  - 无缓存/损坏 → 回退数据库读并写入。
 * 生产上这决定「下一题」是纯 KV 命中还是多读一次整卷题目。
 */
const QUESTION_ROW = {
  id: 10,
  survey_id: 1,
  type: "single",
  title: "题一",
  description: null,
  required: 0,
  order: 0,
  page_id: null,
  validation_json: null,
  settings_json: null,
  parent_question_id: null,
  condition_json: null,
  skip_to_question_id: null,
  created_at: "",
  updated_at: "",
};

function makeDb() {
  let call = 0;
  const db = {
    prepare: vi.fn(() => ({
      bind: vi.fn(function (this: unknown) {
        return this;
      }),
      all: vi.fn(async () => ({ results: [QUESTION_ROW] })),
      first: vi.fn(async () => null),
      run: vi.fn(async () => ({ success: true, meta: { changes: 1 } })),
    })),
    // 第一条语句 = questions，第二条 = options（无选项即可）。
    batch: vi.fn(async () => {
      call += 1;
      return [{ results: [QUESTION_ROW] }, { results: [] }];
    }),
  };
  return { db: db as unknown as D1Database, batchCalls: () => call };
}

function makeCache(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const put = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  });
  const cache = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put,
  } as unknown as KVNamespace;
  return { cache, store, put };
}

function makeEnv(db: D1Database, cache: KVNamespace): Env {
  return { DB: db, CACHE: cache } as unknown as Env;
}

const surveyRow = { id: 1, version: 5, updatedAt: "2026-10-15T00:00:00.000Z" };

describe("published flow cache (v2, stamp validated from payload)", () => {
  it("serves the cached flow without touching the database when the stamp matches", async () => {
    const flow = { questions: [{ ...QUESTION_ROW, options: [] }] };
    const { cache } = makeCache({
      [publishedFlowCacheKey(1)]: JSON.stringify({ version: 5, updatedAt: surveyRow.updatedAt, flow }),
    });
    const { db, batchCalls } = makeDb();
    const env = makeEnv(db, cache);

    const cacheRead = beginPublishedFlowRead(env, 1);
    const resolved = await resolvePublishedFlow(env, surveyRow, cacheRead);

    expect(resolved).toEqual(flow);
    expect(batchCalls()).toBe(0);
  });

  it("falls back to the database and rewrites the cache when the stamp is stale", async () => {
    const staleFlow = { questions: [{ ...QUESTION_ROW, title: "旧题目", options: [] }] };
    const { cache, store } = makeCache({
      [publishedFlowCacheKey(1)]: JSON.stringify({
        version: 4,
        updatedAt: "2026-10-14T00:00:00.000Z",
        flow: staleFlow,
      }),
    });
    const { db, batchCalls } = makeDb();
    const env = makeEnv(db, cache);

    const resolved = await resolvePublishedFlow(env, surveyRow, beginPublishedFlowRead(env, 1));

    expect(batchCalls()).toBe(1);
    expect(resolved.questions[0]?.title).toBe("题一");
    // 新戳写回：下一个请求不必再回源。
    const written = JSON.parse(store.get(publishedFlowCacheKey(1)) ?? "{}") as {
      version?: number;
      updatedAt?: string;
    };
    expect(written.version).toBe(5);
    expect(written.updatedAt).toBe(surveyRow.updatedAt);
  });

  it("reads the database and writes the cache on a cold miss", async () => {
    const { cache, store } = makeCache();
    const { db, batchCalls } = makeDb();
    const env = makeEnv(db, cache);

    const resolved = await resolvePublishedFlow(env, surveyRow, beginPublishedFlowRead(env, 1));

    expect(batchCalls()).toBe(1);
    expect(resolved.questions).toHaveLength(1);
    expect(store.has(publishedFlowCacheKey(1))).toBe(true);
  });

  it("survives a corrupted payload by falling back to the database", async () => {
    const { cache } = makeCache({ [publishedFlowCacheKey(1)]: "not-json" });
    const { db, batchCalls } = makeDb();
    const env = makeEnv(db, cache);

    const resolved = await resolvePublishedFlow(env, surveyRow, beginPublishedFlowRead(env, 1));

    expect(batchCalls()).toBe(1);
    expect(resolved.questions).toHaveLength(1);
  });

  it("keys the cache by survey id only (the stamp lives in the payload)", () => {
    expect(publishedFlowCacheKey(118)).toBe(`published-flow:${SURVEY_FLOW_CACHE_VERSION}:118`);
  });
});
