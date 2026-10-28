import { describe, expect, it, vi } from "vitest";
import { drawTaskItems } from "../../../src/services/game-draw.service";
import type { TaskItemRecord, TaskPackRecord } from "../../../src/db/repositories/task-pack.repository";

vi.mock("../../../src/db/repositories/task-pack.repository", () => ({
  getTaskPackById: vi.fn(),
}));

import { getTaskPackById } from "../../../src/db/repositories/task-pack.repository";

function item(overrides: Partial<TaskItemRecord>): TaskItemRecord {
  return {
    id: 1,
    packId: 1,
    title: "任务",
    description: "描述",
    warning: "",
    score: 5,
    persona: "any",
    mode: "any",
    minFloor: 1,
    maxFloor: 99,
    enabled: true,
    sortOrder: 0,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function pack(items: TaskItemRecord[]): TaskPackRecord {
  return {
    id: 1,
    name: "包",
    description: null,
    gameType: "tower",
    settings: {},
    normalFloors: 10,
    hellFloors: 12,
    prepItems: [],
    prepText: null,
    enabled: true,
    sortOrder: 0,
    createdAt: "",
    updatedAt: "",
    items,
  };
}

describe("drawTaskItems（小游戏区通用抽取）", () => {
  it("包不存在返回 null", async () => {
    vi.mocked(getTaskPackById).mockResolvedValueOnce(null);
    await expect(drawTaskItems({} as D1Database, 9, { count: 1 })).resolves.toBeNull();
  });

  it("停用条目不参与抽取，persona 过滤保留 any", async () => {
    vi.mocked(getTaskPackById).mockResolvedValueOnce(
      pack([
        item({ id: 1, enabled: false }),
        item({ id: 2, persona: "male" }),
        item({ id: 3, persona: "any" }),
      ]),
    );
    const drawn = await drawTaskItems({} as D1Database, 1, { persona: "female", count: 5 });
    expect(drawn?.map((entry) => entry.id)).toEqual([3]);
  });

  it("加权不放回：count 超过池子时抽干即止，一批内不重复", async () => {
    vi.mocked(getTaskPackById).mockResolvedValueOnce(
      pack([item({ id: 1, score: 1 }), item({ id: 2, score: 20 }), item({ id: 3, score: 1 })]),
    );
    const drawn = await drawTaskItems({} as D1Database, 1, { count: 8 });
    expect(drawn).toHaveLength(3);
    expect(new Set(drawn?.map((entry) => entry.id)).size).toBe(3);
  });

  it("权重为 0 的极端分数也会被夹到 1（不出现除零/死循环）", async () => {
    vi.mocked(getTaskPackById).mockResolvedValueOnce(pack([item({ id: 1, score: 1 }), item({ id: 2, score: 2 })]));
    const drawn = await drawTaskItems({} as D1Database, 1, { count: 2, random: () => 0.999 });
    expect(drawn).toHaveLength(2);
  });
});
