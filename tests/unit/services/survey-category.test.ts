import { describe, expect, it, vi } from "vitest";

import {
  assignCategoryToSurveys,
  createCategory,
  deleteCategory,
  deriveCategorySlug,
  isCategoryWriteError,
  normalizeCategoryDescription,
  normalizeCategoryName,
  normalizeCategorySlug,
  updateCategory,
} from "../../../src/services/survey-category.service";

/**
 * 分类的写侧规则（0087）。
 *
 * 重点不在「能建一个分类」，而在三条容易被写坏的约束：
 *   1. slug 全站唯一，冲突时顺延而不是静默覆盖——否则两个分类会指向
 *      同一个筛选参数，运营看到的是「点进去永远是别人的那批问卷」；
 *   2. 删分类必须先把问卷解绑（含软删除的行），否则回收站里恢复出来的
 *      问卷会带着一个已不存在的 category_id；
 *   3. 校验失败要在写库之前返回，不留半条记录。
 */

interface StatementStub {
  sql: string;
  binds: unknown[];
  bind: (...values: unknown[]) => StatementStub;
  first: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

function makeDb(handlers: {
  first?: (sql: string, binds: unknown[]) => unknown;
  all?: (sql: string, binds: unknown[]) => unknown;
  run?: (sql: string, binds: unknown[]) => unknown;
}) {
  const statements: StatementStub[] = [];
  const batch = vi.fn(async (items: StatementStub[]) => items.map((item) => item.run()));
  const db = {
    prepare: vi.fn((sql: string) => {
      const statement: StatementStub = {
        sql,
        binds: [],
        bind: (...values: unknown[]) => {
          statement.binds = values;
          return statement;
        },
        first: vi.fn(async () => handlers.first?.(sql, statement.binds) ?? null),
        all: vi.fn(async () => handlers.all?.(sql, statement.binds) ?? { results: [] }),
        run: vi.fn(async () => handlers.run?.(sql, statement.binds) ?? { success: true, meta: { changes: 0 } }),
      };
      statements.push(statement);
      return statement;
    }),
    batch,
  };
  return { db: db as unknown as D1Database, statements, batch };
}

describe("survey category · 输入规范化", () => {
  it("slug 只接受 ASCII 小写与连字符", () => {
    expect(normalizeCategorySlug("scenario")).toBe("scenario");
    expect(normalizeCategorySlug("  Scenario  ")).toBe("scenario");
    expect(normalizeCategorySlug("情景剧情")).toBeNull();
    expect(normalizeCategorySlug("-lead")).toBeNull();
    expect(normalizeCategorySlug("")).toBeNull();
    expect(normalizeCategorySlug(42)).toBeNull();
  });

  it("分类名 1-20 字符，两侧空白被裁掉", () => {
    expect(normalizeCategoryName("  情景剧情 ")).toBe("情景剧情");
    expect(normalizeCategoryName("   ")).toBeNull();
    expect(normalizeCategoryName("x".repeat(21))).toBeNull();
    expect(normalizeCategoryName(null)).toBeNull();
  });

  it("说明可空，超长拒绝", () => {
    expect(normalizeCategoryDescription(undefined)).toBe("");
    expect(normalizeCategoryDescription(null)).toBe("");
    expect(normalizeCategoryDescription(" 装剧情类 ")).toBe("装剧情类");
    expect(normalizeCategoryDescription("x".repeat(121))).toBeNull();
  });

  it("自动生成的 slug 是合法格式", () => {
    expect(deriveCategorySlug()).toMatch(/^c[a-z0-9]+$/);
  });
});

describe("survey category · 写入", () => {
  it("名称为空时不写库", async () => {
    const { db, statements } = makeDb({});
    const result = await createCategory(db, { name: "  " });
    expect(isCategoryWriteError(result)).toBe(true);
    expect(isCategoryWriteError(result) && result.code).toBe("invalid_name");
    expect(statements).toHaveLength(0);
  });

  it("slug 全被占用时返回冲突，而不是硬插一条重复的", async () => {
    const { db, statements } = makeDb({
      // 任何 slug 查询都命中：模拟 20 次顺延全部撞车。
      first: (sql) => (sql.includes("WHERE slug = ?") ? { id: 1 } : null),
    });
    const result = await createCategory(db, { name: "情景剧情", slug: "scenario" });
    expect(isCategoryWriteError(result)).toBe(true);
    expect(isCategoryWriteError(result) && result.code).toBe("slug_conflict");
    // 20 次探测 + 0 次写入。
    expect(statements.filter((s) => s.sql.startsWith("INSERT"))).toHaveLength(0);
  });

  it("slug 冲突时顺延为 -2 并写入", async () => {
    const { db, statements } = makeDb({
      first: (sql, binds) => (sql.includes("WHERE slug = ?") && binds[0] === "scenario" ? { id: 1 } : null),
      run: (sql) => (sql.startsWith("INSERT") ? { success: true, meta: { last_row_id: 9 } } : { meta: {} }),
    });
    const result = await createCategory(db, { name: "情景剧情", slug: "scenario" });
    expect(isCategoryWriteError(result)).toBe(false);
    const inserted = statements.find((s) => s.sql.startsWith("INSERT"));
    expect(inserted?.binds[1]).toBe("scenario-2");
    expect(isCategoryWriteError(result) ? null : result.id).toBe(9);
  });

  it("更新不存在的分类返回 not_found，不发 UPDATE", async () => {
    const { db, statements } = makeDb({ first: () => null });
    const result = await updateCategory(db, 404, { name: "新名字" });
    expect(isCategoryWriteError(result) && result.code).toBe("not_found");
    expect(statements.filter((s) => s.sql.startsWith("UPDATE"))).toHaveLength(0);
  });

  it("删分类先把问卷解绑，再删分类行", async () => {
    const { db, batch } = makeDb({ first: () => ({ id: 3 }) });
    const ok = await deleteCategory(db, 3);
    expect(ok).toBe(true);
    expect(batch).toHaveBeenCalledTimes(1);
    const statements = batch.mock.calls[0]?.[0] as StatementStub[];
    expect(statements[0]?.sql).toContain("UPDATE surveys SET category_id = NULL");
    expect(statements[1]?.sql).toContain("DELETE FROM survey_categories");
  });

  it("删不存在的分类返回 false，不触发 batch", async () => {
    const { db, batch } = makeDb({ first: () => null });
    expect(await deleteCategory(db, 404)).toBe(false);
    expect(batch).not.toHaveBeenCalled();
  });

  it("批量归类：空选择零查询，N 份就是 N 个占位符", async () => {
    const { db, statements } = makeDb({ run: () => ({ success: true, meta: { changes: 2 } }) });
    expect(await assignCategoryToSurveys(db, [], 3)).toBe(0);
    expect(statements).toHaveLength(0);

    const changed = await assignCategoryToSurveys(db, [4, 5, 6], 3);
    expect(changed).toBe(2);
    const update = statements[0];
    expect(update?.sql).toContain("IN (?,?,?)");
    expect(update?.binds).toEqual([3, expect.any(String), 4, 5, 6]);
  });
});
