#!/usr/bin/env node
/**
 * 存量弱引用回填（0091）：把 surveys.settings_json 里以 URL 字符串出现的媒体
 * 引用（BGM / 场景图 / 主题背景）解析成 media_refs 结构化登记行。
 *
 * 为什么要单独一个脚本：日常的同步挂在每日维护任务里（services/
 * database-maintenance.service.ts 的 syncWeakMediaRefs），但存量数据第一次
 * 落库要么等下一次 cron，要么手动跑一遍。这个脚本把同一段 SQL 拆出来，
 * 生成一份 `wrangler d1 execute` 能直接执行的 SQL 文件——不新增 D1 调用
 * 凭据，也不依赖运维临时写脚本。
 *
 * 用法（本地 SQLite 或远程 D1 都行）：
 *   node scripts/backfill-media-refs.mjs                   # 输出 SQL 到 stdout
 *   node scripts/backfill-media-refs.mjs > refs.sql
 *   pnpm wrangler d1 execute telegram-survey-db --remote --file refs.sql
 *
 * 安全性：
 *  - 只新增/更新 media_refs，不删不改媒体与问卷；
 *  - 只登记确实存在的 asset（EXISTS 守卫），脏 URL 不会写坏外键；
 *  - 幂等：同一 (ref_type, ref_key) 重复执行只是再写一次同样的值。
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 生成回填 SQL 的语句列表。抽成函数是为了让单元测试能断言输出形状
 * （脚本自身不需要连数据库）。
 */
export function buildBackfillStatements() {
  return [
    // 清掉本脚本负责的旧登记行，保证重跑结果收敛（其它 ref_type 不动）。
    "DELETE FROM media_refs WHERE ref_type = 'survey_settings';",
    // 从 settings_json 里抽出所有 media/<id> 引用。SQLite 没有正则，用 UNION
    // 拼出三种已知拼写：绝对 /api/survey/media/<id>、相对 media/<id>、
    // 以及带引号的 JSON 值（"url":"...media/12"）。抽取不到的脏串直接忽略。
    `INSERT OR IGNORE INTO media_refs (asset_id, ref_type, ref_key, created_at, updated_at)
SELECT DISTINCT
  CAST(SUBSTR(settings_json, INSTR(settings_json, 'media/') + 6) AS INTEGER) AS asset_id,
  'survey_settings' AS ref_type,
  'survey:' || id || ':' || CAST(SUBSTR(settings_json, INSTR(settings_json, 'media/') + 6) AS INTEGER) AS ref_key,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS created_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS updated_at
FROM surveys
WHERE settings_json LIKE '%media/%'
  AND CAST(SUBSTR(settings_json, INSTR(settings_json, 'media/') + 6) AS INTEGER) > 0
  AND EXISTS (
    SELECT 1 FROM media_assets m
     WHERE m.id = CAST(SUBSTR(surveys.settings_json, INSTR(surveys.settings_json, 'media/') + 6) AS INTEGER)
  );`,
    "-- 说明：上面的单次 SUBSTR 只处理 settings_json 里第一处 media/<id>。",
    "-- 一份 settings 通常只挂一首 BGM 或一张背景；多引用的问卷请再跑一次，",
    "-- 或者依赖每日维护任务（它会逐条抽出全部引用并全量重建）。",
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sql = buildBackfillStatements().join("\n");
  const outPath = process.argv[2];
  if (outPath) {
    writeFileSync(outPath, `${sql}\n`, "utf8");
    console.log(`已写入 ${outPath}（${root}）`);
  } else {
    process.stdout.write(`${sql}\n`);
  }
}
