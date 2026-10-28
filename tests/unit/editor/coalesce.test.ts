import { describe, expect, it } from "vitest";
import {
  canMergePendingPatch,
  HISTORY_COALESCE_WINDOW_MS,
  shouldCoalesceHistory,
} from "../../../admin/src/editor/coalesce";

/**
 * S5 命令日志的合并判定：一串连续同类编辑（打字）只占一个撤销步骤，
 * 相邻同路径 PATCH 合并成一条待保存操作（后写字段胜出）。
 */
describe("shouldCoalesceHistory", () => {
  it("同 label 且在 800ms 窗口内 → 合并", () => {
    expect(
      shouldCoalesceHistory({ label: "题目标题", at: 1_000 }, "题目标题", 1_000 + HISTORY_COALESCE_WINDOW_MS - 1),
    ).toBe(true);
  });

  it("超过 800ms 窗口 → 不合并（新的撤销步骤）", () => {
    expect(
      shouldCoalesceHistory({ label: "题目标题", at: 1_000 }, "题目标题", 1_000 + HISTORY_COALESCE_WINDOW_MS),
    ).toBe(false);
  });

  it("label 不同（切到别的字段/别的题）→ 不合并", () => {
    expect(shouldCoalesceHistory({ label: "题目标题", at: 1_000 }, "题目描述", 1_050)).toBe(false);
  });

  it("没有上一条历史 → 不合并", () => {
    expect(shouldCoalesceHistory(null, "题目标题", 1_000)).toBe(false);
  });
});

describe("canMergePendingPatch", () => {
  it("相邻同路径 PATCH → 合并", () => {
    expect(
      canMergePendingPatch(
        { method: "PATCH", path: "/api/admin/surveys/1/questions/3" },
        { method: "PATCH", path: "/api/admin/surveys/1/questions/3" },
      ),
    ).toBe(true);
  });

  it("路径不同 / 方法不同 / 无前条 → 不合并", () => {
    expect(
      canMergePendingPatch(
        { method: "PATCH", path: "/api/admin/surveys/1/questions/3" },
        { method: "PATCH", path: "/api/admin/surveys/1/questions/4" },
      ),
    ).toBe(false);
    expect(
      canMergePendingPatch(
        { method: "POST", path: "/api/admin/surveys/1/questions/3" },
        { method: "PATCH", path: "/api/admin/surveys/1/questions/3" },
      ),
    ).toBe(false);
    expect(canMergePendingPatch(null, { method: "PATCH", path: "/api/admin/surveys/1/questions/3" })).toBe(false);
  });
});
