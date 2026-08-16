import { describe, expect, it, vi } from "vitest";

import { listOptionsForQuestions } from "../../../src/db/repositories/question.repository";

describe("question repository", () => {
  it("loads options in D1-safe batches for a large survey", async () => {
    const all = vi.fn(async () => ({
      results: [
        {
          id: 1,
          question_id: 1,
          label: "选项",
          value: "选项",
          order: 0,
          is_other: 0,
          created_at: "2026-08-15T00:00:00.000Z",
          updated_at: "2026-08-15T00:00:00.000Z",
        },
      ],
    }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    const options = await listOptionsForQuestions(
      db,
      Array.from({ length: 181 }, (_, index) => index + 1),
    );

    expect(options).toHaveLength(3);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(bind.mock.calls.map((call) => call.length)).toEqual([90, 90, 1]);
  });
});
