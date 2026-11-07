import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const adminSrc = join(process.cwd(), "admin", "src");

/**
 * 纸条复核页接线守卫（lazy-routes.test.ts 同款 fs 断言）：三处缺一，
 * 被举报/隐藏的纸条就没有页面可处置，运营只能 curl。端点字符串断言落在
 * api.ts 的封装上——页面经 fetchAdminNotes / setAdminNoteStatus 调用，
 * 不直接拼 URL（零新 API，只锁既有 note-api 管理端点的封装存在）。
 */
describe("纸条复核页（/admin/notes）接线", () => {
  it("App.tsx 注册 notes 路由并经 React.lazy 加载", () => {
    const app = readFileSync(join(adminSrc, "App.tsx"), "utf8");
    expect(app).toContain('path: "notes"');
    expect(app).toMatch(/^const NoteReviewPage = lazy\(/m);
  });

  it("api.ts 封装列表与状态两个端点字符串", () => {
    const api = readFileSync(join(adminSrc, "api.ts"), "utf8");
    // GET /api/note/admin/notes?status=…（src/http/note-api.ts adminListNotes）
    expect(api).toContain("/api/note/admin/notes?status=");
    expect(api).toContain("export function fetchAdminNotes(");
    // POST /api/note/admin/notes/:id/status（adminSetNoteStatus）
    expect(api).toContain("/api/note/admin/notes/${id}/status");
    expect(api).toContain("export function setAdminNoteStatus(");
  });

  it("Layout.tsx 标题映射含「纸条复核」", () => {
    const layout = readFileSync(join(adminSrc, "components", "Layout.tsx"), "utf8");
    expect(layout).toContain('path.startsWith("/notes")');
    expect(layout).toContain("纸条复核");
  });
});
