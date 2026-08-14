export type ExportJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface ExportJob {
  id: number;
  surveyId: number;
  requestedBy: number | null;
  format: "csv" | "xlsx" | "zip";
  status: ExportJobStatus;
  r2Key: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface ExportJobRow {
  id: number;
  survey_id: number;
  requested_by: number | null;
  format: string;
  status: string;
  r2_key: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

function mapExportJob(row: ExportJobRow): ExportJob {
  return {
    id: row.id,
    surveyId: row.survey_id,
    requestedBy: row.requested_by,
    format: row.format as ExportJob["format"],
    status: row.status as ExportJobStatus,
    r2Key: row.r2_key,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export async function createExportJob(
  db: D1Database,
  input: {
    surveyId: number;
    requestedBy: number | null;
    format: ExportJob["format"];
  },
): Promise<ExportJob> {
  const timestamp = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO export_jobs (
        survey_id, requested_by, format, status, created_at
      ) VALUES (?, ?, ?, 'pending', ?)`,
    )
    .bind(input.surveyId, input.requestedBy, input.format, timestamp)
    .run();

  const id = result.meta?.last_row_id;
  if (typeof id !== "number") {
    throw new Error("Failed to create export job");
  }

  const row = await db
    .prepare("SELECT * FROM export_jobs WHERE id = ? LIMIT 1")
    .bind(id)
    .first<ExportJobRow>();

  if (!row) {
    throw new Error("Failed to load export job");
  }

  return mapExportJob(row);
}

export async function updateExportJob(
  db: D1Database,
  id: number,
  input: {
    status: ExportJobStatus;
    r2Key?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `UPDATE export_jobs SET
        status = ?,
        r2_key = ?,
        error_message = ?,
        completed_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.status,
      input.r2Key ?? null,
      input.errorMessage ?? null,
      input.status === "completed" || input.status === "failed" ? timestamp : null,
      id,
    )
    .run();
}
