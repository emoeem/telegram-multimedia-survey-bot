import { telegramUpdateDedupCutoff } from "./update-dedup.service";

export interface DatabaseMaintenanceSummary {
  expiredResponses: number;
  expiredSurveyDrafts: number;
  expiredTemplateDrafts: number;
  expiredGeneratorDrafts: number;
  expiredPreviewAssets: number;
  expiredGeneratedAssets: number;
  orphanAssets: number;
  expiredRenderJobs: number;
  expiredGeneratorJobs: number;
  expiredReportResults: number;
  expiredExportJobs: number;
  expiredAuditLogs: number;
  expiredTelegramDedupRows: number;
  /** Rows this run read, as metered by D1. The free tier allows 5,000,000/day. */
  rowsRead: number;
  /** True when the run stopped early to stay inside MAINTENANCE_ROWS_READ_BUDGET. */
  truncated: boolean;
}

const DAY = 86_400_000;

/**
 * How many orphan media rows a single daily run may delete. The sweep is
 * idempotent, so a backlog simply drains over the following days instead of
 * turning one run into an unbounded scan.
 */
const ORPHAN_MEDIA_BATCH_SIZE = 100;

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
] as const;

async function missingOrphanSweepIndexes(db: D1Database): Promise<string[]> {
  const names = ORPHAN_SWEEP_INDEXES.map((index) => index.name);
  const placeholders = names.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${placeholders})`)
    .bind(...names)
    .all<{ name: string }>();
  const found = new Set((result.results ?? []).map((row) => row.name));
  return names.filter((name) => !found.has(name));
}

async function ensureOrphanSweepIndexes(db: D1Database): Promise<boolean> {
  try {
    const missing = await missingOrphanSweepIndexes(db);
    if (missing.length === 0) return true;
    console.info("Creating read-path indexes for the orphan media sweep", { missing });
    for (const index of ORPHAN_SWEEP_INDEXES) {
      if (!missing.includes(index.name)) continue;
      await db.prepare(index.create).run();
    }
    const stillMissing = await missingOrphanSweepIndexes(db);
    if (stillMissing.length > 0) {
      console.warn("Orphan media sweep stays parked: read-path indexes are still missing", { stillMissing });
      return false;
    }
    return true;
  } catch (error) {
    console.warn("Orphan media sweep stays parked: could not ensure read-path indexes", error);
    return false;
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

/**
 * Media ids that answers still reference inside their JSON payload.
 * `answers.json_value` has always been written as `{"mediaAssetId": N}`; the
 * regex also catches older or nested spellings so the scan stays strictly
 * safer than the per-row LIKE probes it replaces.
 */
async function loadAnswerJsonMediaIds(db: D1Database): Promise<Set<number>> {
  const result = await db
    .prepare(
      `SELECT json_value FROM answers
        WHERE json_value IS NOT NULL
          AND json_value LIKE '%"mediaAssetId"%'`,
    )
    .all<{ json_value: string | null }>();
  const ids = new Set<number>();
  for (const row of result.results ?? []) {
    for (const id of collectIds(row.json_value?.matchAll(/"mediaAssetId"\s*:\s*(\d+)/g) ?? [])) {
      ids.add(id);
    }
  }
  return ids;
}

/** Media ids embedded in survey settings (`{"url":"/api/survey/media/12"}`). */
async function loadSurveySettingsMediaIds(db: D1Database): Promise<Set<number>> {
  const result = await db
    .prepare(
      `SELECT settings_json FROM surveys
        WHERE settings_json IS NOT NULL
          AND settings_json LIKE '%media/%'`,
    )
    .all<{ settings_json: string | null }>();
  const ids = new Set<number>();
  for (const row of result.results ?? []) {
    // Matches both `/api/survey/media/12` and relative `media/12` spellings.
    // Over-matching only keeps a row alive, which is the safe direction.
    for (const id of collectIds(row.settings_json?.matchAll(/media\/(\d+)/g) ?? [])) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Candidate orphan media rows, oldest first and bounded.
 *
 * The previous implementation asked SQLite to evaluate eleven `NOT EXISTS`
 * probes for every media row in one statement. Since several referencing
 * columns were unindexed, that meant repeated full table scans: a single run
 * read ~5.3M rows and burned the entire daily D1 rows-read budget on
 * 2026-09-14. The candidate query now only uses indexed columns, and the two
 * unindexed JSON fallbacks are resolved with one scan each.
 */
async function findOrphanMediaCandidates(db: D1Database, before: string): Promise<number[]> {
  const result = await db
    .prepare(
      `SELECT m.id
         FROM media_assets m
        WHERE m.created_at < ?
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
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ?`,
    )
    .bind(before, ORPHAN_MEDIA_BATCH_SIZE)
    .all<{ id: number }>();
  return (result.results ?? []).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
}

async function deleteOrphanMediaAssets(db: D1Database, before: string): Promise<number> {
  const candidates = await findOrphanMediaCandidates(db, before);
  if (candidates.length === 0) return 0;
  const referencedInJson = new Set<number>([
    ...(await loadAnswerJsonMediaIds(db)),
    ...(await loadSurveySettingsMediaIds(db)),
  ]);
  let deleted = 0;
  for (const id of candidates) {
    if (referencedInJson.has(id)) continue;
    deleted += await changes(db.prepare("DELETE FROM media_assets WHERE id = ?").bind(id));
  }
  return deleted;
}

/**
 * Deletes only operational residue. Published surveys, all completed answers,
 * templates and identity cards are deliberately outside this retention policy.
 */
export async function runDatabaseMaintenance(db: D1Database, now = Date.now()): Promise<DatabaseMaintenanceSummary> {
  const staleResponseBefore = cutoff(30, now);
  const draftBefore = cutoff(90, now);
  const previewBefore = cutoff(7, now);
  const generatedBefore = cutoff(30, now);
  const jobBefore = cutoff(30, now);
  const resultBefore = cutoff(90, now);
  const auditBefore = cutoff(180, now);

  const budget: ReadBudget = { rowsRead: 0, exceeded: false };
  const scoped = withReadBudget(db, budget);
  const summary: DatabaseMaintenanceSummary = {
    expiredResponses: 0,
    expiredSurveyDrafts: 0,
    expiredTemplateDrafts: 0,
    expiredGeneratorDrafts: 0,
    expiredPreviewAssets: 0,
    expiredGeneratedAssets: 0,
    orphanAssets: 0,
    expiredRenderJobs: 0,
    expiredGeneratorJobs: 0,
    expiredReportResults: 0,
    expiredExportJobs: 0,
    expiredAuditLogs: 0,
    expiredTelegramDedupRows: 0,
    rowsRead: 0,
    truncated: false,
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
      summary.expiredRenderJobs = await changes(
        scoped
          .prepare(
            `DELETE FROM render_jobs
     WHERE status IN ('completed', 'failed')
       AND COALESCE(completed_at, created_at) < ?`,
          )
          .bind(jobBefore),
      );
    },
    async () => {
      summary.expiredGeneratorJobs = await changes(
        scoped
          .prepare(
            `DELETE FROM image_generator_jobs
     WHERE status IN ('completed', 'failed')
       AND COALESCE(completed_at, created_at) < ?`,
          )
          .bind(jobBefore),
      );
    },
    async () => {
      summary.expiredExportJobs = await changes(
        scoped
          .prepare(
            `DELETE FROM export_jobs
     WHERE status IN ('completed', 'failed')
       AND COALESCE(completed_at, created_at) < ?`,
          )
          .bind(jobBefore),
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
      if (await ensureOrphanSweepIndexes(scoped)) {
        summary.orphanAssets = await deleteOrphanMediaAssets(scoped, previewBefore);
      }
    },
  ];

  for (const step of steps) {
    if (budget.exceeded) break;
    await step();
  }

  summary.rowsRead = budget.rowsRead;
  summary.truncated = budget.exceeded;
  if (summary.truncated) {
    console.warn("Database maintenance stopped early: read budget exhausted", summary);
  }
  return summary;
}
