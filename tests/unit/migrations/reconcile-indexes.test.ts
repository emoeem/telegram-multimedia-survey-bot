import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fullMigrationSchema } from "../../helpers/full-schema";
import { sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 0098 对账迁移的覆盖守卫：全部迁移在真实 SQLite 里执行后，sqlite_master 里
 * 的每一条显式索引都必须出现在 0098 里。没有这条守卫，"新增迁移忘了重跑
 * 生成脚本"会静默回到漂移状态（0034/0038 重建表丢索引的教训见 0098 文件头）。
 * 定义提取用执行后的终态 schema 而不是解析文件文本——过渡表/已 DROP 表的
 * 索引照抄会在终态 schema 上失败。
 */
const require = createRequire(import.meta.url);
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const RECONCILE_FILE = "0098_reconcile_indexes.sql";

function finalSchemaIndexNames(): string[] {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(fullMigrationSchema());
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all() as { name: string }[]
  ).map((row) => row.name);
}

const describeIf = sqliteD1Available ? describe : describe.skip;

describeIf("0098 reconcile migration", () => {
  it("re-declares every index in the fully-migrated final schema", () => {
    const reconcile = readFileSync(path.join(MIGRATIONS_DIR, RECONCILE_FILE), "utf8");
    const names = finalSchemaIndexNames();
    expect(names.length).toBeGreaterThan(100);
    const missing = names.filter((name) => !new RegExp(`INDEX IF NOT EXISTS ${name}\\b`).test(reconcile));
    expect(missing).toEqual([]);
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
