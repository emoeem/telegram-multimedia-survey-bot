import { describe, expect, it, vi } from "vitest";
import { listTrash, trashCutoff } from "../../../src/services/trash.service";

function createDb(rows: Record<string, unknown>[][]): D1Database {
  return {
    prepare: vi.fn(() => ({ bind: vi.fn(() => ({})) })),
    batch: vi.fn(async () => rows.map((results) => ({ results, meta: {} }))),
  } as unknown as D1Database;
}

describe("trash service", () => {
  it("computes a deterministic 30-day retention cutoff from the injected clock", () => {
    expect(trashCutoff(Date.parse("2026-08-19T00:00:00.000Z"))).toBe("2026-07-20T00:00:00.000Z");
  });

  it("merges all trash kinds, hides child artwork of a deleted person, and sorts newest first", async () => {
    const db = createDb([
      [{ id: 1, title: "问卷", deletedAt: "2026-08-18T00:00:00.000Z" }],
      [{ id: 2, title: "人物", deletedAt: "2026-08-17T00:00:00.000Z" }],
      [{ id: 3, title: "作品", deletedAt: "2026-08-16T00:00:00.000Z" }],
      [{ id: 4, title: "树洞", deletedAt: "2026-08-15T00:00:00.000Z" }],
      [{ id: "tpl", title: "模板", deletedAt: "2026-08-14T00:00:00.000Z" }],
    ]);
    const items = await listTrash(db, Date.parse("2026-08-19T00:00:00.000Z"), 100);
    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "survey:1",
      "showcase_person:2",
      "showcase_item:3",
      "plaza_post:4",
      "report_template:tpl",
    ]);
  });
});
