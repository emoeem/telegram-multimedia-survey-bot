import { describe, expect, it, vi } from "vitest";

import {
  createMediaAsset,
  getAnswerMediaByAnswerIds,
  getMediaAssetsByIds,
  getQuestionMediaByQuestionIds,
  listOptionMediaByOptionIds,
} from "../../../src/db/repositories/media.repository";

interface StatementMock {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

function createD1Mock(): D1Database {
  const now = "2026-08-14T00:00:00.000Z";
  const statement: StatementMock = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => ({
      id: 9,
      media_type: "photo",
      telegram_file_id: "file-id",
      telegram_file_unique_id: "unique-id",
      mime_type: "image/jpeg",
      file_name: null,
      file_size: 100,
      width: 800,
      height: 600,
      duration: null,
      r2_key: null,
      created_at: now,
      updated_at: now,
    })),
    run: vi.fn(async () => ({
      success: true,
      meta: { last_row_id: 9 },
    })),
  };

  return {
    prepare: vi.fn(() => statement),
  } as unknown as D1Database;
}

describe("media repository", () => {
  it("creates and maps a media asset", async () => {
    const db = createD1Mock();

    const asset = await createMediaAsset(db, {
      mediaType: "photo",
      telegramFileId: "file-id",
      telegramFileUniqueId: "unique-id",
      mimeType: "image/jpeg",
      fileSize: 100,
      width: 800,
      height: 600,
    });

    expect(asset.id).toBe(9);
    expect(asset.mediaType).toBe("photo");
    expect(asset.telegramFileUniqueId).toBe("unique-id");
  });
});

interface CapturedStatement {
  sql: string;
  bound: unknown[];
}

/**
 * Fake D1 that records every prepared statement and answers `.all()` with rows
 * derived from the bound ids, so a test can prove N ids produce one query.
 */
function createCapturingDb(
  answer: (sql: string, bound: unknown[]) => Array<Record<string, unknown>>,
): { db: D1Database; statements: CapturedStatement[] } {
  const statements: CapturedStatement[] = [];
  const db = {
    prepare(sql: string) {
      const captured: CapturedStatement = { sql, bound: [] };
      statements.push(captured);
      const statement = {
        bind(...args: unknown[]) {
          captured.bound = args;
          return statement;
        },
        async all() {
          return { results: answer(sql, captured.bound), meta: {} };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, statements };
}

function mediaRow(id: number): Record<string, unknown> {
  return {
    id,
    asset_scope: "survey",
    media_type: "photo",
    telegram_file_id: null,
    telegram_file_unique_id: null,
    url: null,
    storage_kind: "temporary",
    storage_key: `key-${id}`,
    expires_at: null,
    mime_type: "image/jpeg",
    file_name: null,
    file_size: 10,
    width: 1,
    height: 1,
    duration: null,
    r2_key: null,
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z",
  };
}

describe("media repository batching", () => {
  it("loads many assets with one IN query per 90 ids", async () => {
    const { db, statements } = createCapturingDb((_sql, bound) =>
      (bound as number[]).map((id) => mediaRow(id)),
    );

    const assets = await getMediaAssetsByIds(db, [1, 2, 3]);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain("IN (?,?,?)");
    expect([...assets.keys()]).toEqual([1, 2, 3]);

    const many = Array.from({ length: 200 }, (_, index) => index + 1);
    await getMediaAssetsByIds(db, many);
    // 200 ids -> ceil(200/90) = 3 batched statements.
    expect(statements).toHaveLength(1 + 3);
  });

  it("deduplicates and drops invalid asset ids", async () => {
    const { db, statements } = createCapturingDb((_sql, bound) =>
      (bound as number[]).map((id) => mediaRow(id)),
    );

    await getMediaAssetsByIds(db, [5, 5, 0, -1, 7]);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.bound).toEqual([5, 7]);
  });

  it("loads question media for many questions in one query", async () => {
    const { db, statements } = createCapturingDb((_sql, bound) =>
      (bound as number[]).map((questionId) => ({
        id: questionId * 10,
        question_id: questionId,
        media_asset_id: questionId * 100,
        sort_order: 0,
      })),
    );

    const rows = await getQuestionMediaByQuestionIds(db, [11, 12, 13]);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain("question_id IN (?,?,?)");
    expect(rows).toEqual([
      { id: 110, questionId: 11, mediaAssetId: 1100, sortOrder: 0 },
      { id: 120, questionId: 12, mediaAssetId: 1200, sortOrder: 0 },
      { id: 130, questionId: 13, mediaAssetId: 1300, sortOrder: 0 },
    ]);
  });

  it("loads answer media for many answers in one query", async () => {
    const { db, statements } = createCapturingDb((_sql, bound) =>
      (bound as number[]).map((answerId) => ({
        id: answerId,
        answer_id: answerId,
        media_asset_id: answerId + 1000,
        sort_order: 0,
      })),
    );

    const rows = await getAnswerMediaByAnswerIds(db, [1, 2]);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain("answer_id IN (?,?)");
    expect(rows).toEqual([
      { id: 1, answerId: 1, mediaAssetId: 1001, sortOrder: 0 },
      { id: 2, answerId: 2, mediaAssetId: 1002, sortOrder: 0 },
    ]);
  });

  it("loads option media for many options in one query", async () => {
    const { db, statements } = createCapturingDb((_sql, bound) =>
      (bound as number[]).map((optionId) => ({
        id: optionId,
        question_option_id: optionId,
        media_asset_id: optionId + 2000,
        sort_order: 0,
      })),
    );

    const rows = await listOptionMediaByOptionIds(db, [4, 5]);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain("question_option_id IN (?,?)");
    expect(rows).toEqual([
      { id: 4, questionOptionId: 4, mediaAssetId: 2004, sortOrder: 0 },
      { id: 5, questionOptionId: 5, mediaAssetId: 2005, sortOrder: 0 },
    ]);
  });

  it("skips the query entirely when there are no ids", async () => {
    const { db, statements } = createCapturingDb(() => []);

    expect((await getMediaAssetsByIds(db, [])).size).toBe(0);
    expect(await getQuestionMediaByQuestionIds(db, [])).toEqual([]);
    expect(await getAnswerMediaByAnswerIds(db, [])).toEqual([]);
    expect(await listOptionMediaByOptionIds(db, [])).toEqual([]);
    expect(statements).toHaveLength(0);
  });
});
