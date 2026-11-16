#!/usr/bin/env bash
# 只读 D1 诊断探针——定位 2026-11-16 维护告警（13,555,791 行读取）的元凶语句。
#
# 纪律：所有查询必须有界，探针自身不允许成为新的额度事故：
#   - MAX(id) 走 rowid，O(1)；
#   - COUNT 只走相关索引的范围段（对应 retention 清理真正会读的行数）；
#   - LIKE 密度采样按 rowid 窗口限量；
#   - 两条 REPRO 原样复现维护任务里仅有的两条"单语句无界"扫描（孤儿候选
#     扫描 / answers JSON 扫描），LIMIT 1 / LIMIT 2000，用 meta.rows_read
#     直接读出它们的真实计量成本。
# 免费档额度已耗尽时所有查询都会失败，脚本识别该错误并直接给出档位结论。
# 结论落档后：本脚本与 .github/workflows/d1-diagnostic-probe.yml 一并删除。
set -uo pipefail

DB="telegram-survey-db"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT

ISO7="$(date -u -d '7 days ago' '+%Y-%m-%dT%H:%M:%S')"
ISO180="$(date -u -d '180 days ago' '+%Y-%m-%dT%H:%M:%S')"

print_rows_read() { # file — 从 wrangler --json 输出提取每条语句的 meta.rows_read
  jq -r 'if type=="array" then (.[] | select(.meta) | "  rows_read=\(.meta.rows_read) writes=\(.meta.rows_written)") else (if .meta then "  rows_read=\(.meta.rows_read) writes=\(.meta.rows_written)" else empty end) end' "$1" 2>/dev/null
}

run_sql() { # label, sql
  # bash 5 对同一 local 语句里的变量先展开后赋值，必须逐行声明。
  local label="$1"
  local sql="$2"
  local file="$DIR/$label.json"
  echo "===== PROBE $label ====="
  if pnpm exec wrangler d1 execute "$DB" --remote --command "$sql" --json >"$file" 2>"$DIR/$label.err"; then
    cat "$file"
    echo
    print_rows_read "$file"
  else
    echo "[FAILED] $label"
    cat "$DIR/$label.err"
    echo
    # 额度耗尽 / 档位错误的特征：撞上就立刻停，不再烧任何探针。
    if grep -qiE "exceeded d1|daily row (read|write) limit|code: ?7500|authentication|authorized" "$DIR/$label.err"; then
      echo "!!! 检测到额度/权限错误，探针提前停止（上面的报错即档位结论）。"
      exit 0
    fi
  fi
  echo
}

max_id_of() { # json-file, tbl — 从 UNION ALL 结果里取某表的 max_id
  jq -r --arg t "$2" 'if type=="array" then (.[] | select(.results) | .results[]? | select(.tbl==$t) | .max_id) else (.results[]? | select(.tbl==$t) | .max_id) end' "$1" 2>/dev/null | head -1
}

# ---------- 第 1 组：表规模上界（全部 O(1)，先拿档位信号） ----------
run_sql "max-ids-a" "SELECT 'answers' AS tbl, MAX(id) AS max_id FROM answers
 UNION ALL SELECT 'surveys', MAX(id) FROM surveys
 UNION ALL SELECT 'audit_logs', MAX(id) FROM audit_logs
 UNION ALL SELECT 'survey_responses', MAX(id) FROM survey_responses"
run_sql "max-ids-b" "SELECT 'media_assets' AS tbl, MAX(id) AS max_id FROM media_assets
 UNION ALL SELECT 'telegram_update_dedup', MAX(id) FROM telegram_update_dedup
 UNION ALL SELECT 'rate_limits', MAX(id) FROM rate_limits
 UNION ALL SELECT 'media_refs', MAX(id) FROM media_refs"
run_sql "max-ids-c" "SELECT 'export_jobs' AS tbl, MAX(id) AS max_id FROM export_jobs
 UNION ALL SELECT 'render_jobs', MAX(id) FROM render_jobs
 UNION ALL SELECT 'image_generator_jobs', MAX(id) FROM image_generator_jobs
 UNION ALL SELECT 'notes', MAX(id) FROM notes
 UNION ALL SELECT 'plaza_posts', MAX(id) FROM plaza_posts"

ANSWERS_MAX="$(max_id_of "$DIR/max-ids-a.json" answers)"
SURVEYS_MAX="$(max_id_of "$DIR/max-ids-a.json" surveys)"

# ---------- 第 2 组：嫌疑 A 的规模——7 天前的媒体行数（候选扫描每天必读的量） ----------
run_sql "media-count" "SELECT COUNT(*) AS total_media FROM media_assets;
 SELECT COUNT(*) AS media_older_than_7d FROM media_assets WHERE created_at < '$ISO7'"

# ---------- 第 3 组：嫌疑 C 的规模——audit_logs 180 天保留段的行数 ----------
run_sql "audit-count" "SELECT COUNT(*) AS audit_before_180d FROM audit_logs WHERE created_at < '$ISO180'"

# ---------- 第 4 组：answers / surveys 的 LIKE 密度采样（rowid 窗口，各 ≤5 万行） ----------
if [ -n "$ANSWERS_MAX" ] && [ "$ANSWERS_MAX" -gt 150000 ] 2>/dev/null; then
  MID=$((ANSWERS_MAX / 2))
  run_sql "answers-density" "SELECT 'early' AS w, COUNT(*) AS matches FROM answers WHERE id > 0 AND id <= 50000 AND json_value LIKE '%\"mediaAssetId\"%'
   UNION ALL SELECT 'mid', COUNT(*) FROM answers WHERE id > $MID AND id <= $((MID + 50000)) AND json_value LIKE '%\"mediaAssetId\"%'
   UNION ALL SELECT 'late', COUNT(*) FROM answers WHERE id > $((ANSWERS_MAX - 50000)) AND id <= $ANSWERS_MAX AND json_value LIKE '%\"mediaAssetId\"%'"
fi
if [ -n "$SURVEYS_MAX" ] && [ "$SURVEYS_MAX" -gt 60000 ] 2>/dev/null; then
  MID=$((SURVEYS_MAX / 2))
  run_sql "surveys-density" "SELECT 'early' AS w, COUNT(*) AS matches FROM surveys WHERE id > 0 AND id <= 30000 AND (settings_json LIKE '%media/%' OR settings_json LIKE '%\"assetId\"%')
   UNION ALL SELECT 'mid', COUNT(*) FROM surveys WHERE id > $MID AND id <= $((MID + 30000)) AND (settings_json LIKE '%media/%' OR settings_json LIKE '%\"assetId\"%')
   UNION ALL SELECT 'late', COUNT(*) FROM surveys WHERE id > $((SURVEYS_MAX - 30000)) AND id <= $SURVEYS_MAX AND (settings_json LIKE '%media/%' OR settings_json LIKE '%\"assetId\"%')"
fi

# ---------- 第 5 组：REPRO——孤儿候选扫描（与维护任务逐字同形，LIMIT 1） ----------
run_sql "repro-orphan-candidates" "SELECT m.id FROM media_assets m
  WHERE m.created_at < '$ISO7'
    AND NOT EXISTS (SELECT 1 FROM question_media qm WHERE qm.media_asset_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM option_media om WHERE om.media_asset_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM answer_media am WHERE am.media_asset_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM visual_template_assets vta WHERE vta.asset_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM gallery_profile_media gpm WHERE gpm.media_asset_id = m.id OR gpm.source_asset_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM identity_profiles ip WHERE ip.front_asset_id = m.id OR ip.back_asset_id = m.id OR ip.background_asset_id = m.id OR ip.card_asset_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM image_generator_backgrounds igb WHERE igb.asset_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM image_generators ig WHERE ig.report_background_asset_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM surveys s WHERE s.cover_media_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM survey_responses r WHERE r.gallery_cover_source_asset_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM plaza_posts p WHERE p.image_asset_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM showcase_persons sp WHERE sp.background_media_id = m.id OR sp.illustration_media_id = m.id OR sp.avatar_media_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM showcase_items si WHERE si.cover_media_id = m.id OR si.media_asset_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM media_refs mr WHERE mr.asset_id = m.id)
  ORDER BY m.created_at ASC, m.id ASC
  LIMIT 1"

# ---------- 第 6 组：REPRO——answers JSON 扫描第一页（与维护任务逐字同形） ----------
run_sql "repro-answers-scan" "SELECT id, json_value FROM answers
  WHERE id > 0
    AND json_value IS NOT NULL
    AND json_value LIKE '%\"mediaAssetId\"%'
  ORDER BY id ASC
  LIMIT 2000"

echo "===== DONE ====="
