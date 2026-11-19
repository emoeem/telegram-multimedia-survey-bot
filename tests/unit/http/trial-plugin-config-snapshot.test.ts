import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveParticipant: vi.fn(),
}));

vi.mock("../../../src/http/survey/participant", () => ({ resolveParticipant: mocks.resolveParticipant }));

import { handleTrialApiRequest } from "../../../src/http/trial-api";
import type { Env } from "../../../src/index";
import { createTaskPack, updateTaskPack } from "../../../src/db/repositories/task-pack.repository";
import { getTaskRunById } from "../../../src/db/repositories/task-run.repository";
import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 插件局开局配置快照（0103 config_json）的 HTTP 端到端验证：
 * - 开局 run 的 config_json 非空且等于开局时的包配置（归一化后）；
 * - 开局后管理端改 gameType/settings，进行中 run 的 view/apply/grade 仍用
 *   开局配置——不再触发 trial-plugin-api.ts catch 的 abandoned 兜底结算；
 * - summary 的玩法标题用快照 gameType，不随包改玩法漂移；
 * - 存量无快照行（config_json NULL）回退现读包配置（0103 之前的行为）。
 *
 * 用 guess 玩法做确定性断言：开局后把 rangeMax 从 100 改到 10、score 从 20
 * 改到 100——谜底（如 50）在新配置下「越界无效」，只有走快照才能命中结算，
 * 且得分按快照的 score=20/attempts=7 而不是新值。
 */
const ANONYMOUS = {
  kind: "anonymous",
  dbUserId: null,
  telegramUserId: null,
  participantKey: "key-snap",
  participantHash: "web_snapshot",
} as const;

const START_SETTINGS = { rangeMin: 1, rangeMax: 100, attempts: 7, score: 20 };
const CHANGED_SETTINGS = { rangeMin: 1, rangeMax: 10, attempts: 5, score: 100 };

function createFakeKV() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
  } as unknown as KVNamespace;
}

describe.skipIf(!sqliteD1Available)("trial HTTP (plugin run config snapshot 0103)", () => {
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
      name: "快照包",
      gameType: "guess",
      settings: { ...START_SETTINGS },
      items: [],
    });
    packId = pack.id;
  });

  async function startGuessRun(): Promise<{ runId: number; secret: number; attemptsLeft: number }> {
    const started = (await post("/api/trial/runs", { packId, persona: "male", mode: "normal" })) as Response;
    expect(started.status).toBe(201);
    const body = (await started.json()) as { run: { id: number } };
    const record = (await getTaskRunById(db, body.run.id))!;
    const state = record.plugin?.state as { secret: number; attemptsLeft: number };
    return { runId: record.id, secret: state.secret, attemptsLeft: state.attemptsLeft };
  }

  it("新局写入快照；改包后 view/apply/grade 仍用开局配置；summary 标题不漂移", async () => {
    const { runId, secret } = await startGuessRun();

    // 开局快照：config_json 非空且等于开局时的包配置（validateConfig 归一化后）。
    const created = (await getTaskRunById(db, runId))!;
    expect(created.configSnapshot).toEqual({ gameType: "guess", settings: { ...START_SETTINGS } });

    // 管理端改包：玩法换成 draw，配置整个换掉（write.ts 允许随时改、不查 active 局）。
    await updateTaskPack(db, packId, { gameType: "draw", settings: { ...CHANGED_SETTINGS } });

    // /runs/active 恢复视图用快照：区间/机会数还是开局值；玩法标题还是「猜数字」。
    const active = (await get("/api/trial/runs/active")) as Response;
    expect(active.status).toBe(200);
    const activeBody = (await active.json()) as {
      run: { plugin: string; pluginTitle: string; status: string };
      view: { payload: { range: [number, number]; attempts: number } };
      packEnabled: boolean;
    };
    expect(activeBody.packEnabled).toBe(true);
    expect(activeBody.run.plugin).toBe("guess");
    expect(activeBody.run.pluginTitle).toBe("猜数字");
    expect(activeBody.view.payload.range).toEqual([1, 100]);
    expect(activeBody.view.payload.attempts).toBe(7);

    // 先错一发（扣一次机会），再猜中：apply/grade 都按快照配置结算。
    const wrong = secret === 1 ? 2 : secret - 1;
    const miss = (await post(`/api/trial/runs/${runId}/action`, {
      action: { kind: "guess", value: wrong },
    })) as Response;
    expect(miss.status).toBe(200);
    const missBody = (await miss.json()) as { finished: boolean; view: { payload: { attemptsLeft: number } } };
    expect(missBody.finished).toBe(false);
    expect(missBody.view.payload.attemptsLeft).toBe(6);

    const hit = (await post(`/api/trial/runs/${runId}/action`, {
      action: { kind: "guess", value: secret },
    })) as Response;
    expect(hit.status).toBe(200);
    const hitBody = (await hit.json()) as {
      finished: boolean;
      run: { plugin: string; pluginTitle: string; status: string; score: number };
      view: { status: string; payload: { range: [number, number] } };
      result: { score: number; grade: string | null; completed: boolean };
    };
    // 命中结算成功（不是 abandoned 兜底）：completed 且评级来自引擎而非 null。
    expect(hitBody.finished).toBe(true);
    expect(hitBody.result.completed).toBe(true);
    expect(hitBody.result.grade).toBe("S");
    // 计分用快照配置（score=20、attempts=7、剩 6 次机会）：ceil(20×6/7)=18，
    // 若错误地读了新配置会得到 ceil(100×6/5)=120。
    expect(hitBody.result.score).toBe(18);
    expect(hitBody.run.score).toBe(18);
    // 视图区间来自快照 [1,100]，不是改包后的 [1,10]。
    expect(hitBody.view.status).toBe("won");
    expect(hitBody.view.payload.range).toEqual([1, 100]);
    expect(hitBody.run.plugin).toBe("guess");
    expect(hitBody.run.pluginTitle).toBe("猜数字");

    // 落库状态：completed（而非 abandoned），快照原样保留。
    const settled = (await getTaskRunById(db, runId))!;
    expect(settled.status).toBe("completed");
    expect(settled.configSnapshot).toEqual({ gameType: "guess", settings: { ...START_SETTINGS } });
  });

  it("存量无快照行回退现读包配置：view/apply 用改包后的 settings", async () => {
    // 直接插一条 0103 之前的存量行：信封是 guess 局、config_json 为 NULL。
    const legacyState = { secret: 50, attemptsLeft: 7, score: 0, history: [], finished: false };
    const inserted = await db
      .prepare(
        `INSERT INTO task_runs (pack_id, user_id, participant_hash, persona, mode, starting_floor, current_floor, max_floor,
           score, completed_tasks, skipped_tasks, status, state_json, config_json, started_at, finished_at, updated_at)
         VALUES (?, NULL, ?, 'any', 'normal', 1, 1, 7, 0, 0, 0, 'active', ?, NULL, ?, NULL, ?)`,
      )
      .bind(
        packId,
        ANONYMOUS.participantHash,
        JSON.stringify({ kind: "plugin", plugin: "guess", state: legacyState }),
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      )
      .run();
    const legacyRunId = Number(inserted.meta?.last_row_id);

    // 管理端把区间缩到 [1,10]：存量行没有快照，只能回退现读。
    await updateTaskPack(db, packId, { settings: { ...CHANGED_SETTINGS } });

    // /runs/active（按 id DESC 命中存量行）：视图带现读配置的 [1,10]。
    const active = (await get("/api/trial/runs/active")) as Response;
    expect(active.status).toBe(200);
    const activeBody = (await active.json()) as {
      run: { id: number };
      view: { payload: { range: [number, number]; attempts: number } };
    };
    expect(activeBody.run.id).toBe(legacyRunId);
    expect(activeBody.view.payload.range).toEqual([1, 10]);
    expect(activeBody.view.payload.attempts).toBe(5);

    // 猜 50 在现读配置下越界 → 无效输入不推进（apply 走的是包配置而非快照）。
    const action = (await post(`/api/trial/runs/${legacyRunId}/action`, {
      action: { kind: "guess", value: 50 },
    })) as Response;
    expect(action.status).toBe(200);
    const actionBody = (await action.json()) as { finished: boolean; view: { payload: { range: [number, number] } } };
    expect(actionBody.finished).toBe(false);
    expect(actionBody.view.payload.range).toEqual([1, 10]);

    // 状态未被推进（attemptsLeft 仍是 7），局没有被动结算。
    const record = (await getTaskRunById(db, legacyRunId))!;
    expect(record.status).toBe("active");
    expect((record.plugin?.state as { attemptsLeft: number }).attemptsLeft).toBe(7);
    expect(record.configSnapshot).toBeUndefined();
  });
});
