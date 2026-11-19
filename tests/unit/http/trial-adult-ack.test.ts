import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveParticipant: vi.fn(),
}));

vi.mock("../../../src/http/survey/participant", () => ({ resolveParticipant: mocks.resolveParticipant }));

import { handleMeApiRequest } from "../../../src/http/me-api";
import { handleTrialApiRequest } from "../../../src/http/trial-api";
import type { Env } from "../../../src/index";
import { createTaskPack, updateTaskPack } from "../../../src/db/repositories/task-pack.repository";
import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * /trial 18+ 门禁下沉到包级的服务端强制点（0104，/api/trial/* 的第一个）：
 * - 未 ack 用户对 adult 包 POST /api/trial/runs 返回 451 且不产生 task_runs 行；
 * - 包级 ack（ackedAdultPackIds 命中）或全局 ack（ackAll）任一即放行；
 * - 非 adult 包、未 ack 也不受影响；
 * - ack 偏好经 /api/me/preferences（0080 先例扩展）读写并有回读断言。
 * 身份按 x-test-hash 头区分（resolveParticipant mock 读该头），模拟不同参与者。
 */
const PACK_NAME = "HTTP 18+ 包";

function participant(hash: string) {
  return {
    kind: "anonymous",
    dbUserId: null,
    telegramUserId: null,
    participantKey: `key-${hash}`,
    participantHash: hash,
  } as const;
}

function createFakeKV() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
  } as unknown as KVNamespace;
}

describe.skipIf(!sqliteD1Available)("trial HTTP (adult pack server-side gate 0104)", () => {
  let db: D1Database;
  let env: Env;
  let adultPackId: number;
  let freePackId: number;

  function request(method: "GET" | "POST", path: string, hash: string, body?: unknown): Request {
    return new Request(`https://bot.test${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-test-hash": hash,
      },
    });
  }

  const run = async (method: "GET" | "POST", path: string, hash: string, body?: unknown) => {
    const response = await handleTrialApiRequest(
      request(method, path, hash, body),
      env,
      new URL(`https://bot.test${path}`),
    );
    return response as Response;
  };

  const preferences = async (method: "GET" | "POST", hash: string, body?: unknown) => {
    const response = (await handleMeApiRequest(
      request(method, "/api/me/preferences", hash, body),
      env,
      new URL("https://bot.test/api/me/preferences"),
    )) as Response;
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const postRun = (packId: number, hash: string) =>
    run("POST", "/api/trial/runs", hash, { packId, persona: "male", mode: "normal" });

  const taskRunCount = async () =>
    Number((await db.prepare("SELECT COUNT(*) AS n FROM task_runs").first<{ n: number }>())?.n ?? 0);

  beforeEach(async () => {
    db = createSqliteD1(fullMigrationSchema());
    env = { DB: db, CACHE: createFakeKV(), ADMIN_IDS: "", BOT_TOKEN: "t", WEBHOOK_SECRET: "s" } as unknown as Env;
    mocks.resolveParticipant.mockReset();
    mocks.resolveParticipant.mockImplementation(async (req: Request) =>
      participant(req.headers.get("x-test-hash") ?? "web_ack_default"),
    );
    // 存量包语义：createTaskPack 缺省 adult=true（列默认 1）。
    const adultPack = await createTaskPack(db, {
      name: PACK_NAME,
      items: [
        { title: "任务一", description: "描述一", score: 3 },
        { title: "任务二", description: "描述二", score: 4 },
      ],
    });
    adultPackId = adultPack.id;
    const freePack = await createTaskPack(db, {
      name: "全年龄包",
      adult: false,
      items: [{ title: "轻任务", description: "描述", score: 2 }],
    });
    freePackId = freePack.id;
  });

  it("GET /api/trial/packs 带出 adult 字段（列值 + 管理端更新后翻转）", async () => {
    const packsBody = (await (await run("GET", "/api/trial/packs", "web_ack_none")).json()) as {
      packs: Array<{ id: number; adult: boolean }>;
    };
    expect(packsBody.packs.find((pack) => pack.id === adultPackId)?.adult).toBe(true);
    expect(packsBody.packs.find((pack) => pack.id === freePackId)?.adult).toBe(false);

    await updateTaskPack(db, adultPackId, { adult: false });
    const afterBody = (await (await run("GET", "/api/trial/packs", "web_ack_none")).json()) as {
      packs: Array<{ id: number; adult: boolean }>;
    };
    expect(afterBody.packs.find((pack) => pack.id === adultPackId)?.adult).toBe(false);
  });

  it("未 ack 用户对 adult 包开局被拒（451）且不建 task_runs 行", async () => {
    const blocked = await postRun(adultPackId, "web_ack_none");
    expect(blocked.status).toBe(451);
    expect(((await blocked.json()) as { code: string }).code).toBe("adult_ack_required");
    expect(await taskRunCount()).toBe(0);
  });

  it("非 adult 包不受影响；包级 ack 放行且只对该包生效；全局 ack 放行所有包", async () => {
    // 非 adult 包：未 ack 也放行（201）。
    const free = await postRun(freePackId, "web_ack_free");
    expect(free.status).toBe(201);

    // 包级 ack：命中该包放行；只 ack 了别的包的用户仍被拒（包级粒度）。
    await preferences("POST", "web_ack_pack", { trialAdultAckedPackId: adultPackId });
    const acked = await postRun(adultPackId, "web_ack_pack");
    expect(acked.status).toBe(201);

    await preferences("POST", "web_ack_other_pack", { trialAdultAckedPackId: freePackId });
    const wrongPack = await postRun(adultPackId, "web_ack_other_pack");
    expect(wrongPack.status).toBe(451);

    // 全局 ack（单向兼容）：对任何 adult 包放行。
    await preferences("POST", "web_ack_all", { trialAdultAckAll: true });
    const global = await postRun(adultPackId, "web_ack_all");
    expect(global.status).toBe(201);
    const secondAdult = await createTaskPack(db, {
      name: "另一个 18+ 包",
      items: [{ title: "任务", description: "描述", score: 2 }],
    });
    const globalOther = await postRun(secondAdult.id, "web_ack_all_other");
    expect(globalOther.status).toBe(451);
    await preferences("POST", "web_ack_all_other", { trialAdultAckAll: true });
    const globalOtherAfter = await postRun(secondAdult.id, "web_ack_all_other");
    expect(globalOtherAfter.status).toBe(201);
  });

  it("ack 偏好经 /api/me/preferences 读写有回读；重复 ack 幂等；非法输入 400", async () => {
    // 0080 原字段仍在，trial 字段缺省为未 ack 空态。
    const initial = await preferences("GET", "web_ack_pref");
    expect(initial.status).toBe(200);
    expect(initial.body.ageVerifiedAt).toBeNull();
    expect(initial.body.trialAdultAckAll).toBe(false);
    expect(initial.body.trialAdultAckedPackIds).toEqual([]);

    await preferences("POST", "web_ack_pref", { trialAdultAckedPackId: adultPackId });
    await preferences("POST", "web_ack_pref", { trialAdultAckedPackId: adultPackId });
    await preferences("POST", "web_ack_pref", { trialAdultAckedPackId: freePackId });
    const after = await preferences("GET", "web_ack_pref");
    expect(after.body.trialAdultAckedPackIds).toEqual([adultPackId, freePackId].sort((a, b) => a - b));
    expect(after.body.trialAdultAckAll).toBe(false);

    await preferences("POST", "web_ack_pref", { trialAdultAckAll: true });
    const global = await preferences("GET", "web_ack_pref");
    expect(global.body.trialAdultAckAll).toBe(true);
    // 全局 ack 不清空包级列表（两列互不覆盖）。
    expect((global.body.trialAdultAckedPackIds as number[]).length).toBe(2);

    const badFlag = await preferences("POST", "web_ack_pref", { trialAdultAckAll: "yes" });
    expect(badFlag.status).toBe(400);
    const badId = await preferences("POST", "web_ack_pref", { trialAdultAckedPackId: 0 });
    expect(badId.status).toBe(400);
    const badLegacy = await preferences("POST", "web_ack_pref", { ageVerified: "sure" });
    expect(badLegacy.status).toBe(400);
  });
});
