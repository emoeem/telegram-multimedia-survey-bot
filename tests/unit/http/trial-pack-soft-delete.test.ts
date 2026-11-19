import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveParticipant: vi.fn(),
}));

vi.mock("../../../src/http/survey/participant", () => ({ resolveParticipant: mocks.resolveParticipant }));

import { handleTrialApiRequest } from "../../../src/http/trial-api";
import type { Env } from "../../../src/index";
import { deleteTaskPack, createTaskPack } from "../../../src/db/repositories/task-pack.repository";
import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * task_packs 软删（0101 墓碑）的玩家端 HTTP 验证（/api/trial/*）：
 * - GET /api/trial/packs 默认列表不含已删包；
 * - 对已删包 POST /api/trial/runs 开局被拒（404）；
 * - 进行中的局在包被软删后，GET /api/trial/runs/active 走既有 packMissing
 *   降级分支（自动结算 abandon，玩家不会被 run_active 锁死）；
 * - GET /api/trial/history 的包名映射显式含墓碑包：显示真实名称而非 #id
 *   （历史成绩保留，与「成绩已经发生，不因包下架消失」的榜单设计一致）。
 * 身份按 leaderboard-cache.test.ts 同款 mock 掉 resolveParticipant（匿名哈希）。
 */
const ANONYMOUS = {
  kind: "anonymous",
  dbUserId: null,
  telegramUserId: null,
  participantKey: "key-http",
  participantHash: "web_httpdel",
} as const;

const PACK_NAME = "HTTP 软删包";

function createFakeKV() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
  } as unknown as KVNamespace;
}

describe.skipIf(!sqliteD1Available)("trial HTTP (task pack soft delete 0101)", () => {
  let db: D1Database;
  let env: Env;
  let packId: number;

  const get = (path: string) =>
    handleTrialApiRequest(new Request(`https://bot.test${path}`), env, new URL(`https://bot.test${path}`));

  const post = (path: string, body: unknown) =>
    handleTrialApiRequest(
      new Request(`https://bot.test${path}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
      env,
      new URL(`https://bot.test${path}`),
    );

  beforeEach(async () => {
    db = createSqliteD1(fullMigrationSchema());
    env = { DB: db, CACHE: createFakeKV(), ADMIN_IDS: "", BOT_TOKEN: "t", WEBHOOK_SECRET: "s" } as unknown as Env;
    mocks.resolveParticipant.mockReset();
    mocks.resolveParticipant.mockResolvedValue(ANONYMOUS);
    const pack = await createTaskPack(db, {
      name: PACK_NAME,
      items: [
        { title: "任务一", description: "描述一", score: 3 },
        { title: "任务二", description: "描述二", score: 4 },
      ],
    });
    packId = pack.id;
  });

  it("玩家路径排除墓碑；进行中的局走 packMissing 降级；history 保留真实包名", async () => {
    // 软删前：packs 可见，开局成功（201）。
    const packsBefore = (await get("/api/trial/packs")) as Response;
    expect(packsBefore.status).toBe(200);
    expect(((await packsBefore.json()) as { packs: Array<{ id: number }> }).packs.some((p) => p.id === packId)).toBe(
      true,
    );

    const started = (await post("/api/trial/runs", { packId, persona: "male", mode: "normal" })) as Response;
    expect(started.status).toBe(201);

    await deleteTaskPack(db, packId);

    // 软删后：packs 不再含该包（玩家侧不可见）。
    const packsAfter = (await get("/api/trial/packs")) as Response;
    expect(((await packsAfter.json()) as { packs: Array<{ id: number }> }).packs.some((p) => p.id === packId)).toBe(
      false,
    );

    // 进行中的局不被锁死：/runs/active 命中既有 packMissing 分支并自动结算。
    const active = (await get("/api/trial/runs/active")) as Response;
    expect(active.status).toBe(200);
    const activeBody = (await active.json()) as { packMissing?: boolean; run: { status: string; packId: number } };
    expect(activeBody.packMissing).toBe(true);
    expect(activeBody.run.status).toBe("abandoned");
    expect(activeBody.run.packId).toBe(packId);

    // 结算后重新开局对已删包被拒（404 not_found）。
    const blocked = (await post("/api/trial/runs", { packId, persona: "male", mode: "normal" })) as Response;
    expect(blocked.status).toBe(404);
    expect(((await blocked.json()) as { code: string }).code).toBe("not_found");

    // history 的包名映射显式带墓碑包：真实名称，不退化 #id；对局记录仍在。
    const history = (await get("/api/trial/history")) as Response;
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as { runs: Array<{ packId: number; packName: string }> };
    const historyRun = historyBody.runs.find((run) => run.packId === packId);
    expect(historyRun).toBeTruthy();
    expect(historyRun?.packName).toBe(PACK_NAME);
  });
});
