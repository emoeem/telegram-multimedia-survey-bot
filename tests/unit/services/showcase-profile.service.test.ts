import { describe, expect, it } from "vitest";

import { mapProfileToShowcasePerson, syncShowcasePersonFromProfile } from "../../../src/services/showcase-profile.service";
import type { ProfileGalleryItem } from "../../../src/services/profile-gallery.service";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

const SCHEMA = `
CREATE TABLE media_assets (id INTEGER PRIMARY KEY, asset_scope TEXT);
CREATE TABLE showcase_persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, subtitle TEXT, description TEXT,
  accent_color TEXT, background_from TEXT, background_to TEXT,
  background_media_id INTEGER, illustration_media_id INTEGER, avatar_media_id INTEGER,
  background_url TEXT, illustration_url TEXT,
  tags_json TEXT, links_json TEXT,
  survey_id INTEGER, response_id INTEGER, owner_user_id INTEGER,
  feature_rank INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0, created_by INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE showcase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT,
  kind TEXT NOT NULL DEFAULT 'other', cover_media_id INTEGER, cover_url TEXT, media_asset_id INTEGER, url TEXT,
  featured INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_showcase_persons_response
  ON showcase_persons(response_id) WHERE response_id IS NOT NULL;
INSERT INTO media_assets (id, asset_scope) VALUES (901, 'gallery_profile'), (902, 'gallery_profile');
`;

function profile(overrides: Partial<ProfileGalleryItem> = {}): ProfileGalleryItem {
  return {
    responseId: 55,
    surveyId: 12,
    owner: { telegramUserId: 700, username: "asha", firstName: "阿沙", lastName: null },
    showUsername: true,
    publishedAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    images: [
      { mediaAssetId: 901, questionId: 3 },
      { mediaAssetId: 902, questionId: 4 },
    ],
    fields: [
      { questionId: 1, title: "你的昵称", value: "夜航" },
      { questionId: 2, title: "一句话签名", value: "把夜里的风写成字" },
      { questionId: 5, title: "兴趣爱好标签", value: "写作、旅行 #摄影#" },
      { questionId: 6, title: "自我介绍", value: "常年熬夜的写作者。" },
    ],
    ...overrides,
  };
}

describe("profile → showcase mapping", () => {
  it("maps heuristic fields, tags and images onto a draft page", () => {
    const { fields } = mapProfileToShowcasePerson(profile());
    expect(fields.name).toBe("夜航");
    expect(fields.subtitle).toBe("把夜里的风写成字");
    expect(fields.description).toBe("常年熬夜的写作者。");
    expect(fields.tags).toEqual(["写作", "旅行", "摄影"]);
    expect(fields.illustrationMediaId).toBe(901);
    expect(fields.backgroundMediaId).toBe(902);
    expect(fields.responseId).toBe(55);
    expect(fields.surveyId).toBe(12);
  });

  it("falls back to the owner name and longest answers when titles do not match", () => {
    const { fields } = mapProfileToShowcasePerson(
      profile({
        images: [],
        fields: [
          { questionId: 1, title: "Q1", value: "短" },
          { questionId: 2, title: "Q2", value: "这是一段更长的回答，用来兜底当简介。" },
        ],
      }),
    );
    expect(fields.name).toBe("阿沙");
    expect(fields.subtitle).toBeNull();
    expect(fields.tags).toEqual([]);
    // 没有「简介」题时按长度取前三条回答拼成简介（题目越短越靠后）。
    expect(fields.description).toBe("这是一段更长的回答，用来兜底当简介。\n短");
    expect(fields.illustrationMediaId).toBeNull();
  });
});

describe.skipIf(!sqliteD1Available)("profile → showcase sync (real SQLite)", () => {
  it("creates one draft per response and never overwrites an existing page", async () => {
    const db = createSqliteD1(SCHEMA);
    const first = await syncShowcasePersonFromProfile(db, profile(), { ownerUserId: 7 });
    expect(first).toMatchObject({ created: true, published: false });

    const row = await db
      .prepare("SELECT name, published, owner_user_id ownerUserId, response_id responseId FROM showcase_persons WHERE id = ?")
      .bind(first.personId)
      .first<{ name: string; published: number; ownerUserId: number; responseId: number }>();
    expect(row).toMatchObject({ name: "夜航", published: 0, ownerUserId: 7, responseId: 55 });

    // 管理员改过名字后再点一次「生成展示页」不能把改动冲掉。
    await db.prepare("UPDATE showcase_persons SET name = '管理员改名', published = 1 WHERE id = ?").bind(first.personId).run();
    const second = await syncShowcasePersonFromProfile(db, profile({ fields: [] }), { ownerUserId: 7 });
    expect(second).toMatchObject({ personId: first.personId, created: false, published: true });
    const names = await db.prepare("SELECT name FROM showcase_persons").all<{ name: string }>();
    expect(names.results).toEqual([{ name: "管理员改名" }]);
  });
});
