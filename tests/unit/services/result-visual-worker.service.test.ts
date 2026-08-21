import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendPhoto, sendDocument, sendMessage, sendPhotoAlbum, renderResultVisualPng, renderHtmlReportArtifact, parseVisualTemplateDefinition, resolveResultVisualImages } = vi.hoisted(() => ({
  sendPhoto: vi.fn(),
  sendDocument: vi.fn(),
  sendMessage: vi.fn(),
  sendPhotoAlbum: vi.fn(),
  renderResultVisualPng: vi.fn(),
  renderHtmlReportArtifact: vi.fn(),
  parseVisualTemplateDefinition: vi.fn(),
  resolveResultVisualImages: vi.fn(),
}));

vi.mock("../../../src/bot/telegram", () => ({ sendPhoto, sendDocument, sendMessage, sendPhotoAlbum }));
vi.mock("../../../src/services/result-visual-renderer.service", () => ({ renderResultVisualPng }));
vi.mock("../../../src/services/html-report-renderer.service", () => ({ renderHtmlReportArtifact }));
vi.mock("../../../src/services/result-visual-wasm", () => ({ RESULT_VISUAL_WASM: {} }));
vi.mock("../../../src/services/result-visual-font", () => ({
  RESULT_VISUAL_FONT: new Uint8Array([1]),
  RESULT_VISUAL_EMOJI_FONT: new Uint8Array([1]),
  RESULT_VISUAL_FONTS: [new Uint8Array([1])],
}));
vi.mock("../../../src/services/visual-template-validator.service", () => ({ parseVisualTemplateDefinition }));
vi.mock("../../../src/services/result-visual-image.service", () => ({ resolveResultVisualImages }));

import { processResultVisualMessage } from "../../../src/services/result-visual-worker.service";

const profileRow = {
  id: 4,
  survey_id: 2,
  response_id: 3,
  result_type: "custom",
  schema_version: 1,
  title: "测试结果",
  subtitle: null,
  fields_json: "{}",
  stats_json: "[]",
  tags_json: "[]",
  images_json: "{}",
  metadata_json: "{}",
  created_at: "now",
  updated_at: "now",
};

const templateVersionRow = {
  id: 5,
  template_id: 6,
  version: 1,
  template_schema_version: 1,
  definition_json: "{}",
  variables_json: "[]",
  created_by: null,
  created_at: "now",
};

function createDb(reportTemplate = false, requestedBy = 7): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const db = {
    prepare: vi.fn((statementSql: string) => {
      sql.push(statementSql);
      const statement = {
        bind: vi.fn(() => statement),
        run: vi.fn(async () => ({ success: true, meta: { changes: 1 } })),
        first: vi.fn(async () => {
          if (statementSql.includes("FROM render_jobs")) return {
            id: 8, result_profile_id: 4, template_id: 6, template_version: 1,
            chat_id: 99, requested_by: requestedBy, status: "queued", attempts: 0,
            force_regenerate: 0, error_code: null, error_message: null,
            created_at: "now", started_at: null, completed_at: null,
          };
          if (statementSql.includes("FROM result_profiles")) return profileRow;
          if (statementSql.includes("FROM survey_responses")) return {
            id: 3, survey_id: 2, user_id: 7, participant_hash: "hash", status: "completed",
            started_at: "now", completed_at: "now", submitted_at: "now", current_question_id: null,
            version: 1, created_at: "now", updated_at: "now",
          };
          if (statementSql.includes("FROM visual_template_versions")) return templateVersionRow;
          if (statementSql.includes("FROM visual_templates")) return reportTemplate ? {
            id: 6, owner_id: null, survey_id: null, name: "分页报告", description: null, type: "report", status: "published", current_version: 1, created_at: "now", updated_at: "now",
          } : null;
          return null;
        }),
      };
      return statement;
    }),
  } as unknown as D1Database;
  return { db, sql };
}

describe("result visual queue worker", () => {
  beforeEach(() => vi.clearAllMocks());
  it("sends rendered PNG bytes directly to Telegram without an intermediate object store", async () => {
    const { db, sql } = createDb();
    const png = new Uint8Array([137, 80, 78, 71]);
    parseVisualTemplateDefinition.mockReturnValue({ width: 1080, height: 1350 });
    resolveResultVisualImages.mockResolvedValue({});
    renderResultVisualPng.mockResolvedValue(png);
    sendPhoto.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await processResultVisualMessage({ DB: db, BOT_TOKEN: "token" }, { kind: "result_visual", jobId: 8 });

    expect(sendPhoto).toHaveBeenCalledWith("token", 99, png, "🎉 你的结果卡已生成", {
      inline_keyboard: [[{
        text: "🔄 重新生成",
        callback_data: "rv:regenerate:3",
      }]],
    });
    expect(sql.some((statement) => statement.includes("status = 'completed'"))).toBe(true);
    expect(sql.join("\n")).not.toContain("r2_");
    expect(sql.join("\n")).not.toContain("result_visuals");
  });

  it("delivers mobile previews, lossless pages, and an A4 archive", async () => {
    const { db, sql } = createDb(true);
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2]);
    const archivePdf = new Uint8Array([37, 80, 68, 70]);
    parseVisualTemplateDefinition.mockReturnValue({ width: 1080, height: 1350 });
    resolveResultVisualImages.mockResolvedValue({});
    renderHtmlReportArtifact.mockResolvedValue({
      pages: [
        { id: "page-01", kind: "cover", bytes: first, size: 1, width: 2560, height: 1800, type: "image/png" },
        { id: "page-02", kind: "verdict", bytes: second, size: 1, width: 2560, height: 1800, type: "image/png" },
      ],
      archivePdf, archivePdfSize: archivePdf.byteLength,
      totalPages: 2, totalBytes: 2, deliveryMode: "album", failures: [],
    });
    sendPhotoAlbum.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    sendDocument.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    await processResultVisualMessage({ DB: db, BOT_TOKEN: "token", BROWSER: {} as never }, { kind: "result_visual", jobId: 8 });
    expect(sendPhotoAlbum).toHaveBeenCalledWith("token", 99, [
      { bytes: first, caption: "🎉 你的分析报告 · 共 2 页" },
      { bytes: second },
    ]);
    expect(sendDocument).toHaveBeenNthCalledWith(1, "token", 99, "result-report-8-hd-01.png", first, "image/png");
    expect(sendDocument).toHaveBeenNthCalledWith(2, "token", 99, "result-report-8-hd-02.png", second, "image/png");
    expect(sendDocument).toHaveBeenNthCalledWith(3, "token", 99, "result-report-8-archive.pdf", archivePdf, "application/pdf");
    expect(sql.some((statement) => statement.includes("status = 'completed'"))).toBe(true);
  });

  it("continues after an individual report page delivery failure", async () => {
    const { db, sql } = createDb(true, 99);
    renderHtmlReportArtifact.mockResolvedValue({
      pages: [
        { id: "page-01", kind: "cover", bytes: new Uint8Array([1]), size: 1, width: 2560, height: 1800, type: "image/png" },
        { id: "page-02", kind: "verdict", bytes: new Uint8Array([2]), size: 1, width: 2560, height: 1800, type: "image/png" },
      ], totalPages: 2, totalBytes: 2, deliveryMode: "album", failures: [],
    });
    sendPhotoAlbum.mockRejectedValueOnce(new Error("album failed"));
    sendPhoto.mockRejectedValueOnce(new Error("page one failed")).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    sendDocument.mockRejectedValueOnce(new Error("document failed"));
    sendMessage.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    await processResultVisualMessage({ DB: db, BOT_TOKEN: "token", BROWSER: {} as never }, { kind: "result_visual", jobId: 8 });
    expect(sendPhoto).toHaveBeenCalledTimes(2);
    expect(sendPhoto).toHaveBeenLastCalledWith("token", 99, expect.any(Uint8Array), "分析报告 2/2 · verdict", {
      inline_keyboard: [[{ text: "🔄 重新生成", callback_data: "owner:response_report_generate:2:3:6" }]],
    });
    expect(sendMessage).toHaveBeenCalledWith("token", 99, expect.stringContaining("1 个页面生成或发送失败"));
    expect(sql.some((statement) => statement.includes("status = 'completed'"))).toBe(true);
  });
});
