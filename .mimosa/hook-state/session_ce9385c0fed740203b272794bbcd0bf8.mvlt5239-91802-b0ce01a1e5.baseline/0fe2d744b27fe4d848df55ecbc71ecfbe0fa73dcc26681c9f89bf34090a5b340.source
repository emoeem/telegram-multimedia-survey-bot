import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";
import { handleAdminApi } from "../../../src/http/admin-api";
import { handleAdminTrashRead } from "../../../src/http/admin/trash";
import type { Env } from "../../../src/index";

/**
 * Regression cover for "回收站里点彻底删除，刷新后内容还在".
 *
 * The trash read handler matched on the path alone, so it answered `POST` and
 * `DELETE /api/admin/trash` with the *list* (HTTP 200) before the write handler
 * could run. The admin UI only surfaces a failure when the response is not ok,
 * so the delete looked like a success and the entry reappeared on reload.
 *
 * The schema is the real one: every migration in `db/migrations` is applied to an
 * in-memory SQLite database, so a delete that only *looks* permanent (soft-delete
 * flag, cascade that does not fire) fails here instead of in production.
 */
const MIGRATIONS_DIR = join(process.cwd(), "db/migrations");
const DEV_AUTH_SECRET = "trash-test-dev-secret";
const ADMIN_TELEGRAM_ID = 111;

function fullSchema(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
    .join("\n");
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    BOT_TOKEN: "test-bot-token",
    ADMIN_IDS: String(ADMIN_TELEGRAM_ID),
    ENVIRONMENT: "development",
    ADMIN_DEV_AUTH_SECRET: DEV_AUTH_SECRET,
  } as unknown as Env;
}

function apiRequest(path: string, options: { method?: string; body?: unknown } = {}): Request {
  return new Request(`https://example.test${path}`, {
    method: options.method ?? "GET",
    headers: {
      "x-telegram-user-id": String(ADMIN_TELEGRAM_ID),
      "x-dev-auth-secret": DEV_AUTH_SECRET,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

const TRASHED_SURVEY_ID = 501;
const LIVE_SURVEY_ID = 502;

async function seed(db: D1Database, options: { trashed: boolean } = { trashed: true }): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO users (id, telegram_user_id, first_name, system_role, created_at, updated_at) VALUES (1, ?, '管理员', 'admin', ?, ?)",
    )
    .bind(ADMIN_TELEGRAM_ID, now, now)
    .run();
  const insertSurvey = (id: number, title: string, deletedAt: string | null) =>
    db
      .prepare(
        "INSERT INTO surveys (id, owner_id, title, status, created_at, updated_at, deleted_at) VALUES (?, 1, ?, 'published', ?, ?, ?)",
      )
      .bind(id, title, now, now, deletedAt)
      .run();
  await insertSurvey(TRASHED_SURVEY_ID, "待彻底删除的问卷", options.trashed ? now : null);
  await insertSurvey(LIVE_SURVEY_ID, "正常问卷", null);
  // A question and an answer row prove the delete is a real cascade and not just
  // the parent row disappearing.
  await db
    .prepare(
      "INSERT INTO survey_questions (id, survey_id, type, title, created_at, updated_at) VALUES (1, ?, 'single_choice', '题目', ?, ?)",
    )
    .bind(TRASHED_SURVEY_ID, now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO survey_responses (id, survey_id, participant_hash, status, started_at, created_at, updated_at) VALUES (1, ?, 'hash-1', 'in_progress', ?, ?, ?)",
    )
    .bind(TRASHED_SURVEY_ID, now, now, now)
    .run();
}

async function countRows(db: D1Database, table: string, surveyId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE survey_id = ?`)
    .bind(surveyId)
    .first<{ total: number }>();
  return Number(row?.total ?? -1);
}

describe.skipIf(!sqliteD1Available)("admin trash write routing", () => {
  let schema = "";
  beforeAll(() => {
    schema = fullSchema();
  });

  it("answers a DELETE with the write result, not the trash list", async () => {
    const db = createSqliteD1(schema);
    await seed(db);
    const env = makeEnv(db);

    const response = await handleAdminApi(
      apiRequest("/api/admin/trash", {
        method: "DELETE",
        body: { items: [{ kind: "survey", id: String(TRASHED_SURVEY_ID) }] },
      }),
      env,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; results: Array<{ ok: boolean }> };
    // The pre-fix handler replied with `{ items, retentionDays }` and no `ok`.
    expect(payload.ok).toBe(true);
    expect(payload.results).toEqual([{ kind: "survey", id: String(TRASHED_SURVEY_ID), ok: true }]);

    // The row and everything hanging off it are really gone from the database.
    const survey = await db
      .prepare("SELECT COUNT(*) AS total FROM surveys WHERE id = ?")
      .bind(TRASHED_SURVEY_ID)
      .first<{ total: number }>();
    expect(Number(survey?.total)).toBe(0);
    expect(await countRows(db, "survey_questions", TRASHED_SURVEY_ID)).toBe(0);
    expect(await countRows(db, "survey_responses", TRASHED_SURVEY_ID)).toBe(0);
    // Unrelated surveys survive.
    const live = await db
      .prepare("SELECT COUNT(*) AS total FROM surveys WHERE id = ?")
      .bind(LIVE_SURVEY_ID)
      .first<{ total: number }>();
    expect(Number(live?.total)).toBe(1);
  });

  it("no longer lists the purged item when the trash is reloaded", async () => {
    const db = createSqliteD1(schema);
    await seed(db);
    const env = makeEnv(db);

    const before = await handleAdminApi(apiRequest("/api/admin/trash"), env);
    const beforeList = (await before.json()) as { items: Array<{ id: string }> };
    expect(beforeList.items.some((item) => item.id === String(TRASHED_SURVEY_ID))).toBe(true);

    await handleAdminApi(
      apiRequest("/api/admin/trash", {
        method: "DELETE",
        body: { items: [{ kind: "survey", id: String(TRASHED_SURVEY_ID) }] },
      }),
      env,
    );

    // A fresh read — the equivalent of reopening/refreshing the recycle bin.
    const after = await handleAdminApi(apiRequest("/api/admin/trash"), env);
    const afterList = (await after.json()) as { items: Array<{ id: string }> };
    expect(afterList.items.some((item) => item.id === String(TRASHED_SURVEY_ID))).toBe(false);
  });

  it("restores a trashed survey through POST", async () => {
    const db = createSqliteD1(schema);
    await seed(db);
    const env = makeEnv(db);

    const response = await handleAdminApi(
      apiRequest("/api/admin/trash", {
        method: "POST",
        body: { items: [{ kind: "survey", id: String(TRASHED_SURVEY_ID) }] },
      }),
      env,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean };
    expect(payload.ok).toBe(true);
    const row = await db
      .prepare("SELECT deleted_at FROM surveys WHERE id = ?")
      .bind(TRASHED_SURVEY_ID)
      .first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).toBeNull();
  });

  it("keeps the read handler out of the write path", async () => {
    const db = createSqliteD1(schema);
    await seed(db);
    const ctx = {
      user: { id: 1 },
      isAdmin: true,
      fail: (status: number, code: string, message: string) => Response.json({ code, message }, { status }),
      json: (body: unknown) => Response.json(body),
    } as unknown as Parameters<typeof handleAdminTrashRead>[3];
    const url = new URL("https://example.test/api/admin/trash");

    // Direct guarantee: only reads are answered here, so a write can never be
    // swallowed by this handler again regardless of route ordering.
    await expect(
      handleAdminTrashRead(new Request(url, { method: "DELETE" }), url, makeEnv(db), ctx),
    ).resolves.toBeNull();
    await expect(
      handleAdminTrashRead(new Request(url, { method: "POST", body: "{}" }), url, makeEnv(db), ctx),
    ).resolves.toBeNull();
    await expect(
      handleAdminTrashRead(new Request(url, { method: "GET" }), url, makeEnv(db), ctx),
    ).resolves.not.toBeNull();
  });

  it("refuses a non-admin instead of deleting anything", async () => {
    const db = createSqliteD1(schema);
    await seed(db);
    const now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO users (id, telegram_user_id, first_name, system_role, created_at, updated_at) VALUES (2, 222, '普通用户', 'user', ?, ?)",
      )
      .bind(now, now)
      .run();
    const env = makeEnv(db);
    const asOutsider = (method: string) =>
      new Request("https://example.test/api/admin/trash", {
        method,
        headers: {
          "x-telegram-user-id": "222",
          "x-dev-auth-secret": DEV_AUTH_SECRET,
          ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
        },
        ...(method === "GET" ? {} : { body: JSON.stringify({ items: [{ kind: "survey", id: "501" }] }) }),
      });

    const purge = await handleAdminApi(asOutsider("DELETE"), env);
    expect(purge.status).toBe(403);
    const list = await handleAdminApi(asOutsider("GET"), env);
    expect(list.status).toBe(403);

    // The trashed survey is untouched.
    const row = await db
      .prepare("SELECT deleted_at FROM surveys WHERE id = ?")
      .bind(TRASHED_SURVEY_ID)
      .first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).not.toBeNull();
  });

  it("reports an out-of-retention item as not deleted and keeps the row", async () => {
    const db = createSqliteD1(schema);
    await seed(db);
    const expired = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await db
      .prepare(
        "INSERT INTO surveys (id, owner_id, title, status, created_at, updated_at, deleted_at) VALUES (503, 1, '过期条目', 'published', ?, ?, ?)",
      )
      .bind(expired, expired, expired)
      .run();
    const env = makeEnv(db);

    const response = await handleAdminApi(
      apiRequest("/api/admin/trash", { method: "DELETE", body: { items: [{ kind: "survey", id: "503" }] } }),
      env,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      code?: string;
      results: Array<{ ok: boolean }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("trash_item_expired");
    expect(payload.results).toEqual([{ kind: "survey", id: "503", ok: false }]);
    const row = await db.prepare("SELECT COUNT(*) AS total FROM surveys WHERE id = 503").first<{ total: number }>();
    expect(Number(row?.total)).toBe(1);
  });

  it("rejects an empty selection without touching the database", async () => {
    const db = createSqliteD1(schema);
    await seed(db);
    const env = makeEnv(db);

    const response = await handleAdminApi(
      apiRequest("/api/admin/trash", { method: "DELETE", body: { items: [] } }),
      env,
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("validation_failed");
    const row = await db
      .prepare("SELECT deleted_at FROM surveys WHERE id = ?")
      .bind(TRASHED_SURVEY_ID)
      .first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).not.toBeNull();
  });
});
