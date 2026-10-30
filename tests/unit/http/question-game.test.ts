import { describe, expect, it } from "vitest";

import { validateQuestionPayload } from "../../../src/http/admin/helpers";

/**
 * game 题（小游戏题）的 settings.game 白名单回归。
 *
 * 背景：2026-10-30 之前，settings 白名单只有 columns/speaker/scene，
 * 编辑器「绑定任务包」下拉写入的 settings.game 会被静默丢弃——导入的
 * quest/flip-card 扩展包根本接不进问卷（E2E 游玩时发现的断点）。
 */
describe("game 题 payload（settings.game 绑定）", () => {
  it("创建时接受 settings.game 并回填规范形状", () => {
    const result = validateQuestionPayload(
      { type: "game", title: "午夜站台", required: true, settings: { game: { packId: 6, gameType: "quest" } } },
      true,
    );
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.payload?.settingsJson ?? "{}")).toEqual({ game: { packId: 6, gameType: "quest" } });
  });

  it("gameType 缺省时只存 packId；packId 非法时拒绝", () => {
    const minimal = validateQuestionPayload({ type: "game", title: "小游戏", settings: { game: { packId: 7 } } }, true);
    expect(minimal.error).toBeUndefined();
    expect(JSON.parse(minimal.payload?.settingsJson ?? "{}")).toEqual({ game: { packId: 7 } });

    const badPack = (packId: unknown) =>
      validateQuestionPayload({ type: "game", title: "小游戏", settings: { game: { packId } } }, true).error;
    expect(badPack(0)).toContain("packId");
    expect(badPack(-1)).toContain("packId");
    expect(badPack(undefined)).toContain("packId");
  });

  it("非 game 题不允许 settings.game；PATCH 既有 game 题可换绑", () => {
    expect(
      validateQuestionPayload({ type: "text", title: "x", settings: { game: { packId: 1 } } }, true).error,
    ).toContain("仅 game 题");

    // 与 question-note.test.ts 同款：PATCH 时校验器按存量题型收口。
    const rebind = validateQuestionPayload({ settings: { game: { packId: 9 } } }, false, "game");
    expect(rebind.error).toBeUndefined();
    expect(JSON.parse(rebind.payload?.settingsJson ?? "{}")).toEqual({ game: { packId: 9 } });

    const onNonGame = validateQuestionPayload({ settings: { game: { packId: 9 } } }, false, "text");
    expect(onNonGame.error).toContain("仅 game 题");
  });
});
