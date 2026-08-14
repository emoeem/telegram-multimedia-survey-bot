import { describe, expect, it } from "vitest";

import {
  buildCsv,
  buildExportZip,
  buildXlsx,
  type ResponseRow,
} from "../../../src/services/export.service";

describe("export service", () => {
  it("builds CSV from response rows", () => {
    const csv = buildCsv([
      {
        response_id: 1,
        status: "completed",
        started_at: "2026-08-14T00:00:00.000Z",
        completed_at: "2026-08-14T00:01:00.000Z",
        "你的名字？": "Alice",
      },
    ]);

    expect(csv).toContain("response_id");
    expect(csv).toContain('"Alice"');
  });

  it("builds a zip export", () => {
    const csv = "id,name\n1,Alice";
    const zip = buildExportZip(csv, [
      {
        response_id: 1,
        status: "completed",
        started_at: "2026-08-14T00:00:00.000Z",
        completed_at: null,
      } as ResponseRow,
    ]);

    expect(zip.length).toBeGreaterThan(0);
  });

  it("builds an xlsx export", () => {
    const rows: ResponseRow[] = [
      {
        response_id: 1,
        status: "completed",
        started_at: "2026-08-14T00:00:00.000Z",
        completed_at: null,
      },
    ];

    const xlsx = buildXlsx(rows);
    expect(xlsx.byteLength).toBeGreaterThan(0);
  });
});
