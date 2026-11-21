import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveParticipant: vi.fn(),
}));

vi.mock("../../../src/http/survey/participant", () => ({ resolveParticipant: mocks.resolveParticipant }));

import { handleTrialApiRequest } from "../../../src/http/trial-api";
import type { Env } from "../../../src/index";
import { createTaskPack, updateTaskPack } from "../../../src/db/repositories/task-pack.repository";
import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * /trial 18+ 门禁下沉到包级的服务端强制点（0106，POST /api/trial/runs——
 * 爬塔与插件开局的唯一共同入口）：
 * - adult 包（爬塔读 adult 列、插件读清单 capabilities.adult）开局必须显式
 *   携带 adultAck: true（请求参数确认），未携带返回 451 + adult_ack_required
 *   且不产生 task_runs 行；
 * - 非 adult 包不带参数也放行；
 * - GET /api/trial/packs 带出 adult 字段（列值 + 管理端更新后翻转）。
 * 身份按 x-test-hash 头区分（resolveParticipant mock 读该头），模拟不同参与者。
 */
const PACK_NAME = "HTTP 18+ 包";

/** 最小合法 quest 内容（content.ts 的校验：version/title/start/nodes/choices.goto 均需存在）。 */
const QUEST_CONTENT = JSON.stringify({
  version: 1,
  title: "18+ 测试剧情",
  intro: "测试用",
  start: "n1",
  items: [],
  nodes: [
    { id: "n1", text: "开场", choices: [{ text: "继续", goto: "n2" }] },
    { id: "n2", text: "终章" },
  ],
});

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

describe.skipIf(!sqliteD1Available)("trial HTTP (adult pack server-side gate 0106)", () => {
  let db: D1Database;
  let env: Env;
  let adultPackId: number;
  let freePackId: number;
  let adultQuestPackId: number;

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

  const postRun = (packId: number, hash: string, extra: Record<string, unknown> = {}) =>
    run("POST", "/api/trial/runs", hash, { packId, persona: "male", mode: "normal", ...extra });

  const taskRunCount = async () =>
    Number((await db.prepare("SELECT COUNT(*) AS n FROM task_runs").first<{ n: number }>())?.n ?? 0);

  beforeEach(async () => {
    db = createSqliteD1(fullMigrationSchema());
    env = { DB: db, CACHE: createFakeKV(), ADMIN_IDS: "", BOT_TOKEN: "t", WEBHOOK_SECRET: "s" } as unknown as Env;
    mocks.resolveParticipant.mockReset();
    mocks.resolveParticipant.mockImplementation(async (req: Request) =>
      participant(req.headers.get("x-test-hash") ?? "web_ack_default"),
    );
    // 存量语义：createTaskPack 缺省 adult=false（0106 列默认 0）。
    const adultPack = await createTaskPack(db, {
      name: PACK_NAME,
      adult: true,
      items: [
        { title: "任务一", description: "描述一", score: 3 },
        { title: "任务二", description: "描述二", score: 4 },
      ],
    });
    adultPackId = adultPack.id;
    const freePack = await createTaskPack(db, {
      name: "全年龄包",
      items: [{ title: "轻任务", description: "描述", score: 2 }],
    });
    freePackId = freePack.id;
    // 插件 adult 包：quest 清单 capabilities.adult = true，成人判定不走列。
    const adultQuestPack = await createTaskPack(db, {
      name: "HTTP 18+ 剧情包",
      gameType: "quest",
      settings: { content: QUEST_CONTENT, packId: "test-quest", adult: true },
      items: [],
    });
    adultQuestPackId = adultQuestPack.id;
  });

  it("GET /api/trial/packs 带出 adult 字段（列值 + 管理端更新后翻转）", async () => {
    const packsBody = (await (await run("GET", "/api/trial/packs", "web_ack_none")).json()) as {
      packs: Array<{ id: number; adult: boolean }>;
    };
    expect(packsBody.packs.find((pack) => pack.id === adultPackId)?.adult).toBe(true);
    expect(packsBody.packs.find((pack) => pack.id === freePackId)?.adult).toBe(false);
    // 插件包的 adult 走清单 capabilities.adult（quest=true），与列值无关。
    expect(packsBody.packs.find((pack) => pack.id === adultQuestPackId)?.adult).toBe(true);

    await updateTaskPack(db, adultPackId, { adult: false });
    const afterBody = (await (await run("GET", "/api/trial/packs", "web_ack_none")).json()) as {
      packs: Array<{ id: number; adult: boolean }>;
    };
    expect(afterBody.packs.find((pack) => pack.id === adultPackId)?.adult).toBe(false);
  });

  it("未确认 adult 包开局被拒（451 adult_ack_required）且不建 task_runs 行", async () => {
    const blocked = await postRun(adultPackId, "web_ack_none");
    expect(blocked.status).toBe(451);
    expect(((await blocked.json()) as { code: string }).code).toBe("adult_ack_required");
    expect(await taskRunCount()).toBe(0);
  });

  it("adultAck: false（显式假值）同样被拒——参数必须为 true", async () => {
    const blocked = await postRun(adultPackId, "web_ack_false", { adultAck: false });
    expect(blocked.status).toBe(451);
    expect(((await blocked.json()) as { code: string }).code).toBe("adult_ack_required");
  });

  it("携带 adultAck: true 放行并建局；非 adult 包不带参数也放行", async () => {
    const acked = await postRun(adultPackId, "web_ack_pack", { adultAck: true });
    expect(acked.status).toBe(201);
    expect(await taskRunCount()).toBe(1);

    const free = await postRun(freePackId, "web_ack_free");
    expect(free.status).toBe(201);
    expect(await taskRunCount()).toBe(2);
  });

  it("插件 adult 包（quest）：无参数 451；带参数走清单判定放行", async () => {
    const blocked = await postRun(adultQuestPackId, "web_ack_plugin");
    expect(blocked.status).toBe(451);
    expect(((await blocked.json()) as { code: string }).code).toBe("adult_ack_required");
    expect(await taskRunCount()).toBe(0);

    const acked = await postRun(adultQuestPackId, "web_ack_plugin", { adultAck: true });
    expect(acked.status).toBe(201);
    expect(await taskRunCount()).toBe(1);
  });

  it("同包确认后重复开局不复查历史偏好：每次请求独立校验参数（无服务端 ack 存储）", async () => {
    const first = await postRun(adultPackId, "web_ack_twice", { adultAck: true });
    expect(first.status).toBe(201);
    // 同一参与者第二局必须重新显式携带参数——一局未完成限制会先拦（409），
    // 先放弃第一局再开，验证参数闸每次都生效。
    const active = (await (await run("GET", "/api/trial/runs/active", "web_ack_twice")).json()) as {
      run: { id: number } | null;
    };
    const abandon = await run("POST", `/api/trial/runs/${active.run!.id}/action`, "web_ack_twice", {
      action: "abandon",
    });
    expect(abandon.status).toBe(200);
    const second = await postRun(adultPackId, "web_ack_twice");
    expect(second.status).toBe(451);
    expect(((await second.json()) as { code: string }).code).toBe("adult_ack_required");
  });
});
