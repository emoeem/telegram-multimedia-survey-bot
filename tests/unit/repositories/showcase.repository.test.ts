import { describe, expect, it } from "vitest";

import {
  createShowcaseItem,
  createShowcasePerson,
  deleteShowcaseItem,
  deleteShowcasePerson,
  getPublishedShowcaseItemById,
  getPublishedShowcasePersonIdForAsset,
  getShowcasePersonById,
  updateShowcaseItem,
  listShowcasePersons,
  reorderShowcasePersons,
  updateShowcasePerson,
} from "../../../src/db/repositories/showcase.repository";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * Real-SQLite coverage for the showcase feed.
 *
 * The public gallery runs these statements on every swipe, and the batched item
 * lookup joins `json_each(...)` — which also exposes an `id` column, the
 * ambiguous-ORDER-BY trap that already took the profile-gallery feed down once.
 * Typecheck and mocked tests cannot catch that; this can.
 */
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
INSERT INTO media_assets (id, asset_scope) VALUES (900, 'survey'), (901, 'survey'), (902, 'survey');
`;

describe.skipIf(!sqliteD1Available)("showcase repository (real SQLite)", () => {
  it("returns published people in display order with all of their items", async () => {
    const db = createSqliteD1(SCHEMA);
    const first = await createShowcasePerson(db, {
      name: "月见",
      tags: ["插画", "角色设计"],
      links: [{ type: "github", label: "GitHub", url: "https://github.com/example" }],
      accentColor: "#7c8cff",
      illustrationMediaId: 901,
      published: true,
      sortOrder: 1,
    });
    const second = await createShowcasePerson(db, { name: "兰", published: true, sortOrder: 0 });
    const hidden = await createShowcasePerson(db, { name: "草稿", published: false });

    await createShowcaseItem(db, { personId: first, title: "作品 B", sortOrder: 1, featured: true });
    await createShowcaseItem(db, { personId: first, title: "作品 A", sortOrder: 0 });
    await createShowcaseItem(db, { personId: hidden, title: "隐藏作品" });

    const { persons, total } = await listShowcasePersons(db, { publishedOnly: true });
    expect(total).toBe(2);
    expect(persons.map((person) => person.name)).toEqual(["兰", "月见"]);
    expect(persons.every((person) => person.published)).toBe(true);

    const featured = persons.find((person) => person.name === "月见");
    // Items are ordered by sort_order, not insertion, and every row is attached.
    expect(featured?.items.map((item) => item.title)).toEqual(["作品 A", "作品 B"]);
    expect(featured?.tags).toEqual(["插画", "角色设计"]);
    expect(featured?.links[0]?.url).toBe("https://github.com/example");
    expect(featured?.illustrationMediaId).toBe(901);

    const all = await listShowcasePersons(db, {});
    expect(all.total).toBe(3);
  });

  it("withdraws artwork from the public media endpoint when a person is unpublished", async () => {
    const db = createSqliteD1(SCHEMA);
    const id = await createShowcasePerson(db, { name: "月见", illustrationMediaId: 901, published: true });
    const itemResult = await createShowcaseItem(db, { personId: id, title: "封面作品", coverMediaId: 902 });

    expect(await getPublishedShowcasePersonIdForAsset(db, 901)).toBe(id);
    expect(await getPublishedShowcasePersonIdForAsset(db, 902)).toBe(id);
    expect(await getPublishedShowcasePersonIdForAsset(db, 900)).toBeNull();

    await updateShowcasePerson(db, id, { published: false });
    // Unpublishing is the authorization boundary: the bytes stay in KV, the URL
    // stops resolving.
    expect(await getPublishedShowcasePersonIdForAsset(db, 901)).toBeNull();
    expect(await getPublishedShowcasePersonIdForAsset(db, 902)).toBeNull();
    expect(await getShowcasePersonById(db, id)).not.toBeNull();
    expect(await getShowcaseItemByIdHelper(db, itemResult)).toBe(true);
  });

  // 作品本体（图片/音频/视频）也走同一条授权：素材必须挂在一个已公开人物名下。
  it("round-trips the item media file and authorizes it through the published person", async () => {
    const db = createSqliteD1(SCHEMA);
    const id = await createShowcasePerson(db, { name: "月见", published: true });
    const itemId = await createShowcaseItem(db, {
      personId: id,
      title: "朗读：长夜将明",
      kind: "audio",
      mediaAssetId: 903,
    });

    const person = await getShowcasePersonById(db, id);
    expect(person?.items[0]).toMatchObject({ kind: "audio", mediaAssetId: 903 });
    expect(await getPublishedShowcasePersonIdForAsset(db, 903)).toBe(id);

    // 下架即失效；换文件（patch 成 null）也要能清掉。
    await updateShowcasePerson(db, id, { published: false });
    expect(await getPublishedShowcasePersonIdForAsset(db, 903)).toBeNull();
    await updateShowcasePerson(db, id, { published: true });
    await updateShowcaseItem(db, itemId, { mediaAssetId: null });
    expect((await getShowcasePersonById(db, id))?.items[0]?.mediaAssetId).toBeNull();
    expect(await getPublishedShowcasePersonIdForAsset(db, 903)).toBeNull();
  });

  // 阅读全文接口只服务已公开人物名下的作品。
  it("exposes an item only while its person is published", async () => {
    const db = createSqliteD1(SCHEMA);
    const id = await createShowcasePerson(db, { name: "月见", published: true });
    const itemId = await createShowcaseItem(db, { personId: id, title: "长夜将明", kind: "article" });
    expect((await getPublishedShowcaseItemById(db, itemId))?.item.title).toBe("长夜将明");

    await updateShowcasePerson(db, id, { published: false });
    expect(await getPublishedShowcaseItemById(db, itemId)).toBeNull();
  });

  it("patches only the fields it is given and clears them on null", async () => {
    const db = createSqliteD1(SCHEMA);
    const id = await createShowcasePerson(db, {
      name: "月见",
      subtitle: "插画师",
      tags: ["插画"],
      published: false,
    });

    await updateShowcasePerson(db, id, { subtitle: null, published: true });
    const updated = await getShowcasePersonById(db, id);
    expect(updated?.name).toBe("月见");
    expect(updated?.subtitle).toBeNull();
    expect(updated?.tags).toEqual(["插画"]);
    expect(updated?.published).toBe(true);
  });

  it("reorders in one batch and cascades item deletes", async () => {
    const db = createSqliteD1(SCHEMA);
    const a = await createShowcasePerson(db, { name: "A", sortOrder: 0, published: true });
    const b = await createShowcasePerson(db, { name: "B", sortOrder: 1, published: true });
    await reorderShowcasePersons(db, [b, a]);
    const { persons } = await listShowcasePersons(db, {});
    expect(persons.map((person) => person.name)).toEqual(["B", "A"]);

    const item = await createShowcaseItem(db, { personId: a, title: "作品" });
    expect(await deleteShowcaseItem(db, item)).toBe(true);
    expect((await getShowcasePersonById(db, a))?.items).toHaveLength(0);

    expect(await deleteShowcasePerson(db, a)).toBe(true);
    expect(await getShowcasePersonById(db, a)).toBeNull();
  });
});

/** Local helper: the item must still exist after only the person was hidden. */
async function getShowcaseItemByIdHelper(db: D1Database, id: number): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM showcase_items WHERE id = ?").bind(id).first();
  return row !== null;
}
