import { describe, expect, it } from "vitest";

import { listProfileGalleryItems } from "../../../src/services/profile-gallery.service";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * Regression guard for the plaza feed.
 *
 * The batched gallery lookup joined `json_each(...)`, which itself exposes an
 * `id` column. `ORDER BY ... id` therefore raised "ambiguous column name: id",
 * so `/api/plaza/profiles` answered 500 "服务暂时不可用" for every visitor while
 * typecheck and the mocked tests stayed green. These run the real statements
 * against a real SQLite.
 */
const SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, last_name TEXT, telegram_user_id INTEGER
);
CREATE TABLE survey_responses (
  id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL, user_id INTEGER, status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
  gallery_published INTEGER NOT NULL DEFAULT 1, gallery_published_at TEXT,
  gallery_cover_media_id INTEGER, gallery_visible_question_ids_json TEXT, gallery_show_username INTEGER
);
CREATE TABLE gallery_profile_media (
  id INTEGER PRIMARY KEY, response_id INTEGER NOT NULL, media_asset_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE answers (
  id INTEGER PRIMARY KEY, response_id INTEGER NOT NULL, question_id INTEGER NOT NULL,
  text_value TEXT, number_value REAL, boolean_value INTEGER, rating_value REAL,
  date_value TEXT, time_value TEXT, json_value TEXT,
  created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
  updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
);
CREATE TABLE survey_questions (
  id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT, required INTEGER NOT NULL DEFAULT 0, "order" INTEGER NOT NULL DEFAULT 0,
  page_id INTEGER, validation_json TEXT, settings_json TEXT, parent_question_id INTEGER,
  condition_json TEXT, skip_to_question_id INTEGER,
  created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
  updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
);
CREATE TABLE question_options (
  id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL, label TEXT NOT NULL,
  value TEXT, "order" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO users (id, username, first_name) VALUES (1, 'alice', 'Alice');
INSERT INTO survey_responses (id, survey_id, user_id, gallery_published_at, gallery_show_username)
  VALUES (10, 5, 1, '2026-02-01T00:00:00.000Z', 1), (11, 5, 1, '2026-02-02T00:00:00.000Z', 1);
INSERT INTO survey_questions (id, survey_id, type, title, "order") VALUES (100, 5, 'text', '昵称', 0);
INSERT INTO answers (response_id, question_id, text_value) VALUES (10, 100, '小明'), (11, 100, '小红');
INSERT INTO gallery_profile_media (response_id, media_asset_id, question_id, sort_order)
  VALUES (10, 900, 100, 0), (10, 901, 100, 1), (11, 902, 100, 0);
`;

describe.skipIf(!sqliteD1Available)("plaza profile gallery batching (real SQLite)", () => {
  it("returns every page's answers and gallery media", async () => {
    const db = createSqliteD1(SCHEMA);

    const result = await listProfileGalleryItems(db, {
      surveyId: 5,
      publishedOnly: true,
      limit: 30,
      offset: 0,
    });

    // Both responses must come back: a silently empty batch would hide the
    // failure while still "passing" a length-0 assertion.
    expect(result.items.map((item) => item.responseId).sort((a, b) => a - b)).toEqual([10, 11]);
    expect(result.total).toBe(2);
    expect(result.publishedTotal).toBe(2);

    const first = result.items.find((item) => item.responseId === 10);
    // Two photos on response 10, one on 11 — proves the batched join mapped
    // rows back to the right response instead of dropping or merging them.
    expect(first?.images.map((image) => image.mediaAssetId)).toEqual([900, 901]);
    const second = result.items.find((item) => item.responseId === 11);
    expect(second?.images.map((image) => image.mediaAssetId)).toEqual([902]);

    // Answers were batched the same way.
    expect(first?.fields[0]?.value).toBe("小明");
    expect(second?.fields[0]?.value).toBe("小红");
  });

  it("honours paging without failing on an empty page", async () => {
    const db = createSqliteD1(SCHEMA);
    const page = await listProfileGalleryItems(db, { surveyId: 5, publishedOnly: true, limit: 1, offset: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.responseId).toBe(10);

    const empty = await listProfileGalleryItems(db, { surveyId: 5, publishedOnly: true, limit: 1, offset: 99 });
    expect(empty.items).toEqual([]);
    expect(empty.total).toBe(2);
  });
});
