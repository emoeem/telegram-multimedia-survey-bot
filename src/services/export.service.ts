import { strToU8, zipSync } from "fflate";
import * as XLSX from "xlsx";

import type { QuestionType } from "../db/schema";

interface QuestionColumn {
  id: number;
  title: string;
  type: QuestionType;
}

export interface ResponseRow {
  response_id: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  [key: string]: unknown;
}

function answerValue(row: Record<string, unknown>): unknown {
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
      `SELECT id, title, type
       FROM survey_questions
       WHERE survey_id = ?
       ORDER BY "order" ASC`,
    )
    .bind(surveyId)
    .all<{ id: number; title: string; type: string }>();

  const columns = (questionsResult.results ?? []).map((question) => ({
    id: question.id,
    title: question.title,
    type: question.type as QuestionType,
  }));

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
        json_value
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
      row[column.title] = answer ? answerValue(answer) : "";
    }

    return row;
  });

  return { columns, rows };
}

export function buildCsv(rows: ResponseRow[]): string {
  if (rows.length === 0) {
    return "";
  }

  const headers = Object.keys(rows[0] ?? {});
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((header) => {
          const value = row[header];
          const text = value === null || value === undefined ? "" : String(value);
          return `"${text.replaceAll('"', '""')}"`;
        })
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
