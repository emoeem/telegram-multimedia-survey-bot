import { describe, expect, it, vi } from "vitest";

import {
  createSurvey,
  getSurveyById,
  listSurveysByOwner,
} from "../../../src/db/repositories/survey.repository";

interface StatementMock {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
}

function createD1Mock(input: {
  firstRow?: unknown;
  allRows?: unknown[];
  lastRowId?: number;
}): D1Database {
  const statement: StatementMock = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => input.firstRow ?? null),
    run: vi.fn(async () => ({
      success: true,
      meta: { last_row_id: input.lastRowId ?? 1 },
    })),
    all: vi.fn(async () => ({ results: input.allRows ?? [] })),
  };

  return {
    prepare: vi.fn(() => statement),
  } as unknown as D1Database;
}

describe("survey repository", () => {
  it("creates a survey and maps the returned row", async () => {
    const now = "2026-08-14T00:00:00.000Z";
    const db = createD1Mock({
      lastRowId: 42,
      firstRow: {
        id: 42,
        owner_id: 7,
        title: "Test Survey",
        description: null,
        cover_media_id: null,
        status: "draft",
        anonymous: 0,
        allow_multiple_responses: 0,
        max_responses_per_user: 1,
        version: 1,
        created_at: now,
        updated_at: now,
        published_at: null,
        closed_at: null,
        archived_at: null,
      },
    });

    const survey = await createSurvey(db, {
      ownerId: 7,
      title: "Test Survey",
    });

    expect(survey.id).toBe(42);
    expect(survey.ownerId).toBe(7);
    expect(survey.status).toBe("draft");
  });

  it("returns null when a survey is missing", async () => {
    const db = createD1Mock({ firstRow: null });

    await expect(getSurveyById(db, 123)).resolves.toBeNull();
  });

  it("lists surveys for an owner", async () => {
    const now = "2026-08-14T00:00:00.000Z";
    const db = createD1Mock({
      allRows: [
        {
          id: 1,
          owner_id: 7,
          title: "A",
          description: null,
          cover_media_id: null,
          status: "published",
          anonymous: 1,
          allow_multiple_responses: 1,
          max_responses_per_user: 3,
          version: 1,
          created_at: now,
          updated_at: now,
          published_at: now,
          closed_at: null,
          archived_at: null,
        },
      ],
    });

    const surveys = await listSurveysByOwner(db, 7);

    expect(surveys).toHaveLength(1);
    expect(surveys[0]?.anonymous).toBe(true);
    expect(surveys[0]?.allowMultipleResponses).toBe(true);
  });
});
