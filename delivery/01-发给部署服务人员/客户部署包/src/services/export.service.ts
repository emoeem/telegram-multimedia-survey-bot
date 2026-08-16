import { strToU8, zipSync } from "fflate";
import * as XLSX from "xlsx";

import type { QuestionType } from "../db/schema";

interface QuestionColumn {
  id: number;
  title: string;
  type: QuestionType;
  key: string;
  settingsJson: string | null;
}

export interface ResponseRow {
  response_id: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  [key: string]: unknown;
}

const QUESTION_ID_BATCH_SIZE = 90;

async function loadOptionLabels(
  db: D1Database,
  questionIds: number[],
): Promise<Map<number, string>> {
  const optionLabels = new Map<number, string>();
  const uniqueQuestionIds = [...new Set(questionIds)];

  for (
    let start = 0;
    start < uniqueQuestionIds.length;
    start += QUESTION_ID_BATCH_SIZE
  ) {
    const questionIdBatch = uniqueQuestionIds.slice(
      start,
      start + QUESTION_ID_BATCH_SIZE,
    );
    const result = await db
      .prepare(
        `SELECT id, label
         FROM question_options
         WHERE question_id IN (${questionIdBatch.map(() => "?").join(",")})`,
      )
      .bind(...questionIdBatch)
      .all<{ id: number; label: string }>();

    for (const option of result.results ?? []) {
      optionLabels.set(option.id, option.label);
    }
  }

  return optionLabels;
}

function answerValue(
  row: Record<string, unknown>,
  optionLabels: Map<number, string>,
  column?: QuestionColumn,
): unknown {
  if (
    row["selected_options"] !== null &&
    row["selected_options"] !== undefined &&
    String(row["selected_options"]).length > 0
  ) {
    return row["selected_options"];
  }
  if (row["rating_value"] !== null && row["rating_value"] !== undefined) {
    return row["rating_value"];
  }
  if (row["number_value"] !== null && row["number_value"] !== undefined) {
    return row["number_value"];
  }
  if (row["boolean_value"] !== null && row["boolean_value"] !== undefined) {
    return Number(row["boolean_value"]) === 1 ? "yes" : "no";
  }
  if (row["date_value"] !== null && row["date_value"] !== undefined) {
    return row["date_value"];
  }
  if (row["time_value"] !== null && row["time_value"] !== undefined) {
    return row["time_value"];
  }
  if (row["json_value"] !== null && row["json_value"] !== undefined) {
    try {
      const parsed = JSON.parse(String(row["json_value"])) as unknown;
      if (
        column?.type === "matrix" &&
        parsed && typeof parsed === "object" &&
        "kind" in parsed && (parsed as { kind?: unknown }).kind === "matrix"
      ) {
        const selections = (parsed as { selections?: unknown }).selections;
        let columns: string[] = [];
        try {
          const settings = column.settingsJson ? JSON.parse(column.settingsJson) as { columns?: unknown } : null;
          columns = Array.isArray(settings?.columns) ? settings.columns.filter((item): item is string => typeof item === "string") : [];
        } catch { /* keep raw column number below */ }
        if (selections && typeof selections === "object") {
          return Object.entries(selections as Record<string, unknown>)
            .map(([rowId, columnIndex]) => `${optionLabels.get(Number(rowId)) ?? `行 #${rowId}`}：${columns[Number(columnIndex)] ?? `列 ${Number(columnIndex) + 1}`}`)
            .join(" | ");
        }
      }
      if (Array.isArray(parsed)) {
        return parsed
          .map((optionId) => optionLabels.get(Number(optionId)) ?? String(optionId))
          .join(" | ");
      }
    } catch {
      // Fall through to the original JSON text.
    }
    return row["json_value"];
  }
  return row["text_value"] ?? "";
}

export async function getExportRows(
  db: D1Database,
  surveyId: number,
): Promise<{
  columns: QuestionColumn[];
  rows: ResponseRow[];
}> {
  const questionsResult = await db
    .prepare(
      `SELECT id, title, type, settings_json
       FROM survey_questions
       WHERE survey_id = ?
       ORDER BY "order" ASC`,
    )
    .bind(surveyId)
    .all<{ id: number; title: string; type: string; settings_json: string | null }>();

  const titleCounts = new Map<string, number>();
  for (const question of questionsResult.results ?? []) {
    titleCounts.set(
      question.title,
      (titleCounts.get(question.title) ?? 0) + 1,
    );
  }
  const columns = (questionsResult.results ?? []).map((question) => ({
    id: question.id,
    title: question.title,
    type: question.type as QuestionType,
    settingsJson: question.settings_json,
    key:
      (titleCounts.get(question.title) ?? 0) > 1
        ? `${question.title} (#${question.id})`
        : question.title,
  }));
  const optionLabels = await loadOptionLabels(
    db,
    columns.map((column) => column.id),
  );

  const responsesResult = await db
    .prepare(
      `SELECT id AS response_id, status, started_at, completed_at
       FROM survey_responses
       WHERE survey_id = ?
       ORDER BY id ASC`,
    )
    .bind(surveyId)
    .all<{
      response_id: number;
      status: string;
      started_at: string;
      completed_at: string | null;
    }>();

  const answersResult = await db
    .prepare(
      `SELECT
        response_id,
        question_id,
        text_value,
        number_value,
        boolean_value,
        rating_value,
        date_value,
        time_value,
        json_value,
        (
          SELECT GROUP_CONCAT(qo.label, ' | ')
          FROM answer_options ao
          JOIN question_options qo ON qo.id = ao.question_option_id
          WHERE ao.answer_id = answers.id
        ) AS selected_options
       FROM answers
       WHERE response_id IN (
         SELECT id FROM survey_responses WHERE survey_id = ?
       )`,
    )
    .bind(surveyId)
    .all<Record<string, unknown>>();

  const answersByResponse = new Map<number, Map<number, Record<string, unknown>>>();

  for (const answer of answersResult.results ?? []) {
    const responseId = Number(answer["response_id"]);
    const questionId = Number(answer["question_id"]);
    const responseAnswers = answersByResponse.get(responseId) ?? new Map();
    responseAnswers.set(questionId, answer);
    answersByResponse.set(responseId, responseAnswers);
  }

  const rows = (responsesResult.results ?? []).map((response) => {
    const row: ResponseRow = {
      response_id: response.response_id,
      status: response.status,
      started_at: response.started_at,
      completed_at: response.completed_at,
    };

    const answers = answersByResponse.get(response.response_id);
    for (const column of columns) {
      const answer = answers?.get(column.id);
      row[column.key] = answer ? answerValue(answer, optionLabels, column) : "";
    }

    return row;
  });

  return { columns, rows };
}

export function buildCsv(rows: ResponseRow[]): string {
  if (rows.length === 0) {
    return "";
  }

  const csvCell = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return `"${text.replaceAll('"', '""')}"`;
  };
  const headers = Object.keys(rows[0] ?? {});
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) =>
      headers
        .map((header) => csvCell(row[header]))
        .join(","),
    ),
  ];

  return lines.join("\n");
}

export function buildXlsx(rows: ResponseRow[]): Uint8Array {
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Responses");
  return XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as Uint8Array;
}

export function buildExportZip(
  csv: string,
  rows: ResponseRow[],
  mediaFiles: { name: string; data: Uint8Array }[] = [],
): Uint8Array {
  const zipEntries: Record<string, Uint8Array> = {
    "answers.csv": strToU8(csv),
    "metadata.json": strToU8(
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          responseCount: rows.length,
          mediaCount: mediaFiles.length,
        },
        null,
        2,
      ),
    ),
  };

  for (const file of mediaFiles) {
    zipEntries[file.name] = file.data;
  }

  return zipSync(zipEntries);
}

export type ExportFormat = "csv" | "xlsx" | "zip";

export function serializeExport(
  format: ExportFormat,
  csv: string,
  rows: ResponseRow[],
  mediaFiles: { name: string; data: Uint8Array }[] = [],
): Uint8Array | string {
  if (format === "csv") {
    return csv;
  }

  if (format === "xlsx") {
    return buildXlsx(rows);
  }

  return buildExportZip(csv, rows, mediaFiles);
}
