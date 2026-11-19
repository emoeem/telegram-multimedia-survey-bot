#!/usr/bin/env node
/**
 * 生成 db/migrations/0098_reconcile_indexes.sql——全库索引对账迁移。
 *
 * 背景（2026-11-16/17 排查）：0034/0038 这类 rename-dance 重建表迁移会把旧表
 * 的索引连同 DROP TABLE 一起删掉，而重建清单只补回一部分——f4a560c5 客户库
 * 的 d1_migrations 记录 0004 已应用，但 0004 里的 idx_responses_survey_id 实测
 * 不存在。迁移文件内容在"已应用"之后不可重放（wrangler 只认文件名），漂移
 * 只能靠显式对账修复。
 *
 * 生成方式不是解析迁移文件文本：重建迁移里绑在 `xxx_new` 过渡表上的索引、
 * 以及已被后续迁移 DROP 的表（如 device_tasks）的索引，逐字照抄都会在终态
 * schema 上失败。本脚本把全部迁移在真实 SQLite（node:sqlite）里执行一遍，
 * 从终态 sqlite_master 反向提取每条索引的定义——那才是"新库最终长什么样"
 * 的权威答案。新增/修改普通迁移后重跑本脚本再生成；0098 之外不要手工编辑。
 */
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS_DIR = path.join(ROOT, "db", "migrations");
const TARGET_NAME = "0098_reconcile_indexes.sql";

const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql") && f !== TARGET_NAME).sort();
const db = new DatabaseSync(":memory:");
for (const file of files) {
  db.exec(await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf8"));
}
// sql IS NOT NULL：UNIQUE 约束的隐式索引 sql 为空，不可（也无需）显式重建。
const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();

const entries = rows
  .map((r) => ({
    name: r.name,
    sql: String(r.sql).replace(
      /^CREATE\s+(UNIQUE\s+)?INDEX\s/i,
      (m, unique) => `CREATE ${unique ?? ""}INDEX IF NOT EXISTS `,
    ),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// 位置过滤：0098 在迁移文件名序里排在后续迁移之前执行（全新库 bootstrap 与
// wrangler apply 都是按文件名顺序）。引用「后续迁移才新增列」的索引（如
// 0101/0102 引用 0101 才加入的 task_packs.deleted_at）在 0098 位置无法创建，
// 收进本文件会让全新库在 0098 处直接报错。这类索引由各自的迁移文件（自带
// IF NOT EXISTS）负责创建；守卫测试 tests/unit/migrations/reconcile-indexes
// 按同一规则双向核对——缺失与越界收录都报错。
const positionDb = new DatabaseSync(":memory:");
for (const file of files.filter((f) => f < TARGET_NAME)) {
  positionDb.exec(await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf8"));
}
const reconcilable = [];
const skipped = [];
for (const entry of entries) {
  try {
    positionDb.exec("BEGIN");
    positionDb.exec(entry.sql);
    positionDb.exec("COMMIT");
    reconcilable.push(entry);
  } catch (error) {
    positionDb.exec("ROLLBACK");
    skipped.push(`${entry.name}: ${String(error).split("\n")[0]}`);
  }
}

const lines = [
  "-- 0098 · 全库索引对账（reconcile）。",
  "--",
  "-- 迁移记录按文件名记账、不校验内容：0034/0038 这类 rename-dance 重建表迁移",
  "-- 用 DROP TABLE 换新表时连带删除旧表全部索引，重建清单只补回一部分——",
  "-- f4a560c5 客户库实测 d1_migrations 记录 0004 已应用而 0004 里的",
  "-- idx_responses_survey_id 不存在。本迁移把全部迁移执行后的终态索引逐条",
  "-- CREATE IF NOT EXISTS 重申一遍（幂等、按名排序），一次性消除所有部署的",
  "-- 历史漂移。",
  "--",
  "-- 覆盖范围：只收录「在本文件执行位置（文件名序，位于 0099+ 之前）可创建」",
  "-- 的终态索引。引用后续迁移才新增列的索引（如 0101/0102 引用 0101 才加入",
  "-- 的 task_packs.deleted_at 的局部索引）不收录——它们在 0098 位置创建会",
  "-- 让全新库的按序 bootstrap 报错；这些索引由各自迁移（自带 IF NOT EXISTS）",
  "-- 负责创建。",
  "--",
  "-- 生成方式：node scripts/gen-reconcile-migration.mjs——把全部迁移在真实",
  "-- SQLite 里执行后从终态 sqlite_master 提取（不是解析迁移文件文本：过渡表",
  "-- 与已 DROP 表的索引照抄会在终态 schema 上失败）。普通迁移变更后重跑本",
  "-- 脚本再生成，勿手工编辑本文件。维护期运行时自愈的前置清单见",
  "-- src/services/database-maintenance.service.ts 的 MAINTENANCE_INDEXES，两份",
  "-- 清单语义不同：这里管全库一次性对账，那里管每日维护的读写路径自愈。",
  "--",
  "-- 回滚：本迁移只新增索引；DROP 对应索引名即可（一般无需回滚）。",
  "",
  ...reconcilable.map((e) => `${e.sql};`),
  "",
];
await fs.writeFile(path.join(MIGRATIONS_DIR, TARGET_NAME), lines.join("\n"), "utf8");
console.log(
  `generated ${TARGET_NAME}: ${reconcilable.length} indexes from ${files.length} migration files (executed schema)`,
);
for (const item of skipped) {
  console.log(`  skipped (not creatable at 0098 position, owned by its own migration): ${item}`);
}
