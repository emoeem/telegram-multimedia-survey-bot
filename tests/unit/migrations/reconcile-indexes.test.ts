import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fullMigrationSchema } from "../../helpers/full-schema";
import { sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 0098 对账迁移的覆盖守卫（双向）：全部迁移在真实 SQLite 里执行后，终态
 * schema 里「在 0098 执行位置可创建」的每一条显式索引都必须出现在 0098 里；
 * 反过来，0098 里声明的不可能在这个位置创建的索引（引用后续迁移才新增的
 * 列）也不允许出现——那会让全新库的按序 bootstrap 在 0098 处报错
 * （0101/0102 的 task_packs.deleted_at 局部索引是首例，见
 * gen-reconcile-migration.mjs 的位置过滤注释）。没有这条守卫，"新增迁移忘了
 * 重跑生成脚本"会静默回到漂移状态（0034/0038 重建表丢索引的教训见 0098
 * 文件头）。定义提取用执行后的终态 schema 而不是解析文件文本——过渡表/
 * 已 DROP 表的索引照抄会在终态 schema 上失败。
 */
const require = createRequire(import.meta.url);
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const RECONCILE_FILE = "0098_reconcile_indexes.sql";

function finalSchemaIndexes(): Array<{ name: string; sql: string }> {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(fullMigrationSchema());
  return db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all() as Array<{
    name: string;
    sql: string;
  }>;
}

/** 与 gen-reconcile-migration.mjs 同规则：终态索引里「在 0098 位置可创建」的集合。 */
function reconcilableIndexNames(): Set<string> {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const positionFiles = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql") && file < RECONCILE_FILE);
  const db = new DatabaseSync(":memory:");
  for (const file of positionFiles) {
    db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
  const reconcilable = new Set<string>();
  for (const index of finalSchemaIndexes()) {
    const normalized = index.sql.replace(
      /^CREATE\s+(UNIQUE\s+)?INDEX\s/i,
      (m, unique) => `CREATE ${unique ?? ""}INDEX IF NOT EXISTS `,
    );
    try {
      db.exec("BEGIN");
      db.exec(normalized);
      db.exec("COMMIT");
      reconcilable.add(index.name);
    } catch {
      db.exec("ROLLBACK");
    }
  }
  return reconcilable;
}

function declaredNamesInReconcile(reconcile: string): string[] {
  return [...reconcile.matchAll(/INDEX IF NOT EXISTS\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}

const describeIf = sqliteD1Available ? describe : describe.skip;

describeIf("0098 reconcile migration", () => {
  it("re-declares every reconcilable index and declares nothing uncreatable at its position", () => {
    const reconcile = readFileSync(path.join(MIGRATIONS_DIR, RECONCILE_FILE), "utf8");
    const reconcilable = reconcilableIndexNames();
    expect(reconcilable.size).toBeGreaterThan(100);
    const declared = declaredNamesInReconcile(reconcile);
    const missing = [...reconcilable].filter((name) => !new RegExp(`INDEX IF NOT EXISTS ${name}\\b`).test(reconcile));
    expect(missing).toEqual([]);
    // 越界收录（引用后续迁移才新增列）会让全新库 bootstrap 在 0098 处失败。
    const unexpected = declared.filter((name) => !reconcilable.has(name));
    expect(unexpected).toEqual([]);
  });
});

describe("0098 reconcile migration (static shape)", () => {
  it("is idempotent by construction: every statement uses IF NOT EXISTS", () => {
    const reconcile = readFileSync(path.join(MIGRATIONS_DIR, RECONCILE_FILE), "utf8");
    const statements = reconcile.split(";").filter((s) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(s));
    expect(statements.length).toBeGreaterThan(100);
    for (const statement of statements) {
      expect(statement).toMatch(/CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/i);
    }
  });
});
