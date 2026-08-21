import { describe, expect, it, vi } from "vitest";

import {
  enqueueResultVisualJob,
  isResultVisualJobMessage,
} from "../../../src/services/result-visual-queue.service";

function createD1Mock(active = false): D1Database {
  return {
    prepare: vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn(() => statement),
        run: vi.fn(async () => ({ success: true, meta: { last_row_id: 12 } })),
        first: vi.fn(async () => {
          if (sql.includes("status IN ('queued', 'processing')")) return active ? {
            id: 11, result_profile_id: 4, template_id: 5, template_version: 6,
            chat_id: 7, requested_by: 8, status: "processing", attempts: 1,
            force_regenerate: 0, error_code: null, error_message: null,
            created_at: "now", started_at: "now", completed_at: null,
          } : null;
          if (sql.includes("FROM render_jobs")) {
            return {
              id: 12, result_profile_id: 4, template_id: 5, template_version: 6,
              chat_id: 7, requested_by: 8, status: "queued", attempts: 0,
              force_regenerate: 0, error_code: null, error_message: null,
              created_at: "now", started_at: null, completed_at: null,
            };
          }
          return null;
        }),
      };
      return statement;
    }),
  } as unknown as D1Database;
}

describe("result visual queue", () => {
  it("uses an explicit queue discriminator and rejects legacy-shaped messages", () => {
    expect(isResultVisualJobMessage({ kind: "result_visual", jobId: 1 })).toBe(true);
    expect(isResultVisualJobMessage({ jobId: 1, surveyId: 2, format: "csv" })).toBe(false);
    expect(isResultVisualJobMessage({ kind: "result_visual", jobId: 0 })).toBe(false);
  });

  it("does not enqueue a duplicate while an identical render is processing", async () => {
    const queue = { send: vi.fn() } as unknown as Queue;
    const result = await enqueueResultVisualJob(createD1Mock(true), queue, {
      resultProfileId: 4,
      templateId: 5,
      templateVersion: 6,
      chatId: 7,
      requestedBy: 8,
    });

    expect(result.status).toBe("processing");
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("persists and publishes one typed render job", async () => {
    const queue = { send: vi.fn(async () => undefined) } as unknown as Queue;
    const result = await enqueueResultVisualJob(createD1Mock(), queue, {
      resultProfileId: 4,
      templateId: 5,
      templateVersion: 6,
      chatId: 7,
      requestedBy: 8,
    });

    expect(result).toMatchObject({ status: "queued", job: { id: 12 } });
    expect(queue.send).toHaveBeenCalledWith({ kind: "result_visual", jobId: 12 });
  });
});
