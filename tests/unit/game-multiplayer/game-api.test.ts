import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveParticipant: vi.fn(),
  createAuditLog: vi.fn(),
}));

// 身份解析打桩：REST 层的契约是"participant 或 401 Response"，真实 HMAC/D1
// 链路由 participant.ts 自己的单测覆盖。
vi.mock("../../../src/http/survey/participant", () => ({ resolveParticipant: mocks.resolveParticipant }));
// 审计打桩：writeAudit 捕获内部异常，这里要看的是"调用是否发生、参数对不对"。
vi.mock("../../../src/db/repositories/audit.repository", () => ({ createAuditLog: mocks.createAuditLog }));

import { handleGameApiRequest } from "../../../src/http/game-api";
import { GameRoomDO } from "../../../src/durable-objects/game-room";
import { clearGameEnginesForTest, registerGameEngine } from "../../../src/game/multiplayer/engine-registry";
import { gomokuEngine } from "../../../src/game/multiplayer/engines/gomoku";
import type { GameRoomState } from "../../../src/game/multiplayer/engine-types";
import { stubEngine } from "../../helpers/game-engine-stub";
import type { Env } from "../../../src/index";

const HOST = "hash-host";
const HOST_PARTICIPANT = {
  kind: "telegram" as const,
  dbUserId: 42,
  telegramUserId: 123,
  participantKey: null,
  participantHash: HOST,
};

/** 按 SQL 前缀路由的假 D1（me-api.test.ts 先例），并记录语句供断言。 */
function makeDb(routes: Array<[RegExp, unknown]>): { db: D1Database; sqls: string[] } {
  const sqls: string[] = [];
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      const statement = {
        bind(..._args: unknown[]) {
          return statement;
        },
        async first() {
          const matched = routes.find(([pattern]) => pattern.test(sql));
          return matched ? matched[1] : null;
        },
        async all() {
          const matched = routes.find(([pattern]) => pattern.test(sql));
          return { results: matched && Array.isArray(matched[1]) ? matched[1] : [] };
        },
        async run() {
          const matched = routes.find(([pattern]) => pattern.test(sql));
          return (matched && !Array.isArray(matched[1]) ? matched[1] : { meta: { last_row_id: 0 } }) as unknown;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, sqls };
}

/** KV（CACHE）打桩：checkRateLimit 的 rl:v1:* 键读写走这里。 */
function makeCache(prefill: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(prefill));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

/** 包一个真实 GameRoomDO（map-backed 假 ctx）成 DO namespace。 */
function makeNamespace(instance: GameRoomDO & { ctx: unknown }): DurableObjectNamespace {
  return {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        instance.fetch(input instanceof Request ? input : new Request(input, init)),
    })),
  } as unknown as DurableObjectNamespace;
}

function makeDOInstance(): { instance: GameRoomDO & { ctx: unknown }; storage: Map<string, unknown> } {
  const storage = new Map<string, unknown>();
  const fake = {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
      delete: async (key: string) => {
        storage.delete(key);
      },
      list: async () => new Map(),
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      deleteAll: async () => storage.clear(),
    },
    acceptWebSocket: () => {},
    getWebSockets: () => [] as WebSocket[],
  };
  const instance = Object.create(GameRoomDO.prototype) as GameRoomDO & { ctx: unknown };
  instance.ctx = fake as unknown as typeof instance.ctx;
  return { instance, storage };
}

function makeEnv(db: D1Database, cache: ReturnType<typeof makeCache>, namespace: DurableObjectNamespace | null): Env {
  return { DB: db, CACHE: cache, ...(namespace ? { GAME_ROOM: namespace } : {}) } as unknown as Env;
}

function post(path: string, body: unknown): Request {
  return new Request(`https://worker${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://worker${path}`, { method: "GET", headers });
}

beforeEach(() => {
  clearGameEnginesForTest();
  registerGameEngine(stubEngine);
  mocks.resolveParticipant.mockReset();
  mocks.createAuditLog.mockReset();
  mocks.resolveParticipant.mockResolvedValue(HOST_PARTICIPANT);
  mocks.createAuditLog.mockResolvedValue(undefined);
});

describe("game-api 鉴权", () => {
  it("未鉴权的创建请求直接 401，不触 D1 也不建 DO 房间", async () => {
    const { instance, storage } = makeDOInstance();
    const { db } = makeDb([]);
    const cache = makeCache();
    mocks.resolveParticipant.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, code: "identity_required", message: "缺少答卷者身份" }), {
        status: 401,
      }),
    );
    const response = await handleGameApiRequest(
      post("/api/game/rooms", { gameType: "stub-guess" }),
      makeEnv(db, cache, makeNamespace(instance)),
      new URL("https://worker/api/game/rooms"),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    expect(cache.put).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });

  it("未鉴权的 WS 升级请求在升级前被拒 401（绝不转发升级）", async () => {
    const { instance } = makeDOInstance();
    const namespace = makeNamespace(instance);
    const { db } = makeDb([]);
    mocks.resolveParticipant.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, code: "identity_required", message: "缺少答卷者身份" }), {
        status: 401,
      }),
    );
    const response = await handleGameApiRequest(
      get("/api/game/rooms/1/ws", { Upgrade: "websocket" }),
      makeEnv(db, makeCache(), namespace),
      new URL("https://worker/api/game/rooms/1/ws"),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    // DO 实例从未收到任何请求。
    expect(namespace.get as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe("game-api 限流", () => {
  it("创建超过 10 次/小时返回 429（Retry-After 头）", async () => {
    const { instance } = makeDOInstance();
    const windowIndex = Math.floor(Date.now() / 3_600_000);
    const cache = makeCache({ [`rl:v1:game-room-create:${HOST}:${windowIndex}`]: "10" });
    const response = await handleGameApiRequest(
      post("/api/game/rooms", { gameType: "stub-guess" }),
      makeEnv(makeDb([]).db, cache, makeNamespace(instance)),
      new URL("https://worker/api/game/rooms"),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(429);
    expect(response!.headers.get("Retry-After")).not.toBeNull();
  });

  it("加入超过 30 次/小时返回 429", async () => {
    const { instance } = makeDOInstance();
    const windowIndex = Math.floor(Date.now() / 3_600_000);
    const cache = makeCache({ [`rl:v1:game-room-join:${HOST}:${windowIndex}`]: "30" });
    const response = await handleGameApiRequest(
      post("/api/game/rooms/1/join", {}),
      makeEnv(makeDb([]).db, cache, makeNamespace(instance)),
      new URL("https://worker/api/game/rooms/1/join"),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(429);
  });
});

describe("game-api 创建-加入-列表流程（DO stub 全链路）", () => {
  it("创建：写目录行 → DO 建房 → 审计 game_room_create；roomRef 是锁定的 room_<id>", async () => {
    const { instance, storage } = makeDOInstance();
    const insertSpy = { meta: { last_row_id: 7 } };
    const { db, sqls } = makeDb([[/INSERT INTO game_rooms/, insertSpy]]);
    const response = await handleGameApiRequest(
      post("/api/game/rooms", { gameType: "stub-guess", displayName: "房主" }),
      makeEnv(db, makeCache(), makeNamespace(instance)),
      new URL("https://worker/api/game/rooms"),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const payload = (await response!.json()) as {
      room: { id: number; gameType: string };
      roomRef: string;
      view: { view: { mySecret: string } };
    };
    // 深链接格式锁定：roomRef = room_<自增 id>，G3 生成器按此拼 startapp。
    expect(payload.room).toEqual({ id: 7, gameType: "stub-guess", status: "lobby" });
    expect(payload.roomRef).toBe("room_7");
    expect(payload.view.view.mySecret).toBe(`secret-of-${HOST}`);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain("INSERT INTO game_rooms");
    // DO 房间已建立，房主在座。
    const room = storage.get("room") as GameRoomState;
    expect(room.roomId).toBe("room_7");
    expect(room.players[0]!.participantHash).toBe(HOST);
    expect(room.players[0]!.isHost).toBe(true);
    // 审计：actor = participant.dbUserId，entityId 是目录行 id。
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorUserId: 42, action: "game_room_create", entityType: "game_room", entityId: "7" }),
    );
  });

  it("DO 建房失败时回收目录行（不留孤儿索引行）", async () => {
    // 未登记玩法：INSERT 成功，DO 返回 unknown_game_type → DELETE 目录行。
    const storage = new Map<string, unknown>();
    const fake = {
      storage: {
        get: async (k: string) => storage.get(k),
        put: async () => {},
        delete: async () => {},
        list: async () => new Map(),
        getAlarm: async () => null,
        setAlarm: async () => {},
        deleteAlarm: async () => {},
        deleteAll: async () => {},
      },
      acceptWebSocket: () => {},
      getWebSockets: () => [] as WebSocket[],
    };
    const instance = Object.create(GameRoomDO.prototype) as GameRoomDO & { ctx: unknown };
    instance.ctx = fake as unknown as typeof instance.ctx;
    const { db, sqls } = makeDb([
      [/INSERT INTO game_rooms/, { meta: { last_row_id: 3 } }],
      [/DELETE FROM game_rooms/, { meta: {} }],
    ]);
    const response = await handleGameApiRequest(
      post("/api/game/rooms", { gameType: "no-such-game" }),
      makeEnv(db, makeCache(), makeNamespace(instance)),
      new URL("https://worker/api/game/rooms"),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
    expect(((await response!.json()) as { code: string }).code).toBe("unknown_game_type");
    expect(sqls.some((sql) => sql.includes("DELETE FROM game_rooms"))).toBe(true);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("加入：透传按人裁剪视图，不写 D1 不写审计", async () => {
    const { instance, storage } = makeDOInstance();
    await instance.fetch(
      new Request("https://game-room/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameType: "stub-guess", roomId: "room_1", host: { participantHash: HOST } }),
      }),
    );
    const GUEST = "hash-guest";
    mocks.resolveParticipant.mockResolvedValue({ ...HOST_PARTICIPANT, participantHash: GUEST });
    const { db, sqls } = makeDb([]);
    const response = await handleGameApiRequest(
      post("/api/game/rooms/1/join", { displayName: "客人" }),
      makeEnv(db, makeCache(), makeNamespace(instance)),
      new URL("https://worker/api/game/rooms/1/join"),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const payload = (await response!.json()) as { roomRef: string; role: string; view: { view: { mySecret: string } } };
    expect(payload.roomRef).toBe("room_1");
    expect(payload.role).toBe("player");
    expect(payload.view.view.mySecret).toBe(`secret-of-${GUEST}`);
    // 加入路径零 D1 语句（实时态只在 DO）、零审计。
    expect(sqls).toHaveLength(0);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    expect((storage.get("room") as GameRoomState).players).toHaveLength(2);
  });

  it("列表：目录表直读（不触 DO），roomRef 随行；绝不外发 host_participant_hash（匿名哈希即凭证）", async () => {
    const { db } = makeDb([
      [
        /SELECT id, game_type/,
        [
          {
            id: 7,
            game_type: "stub-guess",
            status: "lobby",
            host_participant_hash: HOST,
            created_at: "2026-11-20T00:00:00Z",
            updated_at: "2026-11-20T00:00:00Z",
            closed_at: null,
          },
        ],
      ],
    ]);
    const response = await handleGameApiRequest(
      get("/api/game/rooms?limit=5"),
      makeEnv(db, makeCache(), null),
      new URL("https://worker/api/game/rooms?limit=5"),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const payload = (await response!.json()) as { rooms: Array<Record<string, unknown>> };
    expect(payload.rooms).toHaveLength(1);
    expect(payload.rooms[0]!.roomRef).toBe("room_7");
    // 复核修订：他人 participantHash 不出网（匿名哈希是 web_<participantKey>
    // 凭证本体），只给服务端判定的 isMine。
    expect(payload.rooms[0]!.hostParticipantHash).toBeUndefined();
    expect(JSON.stringify(payload.rooms[0])).not.toContain("host_participant_hash");
    expect(payload.rooms[0]!.isMine).toBe(true);
  });

  it("列表 isMine 按查看者判定：他人的房不是我的", async () => {
    mocks.resolveParticipant.mockResolvedValue({ ...HOST_PARTICIPANT, participantHash: "hash-other" });
    const { db } = makeDb([
      [
        /SELECT id, game_type/,
        [
          {
            id: 7,
            game_type: "stub-guess",
            status: "lobby",
            host_participant_hash: HOST,
            created_at: "2026-11-20T00:00:00Z",
            updated_at: "2026-11-20T00:00:00Z",
            closed_at: null,
          },
        ],
      ],
    ]);
    const response = await handleGameApiRequest(
      get("/api/game/rooms?limit=5"),
      makeEnv(db, makeCache(), null),
      new URL("https://worker/api/game/rooms?limit=5"),
    );
    const payload = (await response!.json()) as { rooms: Array<{ isMine?: boolean }> };
    expect(payload.rooms[0]!.isMine).toBe(false);
  });

  it("mine=1 时按房主哈希过滤（无身份则降级为匿名列表）", async () => {
    const captured: string[] = [];
    const { db } = makeDb([[/SELECT id, game_type/, []]]);
    const spyDb = {
      prepare(sql: string) {
        captured.push(sql);
        return (db as unknown as { prepare(sql: string): unknown }).prepare(sql);
      },
    } as unknown as D1Database;
    await handleGameApiRequest(
      get("/api/game/rooms?mine=1"),
      makeEnv(spyDb, makeCache(), null),
      new URL("https://worker/api/game/rooms?mine=1"),
    );
    expect(captured[0]).toContain("host_participant_hash = ?");
  });

  it("GAME_ROOM 绑定缺失：404 game_disabled（客户部署不启用的明确语义）", async () => {
    const { db } = makeDb([]);
    const response = await handleGameApiRequest(
      post("/api/game/rooms", { gameType: "stub-guess" }),
      makeEnv(db, makeCache(), null),
      new URL("https://worker/api/game/rooms"),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);
    expect(((await response!.json()) as { code: string }).code).toBe("game_disabled");
  });
});

describe("game-api WS 握手转发", () => {
  it("鉴权通过时携带 Upgrade 与身份头转发到 DO stub", async () => {
    let forwarded: Request | null = null;
    const namespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({
        fetch: async (input: Request) => {
          forwarded = input;
          return new Response(null, { status: 401 }); // 桩返回一个可检查的响应
        },
      })),
    } as unknown as DurableObjectNamespace;
    const response = await handleGameApiRequest(
      get("/api/game/rooms/5/ws", { Upgrade: "websocket", Connection: "Upgrade" }),
      makeEnv(makeDb([]).db, makeCache(), namespace),
      new URL("https://worker/api/game/rooms/5/ws"),
    );
    expect(response).not.toBeNull();
    expect(forwarded).not.toBeNull();
    expect(forwarded!.headers.get("Upgrade")?.toLowerCase()).toBe("websocket");
    expect(forwarded!.headers.get("x-game-viewer-hash")).toBe(HOST);
    expect(namespace.idFromName as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("room_5");
  });

  it("非升级请求打到 /ws 返回 400 提示", async () => {
    const response = await handleGameApiRequest(
      get("/api/game/rooms/5/ws"),
      makeEnv(makeDb([]).db, makeCache(), makeNamespace(makeDOInstance().instance)),
      new URL("https://worker/api/game/rooms/5/ws"),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
  });
});

describe("game-api GET /api/game/types（已注册玩法列表）", () => {
  it("公开 GET 返回注册表里每个引擎的元数据；缺 meta 的引擎按 label 兜底、人数为 null", async () => {
    // beforeEach 已注册 stubEngine（无 meta）：走 label 兜底分支。
    const response = await handleGameApiRequest(
      get("/api/game/types"),
      makeEnv(makeDb([]).db, makeCache(), null),
      new URL("https://worker/api/game/types"),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = (await response!.json()) as {
      ok: boolean;
      games: Array<{
        name: string;
        displayName: string;
        description: string;
        minPlayers: number | null;
        maxPlayers: number | null;
      }>;
    };
    expect(body.ok).toBe(true);
    const stub = body.games.find((game) => game.name === "stub-guess");
    expect(stub).toEqual({
      name: "stub-guess",
      displayName: "协议测试桩",
      description: "",
      minPlayers: null,
      maxPlayers: null,
    });
  });

  it("带 meta 的引擎（gomoku）透出完整元数据；注册表空时返回空列表", async () => {
    registerGameEngine(gomokuEngine);
    const response = await handleGameApiRequest(
      get("/api/game/types"),
      makeEnv(makeDb([]).db, makeCache(), null),
      new URL("https://worker/api/game/types"),
    );
    const body = (await response!.json()) as { ok: boolean; games: Array<Record<string, unknown>> };
    expect(body.games.find((game) => game.name === "gomoku")).toEqual({
      name: "gomoku",
      displayName: "五子棋",
      description: "黑白轮流落子，先连成五子的一方获胜；每一步限时一分钟。",
      minPlayers: 2,
      maxPlayers: 2,
    });

    clearGameEnginesForTest();
    const empty = await handleGameApiRequest(
      get("/api/game/types"),
      makeEnv(makeDb([]).db, makeCache(), null),
      new URL("https://worker/api/game/types"),
    );
    expect(((await empty!.json()) as { games: unknown[] }).games).toEqual([]);
  });

  it("非 GET 返回 405；响应是纯元数据，不含任何玩家/房间私有信息（泄漏断言）", async () => {
    registerGameEngine(gomokuEngine);
    const methodCheck = await handleGameApiRequest(
      post("/api/game/types", {}),
      makeEnv(makeDb([]).db, makeCache(), null),
      new URL("https://worker/api/game/types"),
    );
    expect(methodCheck!.status).toBe(405);

    const response = await handleGameApiRequest(
      get("/api/game/types"),
      makeEnv(makeDb([]).db, makeCache(), null),
      new URL("https://worker/api/game/types"),
    );
    const raw = JSON.stringify(await response!.json());
    // 私有视图纪律：玩法列表只读注册表元数据，绝不允许夹带 participantHash、
    // 房间状态或引擎私有载荷（stub 引擎的 secret 也不得出现）。
    expect(raw).not.toContain("participantHash");
    expect(raw).not.toContain("secret-of-");
    expect(raw).not.toContain("engineState");
    expect(raw).not.toContain("roomId");
  });
});
