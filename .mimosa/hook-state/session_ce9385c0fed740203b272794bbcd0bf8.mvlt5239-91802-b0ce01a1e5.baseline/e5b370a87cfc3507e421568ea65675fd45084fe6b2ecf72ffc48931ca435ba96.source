import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  attachSurveyToSeries,
  createSeries,
  listChapters,
  listPublishedSeries,
} from "../../../src/db/repositories/series.repository";
import {
  listNotifications,
  markNotificationsSeen,
  notifySeriesPublish,
  toggleSeriesFollow,
} from "../../../src/services/series-follow.service";

/**
 * 系列/追更（0083/0084）的真实 SQL 语义：章节顺序、发布过滤、关注开关、
 * 发布通知的一次插行与未读清理。
 */

const SCHEMA = [
  // 迁移里的 ALTER 依赖这两张表，必须先建。
  "CREATE TABLE users (id INTEGER PRIMARY KEY, telegram_user_id INTEGER);",
  `
  CREATE TABLE surveys (
    id INTEGER PRIMARY KEY,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    deleted_at TEXT,
    access_code TEXT,
    content_rating TEXT NOT NULL DEFAULT 'all',
    cover_media_id INTEGER,
    published_at TEXT,
    updated_at TEXT
  );`,
  readFileSync(join(__dirname, "../../../db/migrations/0083_series.sql"), "utf-8"),
  readFileSync(join(__dirname, "../../../db/migrations/0084_follows_notifications.sql"), "utf-8"),
].join("\n");

function createDb(): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const wrapper = {
    sqlite,
    prepare(sql: string) {
      return {
        bind: (...bound: unknown[]) => {
          const run = sqlite.prepare(sql);
          const params = bound as never[];
          return {
            first: async <T>() => (run.get(...params) as T | undefined) ?? null,
            all: async <T>() => ({ results: run.all(...params) as unknown as T[], meta: {} }),
            run: async () => {
              const outcome = run.run(...params) as unknown as { changes: number };
              return { success: true, meta: { changes: outcome.changes, last_row_id: 0 } };
            },
          };
        },
        first: async <T>() => (sqlite.prepare(sql).get() as T | undefined) ?? null,
        all: async <T>() => ({ results: sqlite.prepare(sql).all() as unknown as T[], meta: {} }),
        run: async () => {
          const outcome = sqlite.prepare(sql).run() as unknown as { changes: number };
          return { success: true, meta: { changes: outcome.changes, last_row_id: 0 } };
        },
      };
    },
  };
  return wrapper as unknown as D1Database & { sqlite: DatabaseSync };
}

let db: D1Database & { sqlite: DatabaseSync };

beforeEach(() => {
  db = createDb();
  // survey_series.owner_id / surveys 的外键需要真实用户行。
  db.sqlite.prepare("INSERT INTO users (id, telegram_user_id) VALUES (1, 100)").run();
});

async function seedChapter(surveyId: number, seriesId: number, order: number, status = "published") {
  db.sqlite
    .prepare("INSERT INTO surveys (id, title, status, series_id, series_order) VALUES (?, ?, ?, ?, ?)")
    .run(surveyId, `第${order}章`, status, seriesId, order);
}

describe("series repository", () => {
  it("orders chapters and hides drafts from the public view", async () => {
    const series = await createSeries(db, { ownerId: 1, slug: "s-1", title: "连载一" });
    await seedChapter(2, series.id, 2);
    await seedChapter(1, series.id, 1);
    await seedChapter(3, series.id, 3, "draft");

    const publicChapters = await listChapters(db, series.id);
    expect(publicChapters.map((chapter) => chapter.surveyId)).toEqual([1, 2]);
    const authorChapters = await listChapters(db, series.id, { includeDrafts: true });
    expect(authorChapters.map((chapter) => chapter.surveyId)).toEqual([1, 2, 3]);

    const shelf = await listPublishedSeries(db);
    expect(shelf.map((item) => item.slug)).toEqual(["s-1"]);
  });

  it("attaching moves a survey between series", async () => {
    const one = await createSeries(db, { ownerId: 1, slug: "s-1", title: "一" });
    const two = await createSeries(db, { ownerId: 1, slug: "s-2", title: "二" });
    await seedChapter(7, one.id, 1);
    await attachSurveyToSeries(db, 7, two.id, 5);
    const chapters = await listChapters(db, two.id, { includeDrafts: true });
    expect(chapters.map((chapter) => chapter.surveyId)).toEqual([7]);
    expect((await listChapters(db, one.id, { includeDrafts: true })).length).toBe(0);
  });
});

describe("series follows & notifications", () => {
  it("toggles follow state", async () => {
    const series = await createSeries(db, { ownerId: 1, slug: "s-1", title: "一" });
    expect(await toggleSeriesFollow(db, "user_7", series.id)).toEqual({ following: true });
    expect(await toggleSeriesFollow(db, "user_7", series.id)).toEqual({ following: false });
    expect(await toggleSeriesFollow(db, "user_7", series.id)).toEqual({ following: true });
  });

  it("publish notification lands once per follower and clears on seen", async () => {
    const series = await createSeries(db, { ownerId: 1, slug: "s-1", title: "深潜" });
    await toggleSeriesFollow(db, "user_7", series.id);
    await toggleSeriesFollow(db, "user_8", series.id);

    const notified = await notifySeriesPublish(db, {
      seriesId: series.id,
      seriesTitle: "深潜",
      surveyId: 42,
      chapterTitle: "第三章",
    });
    expect(notified).toBe(2);

    for (const hash of ["user_7", "user_8"]) {
      const feed = await listNotifications(db, hash);
      expect(feed.unread).toBe(1);
      expect(feed.items[0]?.title).toContain("深潜");
      expect(feed.items[0]?.link).toBe("/s/42");
      await markNotificationsSeen(db, hash);
      expect((await listNotifications(db, hash)).unread).toBe(0);
    }
  });
});
