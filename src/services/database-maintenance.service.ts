import { telegramUpdateDedupCutoff } from "./update-dedup.service";
import { loadSweepCursor, saveLastMaintenanceHealth, saveSweepCursor } from "./maintenance-state.service";
import { upsertMediaRef } from "../db/repositories/media.repository";
import { parseMediaRef } from "../survey/media-ref";

export interface DatabaseMaintenanceSummary {
  expiredResponses: number;
  /** 0089 纸条聊天：到期自动下架的纸条数。 */
  expiredNotes: number;
  expiredSurveyDrafts: number;
  expiredDeletedSurveys: number;
  expiredDeletedShowcasePeople: number;
  expiredDeletedShowcaseItems: number;
  expiredDeletedPlazaPosts: number;
  expiredDeletedReportTemplates: number;
  expiredTemplateDrafts: number;
  expiredGeneratorDrafts: number;
  expiredPreviewAssets: number;
  expiredGeneratedAssets: number;
  orphanAssets: number;
  /** 0091：本次同步进 media_refs 的弱引用登记行数。 */
  mediaRefsSynced: number;
  expiredRenderJobs: number;
  expiredGeneratorJobs: number;
  expiredReportResults: number;
  expiredExportJobs: number;
  /** 0097：卡死在 sending 的导出任务被回收为终态的行数（已记账补 completed + 未记账置 failed）。 */
  reclaimedSendingExportJobs: number;
  expiredAuditLogs: number;
  expiredTelegramDedupRows: number;
  expiredRateLimitRows: number;
  /** Rows this run read, as metered by D1. The free tier allows 5,000,000/day. */
  rowsRead: number;
  /** True when the run stopped early to stay inside MAINTENANCE_ROWS_READ_BUDGET. */
  truncated: boolean;
  /**
   * True when the run did nothing at all because required indexes could not be
   * ensured (schema drift)。清理完全停摆，比截断更严重——cron 会因此给管理员
   * 发单独的 DM（truncated 保持 false，两路告警互不吞）。
   */
  parked: boolean;
  /** parked 时的缺失索引清单（其余情况为空数组），供停车 DM 直出原因。 */
  parkedMissingIndexes: string[];
}

const DAY = 86_400_000;

/** 零值汇总——索引自愈失败停车时返回它（与正常路径的字段形状完全一致）。 */
const EMPTY_MAINTENANCE_SUMMARY: DatabaseMaintenanceSummary = {
  expiredResponses: 0,
  expiredNotes: 0,
  expiredSurveyDrafts: 0,
  expiredDeletedSurveys: 0,
  expiredDeletedShowcasePeople: 0,
  expiredDeletedShowcaseItems: 0,
  expiredDeletedPlazaPosts: 0,
  expiredDeletedReportTemplates: 0,
  expiredTemplateDrafts: 0,
  expiredGeneratorDrafts: 0,
  expiredPreviewAssets: 0,
  expiredGeneratedAssets: 0,
  orphanAssets: 0,
  mediaRefsSynced: 0,
  expiredRenderJobs: 0,
  expiredGeneratorJobs: 0,
  expiredReportResults: 0,
  expiredExportJobs: 0,
  reclaimedSendingExportJobs: 0,
  expiredAuditLogs: 0,
  expiredTelegramDedupRows: 0,
  expiredRateLimitRows: 0,
  rowsRead: 0,
  truncated: false,
  parked: false,
  parkedMissingIndexes: [],
};

/**
 * export_jobs 卡死 sending 的回收阈值（0097）：与 result-visual /
 * image-generator 恢复服务的 staleProcessingMs（30 分钟）同口径。sending 的
 * 健康窗口只有文件上传 + 记账 batch 的秒级；阈值太短会误杀正在发送的行，
 * 太长则卡死行白占表。见 runDatabaseMaintenance 内的回收步骤注释。
 */
const STALE_SENDING_MS = 30 * 60_000;

/**
 * How many orphan media rows a single daily run may delete. The sweep is
 * idempotent, so a backlog simply drains over the following days instead of
 * turning one run into an unbounded scan.
 */
const ORPHAN_MEDIA_BATCH_SIZE = 100;

/**
 * 孤儿清扫批量化（B8）的单语句 IN 分块尺寸：候选批 ≤ 100 行，绑定参数上限
 * 100 留余量（media.repository.ts 的 MEDIA_ID_BATCH_SIZE 同款口径）。
 */
const ORPHAN_MEDIA_CHUNK_SIZE = 90;

/**
 * Ceiling for a single daily maintenance run.
 *
 * D1 meters the free tier at 5,000,000 rows read per day for the whole
 * account, shared with every bot update, dashboard request and survey answer.
 * A run that suddenly reads millions does not just fail by itself, it takes
 * the whole product down until midnight UTC. Two things now stand between the
 * account and that: the read-path indexes, and this budget — anything above it
 * is a bug to fix, not work to finish. Every step is idempotent, so stopping
 * between steps only pauses the cleanup; the next daily run resumes it.
 */
export const MAINTENANCE_ROWS_READ_BUDGET = 500_000;

interface ReadBudget {
  rowsRead: number;
  exceeded: boolean;
}

function recordRowsRead(result: { meta?: { rows_read?: number } } | null, budget: ReadBudget): void {
  budget.rowsRead += Number(result?.meta?.rows_read ?? 0);
  if (budget.rowsRead > MAINTENANCE_ROWS_READ_BUDGET) budget.exceeded = true;
}

/**
 * Wraps a D1 binding so every statement the maintenance run issues feeds the
 * read budget. D1 already reports the cost per statement in `meta.rows_read` —
 * the same number the daily quota is metered on — so no extra queries are
 * needed to know how expensive a run is.
 */
function withReadBudget(db: D1Database, budget: ReadBudget): D1Database {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    ({
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      run: async <T = Record<string, unknown>>() => {
        const result = await statement.run<T>();
        recordRowsRead(result, budget);
        return result;
      },
      all: async <T = Record<string, unknown>>() => {
        const result = await statement.all<T>();
        recordRowsRead(result, budget);
        return result;
      },
      first: (column?: string) => (column === undefined ? statement.first() : statement.first(column)),
      raw: (...args: unknown[]) => (statement.raw as (...callArgs: unknown[]) => Promise<unknown[]>)(...args),
    }) as unknown as D1PreparedStatement;

  return {
    prepare: (query: string) => wrap(db.prepare(query)),
    batch: async (statements: D1PreparedStatement[]) => {
      const results = await db.batch(statements);
      for (const result of results) recordRowsRead(result, budget);
      return results;
    },
    exec: (query: string) => db.exec(query),
  } as unknown as D1Database;
}

/**
 * Retention indexes every step in this file depends on, using the exact SQL
 * from their canonical migrations (0020 / 0052 / 0055 / 0074 / 0089 / 0091 /
 * 0017 / 0004).
 *
 * The 2026-11-16 alert (13,555,791 rows read against the 500K budget) proved
 * the deploy-order lesson of 2026-09-14 generalizes: a run can reach
 * production before its migration does, and ONE unindexed retention DELETE
 * then full-scans a whole table every day. Until now only the orphan sweep
 * self-ensured its indexes; a missing idx_responses_status_updated or
 * idx_audit_logs_created_at silently turned that step into a full scan. The
 * maintenance job now guarantees every index it depends on before running.
 */
export const RETENTION_INDEXES = [
  // 0020_maintenance_and_template_assets.sql
  {
    name: "idx_render_jobs_retention",
    create: "CREATE INDEX IF NOT EXISTS idx_render_jobs_retention ON render_jobs(status, completed_at, created_at)",
  },
  {
    name: "idx_image_generator_jobs_retention",
    create:
      "CREATE INDEX IF NOT EXISTS idx_image_generator_jobs_retention ON image_generator_jobs(status, completed_at, created_at)",
  },
  {
    name: "idx_export_jobs_retention",
    create: "CREATE INDEX IF NOT EXISTS idx_export_jobs_retention ON export_jobs(status, completed_at, created_at)",
  },
  {
    name: "idx_surveys_draft_retention",
    create: "CREATE INDEX IF NOT EXISTS idx_surveys_draft_retention ON surveys(status, updated_at)",
  },
  {
    name: "idx_visual_templates_draft_retention",
    create: "CREATE INDEX IF NOT EXISTS idx_visual_templates_draft_retention ON visual_templates(status, updated_at)",
  },
  {
    name: "idx_image_generators_draft_retention",
    create: "CREATE INDEX IF NOT EXISTS idx_image_generators_draft_retention ON image_generators(status, updated_at)",
  },
  {
    name: "idx_report_results_retention",
    create: "CREATE INDEX IF NOT EXISTS idx_report_results_retention ON report_results(created_at, id)",
  },
  // 0055_audit_indexes.sql
  {
    name: "idx_responses_status_updated",
    create: "CREATE INDEX IF NOT EXISTS idx_responses_status_updated ON survey_responses(status, updated_at)",
  },
  {
    name: "idx_audit_logs_created_at",
    create: "CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at)",
  },
  {
    name: "idx_image_generator_jobs_report_result",
    create:
      "CREATE INDEX IF NOT EXISTS idx_image_generator_jobs_report_result ON image_generator_jobs(report_result_id)",
  },
  {
    name: "idx_image_generator_jobs_generator",
    create: "CREATE INDEX IF NOT EXISTS idx_image_generator_jobs_generator ON image_generator_jobs(generator_id)",
  },
  {
    name: "idx_render_jobs_template",
    create: "CREATE INDEX IF NOT EXISTS idx_render_jobs_template ON render_jobs(template_id)",
  },
  {
    name: "idx_image_generators_template",
    create: "CREATE INDEX IF NOT EXISTS idx_image_generators_template ON image_generators(template_id)",
  },
  // 0052_telegram_idempotency_and_query_indexes.sql
  {
    name: "idx_telegram_update_dedup_received_at",
    create: "CREATE INDEX IF NOT EXISTS idx_telegram_update_dedup_received_at ON telegram_update_dedup(received_at)",
  },
  {
    name: "idx_rate_limits_window_start",
    create: "CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start ON rate_limits(window_start)",
  },
  // 0074_soft_delete.sql（partial index，逐字取自迁移）
  {
    name: "idx_surveys_deleted_at",
    create: "CREATE INDEX IF NOT EXISTS idx_surveys_deleted_at ON surveys(deleted_at, id) WHERE deleted_at IS NOT NULL",
  },
  {
    name: "idx_showcase_persons_deleted_at",
    create:
      "CREATE INDEX IF NOT EXISTS idx_showcase_persons_deleted_at ON showcase_persons(deleted_at, id) WHERE deleted_at IS NOT NULL",
  },
  {
    name: "idx_showcase_items_deleted_at",
    create:
      "CREATE INDEX IF NOT EXISTS idx_showcase_items_deleted_at ON showcase_items(deleted_at, id) WHERE deleted_at IS NOT NULL",
  },
  {
    name: "idx_plaza_posts_deleted_at",
    create:
      "CREATE INDEX IF NOT EXISTS idx_plaza_posts_deleted_at ON plaza_posts(deleted_at, id) WHERE deleted_at IS NOT NULL",
  },
  {
    name: "idx_report_templates_deleted_at",
    create:
      "CREATE INDEX IF NOT EXISTS idx_report_templates_deleted_at ON report_templates(deleted_at, id) WHERE deleted_at IS NOT NULL",
  },
  // 0089_note_chat.sql
  {
    name: "idx_notes_pool",
    create: "CREATE INDEX IF NOT EXISTS idx_notes_pool ON notes(status, expires_at, id)",
  },
  // 0091_media_library.sql
  {
    name: "idx_media_refs_asset",
    create: "CREATE INDEX IF NOT EXISTS idx_media_refs_asset ON media_refs(asset_id)",
  },
  // 0017_media_asset_scopes.sql
  {
    name: "idx_media_assets_scope",
    create: "CREATE INDEX IF NOT EXISTS idx_media_assets_scope ON media_assets(asset_scope, id)",
  },
  // 0004_responses_answers.sql
  {
    name: "idx_responses_survey_id",
    create: "CREATE INDEX IF NOT EXISTS idx_responses_survey_id ON survey_responses(survey_id)",
  },
] as const;

/**
 * Read-path indexes the sweep needs, using the exact SQL from migration 0051.
 *
 * The migration stays the canonical record, but a deploy can reach production
 * before the migration does — that is exactly what happened on 2026-09-14,
 * when the sweep ran against unindexed columns and read enough rows to exhaust
 * the account's daily D1 budget for everyone. Rather than trusting the deploy
 * and migration to arrive in the right order, the maintenance job now
 * guarantees its own prerequisite: create what is missing, then sweep. If the
 * indexes cannot be created, the sweep stays parked instead of repeating the
 * outage, and the next daily run tries again.
 */
export const ORPHAN_SWEEP_INDEXES = [
  {
    name: "idx_media_assets_created_at",
    create: "CREATE INDEX IF NOT EXISTS idx_media_assets_created_at ON media_assets(created_at, id)",
  },
  {
    name: "idx_gallery_profile_media_asset",
    create: "CREATE INDEX IF NOT EXISTS idx_gallery_profile_media_asset ON gallery_profile_media(media_asset_id)",
  },
  {
    name: "idx_gallery_profile_media_source_asset",
    create:
      "CREATE INDEX IF NOT EXISTS idx_gallery_profile_media_source_asset ON gallery_profile_media(source_asset_id)",
  },
  {
    name: "idx_identity_profiles_front_asset",
    create: "CREATE INDEX IF NOT EXISTS idx_identity_profiles_front_asset ON identity_profiles(front_asset_id)",
  },
  {
    name: "idx_identity_profiles_back_asset",
    create: "CREATE INDEX IF NOT EXISTS idx_identity_profiles_back_asset ON identity_profiles(back_asset_id)",
  },
  {
    name: "idx_identity_profiles_background_asset",
    create:
      "CREATE INDEX IF NOT EXISTS idx_identity_profiles_background_asset ON identity_profiles(background_asset_id)",
  },
  {
    name: "idx_identity_profiles_card_asset",
    create: "CREATE INDEX IF NOT EXISTS idx_identity_profiles_card_asset ON identity_profiles(card_asset_id)",
  },
  {
    name: "idx_image_generator_backgrounds_asset",
    create: "CREATE INDEX IF NOT EXISTS idx_image_generator_backgrounds_asset ON image_generator_backgrounds(asset_id)",
  },
  {
    name: "idx_image_generators_report_background_asset",
    create:
      "CREATE INDEX IF NOT EXISTS idx_image_generators_report_background_asset ON image_generators(report_background_asset_id)",
  },
  {
    name: "idx_survey_responses_gallery_cover_source",
    create:
      "CREATE INDEX IF NOT EXISTS idx_survey_responses_gallery_cover_source ON survey_responses(gallery_cover_source_asset_id)",
  },
  {
    name: "idx_surveys_cover_media",
    create: "CREATE INDEX IF NOT EXISTS idx_surveys_cover_media ON surveys(cover_media_id)",
  },
  // 树洞配图与展示区图片只被这两处引用。漏掉它们时，7 天前的图会被当成孤儿删掉
  // （行 + KV 字节），帖子/展示页就此变成破图。
  {
    name: "idx_plaza_posts_image_asset",
    create: "CREATE INDEX IF NOT EXISTS idx_plaza_posts_image_asset ON plaza_posts(image_asset_id)",
  },
  {
    name: "idx_showcase_persons_illustration_asset",
    create:
      "CREATE INDEX IF NOT EXISTS idx_showcase_persons_illustration_asset ON showcase_persons(illustration_media_id)",
  },
  {
    name: "idx_showcase_items_cover_asset",
    create: "CREATE INDEX IF NOT EXISTS idx_showcase_items_cover_asset ON showcase_items(cover_media_id)",
  },
  {
    name: "idx_showcase_items_media_asset",
    create: "CREATE INDEX IF NOT EXISTS idx_showcase_items_media_asset ON showcase_items(media_asset_id)",
  },

  // 0107_media_refs_ref_index.sql（2026-11-22 读预算告警收口）：syncWeakMediaRefs
  // 对每个含媒体引用的问卷跑 ref_key LIKE 'survey:{id}:%' 的 DELETE，此前
  // media_refs 无 ref_type/ref_key 索引 → 每问卷一次全表扫，读放大
  // = 问卷数 × 引用行数（单轮实测 9.7M）。部署先于迁移到达时自愈建索引。
  {
    name: "idx_media_refs_ref",
    create: "CREATE INDEX IF NOT EXISTS idx_media_refs_ref ON media_refs(ref_type, ref_key)",
  },
] as const;

/** 本次维护全部前置索引（retention 步骤 + 孤儿清扫），run 开始前统一自愈。 */
export const MAINTENANCE_INDEXES = [...RETENTION_INDEXES, ...ORPHAN_SWEEP_INDEXES] as Array<
  (typeof RETENTION_INDEXES)[number] | (typeof ORPHAN_SWEEP_INDEXES)[number]
>;

async function missingMaintenanceIndexes(db: D1Database): Promise<string[]> {
  const names = MAINTENANCE_INDEXES.map((index) => index.name);
  const placeholders = names.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${placeholders})`)
    .bind(...names)
    .all<{ name: string }>();
  const found = new Set((result.results ?? []).map((row) => row.name));
  return names.filter((name) => !found.has(name));
}

/**
 * Ensure every index this run depends on. Returns the indexes still missing on
 * a hard failure (schema drift: a column is missing, or a non-"no such table"
 * error) — that is when running would full-scan, so the whole run parks and
 * the next daily run retries; the caller turns the list into the admin DM.
 * An index whose TABLE is absent (a migration that has not been applied yet,
 * e.g. telegram_update_dedup before 0052) is tolerated: the matching step has
 * its own try/catch and skips itself.
 */
async function ensureMaintenanceIndexes(db: D1Database): Promise<string[]> {
  const empty: string[] = [];
  try {
    const missing = await missingMaintenanceIndexes(db);
    if (missing.length === 0) return empty;
    console.info("Creating maintenance indexes that are missing", { missing });
    const uncreateable = new Set<string>();
    for (const index of MAINTENANCE_INDEXES) {
      if (!missing.includes(index.name)) continue;
      try {
        await db.prepare(index.create).run();
      } catch (error) {
        if (/no such table/i.test(String(error))) {
          console.warn("Maintenance index skipped: its table is missing (migration not applied yet)", {
            index: index.name,
          });
          uncreateable.add(index.name);
          continue;
        }
        uncreateable.add(index.name);
        console.warn("Failed to create maintenance index", { index: index.name, error: String(error) });
      }
    }
    const stillMissing = (await missingMaintenanceIndexes(db)).filter((name) => !uncreateable.has(name));
    if (stillMissing.length > 0) {
      console.warn("Maintenance stays parked: required indexes are still missing", { stillMissing });
      return stillMissing;
    }
    return empty;
  } catch (error) {
    console.warn("Maintenance stays parked: could not ensure indexes", error);
    return ["<ensure failed>"];
  }
}

function cutoff(days: number, now: number): string {
  return new Date(now - days * DAY).toISOString();
}

async function changes(statement: D1PreparedStatement): Promise<number> {
  const result = await statement.run();
  return result.meta?.changes ?? 0;
}

function collectIds(matches: Iterable<RegExpMatchArray | null>): Set<number> {
  const ids = new Set<number>();
  for (const match of matches) {
    if (!match) continue;
    const id = Number(match[1] ?? match[0]);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

function tryParseJson(raw: string | null | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 结构化媒体引用（`{"assetId": n}`）提取——媒体结构化的双读过渡（阶段 D）：
 * URL 字符串仍由 `/media\/(\d+)/` 正则兜底，这里只补对象形态。裸数字不收
 * （settings 里的普通数值字段歧义太大，宁可少收——过收会挡住合法删除，
 * 漏收的兜底是孤儿清扫前的正则与 media_refs 重建）。
 */
function collectStructuredAssetIds(value: unknown, ids: Set<number>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredAssetIds(item, ids);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("assetId" in record) {
      const id = parseMediaRef(record);
      if (id !== null) ids.add(id);
    }
    for (const child of Object.values(record)) collectStructuredAssetIds(child, ids);
  }
}

/** settings_json 的媒体引用提取（双读）：URL 字符串 + 结构化 `{assetId}`。 */
function collectSurveySettingsMediaIds(raw: string | null): Set<number> {
  const ids = collectIds(raw?.matchAll(/media\/(\d+)/g) ?? []);
  collectStructuredAssetIds(tryParseJson(raw), ids);
  return ids;
}

/**
 * Fixed rowid windows for the JSON scans.
 *
 * 旧实现按「命中行」翻页（`id > lastId AND LIKE ... LIMIT 2000`）：页与页之
 * 间的扫描跨度取决于命中的稀疏程度——命中稀疏时，一条语句就能从头扫到表尾，
 * 读预算只能在语句结束后才生效，13,555,791 行的告警正属于这个量级。改为按
 * rowid 固定窗口分页后，每条语句的读取上限恒为 JSON_SCAN_WINDOW_ROWS 行，
 * 读预算在窗口之间可以真正拦住扫描。
 */
const JSON_SCAN_WINDOW_ROWS = 20_000;

/** MAX(id) 走 rowid，O(1)。经 withReadBudget 包装，会计入预算。 */
async function maxRowId(db: D1Database, table: string): Promise<number> {
  const result = await db.prepare(`SELECT MAX(id) AS max_id FROM ${table}`).all<{ max_id: number | null }>();
  return Number(result.results?.[0]?.max_id ?? 0);
}

/**
 * Bounded windowed scan over a JSON column. `table` / `column` / `likeFilter`
 * are internal constants only (never user input) — identifiers cannot be
 * bound, so they are interpolated here deliberately.
 *
 * Returns `completed: false` when the read budget stopped the scan midway.
 * Callers MUST treat a partial result as unsafe for deletion: media referenced
 * in unscanned rows would be misjudged as orphaned (see deleteOrphanMediaAssets).
 */
async function scanJsonRows(
  db: D1Database,
  table: string,
  column: string,
  likeFilter: string,
  shouldStop: () => boolean,
  onRow: (row: { id: number; value: string | null }) => void | Promise<void>,
  // 2026-11-22 读预算收口：窗口查询此前走裸 .all()，每次最多读
  // JSON_SCAN_WINDOW_ROWS(20K) 行却不计入预算——answers 全表的 LIKE 过滤扫描
  // 真实读取远超 summary.rowsRead（告警口径只含已记账部分）。现在计入预算，
  // 窗口间照常 shouldStop，超预算即停。放在收尾可选位。
  budget?: ReadBudget,
): Promise<{ completed: boolean }> {
  const maxId = await maxRowId(db, table);
  let windowStart = 0;
  while (windowStart < maxId && !shouldStop()) {
    const windowEnd = Math.min(windowStart + JSON_SCAN_WINDOW_ROWS, maxId);
    const result = await db
      .prepare(
        `SELECT id, ${column} AS value FROM ${table}
          WHERE id > ? AND id <= ?
            AND ${column} IS NOT NULL
            AND ${likeFilter}`,
      )
      .bind(windowStart, windowEnd)
      .all<{ id: number; value: string | null }>();
    if (budget) recordRowsRead(result, budget);
    for (const row of result.results ?? []) {
      await onRow(row);
    }
    windowStart = windowEnd;
  }
  return { completed: windowStart >= maxId };
}

/**
 * Media ids that answers still reference inside their JSON payload.
 * `answers.json_value` has always been written as `{"mediaAssetId": N}`; the
 * regex also catches older or nested spellings so the scan stays strictly
 * safer than the per-row LIKE probes it replaces.
 */
async function loadAnswerJsonMediaIds(
  db: D1Database,
  shouldStop: () => boolean,
  budget?: ReadBudget,
): Promise<{
  ids: Set<number>;
  completed: boolean;
}> {
  const ids = new Set<number>();
  const { completed } = await scanJsonRows(
    db,
    "answers",
    "json_value",
    `json_value LIKE '%"mediaAssetId"%'`,
    shouldStop,
    (row) => {
      for (const id of collectIds(String(row.value ?? "").matchAll(/"mediaAssetId"\s*:\s*(\d+)/g) ?? [])) {
        ids.add(id);
      }
    },
    budget,
  );
  return { ids, completed };
}

/** Media ids embedded in survey settings (URL strings and structured `{"assetId":n}`). */
async function loadSurveySettingsMediaIds(
  db: D1Database,
  shouldStop: () => boolean,
  budget?: ReadBudget,
): Promise<{
  ids: Set<number>;
  completed: boolean;
}> {
  const ids = new Set<number>();
  const { completed } = await scanJsonRows(
    db,
    "surveys",
    "settings_json",
    `(settings_json LIKE '%media/%' OR settings_json LIKE '%"assetId"%')`,
    shouldStop,
    (row) => {
      // Dual-read transition (阶段 D): the regex matches both `/api/survey/media/12`
      // and relative `media/12` spellings; collectSurveySettingsMediaIds adds the
      // structured `{"assetId":n}` objects. Over-matching only keeps a row alive,
      // which is the safe direction.
      for (const id of collectSurveySettingsMediaIds(row.value ?? null)) {
        ids.add(id);
      }
    },
    budget,
  );
  return { ids, completed };
}

/**
 * Candidate orphan media rows, bounded twice over.
 *
 * The original implementation asked SQLite to evaluate fifteen `NOT EXISTS`
 * probes for every media row in one statement. Since several referencing
 * columns were unindexed, that meant repeated full table scans: a single run
 * read ~5.3M rows and burned the entire daily D1 rows-read budget on
 * 2026-09-14. The probes are all indexed now, but the statement itself still
 * had no upper bound on rows scanned — on a database with hundreds of
 * thousands of old media rows it re-probes every one of them, daily, and the
 * read budget cannot stop a single statement. The scan therefore walks
 * fixed-width rowid windows (each capped at ORPHAN_CANDIDATE_WINDOW_ROWS
 * rows plus their probes), and the read budget cuts it off between windows.
 *
 * Ordering is `id ASC` (≈ creation order) instead of `created_at ASC`: the
 * id-window predicate is what bounds each statement, and drain order within
 * a daily batch of 100 rows is not load-bearing.
 */
const ORPHAN_CANDIDATE_WINDOW_ROWS = 5_000;

async function findOrphanMediaCandidates(
  db: D1Database,
  before: string,
  shouldStop: () => boolean,
  initialWindowStart = 0,
): Promise<{ ids: number[]; completed: boolean; nextWindowStart: number }> {
  const maxId = await maxRowId(db, "media_assets");
  // 游标越过表尾（表收缩过/游标过期）时从头扫，避免永久跳过前缀。
  const start = initialWindowStart > 0 && initialWindowStart < maxId ? initialWindowStart : 0;
  const ids = new Set<number>();
  let windowStart = start;
  while (ids.size < ORPHAN_MEDIA_BATCH_SIZE && windowStart < maxId && !shouldStop()) {
    const windowEnd = Math.min(windowStart + ORPHAN_CANDIDATE_WINDOW_ROWS, maxId);
    const result = await db
      .prepare(
        `SELECT m.id
         FROM media_assets m
        WHERE m.id > ? AND m.id <= ?
          AND m.created_at < ?
          AND NOT EXISTS (SELECT 1 FROM question_media qm WHERE qm.media_asset_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM option_media om WHERE om.media_asset_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM answer_media am WHERE am.media_asset_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM visual_template_assets vta WHERE vta.asset_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM gallery_profile_media gpm
                           WHERE gpm.media_asset_id = m.id OR gpm.source_asset_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM identity_profiles ip
                           WHERE ip.front_asset_id = m.id
                              OR ip.back_asset_id = m.id
                              OR ip.background_asset_id = m.id
                              OR ip.card_asset_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM image_generator_backgrounds igb WHERE igb.asset_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM image_generators ig WHERE ig.report_background_asset_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM surveys s WHERE s.cover_media_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM survey_responses r WHERE r.gallery_cover_source_asset_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM plaza_posts p WHERE p.image_asset_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM showcase_persons sp
                           WHERE sp.background_media_id = m.id
                              OR sp.illustration_media_id = m.id
                              OR sp.avatar_media_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM showcase_items si
                           WHERE si.cover_media_id = m.id OR si.media_asset_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM media_refs mr WHERE mr.asset_id = m.id)
        ORDER BY m.id ASC
        LIMIT ?`,
      )
      .bind(windowStart, windowEnd, before, ORPHAN_MEDIA_BATCH_SIZE - ids.size)
      .all<{ id: number }>();
    for (const row of result.results ?? []) {
      const id = Number(row.id);
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
    windowStart = windowEnd;
  }
  return { ids: [...ids], completed: windowStart >= maxId, nextWindowStart: windowStart };
}

/**
 * 孤儿素材回收（0091 起同时回收 blob）。
 *
 * 之前只删 media_assets 行：历史行都带 KV TTL 兜底，blob 会自己过期。内容
 * 寻址 blob（media:blob:<sha256>，无 TTL）打破了这个前提——行删了 blob 会
 * 永久留在 R2。所以删行前先记下 storage_key，删完后若已无任何 asset 行指向
 * 同一个 key（去重后的共享 blob 可能仍被别的行引用），才删对象本身。
 */
async function deleteOrphanMediaAssets(
  db: D1Database,
  before: string,
  shouldStop: () => boolean,
  store: OrphanBlobStore | null,
  initialWindowStart = 0,
  budget?: ReadBudget,
): Promise<{ deleted: number; scansComplete: boolean; candidateCompleted: boolean; nextWindowStart: number }> {
  // 预算已耗尽（前面步骤烧完）时直接停：候选扫描与两道 JSON 保护扫描都不可
  // 靠，本步什么都不删；游标保持原值，下一轮从同一位置继续。
  if (shouldStop()) {
    return { deleted: 0, scansComplete: false, candidateCompleted: false, nextWindowStart: initialWindowStart };
  }
  const candidates = await findOrphanMediaCandidates(db, before, shouldStop, initialWindowStart);
  if (candidates.ids.length === 0) {
    return {
      deleted: 0,
      scansComplete: candidates.completed,
      candidateCompleted: candidates.completed,
      nextWindowStart: candidates.nextWindowStart,
    };
  }
  const answerScan = await loadAnswerJsonMediaIds(db, shouldStop, budget);
  const settingsScan = await loadSurveySettingsMediaIds(db, shouldStop, budget);
  const scansComplete = candidates.completed && answerScan.completed && settingsScan.completed;
  if (!scansComplete) {
    // 修复 2026-11-16 发现的数据丢失窗口：旧实现在预算耗尽后仍会拿「不完整的
    // 引用集合」去删候选——答案 JSON 里还引用着的素材会被误当孤儿删掉。扫描
    // 不完整 = 本轮不删，清扫是幂等的，下一个完整运行会接着做。
    console.warn("Orphan sweep skipped: a protective scan was truncated by the read budget", {
      candidates: candidates.ids.length,
    });
    return {
      deleted: 0,
      scansComplete: false,
      candidateCompleted: candidates.completed,
      nextWindowStart: candidates.nextWindowStart,
    };
  }
  const referencedInJson = new Set<number>([...answerScan.ids, ...settingsScan.ids]);
  // JSON 保护扫描之外的候选才是本次要删的集合（≤ ORPHAN_MEDIA_BATCH_SIZE 行）。
  const doomedIds = candidates.ids.filter((id) => !referencedInJson.has(id));
  // B8 批量化（审计 N+1 清单 database-maintenance.service.ts:410）：旧实现每
  // 候选 3 次往返（SELECT storage_key → DELETE → 复用检查）。现在三步集合化
  // （键预取 → IN 批删 → IN 复用检查），按 90/批分块（D1 单语句绑定参数上限
  // 100，media.repository.ts 的 MEDIA_ID_BATCH_SIZE 同款口径）。IN 列表本身
  // 以候选批为上界，批量化不改变「单轮至多删 ORPHAN_MEDIA_BATCH_SIZE 行」的
  // 预算语义。全部走 .run/.all（withReadBudget 记账），旧行里的 .first() 探针
  // 是不计账的——批量化顺带把记账补齐。
  //
  // 时序语义差异（与审计第六节的批量化方案一致）：复用检查从「删完本行立刻
  // 查」变为「本批删完后统一查」——对共享 storage_key（media:blob:<sha256>
  // 内容寻址去重）的多候选行，两种时序的终态相同：整批删完仍有行引用的键
  // 保留 blob，无人引用的键删对象。并发窗口内被第三者抢先删掉的候选行，其
  // 键若已无引用，本批也会 store.delete 一次——对象可能已被删除，catch 吞掉
  // 即可（与逐行版 best-effort 相同）；键仍有引用则照常保留，复用保护不变。
  const keysByDoomedId = new Map<number, string>();
  if (store && doomedIds.length > 0) {
    for (let start = 0; start < doomedIds.length; start += ORPHAN_MEDIA_CHUNK_SIZE) {
      const ids = doomedIds.slice(start, start + ORPHAN_MEDIA_CHUNK_SIZE);
      const keyRows = await db
        .prepare(`SELECT id, storage_key storageKey FROM media_assets WHERE id IN (${ids.map(() => "?").join(", ")})`)
        .bind(...ids)
        .all<{ id: number; storageKey: string | null }>();
      for (const row of keyRows.results ?? []) {
        if (row.storageKey) keysByDoomedId.set(Number(row.id), row.storageKey);
      }
    }
  }
  let deleted = 0;
  for (let start = 0; start < doomedIds.length; start += ORPHAN_MEDIA_CHUNK_SIZE) {
    const ids = doomedIds.slice(start, start + ORPHAN_MEDIA_CHUNK_SIZE);
    deleted += await changes(
      db.prepare(`DELETE FROM media_assets WHERE id IN (${ids.map(() => "?").join(", ")})`).bind(...ids),
    );
  }
  if (store && keysByDoomedId.size > 0) {
    // 删行之后再查复用：键仍被任何 asset 行引用（别的候选/非候选行）就保留。
    const keys = [...new Set(keysByDoomedId.values())];
    const stillUsed = new Set<string>();
    for (let start = 0; start < keys.length; start += ORPHAN_MEDIA_CHUNK_SIZE) {
      const chunk = keys.slice(start, start + ORPHAN_MEDIA_CHUNK_SIZE);
      const usedRows = await db
        .prepare(
          `SELECT DISTINCT storage_key storageKey FROM media_assets WHERE storage_key IN (${chunk.map(() => "?").join(", ")})`,
        )
        .bind(...chunk)
        .all<{ storageKey: string }>();
      for (const row of usedRows.results ?? []) stillUsed.add(row.storageKey);
    }
    for (const key of keys) {
      if (!stillUsed.has(key)) await store.delete(key).catch(() => undefined);
    }
  }
  return {
    deleted,
    scansComplete: true,
    candidateCompleted: candidates.completed,
    nextWindowStart: candidates.nextWindowStart,
  };
}

/** 孤儿清扫需要的 blob 删除能力（与 TieredMediaStore.delete 同语义）。 */
export interface OrphanBlobStore {
  delete(storageKey: string): Promise<void>;
}

/**
 * 弱引用登记同步（0091）：把 surveys.settings_json 里出现的媒体引用
 * （BGM / 场景图 / 主题背景……）写进 media_refs。
 *
 * 双读过渡（阶段 D）：既有 URL 字符串由 `/media\/(\d+)/` 兜底正则扫描，
 * 写入侧切换后的结构化 `{"assetId":n}` 由 JSON 解析提取（裸数字不收）。
 *
 * 兜底扫描只服务于"清扫前最后一刻的保护"，素材库的引用计数与
 * 删除保护读不了它——这一步把它们落成结构化行（ref_type='survey_settings'，
 * ref_key='survey:{id}:{assetId}'），素材库页面因此能看到真实引用。
 * 每次全量重建该问卷的登记行：问卷编辑后失效的引用随重建自动消失。
 */
export async function syncWeakMediaRefs(
  db: D1Database,
  shouldStop: () => boolean,
  budget?: ReadBudget,
): Promise<number> {
  let synced = 0;
  if (process.env.PROTO_DEBUG) console.info("syncWeak pre-call", { hasBudget: typeof budget });
  const { completed } = await scanJsonRows(
    db,
    "surveys",
    "settings_json",
    `(settings_json LIKE '%media/%' OR settings_json LIKE '%"assetId"%')`,
    shouldStop,
    async (row) => {
      const assetIds = collectSurveySettingsMediaIds(row.value ?? null);
      await db
        .prepare("DELETE FROM media_refs WHERE ref_type = 'survey_settings' AND ref_key LIKE ?")
        .bind(`survey:${row.id}:%`)
        .run();
      for (const assetId of assetIds) {
        await upsertMediaRef(db, {
          refType: "survey_settings",
          refKey: `survey:${row.id}:${assetId}`,
          assetId,
        });
        synced += 1;
      }
    },
    budget,
  );
  if (!completed) {
    // 部分同步是安全的：只重建已处理问卷的登记行，未处理问卷保留旧引用
    // （旧引用只会过度保护，不会漏保护），孤儿清扫的 NOT EXISTS 探针不受影响。
    console.warn("Weak media ref sync truncated by the read budget", { synced });
  }
  return synced;
}

/**
 * Deletes only operational residue. Published surveys, all completed answers,
 * templates and identity cards are deliberately outside this retention policy.
 */
export async function runDatabaseMaintenance(
  db: D1Database,
  now = Date.now(),
  store: OrphanBlobStore | null = null,
): Promise<DatabaseMaintenanceSummary> {
  const staleResponseBefore = cutoff(30, now);
  const softDeleteBefore = cutoff(30, now);
  const draftBefore = cutoff(90, now);
  const previewBefore = cutoff(7, now);
  const generatedBefore = cutoff(30, now);
  const jobBefore = cutoff(30, now);
  const resultBefore = cutoff(90, now);
  const auditBefore = cutoff(180, now);

  const budget: ReadBudget = { rowsRead: 0, exceeded: false };
  const scoped = withReadBudget(db, budget);
  // 孤儿候选扫描的续扫游标（上一轮被预算截断时停在哪）。settings 读写各 1 行，
  // 经 scoped 计入预算。
  const sweepCursor = await loadSweepCursor(scoped, now);

  // 先自愈全部前置索引，再跑任何步骤：一个缺失的 retention 索引会让对应
  // DELETE 退化成全表扫描——2026-09-14 与 2026-11-16 两次事故的共同根因。
  // 索引建不出来（schema 漂移）时整轮停车：宁可暂停清理，也不烧额度。
  // 缺表（迁移未跑）由 ensure 内部容错；停车时 cron 给管理员发单独的 DM
  // （parked 路径，与预算截断的 truncated 告警互不吞）。
  const missingIndexes = await ensureMaintenanceIndexes(scoped);
  if (missingIndexes.length > 0) {
    console.warn("Database maintenance parked: required indexes could not be ensured", {
      missing: missingIndexes,
      rowsRead: budget.rowsRead,
    });
    try {
      await saveLastMaintenanceHealth(db, {
        at: new Date(now).toISOString(),
        rowsRead: budget.rowsRead,
        truncated: false,
        parked: true,
        orphanAssets: 0,
      });
    } catch (error) {
      console.warn("Saving parked maintenance health snapshot failed", error);
    }
    return {
      ...EMPTY_MAINTENANCE_SUMMARY,
      rowsRead: budget.rowsRead,
      parked: true,
      parkedMissingIndexes: missingIndexes,
    };
  }

  const summary: DatabaseMaintenanceSummary = {
    expiredResponses: 0,
    expiredNotes: 0,
    expiredSurveyDrafts: 0,
    expiredDeletedSurveys: 0,
    expiredDeletedShowcasePeople: 0,
    expiredDeletedShowcaseItems: 0,
    expiredDeletedPlazaPosts: 0,
    expiredDeletedReportTemplates: 0,
    expiredTemplateDrafts: 0,
    expiredGeneratorDrafts: 0,
    expiredPreviewAssets: 0,
    expiredGeneratedAssets: 0,
    orphanAssets: 0,
    mediaRefsSynced: 0,
    expiredRenderJobs: 0,
    expiredGeneratorJobs: 0,
    expiredReportResults: 0,
    expiredExportJobs: 0,
    reclaimedSendingExportJobs: 0,
    expiredAuditLogs: 0,
    expiredTelegramDedupRows: 0,
    expiredRateLimitRows: 0,
    rowsRead: 0,
    truncated: false,
    parked: false,
    parkedMissingIndexes: [],
  };

  // Cheapest and most valuable first, so a run that gets cut short by the read
  // budget still leaves the database healthier than it found it.
  const steps: Array<() => Promise<void>> = [
    async () => {
      summary.expiredResponses = await changes(
        scoped
          .prepare(
            `DELETE FROM survey_responses
     WHERE status IN ('in_progress', 'cancelled', 'abandoned')
       AND updated_at < ?`,
          )
          .bind(staleResponseBefore),
      );
    },
    async () => {
      // 纸条 7 天有效期（0089）：到期即下架。走 idx_notes_pool 前缀索引，
      // 行数 = 当日到期数；查询本身恒定只扫 active + 已到期这一小段。
      summary.expiredNotes = await changes(
        scoped
          .prepare(`UPDATE notes SET status = 'expired' WHERE status = 'active' AND expires_at <= ?`)
          .bind(new Date().toISOString()),
      );
    },
    async () => {
      // Soft-deleted product content is retained for exactly 30 days. Each step is bounded.
      summary.expiredDeletedShowcaseItems = await changes(
        scoped
          .prepare(
            `DELETE FROM showcase_items WHERE id IN (SELECT id FROM showcase_items WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at ASC, id ASC LIMIT 50)`,
          )
          .bind(softDeleteBefore),
      );
    },
    async () => {
      summary.expiredDeletedShowcasePeople = await changes(
        scoped
          .prepare(
            `DELETE FROM showcase_persons WHERE id IN (SELECT id FROM showcase_persons WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at ASC, id ASC LIMIT 50)`,
          )
          .bind(softDeleteBefore),
      );
    },
    async () => {
      summary.expiredDeletedSurveys = await changes(
        scoped
          .prepare(
            `DELETE FROM surveys WHERE id IN (SELECT id FROM surveys WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at ASC, id ASC LIMIT 50)`,
          )
          .bind(softDeleteBefore),
      );
    },
    async () => {
      summary.expiredDeletedPlazaPosts = await changes(
        scoped
          .prepare(
            `DELETE FROM plaza_posts WHERE id IN (SELECT id FROM plaza_posts WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at ASC, id ASC LIMIT 50)`,
          )
          .bind(softDeleteBefore),
      );
    },
    async () => {
      summary.expiredDeletedReportTemplates = await changes(
        scoped
          .prepare(
            `DELETE FROM report_templates WHERE id IN (SELECT id FROM report_templates WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at ASC, id ASC LIMIT 50)`,
          )
          .bind(softDeleteBefore),
      );
    },
    async () => {
      summary.expiredAuditLogs = await changes(
        scoped.prepare("DELETE FROM audit_logs WHERE created_at < ?").bind(auditBefore),
      );
    },
    async () => {
      // Webhook idempotency keys only need to outlive Telegram's retry window.
      // The DELETE is bounded by idx_telegram_update_dedup_received_at. A
      // deploy can reach production before migration 0052 does, so a missing
      // table must pause this step only, never the rest of the run.
      try {
        summary.expiredTelegramDedupRows = await changes(
          scoped
            .prepare("DELETE FROM telegram_update_dedup WHERE received_at < ?")
            .bind(telegramUpdateDedupCutoff(undefined, now)),
        );
      } catch (error) {
        console.warn("Skipped telegram update dedup cleanup", error);
      }
    },
    async () => {
      // Atomic rate-limit counters only need to outlive their largest window
      // (5 minutes for login / access codes). window_start is milliseconds.
      try {
        summary.expiredRateLimitRows = await changes(
          scoped.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - DAY),
        );
      } catch (error) {
        console.warn("Skipped rate limit cleanup", error);
      }
    },
    async () => {
      // Split the COALESCE so SQLite can use idx_render_jobs_retention
      // (status, completed_at, created_at) as a range scan instead of reading
      // every completed/failed row and filtering in the engine.
      summary.expiredRenderJobs = await changes(
        scoped
          .prepare(
            `DELETE FROM render_jobs
     WHERE status IN ('completed', 'failed')
       AND (
         (completed_at IS NOT NULL AND completed_at < ?)
         OR (completed_at IS NULL AND created_at < ?)
       )`,
          )
          .bind(jobBefore, jobBefore),
      );
    },
    async () => {
      summary.expiredGeneratorJobs = await changes(
        scoped
          .prepare(
            `DELETE FROM image_generator_jobs
     WHERE status IN ('completed', 'failed')
       AND (
         (completed_at IS NOT NULL AND completed_at < ?)
         OR (completed_at IS NULL AND created_at < ?)
       )`,
          )
          .bind(jobBefore, jobBefore),
      );
    },
    async () => {
      // 批一引入 sending 阶段后留下的维护盲区：上面这类 retention 只清理
      // completed/failed，卡死的 sending 行（消费者渲染完、占住发送位后死亡，
      // 且队列重投丢失）永远不会回收。这里按进入 sending 的时刻（0097 的
      // sending_at；迁移前的遗留行没有该列，回退 created_at，与 result-visual
      // / image-generator 恢复服务对 started_at 空值的口径一致）把超时行补成
      // 终态，随后的 retention 才有机会接管。
      // 阈值参照相邻状态回收的既有先例（result-visual / image-generator
      // 恢复服务的 staleProcessingMs = 30 分钟）：sending 的健康窗口只是
      // 文件上传 + 记账 batch 的秒级，30 分钟余量充足，又不会在正常发送的
      // 一两秒内误杀。
      const sendingCutoff = new Date(now - STALE_SENDING_MS).toISOString();
      const reclaimTimestamp = new Date(now).toISOString();
      // r2_key 已记账（tg:<chatId>:<messageId>）= 文件已经送达用户，只是上一任
      // 没来得及走完收尾 batch——补 completed（与 completeRecordedExportJob 的
      // 护栏同语义：只补终态，绝不重复发送），置 failed 会与「用户已收到文件」
      // 的事实矛盾。
      const recorded = await changes(
        scoped
          .prepare(
            `UPDATE export_jobs
       SET status = 'completed', completed_at = ?
     WHERE status = 'sending' AND r2_key IS NOT NULL
       AND COALESCE(sending_at, created_at) < ?`,
          )
          .bind(reclaimTimestamp, sendingCutoff),
      );
      // 未记账 = 发送没有送达（进程在上传中死亡 / 占位后从未真正发送）——
      // 置 failed 交给 retention；若队列重投随后到达，claimExportJob 对
      // redelivered 消息仍放行 failed，不会造成任务永久丢失。
      const unrecorded = await changes(
        scoped
          .prepare(
            `UPDATE export_jobs
       SET status = 'failed', error_message = '导出投递超时', completed_at = ?
     WHERE status = 'sending' AND r2_key IS NULL
       AND COALESCE(sending_at, created_at) < ?`,
          )
          .bind(reclaimTimestamp, sendingCutoff),
      );
      summary.reclaimedSendingExportJobs = recorded + unrecorded;
    },
    async () => {
      summary.expiredExportJobs = await changes(
        scoped
          .prepare(
            `DELETE FROM export_jobs
     WHERE status IN ('completed', 'failed')
       AND (
         (completed_at IS NOT NULL AND completed_at < ?)
         OR (completed_at IS NULL AND created_at < ?)
       )`,
          )
          .bind(jobBefore, jobBefore),
      );
    },
    async () => {
      summary.expiredReportResults = await changes(
        scoped
          .prepare(
            `DELETE FROM report_results
     WHERE created_at < ?
       AND NOT EXISTS (SELECT 1 FROM image_generator_jobs WHERE report_result_id = report_results.id)`,
          )
          .bind(resultBefore),
      );
    },
    async () => {
      summary.expiredSurveyDrafts = await changes(
        scoped
          .prepare(
            `DELETE FROM surveys
     WHERE status = 'draft' AND updated_at < ?
       AND NOT EXISTS (SELECT 1 FROM survey_responses WHERE survey_id = surveys.id)`,
          )
          .bind(draftBefore),
      );
    },
    async () => {
      summary.expiredTemplateDrafts = await changes(
        scoped
          .prepare(
            `DELETE FROM visual_templates
     WHERE status = 'draft' AND updated_at < ?
       AND NOT EXISTS (SELECT 1 FROM render_jobs WHERE template_id = visual_templates.id)
       AND NOT EXISTS (SELECT 1 FROM image_generators WHERE template_id = visual_templates.id)`,
          )
          .bind(draftBefore),
      );
    },
    async () => {
      summary.expiredGeneratorDrafts = await changes(
        scoped
          .prepare(
            `DELETE FROM image_generators
     WHERE status = 'draft' AND updated_at < ?
       AND NOT EXISTS (SELECT 1 FROM image_generator_jobs WHERE generator_id = image_generators.id)`,
          )
          .bind(draftBefore),
      );
    },
    async () => {
      summary.expiredPreviewAssets = await changes(
        scoped
          .prepare(
            `DELETE FROM media_assets
     WHERE asset_scope = 'template_preview' AND created_at < ?`,
          )
          .bind(previewBefore),
      );
    },
    async () => {
      summary.expiredGeneratedAssets = await changes(
        scoped
          .prepare(
            `DELETE FROM media_assets
     WHERE asset_scope = 'generated_result' AND created_at < ?`,
          )
          .bind(generatedBefore),
      );
    },
    async () => {
      // 索引已在 run 开头统一自愈（ensureMaintenanceIndexes），这里直接跑。
      summary.mediaRefsSynced = await syncWeakMediaRefs(scoped, () => budget.exceeded, budget);
      const sweep = await deleteOrphanMediaAssets(
        scoped,
        previewBefore,
        () => budget.exceeded,
        store,
        sweepCursor,
        budget,
      );
      summary.orphanAssets = sweep.deleted;
      // 游标持久化：候选扫描被截断就记续扫点（下一轮从上次窗口继续），扫完
      // 重置 0（下一轮从头全覆盖）。游标只影响候选扫描的起点，JSON 保护扫描
      // 每轮都全量跑，正确性不受游标影响。
      await saveSweepCursor(db, sweep.nextWindowStart, !sweep.candidateCompleted);
    },
  ];

  for (const step of steps) {
    if (budget.exceeded) break;
    await step();
  }

  summary.rowsRead = budget.rowsRead;
  summary.truncated = budget.exceeded;
  summary.parked = false;
  summary.parkedMissingIndexes = [];
  if (summary.truncated) {
    console.warn("Database maintenance stopped early: read budget exhausted", summary);
  }
  // 维护健康快照：客户实例由下一次心跳捎带给 license center（vendor 后台
  // 可见）。写入失败不影响清理结果——快照是可观测性数据，不是账本。
  try {
    await saveLastMaintenanceHealth(db, {
      at: new Date(now).toISOString(),
      rowsRead: summary.rowsRead,
      truncated: summary.truncated,
      parked: false,
      orphanAssets: summary.orphanAssets,
    });
  } catch (error) {
    console.warn("Saving maintenance health snapshot failed", error);
  }
  return summary;
}
