#!/usr/bin/env bash
# 只读 D1 诊断探针——定位 2026-11-16 维护告警（13,555,791 行读取）的元凶语句。
#
# 背景：主库探针已证明 telegram-survey-db 全库 ~26MB、最大表 6 万行，
# 13.5M 行不可能出自它；告警消息又不带部署标识（guard.ts 的已知缺陷），
# 所以本脚本按库名参数化，对 staging + 三个客户部署逐库取证。
#
# 纪律：所有查询必须有界，探针自身不允许成为新的额度事故：
#   - MAX(id) / sqlite_master 走 rowid 或系统表，O(1)；
#   - COUNT 一律套 LIMIT 上限（SELECT COUNT(*) FROM (... LIMIT 2000000)），
#     到顶即报告"≥ 上限"，不无界扫描；
#   - LIKE 密度采样按 rowid 窗口限量；
#   - 两条 REPRO 原样复现维护任务里仅有的两条"单语句无界"扫描，LIMIT 1 /
#     LIMIT 2000，用 meta.rows_read 读出真实计量成本。
# 免费档额度耗尽时所有查询都会失败，脚本识别该错误并直接给出档位结论。
# 结论落档后：本脚本与 .github/workflows/d1-diagnostic-probe.yml 一并删除。
set -uo pipefail

DB="${1:?用法: d1-diagnostic-probe.sh <database_name>}"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT

ISO7="$(date -u -d '7 days ago' '+%Y-%m-%dT%H:%M:%S')"
ISO180="$(date -u -d '180 days ago' '+%Y-%m-%dT%H:%M:%S')"

print_rows_read() { # file — 从 wrangler --json 输出提取每条语句的 meta.rows_read
  jq -r 'if type=="array" then (.[] | select(.meta) | "  rows_read=\(.meta.rows_read) writes=\(.meta.rows_written)") else (if .meta then "  rows_read=\(.meta.rows_read) writes=\(.meta.rows_written)" else empty end) end' "$1" 2>/dev/null
}

quota_or_auth_error() { # file — 额度耗尽 / 无权访问该库的特征
  grep -qiE "exceeded d1|daily row (read|write) limit|code: ?7500|authentication|not authorized|unauthorized" "$1"
}

run_sql() { # label, sql
  local label="$1"
  local sql="$2"
  local file="$DIR/$label.json"
  echo "===== PROBE $label ====="
  if pnpm exec wrangler d1 execute "$DB" --remote --command "$sql" --json >"$file" 2>"$DIR/$label.err"; then
    cat "$file"
    echo
    print_rows_read "$file"
  else
    echo "[FAILED] $label —— stderr:"
    cat "$DIR/$label.err"
    echo "--- stdout（wrangler 失败时错误也可能落在 stdout）:"
    cat "$file"
    echo
    # 额度耗尽 / 无权访问：立刻停，不再烧任何探针。
    if quota_or_auth_error "$DIR/$label.err" || quota_or_auth_error "$file"; then
      echo "!!! 检测到额度/权限错误，本库探针提前停止（上面的报错即结论）。"
      exit 0
    fi
  fi
  echo
}

# ---------- 第 1 组：表规模上界（全部 O(1)；逐表独立，缺表不影响其余） ----------
for T in answers surveys audit_logs survey_responses media_assets telegram_update_dedup rate_limits media_refs export_jobs render_jobs image_generator_jobs notes plaza_posts; do
  run_sql "max-$T" "SELECT MAX(id) AS max_id FROM $T"
done

# wrangler --json 单语句输出形如 [ {results, meta} ]，取第一个结果集的 max_id。
ANSWERS_MAX="$(jq -r 'if type=="array" then (.[0].results[0].max_id // empty) else (.results[0].max_id // empty) end' "$DIR/max-answers.json" 2>/dev/null | head -1)"
SURVEYS_MAX="$(jq -r 'if type=="array" then (.[0].results[0].max_id // empty) else (.results[0].max_id // empty) end' "$DIR/max-surveys.json" 2>/dev/null | head -1)"

# ---------- 第 2 组：retention 索引审计（客户库可能没跑全迁移——正是
# 2026-09-14 事故的形态：代码先上线、索引没跟上，retention DELETE 全表扫描） ----------
run_sql "index-audit" "SELECT name FROM sqlite_master WHERE type='index' AND name IN (
  'idx_responses_status_updated','idx_responses_status_started','idx_responses_started_at',
  'idx_audit_logs_created_at','idx_rate_limits_window_start','idx_telegram_update_dedup_received_at',
  'idx_export_jobs_retention','idx_export_jobs_status_created','idx_render_jobs_retention',
  'idx_notes_pool','idx_surveys_deleted_at','idx_showcase_persons_deleted_at','idx_showcase_items_deleted_at',
  'idx_plaza_posts_deleted_at','idx_report_templates_deleted_at','idx_media_assets_scope',
  'idx_media_assets_created_at','idx_media_refs_asset','idx_image_generator_jobs_report_result',
  'idx_image_generator_jobs_generator','idx_render_jobs_template','idx_image_generators_template',
  'idx_report_deliveries_status','idx_surveys_status') ORDER BY name"

# ---------- 第 3 组：嫌疑 A 的规模——7 天前的媒体行数（候选扫描每天必读的量，上限 2M） ----------
run_sql "media-old-count" "SELECT COUNT(*) AS media_older_than_7d_capped FROM (SELECT 1 FROM media_assets WHERE created_at < '$ISO7' LIMIT 2000000)"

# ---------- 第 4 组：嫌疑 C 的规模——audit_logs 180 天保留段（上限 2M） ----------
run_sql "audit-old-count" "SELECT COUNT(*) AS audit_before_180d_capped FROM (SELECT 1 FROM audit_logs WHERE created_at < '$ISO180' LIMIT 2000000)"

# ---------- 第 5 组：answers / surveys 的 LIKE 密度采样（rowid 窗口，各 ≤5 万行） ----------
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

# ---------- 第 6 组：REPRO——孤儿候选扫描（与维护任务逐字同形，LIMIT 1） ----------
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

# ---------- 第 7 组：REPRO——answers JSON 扫描第一页（与维护任务逐字同形） ----------
run_sql "repro-answers-scan" "SELECT id, json_value FROM answers
  WHERE id > 0
    AND json_value IS NOT NULL
    AND json_value LIKE '%\"mediaAssetId\"%'
  ORDER BY id ASC
  LIMIT 2000"

echo "===== DONE $DB ====="
