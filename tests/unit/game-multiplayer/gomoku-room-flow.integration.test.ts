import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveParticipant: vi.fn(),
  createAuditLog: vi.fn(),
}));

// 身份解析打桩（game-api.test.ts 同款）：REST 层契约是"participant 或 401
// Response"，真实 HMAC/D1 链路由 participant.ts 自己的单测覆盖。
vi.mock("../../../src/http/survey/participant", () => ({ resolveParticipant: mocks.resolveParticipant }));
// 审计打桩：agent 只需要确认建房/关闭的审计调用不阻塞链路。
vi.mock("../../../src/db/repositories/audit.repository", () => ({ createAuditLog: mocks.createAuditLog }));

import { handleGameApiRequest } from "../../../src/http/game-api";
import { GameRoomDO } from "../../../src/durable-objects/game-room";
import { clearGameEnginesForTest } from "../../../src/game/multiplayer/engine-registry";
import { registerBuiltinMultiplayerEngines } from "../../../src/game/multiplayer/server-engines";
import type { GameRoomState, GameServerMessage } from "../../../src/game/multiplayer/engine-types";
import type { Env } from "../../../src/index";

/**
 * 五子棋房间整链路集成测试（W2）：REST 建房/加入 + 真实 GameRoomDO + WS
 * 开局/落子广播，引擎用 server-engines 注册的真实 gomokuEngine。
 *
 * 与 game-api.test.ts / game-room-do.test.ts 的分工：
 * - 那两个文件用桩引擎锁协议不变量（version/幂等/裁剪）；
 * - 本文件用真实玩法锁"路由 → DO → 引擎 → WS 线上形状"这条链路，
 *   覆盖任务清单：房间码、第二人座位、非房主开局、黑白分配、
 *   落子写回 stateVersion、WS 广播消息形状与视图裁剪。
 *
 * WS 说明：vitest 没有 workerd，`new Response(null, { status: 101 })` 构造
 * 不了 101（undici 限制），所以握手转发由 game-api.test.ts 的"Upgrade 头
 * 透传"用例覆盖；这里直接驱动 DO 的 Hibernation 面（registerSocket /
 * webSocketMessage），与 game-room-do.test.ts 的既有先例一致。
 */

const HOST = "hash-host";
const GUEST = "hash-guest";
const STRANGER = "hash-stranger";
const ROOM_ROW_ID = 21;

function participant(hash: string): {
  kind: "telegram";
  dbUserId: number;
  telegramUserId: number;
  participantKey: null;
  participantHash: string;
} {
  return {
    kind: "telegram",
    dbUserId: hash === HOST ? 42 : 43,
    telegramUserId: hash === HOST ? 123 : 456,
    participantKey: null,
    participantHash: hash,
  };
}

/** 假 D1：只服务建房 INSERT（last_row_id 固定），语句记录供断言。 */
function makeDb(): { db: D1Database; sqls: string[] } {
  const sqls: string[] = [];
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      const statement = {
        bind(..._args: unknown[]) {
          return statement;
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO game_rooms/.test(sql)) return { meta: { last_row_id: ROOM_ROW_ID } };
          return { meta: {} };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, sqls };
}

function makeCache() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

/** 假 WebSocket：与 game-room-do.test.ts 同款，记录 send 的线上帧。 */
function fakeSocket() {
  const sent: GameServerMessage[] = [];
  let attachment: unknown;
  const ws = {
    tags: null as string[] | null,
    sent,
    send: (message: string) => {
      sent.push(JSON.parse(message) as GameServerMessage);
    },
    serializeAttachment: (value: unknown) => {
      attachment = value;
    },
    deserializeAttachment: () => attachment,
  };
  return ws;
}

type FakeSocket = ReturnType<typeof fakeSocket>;

/** 假 DurableObjectState：map-backed storage + 假 Hibernation 面。 */
function fakeCtx() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    peek: (key: string) => data.get(key),
    storage: {
      get: async <T>(key: string) => data.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        data.set(key, value);
      },
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
      },
      list: async () => new Map(),
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at;
      },
      deleteAlarm: async () => {
        alarm = null;
      },
      deleteAll: async () => {
        data.clear();
      },
    },
    acceptWebSocket: (ws: FakeSocket, tags?: string[]) => {
      ws.tags = tags ?? [];
      sockets.push(ws);
    },
    getWebSockets: (tag?: string) => (tag ? sockets.filter((ws) => ws.tags?.includes(tag)) : [...sockets]),
  };
}

function makeDO(): { instance: GameRoomDO & { ctx: unknown }; fake: ReturnType<typeof fakeCtx> } {
  const fake = fakeCtx();
  const instance = Object.create(GameRoomDO.prototype) as GameRoomDO & { ctx: unknown };
  instance.ctx = fake as unknown as typeof instance.ctx;
  return { instance, fake };
}

/** 真实 GameRoomDO 实例包成 DO namespace（game-api.test.ts 同款）。 */
function makeNamespace(instance: GameRoomDO & { ctx: unknown }): DurableObjectNamespace {
  return {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        instance.fetch(input instanceof Request ? input : new Request(input, init)),
    })),
  } as unknown as DurableObjectNamespace;
}

function makeEnv(): {
  env: Env;
  dbSqls: string[];
  fake: ReturnType<typeof fakeCtx>;
  instance: GameRoomDO & { ctx: unknown };
} {
  const { instance, fake } = makeDO();
  const { db, sqls } = makeDb();
  const env = {
    DB: db,
    CACHE: makeCache(),
    GAME_ROOM: makeNamespace(instance),
  } as unknown as Env;
  return { env, dbSqls: sqls, fake, instance };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://worker${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request(`https://worker${path}`, { method: "GET" });
}

async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** 以某个身份调用 REST 入口（resolveParticipant 按调用时动态返回）。 */
async function rest(env: Env, who: string, request: Request): Promise<Response> {
  mocks.resolveParticipant.mockResolvedValue(participant(who));
  const response = await handleGameApiRequest(request, env, new URL(request.url));
  expect(response).not.toBeNull();
  return response!;
}

/** 建房 + 第二人加入（全走 REST 入口），返回两条响应体。 */
async function createAndJoin(env: Env) {
  const created = await json<{
    room: { id: number; gameType: string; status: string };
    roomRef: string;
    view: { view: { yourColor: string; board: unknown[][] } };
  }>(await rest(env, HOST, post("/api/game/rooms", { gameType: "gomoku" })));

  const joined = await json<{
    roomRef: string;
    role: string;
    view: {
      view: {
        yourColor: string;
        players: Array<{ seatToken: string; color: string }>;
      };
      players: Array<{ seatToken: string; isHost: boolean }>;
    };
  }>(await rest(env, GUEST, post(`/api/game/rooms/${created.room.id}/join`, { displayName: "客人" })));

  return { created, joined };
}

/** 在 DO 上模拟 WS 落地（接受连接 + attachment + 首帧 state）。 */
async function connect(
  instance: GameRoomDO & { ctx: unknown },
  fake: ReturnType<typeof fakeCtx>,
  hash: string,
): Promise<FakeSocket> {
  const socket = fakeSocket();
  const register = (
    instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
  ).registerSocket.bind(instance);
  await register(socket, hash, fake.peek("room") as GameRoomState);
  socket.sent.length = 0; // 首帧 state 已由 game-room-do.test.ts 覆盖，这里清掉
  return socket;
}

async function send(instance: GameRoomDO & { ctx: unknown }, socket: FakeSocket, message: unknown): Promise<void> {
  await instance.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(message));
}

/** 取某连接收到的最后一条 state 帧。 */
function lastState(socket: FakeSocket): { type: "state"; role: string; view: Record<string, unknown> } {
  const frames = socket.sent.filter((message) => message.type === "state");
  expect(frames.length).toBeGreaterThan(0);
  // 线上信封是 GamePlayerView/GamePublicView 联合；测试按 JSON 形状断言。
  return frames.at(-1) as unknown as { type: "state"; role: string; view: Record<string, unknown> };
}

beforeEach(() => {
  clearGameEnginesForTest();
  registerBuiltinMultiplayerEngines(); // 真实 gomokuEngine 进注册表
  mocks.resolveParticipant.mockReset();
  mocks.createAuditLog.mockReset();
  mocks.createAuditLog.mockResolvedValue(undefined);
  mocks.resolveParticipant.mockResolvedValue(participant(HOST));
});

describe("五子棋整链路：REST 建房 → REST 加入 → WS 开局 → WS 落子广播", () => {
  it("REST 建房返回 room_<id> 房间码与房主黑棋视图；第二人加入执白且座位表正确", async () => {
    const { env, dbSqls } = makeEnv();
    const { created, joined } = await createAndJoin(env);

    // 房间码锁定：roomRef = room_<D1 自增 id>，与 DO 实例名同源。
    expect(created.room).toEqual({ id: ROOM_ROW_ID, gameType: "gomoku", status: "lobby" });
    expect(created.roomRef).toBe(`room_${ROOM_ROW_ID}`);
    expect(dbSqls.some((sql) => sql.includes("INSERT INTO game_rooms"))).toBe(true);

    // 房主视图：真实引擎已初始化 15×15 棋盘，房主执黑。
    // （建房响应只回 view：role 由 /state、/join 与 WS 帧携带。）
    expect(created.view.view.yourColor).toBe("black");
    expect(created.view.view.board).toHaveLength(15);

    // 第二人加入：座位表按入座顺序分配黑白（房主黑、客人白）。
    expect(joined.role).toBe("player");
    expect(joined.view.view.yourColor).toBe("white");
    // 座位令牌是 DO 随机铸造的（32 位 hex）：这里按「令牌在信封与引擎座位
    // 两侧同源」做关系断言，并确认绝不出现 participantHash 原文（修复 1）。
    const engineSeats = joined.view.view.players as Array<{ seatToken: string; color: string }>;
    expect(engineSeats.map((seat) => seat.color)).toEqual(["black", "white"]);
    for (const seat of engineSeats) {
      expect(seat.seatToken).toMatch(/^[0-9a-f]{32}$/);
      expect(seat.seatToken).not.toBe(HOST);
      expect(seat.seatToken).not.toBe(GUEST);
    }
    // DO 信封的玩家表也有两人，且房主身份只属于创建者；信封行与引擎座位
    // 共用同一组 seatToken（客户端「座位 → 昵称」对位的数据源）。
    const envelopeTokens = (joined.view.players as Array<{ seatToken: string; isHost: boolean }>).map(
      (player) => player.seatToken,
    );
    expect(envelopeTokens).toEqual(engineSeats.map((seat) => seat.seatToken));
    expect((joined.view.players as Array<{ isHost: boolean }>).map((player) => player.isHost)).toEqual([true, false]);
  });

  it("非房主经 WS 开局被拒 not_host，房间仍是 lobby", async () => {
    const { env, fake, instance } = makeEnv();
    await createAndJoin(env);
    const guestSocket = await connect(instance, fake, GUEST);

    await send(instance, guestSocket, { type: "start" });

    const frame = guestSocket.sent.at(-1)!;
    expect(frame.type).toBe("error");
    expect((frame as { code: string }).code).toBe("not_host");
    expect((fake.peek("room") as GameRoomState).status).toBe("lobby");
  });

  it("房主 WS 开局：黑白分配锁定，双方各自收到裁剪后的 state 帧", async () => {
    const { env, fake, instance } = makeEnv();
    await createAndJoin(env);
    const hostSocket = await connect(instance, fake, HOST);
    const guestSocket = await connect(instance, fake, GUEST);

    await send(instance, hostSocket, { type: "ready", ready: true });
    await send(instance, guestSocket, { type: "ready", ready: true });
    await send(instance, hostSocket, { type: "start" });

    // 发起者收到 action_result：ok + 新 version（create1/join2/ready3/ready4/start5）。
    const result = hostSocket.sent.filter((frame) => frame.type === "action_result").at(-1)!;
    expect(result).toMatchObject({ type: "action_result", actionId: "start", ok: true, version: 5 });

    // 广播 state 帧的线上形状：type/role/view 信封，view 只含协议字段。
    const hostState = lastState(hostSocket);
    const guestState = lastState(guestSocket);
    expect(Object.keys(hostState).sort()).toEqual(["role", "type", "view"]);
    expect(hostState.view.roomId).toBe(`room_${ROOM_ROW_ID}`);
    expect(hostState.view.gameType).toBe("gomoku");
    expect(hostState.view.status).toBe("playing");
    expect(hostState.view.version).toBe(5);
    expect(hostState.view.remainingMs).toEqual(expect.any(Number));
    expect(hostState.view).not.toHaveProperty("settlement");

    // 私有视图裁剪：玩家各拿自己的 yourColor；观战者/公开视图不带。
    expect(hostState.role).toBe("player");
    expect((hostState.view.view as { yourColor: string }).yourColor).toBe("black");
    expect(guestState.role).toBe("player");
    expect((guestState.view.view as { yourColor: string }).yourColor).toBe("white");
    // 广播帧绝不夹带 DO 的裸 state（engineState 是 Worker⇄DO 内部契约）。
    expect(JSON.stringify(hostState)).not.toContain("engineState");
  });

  it("落子经 WS 写回 stateVersion：DO storage 与 REST GET state 都看到 version+1 与新棋盘", async () => {
    const { env, fake, instance } = makeEnv();
    await createAndJoin(env);
    const hostSocket = await connect(instance, fake, HOST);
    const guestSocket = await connect(instance, fake, GUEST);
    const spectatorSocket = await connect(instance, fake, STRANGER);

    await send(instance, hostSocket, { type: "ready", ready: true });
    await send(instance, guestSocket, { type: "ready", ready: true });
    await send(instance, hostSocket, { type: "start" });
    hostSocket.sent.length = 0;
    guestSocket.sent.length = 0;
    spectatorSocket.sent.length = 0;

    await send(instance, hostSocket, {
      type: "action",
      actionId: "move-1",
      action: "move",
      payload: { row: 7, col: 7 },
    });

    // 发起者收到 action_result，version 从 5 → 6。
    const result = hostSocket.sent.filter((frame) => frame.type === "action_result").at(-1)!;
    expect(result).toMatchObject({ type: "action_result", actionId: "move-1", ok: true, version: 6 });

    // DO storage：version 落盘 + 棋盘真实写回（黑子落在 7,7）。
    const stored = fake.peek("room") as GameRoomState;
    expect(stored.version).toBe(6);
    expect((stored.engineState as { board: Array<Array<string | null>> }).board[7]![7]).toBe("black");

    // 广播：对手看到新棋盘、轮到白方、version=6。
    const guestState = lastState(guestSocket);
    expect(guestState.view.version).toBe(6);
    const guestPayload = guestState.view.view as {
      board: Array<Array<string | null>>;
      turn: string;
      yourColor: string;
    };
    expect(guestPayload.board[7]![7]).toBe("black");
    expect(guestPayload.turn).toBe("white");
    expect(guestPayload.yourColor).toBe("white");

    // 观战者收到公开视图：棋盘可见，但不含 any 玩家的 yourColor。
    const spectatorState = lastState(spectatorSocket);
    expect(spectatorState.role).toBe("spectator");
    expect(spectatorState.view.version).toBe(6);
    expect((spectatorState.view.view as { board: Array<Array<string | null>> }).board[7]![7]).toBe("black");
    expect(spectatorState.view.view).not.toHaveProperty("yourColor");

    // REST GET state 走同一条裁剪路径：房主视角 version=6、执黑。
    const restState = await json<{ role: string; view: { version: number; view: { yourColor: string } } }>(
      await rest(env, HOST, get(`/api/game/rooms/${ROOM_ROW_ID}/state`)),
    );
    expect(restState.role).toBe("player");
    expect(restState.view.version).toBe(6);
    expect(restState.view.view.yourColor).toBe("black");
  });

  it("对局中白方 WS 离席 = 认输：立即结算 resign、黑方胜，不再等超时判负", async () => {
    const { env, fake, instance } = makeEnv();
    await createAndJoin(env);
    const hostSocket = await connect(instance, fake, HOST);
    const guestSocket = await connect(instance, fake, GUEST);
    await send(instance, hostSocket, { type: "ready", ready: true });
    await send(instance, guestSocket, { type: "ready", ready: true });
    await send(instance, hostSocket, { type: "start" });
    hostSocket.sent.length = 0;
    guestSocket.sent.length = 0;

    // leave 只在 WS 控制面（REST 面只有 join/close/state/ws），客户端 sendLeave 即此路径。
    await send(instance, guestSocket, { type: "leave" });

    // 发起者收到 action_result，留下的一方收到结算广播。
    const result = guestSocket.sent.filter((frame) => frame.type === "action_result").at(-1)!;
    expect(result).toMatchObject({ type: "action_result", actionId: "leave", ok: true });

    // 结算：resign、胜者是留下的黑方（座位令牌对位，非哈希）；离席者标记 leftAt。
    const stored = fake.peek("room") as GameRoomState;
    expect(stored.status).toBe("settled");
    const settlement = fake.peek("settlement") as { result: string; winnerSeatToken: string | null };
    expect(settlement.result).toBe("resign");
    expect(settlement.winnerSeatToken).toBe(stored.players.find((p) => p.participantHash === HOST)?.seatToken);
    expect(stored.players.find((p) => p.participantHash === GUEST)?.leftAt).not.toBeNull();

    // 留下的玩家收到结算广播，视图带 settlement 快照。
    const hostState = lastState(hostSocket);
    expect(hostState.view.status).toBe("settled");
    expect((hostState.view as { settlement?: { result: string } }).settlement?.result).toBe("resign");
  });

  it("第三人进入对局中的房间：REST join 降级观战（spectatorFallback），不占座位", async () => {
    const { env, fake } = makeEnv();
    await createAndJoin(env);
    const before = fake.peek("room") as GameRoomState;
    const response = await rest(env, STRANGER, post(`/api/game/rooms/${ROOM_ROW_ID}/join`, {}));
    expect(response.status).toBe(200);
    const payload = await json<{ role: string; spectatorFallback?: boolean }>(response);
    expect(payload.role).toBe("spectator");
    expect(payload.spectatorFallback).toBe(true);
    const after = fake.peek("room") as GameRoomState;
    expect(after.players).toHaveLength(2);
    expect(after.version).toBe(before.version);
  });
});
