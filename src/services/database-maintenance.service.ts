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
  expiredIdentityCardJobs: number;
  expiredReportResults: number;
  expiredExportJobs: number;
  expiredAuditLogs: number;
}

const DAY = 86_400_000;

function cutoff(days: number, now: number): string {
  return new Date(now - days * DAY).toISOString();
}

async function changes(statement: D1PreparedStatement): Promise<number> {
  const result = await statement.run();
  return result.meta?.changes ?? 0;
}

/**
 * Deletes only operational residue. Published surveys, all completed answers,
 * templates and identity cards are deliberately outside this retention policy.
 */
export async function runDatabaseMaintenance(
  db: D1Database,
  now = Date.now(),
): Promise<DatabaseMaintenanceSummary> {
  const staleResponseBefore = cutoff(30, now);
  const draftBefore = cutoff(90, now);
  const previewBefore = cutoff(7, now);
  const generatedBefore = cutoff(30, now);
  const jobBefore = cutoff(30, now);
  const resultBefore = cutoff(90, now);
  const auditBefore = cutoff(180, now);

  const expiredResponses = await changes(db.prepare(
    `DELETE FROM survey_responses
     WHERE status IN ('in_progress', 'cancelled', 'abandoned')
       AND updated_at < ?`,
  ).bind(staleResponseBefore));
  const expiredSurveyDrafts = await changes(db.prepare(
    `DELETE FROM surveys
     WHERE status = 'draft' AND updated_at < ?
       AND NOT EXISTS (SELECT 1 FROM survey_responses WHERE survey_id = surveys.id)`,
  ).bind(draftBefore));
  const expiredTemplateDrafts = await changes(db.prepare(
    `DELETE FROM visual_templates
     WHERE status = 'draft' AND updated_at < ?
       AND NOT EXISTS (SELECT 1 FROM render_jobs WHERE template_id = visual_templates.id)
       AND NOT EXISTS (SELECT 1 FROM image_generators WHERE template_id = visual_templates.id)`,
  ).bind(draftBefore));
  const expiredGeneratorDrafts = await changes(db.prepare(
    `DELETE FROM image_generators
     WHERE status = 'draft' AND updated_at < ?
       AND NOT EXISTS (SELECT 1 FROM image_generator_jobs WHERE generator_id = image_generators.id)`,
  ).bind(draftBefore));

  const expiredRenderJobs = await changes(db.prepare(
    `DELETE FROM render_jobs
     WHERE status IN ('completed', 'failed')
       AND COALESCE(completed_at, created_at) < ?`,
  ).bind(jobBefore));
  const expiredGeneratorJobs = await changes(db.prepare(
    `DELETE FROM image_generator_jobs
     WHERE status IN ('completed', 'failed')
       AND COALESCE(completed_at, created_at) < ?`,
  ).bind(jobBefore));
  const expiredIdentityCardJobs = await changes(db.prepare(
    `DELETE FROM identity_card_jobs
     WHERE status IN ('completed', 'failed')
       AND COALESCE(completed_at, created_at) < ?`,
  ).bind(jobBefore));
  const expiredReportResults = await changes(db.prepare(
    `DELETE FROM report_results
     WHERE created_at < ?
       AND NOT EXISTS (SELECT 1 FROM image_generator_jobs WHERE report_result_id = report_results.id)`,
  ).bind(resultBefore));
  const expiredExportJobs = await changes(db.prepare(
    `DELETE FROM export_jobs
     WHERE status IN ('completed', 'failed')
       AND COALESCE(completed_at, created_at) < ?`,
  ).bind(jobBefore));
  const expiredAuditLogs = await changes(db.prepare(
    "DELETE FROM audit_logs WHERE created_at < ?",
  ).bind(auditBefore));

  const expiredPreviewAssets = await changes(db.prepare(
    `DELETE FROM media_assets
     WHERE asset_scope = 'template_preview' AND created_at < ?`,
  ).bind(previewBefore));
  const expiredGeneratedAssets = await changes(db.prepare(
    `DELETE FROM media_assets
     WHERE asset_scope = 'generated_result' AND created_at < ?`,
  ).bind(generatedBefore));

  const orphanAssets = await changes(db.prepare(
    `DELETE FROM media_assets
     WHERE created_at < ?
       AND NOT EXISTS (SELECT 1 FROM question_media WHERE media_asset_id = media_assets.id)
       AND NOT EXISTS (SELECT 1 FROM option_media WHERE media_asset_id = media_assets.id)
       AND NOT EXISTS (SELECT 1 FROM answer_media WHERE media_asset_id = media_assets.id)
       AND NOT EXISTS (SELECT 1 FROM answers
                       WHERE COALESCE(json_value, '') LIKE '%"mediaAssetId":' || media_assets.id || '%')
       AND NOT EXISTS (SELECT 1 FROM visual_template_assets WHERE asset_id = media_assets.id)
       AND NOT EXISTS (SELECT 1 FROM identity_profiles
                       WHERE front_asset_id = media_assets.id
                          OR back_asset_id = media_assets.id
                          OR background_asset_id = media_assets.id)
       AND NOT EXISTS (SELECT 1 FROM image_generator_backgrounds WHERE asset_id = media_assets.id)
       AND NOT EXISTS (SELECT 1 FROM image_generators WHERE report_background_asset_id = media_assets.id)
       AND NOT EXISTS (SELECT 1 FROM surveys WHERE cover_media_id = media_assets.id)`,
  ).bind(previewBefore));

  return {
    expiredResponses,
    expiredSurveyDrafts,
    expiredTemplateDrafts,
    expiredGeneratorDrafts,
    expiredPreviewAssets,
    expiredGeneratedAssets,
    orphanAssets,
    expiredRenderJobs,
    expiredGeneratorJobs,
    expiredIdentityCardJobs,
    expiredReportResults,
    expiredExportJobs,
    expiredAuditLogs,
  };
}
