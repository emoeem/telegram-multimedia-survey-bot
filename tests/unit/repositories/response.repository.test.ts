import { describe, expect, it, vi } from "vitest";

import {
  createResponse,
  upsertDateAnswer,
  upsertNumberAnswer,
  upsertOptionAnswer,
  upsertTimeAnswer,
} from "../../../src/db/repositories/response.repository";

interface CapturedStatement {
  sql: string;
  bindings: unknown[];
  bind: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
}

function createD1Mock(answerId = 91): {
  db: D1Database;
  statements: CapturedStatement[];
  batch: ReturnType<typeof vi.fn>;
} {
  const statements: CapturedStatement[] = [];
  const batch = vi.fn(async () => []);
  const db = {
    prepare: vi.fn((sql: string) => {
      const statement: CapturedStatement = {
        sql,
        bindings: [],
        bind: vi.fn((...bindings: unknown[]) => {
          statement.bindings = bindings;
          return statement;
        }),
        run: vi.fn(async () => ({ success: true })),
        first: vi.fn(async () =>
          sql.includes("SELECT id FROM answers") ? { id: answerId } : null,
        ),
      };
      statements.push(statement);
      return statement;
    }),
    batch,
  } as unknown as D1Database;

  return { db, statements, batch };
}

describe("response repository", () => {
  it("records the survey version on a new response", async () => {
    const statement = {
      bind: vi.fn(() => statement),
      run: vi.fn(async () => ({ success: true, meta: { last_row_id: 55 } })),
      first: vi.fn(async () => ({
        id: 55,
        survey_id: 3,
        user_id: 9,
        participant_hash: "hash",
        status: "in_progress",
        started_at: "2026-08-22T00:00:00.000Z",
        current_question_id: null,
        version: 2,
        completed_at: null,
        submitted_at: null,
        created_at: "2026-08-22T00:00:00.000Z",
        updated_at: "2026-08-22T00:00:00.000Z",
      })),
    };
    const db = { prepare: vi.fn(() => statement) } as unknown as D1Database;

    const response = await createResponse(db, {
      surveyId: 3,
      userId: 9,
      participantHash: "hash",
    });

    expect(statement.bind).toHaveBeenCalledWith(
      3,
      9,
      "hash",
      expect.any(String),
      null,
      3,
      expect.any(String),
      expect.any(String),
    );
    expect(response.version).toBe(2);
  });

  it("replaces option relations and writes normalized answer_options rows", async () => {
    const { db, statements, batch } = createD1Mock();

    await upsertOptionAnswer(db, {
      responseId: 7,
      questionId: 8,
      selectedOptionIds: [101, 102],
    });

    const deleteStatement = statements.find((statement) =>
      statement.sql.includes("DELETE FROM answer_options"),
    );
    expect(deleteStatement?.bindings).toEqual([91]);

    const insertedOptions = batch.mock.calls[0]?.[0] as CapturedStatement[];
    expect(insertedOptions).toHaveLength(2);
    expect(insertedOptions.map((statement) => statement.bindings.slice(0, 2))).toEqual([
      [91, 101],
      [91, 102],
    ]);

    const answerInsert = statements.find((statement) =>
      statement.sql.includes("INSERT INTO answers"),
    );
    expect(answerInsert?.bindings[8]).toBe("[101,102]");
  });

  it("stores number, date, and time answers in their dedicated columns", async () => {
    const { db, statements } = createD1Mock();

    await upsertNumberAnswer(db, {
      responseId: 1,
      questionId: 2,
      numberValue: 12.5,
    });
    await upsertDateAnswer(db, {
      responseId: 1,
      questionId: 3,
      dateValue: "2026-08-14",
    });
    await upsertTimeAnswer(db, {
      responseId: 1,
      questionId: 4,
      timeValue: "21:30",
    });

    const inserts = statements.filter((statement) =>
      statement.sql.includes("INSERT INTO answers"),
    );
    expect(inserts[0]?.bindings.slice(2, 9)).toEqual([
      null,
      12.5,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(inserts[1]?.bindings.slice(2, 9)).toEqual([
      null,
      null,
      null,
      null,
      "2026-08-14",
      null,
      null,
    ]);
    expect(inserts[2]?.bindings.slice(2, 9)).toEqual([
      null,
      null,
      null,
      null,
      null,
      "21:30",
      null,
    ]);
  });
});
