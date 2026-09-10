#!/usr/bin/env node
/**
 * Generates db/migrations/0048_k9_task_pack.sql from the parsed K9 corpus.
 *
 * Usage:
 *   node scripts/parse_k9_pdf.mjs /tmp/k9-task200.txt scripts/data/k9-task200.json
 *   node scripts/import_k9_tasks.mjs scripts/data/k9-task200.json db/migrations/0048_k9_task_pack.sql
 */

import { readFileSync, writeFileSync } from "node:fs";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("usage: node scripts/import_k9_tasks.mjs <corpus.json> <output.sql>");
  process.exit(1);
}

const corpus = JSON.parse(readFileSync(inputPath, "utf8"));
if (corpus.taskCount !== 200 || corpus.missingNumbers.length > 0) {
  console.error(`expected 200 complete tasks, got ${corpus.taskCount} (missing ${corpus.missingNumbers.join(",")})`);
  process.exit(1);
}

const PACK_NAME = "K9 犬训 · 原典 200 题";
const PACK_DESC =
  "内容改编自《K9任务200》原典（虚构角色扮演）。仅限年满 18 周岁；请在私密、双方知情同意的想象场景中完成，设置安全词并避免一切真实伤害行为。部分题目含危险动作或公共场合内容，玩家端会在抽到这些题时先弹窗提醒，请尊重提醒。";

function sqlEscape(value) {
  return String(value ?? "").replaceAll("'", "''");
}

function bodyText(task) {
  const parts = [];
  if (task.purpose) parts.push(`任务目的：${task.purpose}`);
  if (task.tools) parts.push(`任务工具：${task.tools}`);
  if (task.steps) parts.push(task.steps);
  if (task.requirement) parts.push(`任务要求：${task.requirement}`);
  if (task.environment) parts.push(`任务环境：${task.environment}`);
  if (task.verification) parts.push(`验证方式：${task.verification}`);
  if (task.subType) parts.push(`适用奴型：${task.subType}`);
  return parts.join("\n").trim().slice(0, 3000);
}

const now = "2026-09-09T00:00:00.000Z";
const lines = [];
lines.push("-- K9 原典 200 题导入（脚本生成，勿手改）：全量保留，危险/公共场合题带 warning 弹窗。");
lines.push("ALTER TABLE task_items ADD COLUMN warning TEXT NOT NULL DEFAULT '';");
lines.push("");
lines.push(
  `INSERT INTO task_packs (name, description, normal_floors, hell_floors, enabled, sort_order, created_at, updated_at)\nVALUES ('${sqlEscape(PACK_NAME)}', '${sqlEscape(PACK_DESC)}', 20, 25, 1, 10, '${now}', '${now}');`,
);
lines.push("");

for (const task of corpus.tasks) {
  const title = `K9 ${task.n} · ${(task.title ?? "未命名").trim().slice(0, 45)}`;
  const description = bodyText(task);
  const warning = (task.warning ?? "").slice(0, 300);
  lines.push(
    [
      "INSERT INTO task_items (pack_id, title, description, warning, score, persona, mode, min_floor, max_floor, enabled, sort_order, created_at, updated_at)",
      `SELECT id, '${sqlEscape(title)}', '${sqlEscape(description)}', '${sqlEscape(warning)}', 5, 'any', 'any', 1, 25, 1, ${task.n}, '${now}', '${now}'`,
      "FROM task_packs WHERE name = '" + sqlEscape(PACK_NAME) + "';",
    ].join("\n"),
  );
}

writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
const warned = corpus.tasks.filter((task) => task.warning).length;
console.log(
  `wrote ${outputPath}: ${corpus.taskCount} tasks, ${warned} with warning pop-ups (${corpus.warnedNumbers.join(",")})`,
);
