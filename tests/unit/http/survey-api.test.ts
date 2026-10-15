import { afterEach, describe, expect, it, vi } from "vitest";

import { handleSurveyApiRequest } from "../../../src/http/survey-api";
import type { Env } from "../../../src/index";

function makeDb(overrides: Record<string, unknown> = {}) {
  const db = {
    prepare: vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn(() => statement),
        run: vi.fn(async (): Promise<unknown> => ({ success: true, meta: { last_row_id: 99, changes: 1 } })),
        first: vi.fn(async (): Promise<unknown> => null),
        all: vi.fn(async (): Promise<unknown> => ({ results: [] })),
      };
      if (sql.includes("SELECT * FROM surveys")) {
        statement.first.mockResolvedValue(
          overrides.survey ?? {
            id: 1,
            owner_id: 7,
            title: "Web 问卷",
            description: null,
            cover_media_id: null,
            status: "published",
            anonymous: 0,
            allow_multiple_responses: 0,
            max_responses_per_user: 1,
            version: 1,
            created_at: "2026-08-22T00:00:00.000Z",
            updated_at: "2026-08-22T00:00:00.000Z",
            published_at: "2026-08-22T00:00:00.000Z",
            closed_at: null,
            archived_at: null,
            access_code: null,
            access_code_encrypted: null,
          },
        );
      } else if (sql.includes("SELECT * FROM survey_questions")) {
        statement.all.mockResolvedValue({
          results: overrides.questions ?? [
            {
              id: 10,
              survey_id: 1,
              type: "multiple",
              title: "喜欢哪些颜色",
              description: null,
              required: 1,
              order: 0,
              page_id: null,
              validation_json: JSON.stringify({ min_selections: 1 }),
              settings_json: null,
              parent_question_id: null,
              condition_json: null,
              skip_to_question_id: null,
              created_at: "",
              updated_at: "",
            },
          ],
        });
      } else if (sql.includes("FROM surveys s")) {
        statement.all.mockResolvedValue({
          results: overrides.publicSurveys ?? [
            {
              id: 1,
              title: "公开问卷",
              description: "描述",
              accessCode: null,
              publishedAt: "2026-08-22T00:00:00.000Z",
              questionCount: 3,
            },
          ],
        });
      } else if (sql.includes("SELECT * FROM survey_responses") && sql.includes("WHERE id = ?")) {
        statement.first.mockResolvedValue(
          overrides.responseRow ?? {
            id: 42,
            survey_id: 1,
            user_id: null,
            participant_hash: "web_participant-abc-123",
            status: "in_progress",
            started_at: "2026-08-22T00:00:00.000Z",
            completed_at: null,
            submitted_at: null,
            current_question_id: 10,
            version: 1,
            created_at: "2026-08-22T00:00:00.000Z",
            updated_at: "2026-08-22T00:00:00.000Z",
          },
        );
      } else if (sql.includes("FROM question_options")) {
        statement.all.mockResolvedValue({
          results: overrides.options ?? [
            {
              id: 101,
              question_id: 10,
              label: "红色",
              value: "红色",
              order: 0,
              is_other: 0,
              created_at: "",
              updated_at: "",
            },
            {
              id: 102,
              question_id: 10,
              label: "蓝色",
              value: "蓝色",
              order: 1,
              is_other: 0,
              created_at: "",
              updated_at: "",
            },
          ],
        });
      } else if (sql.includes("FROM survey_pages")) {
        statement.all.mockResolvedValue({
          results: overrides.pages ?? [{ id: 5, title: "第一页", description: null, order: 0 }],
        });
      } else if (sql.includes("INSERT INTO survey_responses")) {
        statement.run.mockResolvedValue({ success: true, meta: { last_row_id: 42 } });
      } else if (sql.includes("INSERT INTO media_assets")) {
        statement.run.mockResolvedValue({ success: true, meta: { last_row_id: 77 } });
      } else if (sql.includes("FROM survey_responses") && sql.includes("status = 'in_progress'") && sql.includes("SELECT id, status")) {
        statement.first.mockResolvedValue(overrides.inProgressResponse ?? { id: 42, status: "in_progress" });
      } else if (sql.includes("current_question_id currentQuestionId")) {
        // Resume lookup: no in-progress response unless a test asks for one.
        statement.first.mockResolvedValue(overrides.activeResponse ?? null);
      } else if (sql.includes("SELECT a.* FROM answers a")) {
        // Resume answers, folded into the start-response batch.
        statement.all.mockResolvedValue({ results: overrides.resumeAnswers ?? [] });
      } else if (sql.includes("FROM participant_links pl")) {
        // Folding of the anonymous participant's link/ban lookup into /answers.
        statement.first.mockResolvedValue(overrides.participantLink ?? null);
      } else if (sql.includes("SELECT * FROM answers")) {
        statement.all.mockResolvedValue({ results: overrides.answers ?? [] });
      } else if (sql.includes("SELECT id FROM answers")) {
        statement.first.mockResolvedValue({ id: 55 });
      } else if (sql.includes("SELECT id FROM survey_responses")) {
        statement.first.mockResolvedValue(overrides.ownedResponse ?? { id: 42 });
      } else if (sql.includes("SELECT * FROM media_assets")) {
        statement.first.mockResolvedValue(
          "mediaAsset" in overrides
            ? overrides.mediaAsset
            : {
                id: 77,
                asset_scope: "response",
                media_type: "photo",
                telegram_file_id: null,
                telegram_file_unique_id: null,
                url: null,
                storage_kind: "temporary",
                storage_key: "media:temp:42:key",
                expires_at: null,
                mime_type: "image/png",
                file_name: "photo.png",
                file_size: 3,
                width: null,
                height: null,
                duration: null,
                r2_key: null,
                created_at: "",
                updated_at: "",
              },
        );
      } else if (sql.includes("SELECT * FROM report_deliveries")) {
        statement.first.mockResolvedValue(
          overrides.reportDelivery ?? {
            id: 200,
            response_id: 42,
            report_version: 1,
            delivery_id: "response_42_v1",
            telegram_chat_id: null,
            pdf_message_id: null,
            image_message_ids_json: null,
            status: "pending",
            attempts: 0,
            last_error: null,
            next_retry_at: null,
            delivered_at: null,
            created_at: "2026-08-22T00:00:00.000Z",
            updated_at: "2026-08-22T00:00:00.000Z",
          },
        );
      } else if (sql.includes("INSERT INTO report_deliveries")) {
        statement.run.mockResolvedValue({ success: true, meta: { last_row_id: 200 } });
      } else if (sql.includes("SELECT COUNT(*) AS count")) {
        statement.first.mockResolvedValue({ count: 0 });
      } else if (sql.includes("SELECT r.id FROM survey_responses r")) {
        statement.first.mockResolvedValue(overrides.ownedResponse ?? { id: 42 });
      } else if (sql.includes("SELECT sv.snapshot_json")) {
        statement.first.mockResolvedValue(null);
      }
      return statement;
    }),
    // Batched statements must behave like the same statements executed one by
    // one: the survey API now reads a whole request's rows — and stamps its
    // abuse counter — in a single `db.batch()`, so a canned batch result would
    // hide every read behind it. `all()` wins when the SQL declares rows,
    // otherwise the configured single row is wrapped the way D1 does it.
    batch: vi.fn(async (statements: Array<{ all: () => Promise<unknown>; first: () => Promise<unknown> }>) =>
      Promise.all(
        statements.map(async (statement) => {
          const all = (await statement.all()) as { results?: unknown[] } | undefined;
          if (all?.results?.length) return all;
          const first = await statement.first();
          return first === null || first === undefined ? { results: [] } : { results: [first] };
        }),
      ),
    ),
  } as unknown as D1Database;
  return db;
}

function makeEnv(db: D1Database, extra: Partial<Env> = {}): Env {
  return {
    DB: db,
    BOT_TOKEN: "token",
    WEBHOOK_SECRET: "webhook-secret",
    // Always present in real deployments; several ban/admin checks split it.
    ADMIN_IDS: "",
    MEDIA_KV: {
      put: vi.fn(async () => {}),
      get: vi.fn(async () => null),
    } as unknown as KVNamespace,
    CACHE: {
      put: vi.fn(async () => {}),
      get: vi.fn(async () => null),
    } as unknown as KVNamespace,
    EXPORT_QUEUE: {
      send: vi.fn(async () => {}),
    } as unknown as Queue,
    ...extra,
  } as unknown as Env;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://worker.test${path}`, init);
}

describe("web survey API", () => {
  it("lists published surveys with backend-computed question counts", async () => {
    const db = makeDb();
    const response = await handleSurveyApiRequest(
      request("/api/surveys"),
      makeEnv(db),
      new URL("https://worker.test/api/surveys"),
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      surveys: Array<{ id: number; title: string; questionCount: number; accessCodeRequired: boolean }>;
    };
    expect(body.surveys).toHaveLength(1);
    expect(body.surveys[0]).toMatchObject({
      id: 1,
      title: "公开问卷",
      questionCount: 3,
      accessCodeRequired: false,
    });
    // The submission-bot entry rides along with the list, next to the group
    // invite the pages already show.
    expect((body as { submissionBotUrl?: string | null }).submissionBotUrl).toBe("https://t.me/tougaojiqirbot");
  });

  // The list costs one question-count subquery per published survey — about
  // 15,000 rows read at 200 surveys × 74 questions — out of a free-tier budget
  // of 5,000,000 rows/day for the whole account. A repeat load has to come
  // from KV rather than D1.
  it("serves repeat survey-list loads from the KV cache", async () => {
    const db = makeDb();
    const store = new Map<string, string>();
    const cache = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    } as unknown as KVNamespace;
    const env = makeEnv(db, { CACHE: cache });
    const prepareCalls = (db.prepare as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const listQueries = () => prepareCalls.filter((call) => String(call[0]).includes("FROM surveys s")).length;

    const first = await handleSurveyApiRequest(
      request("/api/surveys"),
      env,
      new URL("https://worker.test/api/surveys"),
    );
    expect(first?.status).toBe(200);
    const firstBody = await first?.json();
    expect(listQueries()).toBe(1);
    expect(cache.put).toHaveBeenCalledTimes(1);

    const second = await handleSurveyApiRequest(
      request("/api/surveys"),
      env,
      new URL("https://worker.test/api/surveys"),
    );
    expect(second?.status).toBe(200);
    expect(await second?.json()).toEqual(firstBody);
    expect(listQueries()).toBe(1);
  });

  // The definition is the other hot, visitor-independent read: questions,
  // options, media and pages for the same survey version are identical for
  // everyone, so a repeat load should not re-read them.
  it("serves repeat survey-definition loads from the KV cache", async () => {
    const db = makeDb();
    const store = new Map<string, string>();
    const cache = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    } as unknown as KVNamespace;
    const env = makeEnv(db, { CACHE: cache });
    const prepareCalls = (db.prepare as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const questionQueries = () =>
      prepareCalls.filter((call) => String(call[0]).includes("FROM survey_questions WHERE survey_id")).length;

    const first = await handleSurveyApiRequest(
      request("/api/survey/1"),
      env,
      new URL("https://worker.test/api/survey/1"),
    );
    expect(first?.status).toBe(200);
    const firstBody = await first?.json();
    expect(questionQueries()).toBe(1);
    expect(cache.put).toHaveBeenCalledTimes(1);

    const second = await handleSurveyApiRequest(
      request("/api/survey/1"),
      env,
      new URL("https://worker.test/api/survey/1"),
    );
    expect(second?.status).toBe(200);
    expect(await second?.json()).toEqual(firstBody);
    expect(questionQueries()).toBe(1);
  });

  it("serves the published survey definition for the renderer", async () => {
    const db = makeDb();
    const response = await handleSurveyApiRequest(
      request("/api/survey/1"),
      makeEnv(db),
      new URL("https://worker.test/api/survey/1"),
    );

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      title: string;
      questions: Array<{ id: number; type: string; options: unknown[]; validation: unknown }>;
      pages: unknown[];
    };
    expect(body.title).toBe("Web 问卷");
    expect(body.pages).toEqual([{ id: 5, title: "第一页", description: null, order: 0 }]);
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0]?.type).toBe("multiple");
    expect((body as { submissionBotUrl?: string | null }).submissionBotUrl).toBe("https://t.me/tougaojiqirbot");
    expect(body.questions[0]?.options).toHaveLength(2);
    expect(body.questions[0]?.validation).toEqual({ min_selections: 1 });
  });

  it("rejects access with a wrong password", async () => {
    const db = makeDb({
      survey: {
        id: 1,
        owner_id: 7,
        title: "加密问卷",
        description: null,
        cover_media_id: null,
        status: "published",
        anonymous: 0,
        allow_multiple_responses: 0,
        max_responses_per_user: 1,
        version: 1,
        created_at: "",
        updated_at: "",
        published_at: "",
        closed_at: null,
        archived_at: null,
        access_code: "secret",
        access_code_encrypted: null,
      },
    });
    const response = await handleSurveyApiRequest(
      request("/api/survey/1/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "wrong" }),
      }),
      makeEnv(db),
      new URL("https://worker.test/api/survey/1/access"),
    );

    expect(response?.status).toBe(403);
  });

  it("starts an anonymous response and stores the survey version", async () => {
    const db = makeDb();
    const response = await handleSurveyApiRequest(
      request("/api/survey/1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-participant-key": "participant-abc-123" },
        body: JSON.stringify({}),
      }),
      makeEnv(db),
      new URL("https://worker.test/api/survey/1/responses"),
    );

    expect(response?.status).toBe(201);
    const body = (await response?.json()) as { responseId: number; resumed: boolean };
    expect(body.responseId).toBe(42);
    expect(body.resumed).toBe(false);
  });

  it("returns the saved answers inline when the start request resumes a response", async () => {
    // The client used to need a second GET /responses round trip before it could
    // render the question the participant had stopped on; the answers now ride
    // along with the resume the batch was already reading.
    const db = makeDb({
      activeResponse: { id: 42, currentQuestionId: 10, status: "in_progress" },
      resumeAnswers: [
        {
          id: 55,
          response_id: 42,
          question_id: 10,
          text_value: null,
          number_value: null,
          boolean_value: null,
          rating_value: null,
          date_value: null,
          time_value: null,
          json_value: JSON.stringify([101]),
          created_at: "",
          updated_at: "",
        },
      ],
    });
    const response = await handleSurveyApiRequest(
      request("/api/survey/1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-participant-key": "participant-abc-123" },
        body: JSON.stringify({}),
      }),
      makeEnv(db),
      new URL("https://worker.test/api/survey/1/responses"),
    );

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      responseId: number;
      resumed: boolean;
      answers: Record<string, unknown>;
    };
    expect(body.resumed).toBe(true);
    expect(body.responseId).toBe(42);
    expect(body.answers).toEqual({ "10": [101] });
  });

  it("refuses an answer save from a banned linked account (folded ban check)", async () => {
    // The anonymous-key path checks the participant_links row inside the main
    // batch; a linked account that has been banned must still be refused there,
    // exactly like resolveParticipant refuses it on every other endpoint.
    const db = makeDb({
      participantLink: { userId: 7, bannedAt: "2026-09-01T00:00:00.000Z", telegramUserId: 12345 },
    });
    const response = await handleSurveyApiRequest(
      request("/api/survey/1/responses/42/answers", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-participant-key": "participant-abc-123" },
        body: JSON.stringify({ questionId: 10, value: [101, 102] }),
      }),
      makeEnv(db),
      new URL("https://worker.test/api/survey/1/responses/42/answers"),
    );

    expect(response?.status).toBe(403);
    const body = (await response?.json()) as { code?: string };
    expect(body.code).toBe("account_banned");
  });

  it("accepts an answer save from a linked account that is not banned", async () => {
    const db = makeDb({
      participantLink: { userId: 7, bannedAt: null, telegramUserId: 12345 },
    });
    const response = await handleSurveyApiRequest(
      request("/api/survey/1/responses/42/answers", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-participant-key": "participant-abc-123" },
        body: JSON.stringify({ questionId: 10, value: [101, 102] }),
      }),
      makeEnv(db),
      new URL("https://worker.test/api/survey/1/responses/42/answers"),
    );

    expect(response?.status).toBe(200);
  });

  it("saves a multiple-choice answer", async () => {
    const db = makeDb();
    const response = await handleSurveyApiRequest(
      request("/api/survey/1/responses/42/answers", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-participant-key": "participant-abc-123" },
        body: JSON.stringify({ questionId: 10, value: [101, 102] }),
      }),
      makeEnv(db),
      new URL("https://worker.test/api/survey/1/responses/42/answers"),
    );

    expect(response?.status).toBe(200);
    const prepareMock = db.prepare as unknown as ReturnType<typeof vi.fn>;
    const insert = prepareMock.mock.calls.find((call: unknown[]) => String(call[0]).includes("INSERT INTO answers"));
    expect(insert).toBeDefined();
  });

  it("reports a missing required question on submit", async () => {
    const db = makeDb();
    const response = await handleSurveyApiRequest(
      request("/api/survey/1/responses/42/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-participant-key": "participant-abc-123" },
        body: JSON.stringify({}),
      }),
      makeEnv(db),
      new URL("https://worker.test/api/survey/1/responses/42/submit"),
    );

    expect(response?.status).toBe(400);
    const body = (await response?.json()) as { code: string };
    expect(body.code).toBe("required_missing");
  });

  it("submits a completed response and enqueues report delivery", async () => {
    const db = makeDb({
      answers: [
        {
          id: 1,
          response_id: 42,
          question_id: 10,
          text_value: null,
          number_value: null,
          boolean_value: null,
          rating_value: null,
          date_value: null,
          time_value: null,
          json_value: "[101,102]",
          created_at: "",
          updated_at: "",
        },
      ],
    });
    const send = vi.fn(async () => {});
    const env = makeEnv(db, {
      EXPORT_QUEUE: { send } as unknown as Queue,
    });
    const response = await handleSurveyApiRequest(
      request("/api/survey/1/responses/42/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-participant-key": "participant-abc-123" },
        body: JSON.stringify({}),
      }),
      env,
      new URL("https://worker.test/api/survey/1/responses/42/submit"),
    );

    expect(response?.status).toBe(200);
    expect(send).toHaveBeenCalledWith({
      kind: "report_delivery",
      deliveryId: "response_42_v1",
    });
    const body = (await response?.json()) as { reportUrl?: string };
    expect(body.reportUrl).toMatch(/^\/report\/42\?t=\d+\.[a-f0-9]+$/);
  });

  it("uploads response images to temporary KV storage", async () => {
    const db = makeDb();
    const kvPut = vi.fn(async (_key: string, _value: Uint8Array) => {});
    const env = makeEnv(db, {
      MEDIA_KV: { put: kvPut, get: vi.fn(async () => null) } as unknown as KVNamespace,
    });
    const form = new FormData();
    // Real PNG magic bytes: upload content is now magic-byte checked, so a
    // text blob declared as image/png is rejected instead of stored.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    form.append("file", new File([pngBytes], "photo.png", { type: "image/png" }));
    const response = await handleSurveyApiRequest(
      request("/api/survey/1/media", {
        method: "POST",
        body: form,
        headers: { "x-participant-key": "participant-abc-123" },
      }),
      env,
      new URL("https://worker.test/api/survey/1/media"),
    );

    expect(response?.status).toBe(201);
    const body = (await response?.json()) as { mediaAssetId: number; url: string };
    expect(body.mediaAssetId).toBe(77);
    expect(body.url).toBe("/api/survey/media/77");
    const storedKey = kvPut.mock.calls[0]?.[0] as string;
    expect(storedKey).toMatch(/^media:temp:42:/);
  });

  it("rejects non-image uploads", async () => {
    const db = makeDb();
    const kvPut = vi.fn(async (_key: string, _value: Uint8Array) => {});
    const env = makeEnv(db, {
      MEDIA_KV: { put: kvPut, get: vi.fn(async () => null) } as unknown as KVNamespace,
    });
    const form = new FormData();
    form.append("file", new File(["abc"], "anim.gif", { type: "image/gif" }));
    const response = await handleSurveyApiRequest(
      request("/api/survey/1/media", {
        method: "POST",
        body: form,
        headers: { "x-participant-key": "participant-abc-123" },
      }),
      env,
      new URL("https://worker.test/api/survey/1/media"),
    );

    expect(response?.status).toBe(400);
    expect(kvPut).not.toHaveBeenCalled();
  });

  it("serves response media from KV with participant auth", async () => {
    const db = makeDb();
    const kvGet = vi.fn(async (_key: string) => new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
    const env = makeEnv(db, {
      MEDIA_KV: { put: vi.fn(async () => {}), get: kvGet } as unknown as KVNamespace,
    });
    const response = await handleSurveyApiRequest(
      request("/api/survey/media/77", { headers: { "x-participant-key": "participant-abc-123" } }),
      env,
      new URL("https://worker.test/api/survey/media/77"),
    );

    expect(response?.status).toBe(200);
    expect(kvGet).toHaveBeenCalledWith("media:temp:42:key", "arrayBuffer");
  });
});

describe("web survey media endpoint edge cache", () => {
  /** 可编程的 caches.default 替身：按 pathname 存取 Response。 */
  function stubEdgeCache() {
    const store = new Map<string, Response>();
    const cache = {
      match: vi.fn(async (request: Request) => store.get(new URL(request.url).pathname)),
      put: vi.fn(async (request: Request, response: Response) => {
        const body = await response.arrayBuffer();
        store.set(
          new URL(request.url).pathname,
          new Response(body, { status: response.status, headers: response.headers }),
        );
      }),
    };
    vi.stubGlobal("caches", { default: cache });
    return { cache, store };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves survey-scope media through the edge cache: first view fills it, repeat views skip D1", async () => {
    const { cache, store } = stubEdgeCache();
    const db = makeDb({
      mediaAsset: {
        id: 77,
        asset_scope: "survey",
        media_type: "audio",
        telegram_file_id: null,
        telegram_file_unique_id: null,
        url: null,
        storage_kind: "temporary",
        storage_key: "media:survey:bgm",
        expires_at: null,
        mime_type: "audio/mpeg",
        file_name: "bgm.mp3",
        file_size: 3,
        width: null,
        height: null,
        duration: null,
        r2_key: null,
        created_at: "",
        updated_at: "",
      },
    });
    const env = makeEnv(db, {
      MEDIA_KV: { put: vi.fn(async () => {}), get: vi.fn(async () => new ArrayBuffer(3)) } as unknown as KVNamespace,
    });
    const batchSpy = db.batch as ReturnType<typeof vi.fn>;

    const first = await handleSurveyApiRequest(
      request("/api/survey/media/77"),
      env,
      new URL("https://worker.test/api/survey/media/77"),
    );
    expect(first?.status).toBe(200);
    // 客户端拿到的是完整 immutable 策略；边缘副本才是短 TTL。
    expect(first?.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(cache.put).toHaveBeenCalledTimes(1);
    const putArgs = cache.put.mock.calls[0] as [Request, Response];
    expect(putArgs[1].headers.get("Cache-Control")).toBe("public, max-age=86400");

    // 命中后不再触数据库：清空计数后重放同一请求。
    batchSpy.mockClear();
    const second = await handleSurveyApiRequest(
      request("/api/survey/media/77"),
      env,
      new URL("https://worker.test/api/survey/media/77"),
    );
    expect(second?.status).toBe(200);
    expect(second?.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(batchSpy).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
  });

  it("never caches response-scope (private) media", async () => {
    const { cache } = stubEdgeCache();
    const db = makeDb();
    const kvGet = vi.fn(async (_key: string) => new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
    const env = makeEnv(db, {
      MEDIA_KV: { put: vi.fn(async () => {}), get: kvGet } as unknown as KVNamespace,
    });
    const response = await handleSurveyApiRequest(
      request("/api/survey/media/77", { headers: { "x-participant-key": "participant-abc-123" } }),
      env,
      new URL("https://worker.test/api/survey/media/77"),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("does not cache authorization failures or unknown assets", async () => {
    const { cache } = stubEdgeCache();
    const db = makeDb({ mediaAsset: null });
    const env = makeEnv(db);
    const response = await handleSurveyApiRequest(
      request("/api/survey/media/999"),
      env,
      new URL("https://worker.test/api/survey/media/999"),
    );
    expect(response?.status).toBe(404);
    expect(cache.put).not.toHaveBeenCalled();
  });
});
