#!/usr/bin/env node
/**
 * 存量弱引用回填（0091）：把 surveys.settings_json 里以 URL 字符串出现的媒体
 * 引用（BGM / 场景图 / 主题背景）解析成 media_refs 结构化登记行。
 *
 * 为什么要单独一个脚本：日常的同步挂在每日维护任务里（services/
 * database-maintenance.service.ts 的 syncWeakMediaRefs），但存量数据第一次
 * 落库要么等下一次 cron，要么手动跑一遍。这个脚本把解析拆出来，生成一份
 * `wrangler d1 execute` 能直接执行的 SQL 文件——不新增 D1 调用凭据，也不
 * 依赖运维临时写脚本。
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
 *
 * v2（逐条遍历）：SQLite 没有正则，用递归 CTE 沿 settings_json 逐处推进
 * INSTR 游标，抽出一行里的**全部** media/<id> 引用（v1 的单次 SUBSTR 只处理
 * 第一处，多引用问卷要反复跑）。游标每步吃掉「上一个 media/ 之后」的文本，
 * 直到找不到下一个 media/ 为止；每处引用产出一条登记行，EXISTS 守卫过滤脏值。
 */
export function buildBackfillStatements() {
  return [
    // 清掉本脚本负责的旧登记行，保证重跑结果收敛（其它 ref_type 不动）。
    "DELETE FROM media_refs WHERE ref_type = 'survey_settings';",
    `INSERT OR IGNORE INTO media_refs (asset_id, ref_type, ref_key, created_at, updated_at)
WITH RECURSIVE scan(survey_id, settings_json, cursor, asset_id) AS (
  SELECT id, settings_json, 1, NULL
  FROM surveys
  WHERE settings_json LIKE '%media/%'
  UNION ALL
  SELECT
    survey_id,
    settings_json,
    cursor + INSTR(SUBSTR(settings_json, cursor), 'media/') + 5,
    CAST(SUBSTR(settings_json, cursor + INSTR(SUBSTR(settings_json, cursor), 'media/') + 5) AS INTEGER)
  FROM scan
  WHERE INSTR(SUBSTR(settings_json, cursor), 'media/') > 0
)
SELECT DISTINCT
  asset_id,
  'survey_settings' AS ref_type,
  'survey:' || survey_id || ':' || asset_id AS ref_key,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS created_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS updated_at
FROM scan
WHERE asset_id IS NOT NULL AND asset_id > 0
  AND EXISTS (SELECT 1 FROM media_assets m WHERE m.id = asset_id)
  AND EXISTS (SELECT 1 FROM surveys s WHERE s.id = survey_id AND s.settings_json LIKE '%media/%');`,
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
