import { beforeEach, describe, expect, it } from "vitest";

import { GameRoomDO } from "../../../src/durable-objects/game-room";
import { clearGameEnginesForTest, registerGameEngine } from "../../../src/game/multiplayer/engine-registry";
import type { GameActionRecord, GameRoomState, GameServerMessage } from "../../../src/game/multiplayer/engine-types";
import { stubEngine } from "../../helpers/game-engine-stub";

/**
 * GameRoomDO 协议底座单测（P0 批次 G1）。
 *
 * 构造方式沿用 rate-limit-do.test.ts 的先例：绕过构造函数，直接以
 * Object.create 挂一个 map-backed 的假 DurableObjectState（storage + 假
 * Hibernation 面 acceptWebSocket/getWebSockets）。101 响应由 workerd 造，
 * vitest（undici）构造不了 101，所以 WS 用例直接驱动 handleWebSocketUpgrade
 * 的 401 分支与 registerSocket。
 */

/** 假 WebSocket：记录 send 的消息与 attachment，供断言。 */
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
      list: async <T>(options?: { prefix?: string; limit?: number }) => {
        const prefix = options?.prefix ?? "";
        const limit = options?.limit ?? Infinity;
        const out = new Map<string, T>();
        for (const [key, value] of data) {
          if (key.startsWith(prefix) && out.size < limit) out.set(key, value as T);
        }
        return out;
      },
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

/** 构造真实 GameRoomDO 实例（绕过构造函数，只挂假 ctx）。 */
function makeDO() {
  const fake = fakeCtx();
  const instance = Object.create(GameRoomDO.prototype) as GameRoomDO & { ctx: unknown };
  instance.ctx = fake as unknown as typeof instance.ctx;
  return { instance, fake };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://game-room${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://game-room${path}`, { method: "GET", headers });
}

const HOST = "hash-host";
const GUEST = "hash-guest";
const STRANGER = "hash-stranger";

async function httpJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** 标准开局：建房 → 客人加入 → 双方 ready → 房主开局。返回 DO 与 fake。 */
async function makeStartedRoom() {
  const { instance, fake } = makeDO();
  await instance.fetch(
    post(
      "/create",
      { gameType: "stub-guess", roomId: "room_9", host: { participantHash: HOST, displayName: "房主" } },
      { "x-game-viewer-hash": HOST },
    ),
  );
  await instance.fetch(post("/join", { participantHash: GUEST, displayName: "客人" }, { "x-game-viewer-hash": GUEST }));
  await instance.fetch(post("/ready", { participantHash: HOST, ready: true }));
  await instance.fetch(post("/ready", { participantHash: GUEST, ready: true }));
  await instance.fetch(post("/start", { participantHash: HOST }));
  return { instance, fake };
}

beforeEach(() => {
  clearGameEnginesForTest();
  registerGameEngine(stubEngine);
});

describe("GameRoomDO 房间生命周期", () => {
  it("创建房间：version=1、房主入座、引擎状态就位", async () => {
    const { instance } = makeDO();
    const response = await instance.fetch(
      post(
        "/create",
        { gameType: "stub-guess", roomId: "room_1", host: { participantHash: HOST } },
        { "x-game-viewer-hash": HOST },
      ),
    );
    expect(response.status).toBe(200);
    const payload = await httpJson(response);
    const state = payload.state as GameRoomState;
    expect(state.version).toBe(1);
    expect(state.status).toBe("lobby");
    expect(state.players).toHaveLength(1);
    expect((state.players[0] as { isHost: boolean }).isHost).toBe(true);
  });

  it("roomId 不是 room_<数字> 格式直接拒绝（深链接格式锁定）", async () => {
    const { instance } = makeDO();
    const bare = await instance.fetch(
      post("/create", { gameType: "stub-guess", roomId: "17", host: { participantHash: HOST } }),
    );
    expect(bare.status).toBe(400);
    expect((await httpJson(bare)).code).toBe("invalid_payload");
    const missing = await instance.fetch(
      post("/create", { gameType: "stub-guess", roomId: "room_abc", host: { participantHash: HOST } }),
    );
    expect(missing.status).toBe(400);
  });

  it("未登记的玩法返回 unknown_game_type", async () => {
    const { instance } = makeDO();
    const response = await instance.fetch(
      post("/create", { gameType: "werewolf", roomId: "room_2", host: { participantHash: HOST } }),
    );
    expect(response.status).toBe(400);
    expect((await httpJson(response)).code).toBe("unknown_game_type");
  });

  it("加入→ready→开局各推进一步 version（协议不变量一：每次成功状态变更 +1）", async () => {
    const { instance } = makeDO();
    const versions: number[] = [];
    const versionsOf = (payload: Record<string, unknown>) =>
      versions.push(((payload.state as GameRoomState) ?? (payload.view as { version: number })).version);

    versionsOf(
      await httpJson(
        await instance.fetch(
          post("/create", { gameType: "stub-guess", roomId: "room_3", host: { participantHash: HOST } }),
        ),
      ),
    );
    versionsOf(
      await httpJson(await instance.fetch(post("/join", { participantHash: GUEST }, { "x-game-viewer-hash": GUEST }))),
    );
    versionsOf(await httpJson(await instance.fetch(post("/ready", { participantHash: GUEST, ready: true }))));
    versionsOf(await httpJson(await instance.fetch(post("/start", { participantHash: HOST }))));

    // 单调递增：1 → 2 → 3 → 4。
    expect(versions).toEqual([1, 2, 3, 4]);
    const final = (await httpJson(await instance.fetch(get("/state", { "x-game-viewer-hash": GUEST })))) as {
      view: { status: string; version: number };
    };
    expect(final.view.status).toBe("playing");
    expect(final.view.version).toBe(4);
  });

  it("重复加入是幂等重入，不推进 version", async () => {
    const { instance } = makeDO();
    await instance.fetch(
      post(
        "/create",
        { gameType: "stub-guess", roomId: "room_4", host: { participantHash: HOST } },
        { "x-game-viewer-hash": HOST },
      ),
    );
    await instance.fetch(post("/join", { participantHash: GUEST }, { "x-game-viewer-hash": GUEST }));
    const before = (
      (await instance.fetch(get("/state", { "x-game-viewer-hash": HOST })).then(httpJson)) as {
        view: { version: number };
      }
    ).view.version;
    const rejoin = await instance.fetch(post("/join", { participantHash: GUEST }, { "x-game-viewer-hash": GUEST }));
    expect((await httpJson(rejoin)).rejoined).toBe(true);
    const after = (
      (await instance.fetch(get("/state", { "x-game-viewer-hash": HOST })).then(httpJson)) as {
        view: { version: number };
      }
    ).view.version;
    expect(after).toBe(before);
  });

  it("第三人加入满员房间：W4 起降级为只读观战（不报错），version 不动", async () => {
    const { instance } = makeDO();
    await instance.fetch(
      post(
        "/create",
        { gameType: "stub-guess", roomId: "room_5", host: { participantHash: HOST } },
        { "x-game-viewer-hash": HOST },
      ),
    );
    await instance.fetch(post("/join", { participantHash: GUEST }, { "x-game-viewer-hash": GUEST }));
    const before = (
      (await instance.fetch(get("/state", { "x-game-viewer-hash": HOST })).then(httpJson)) as {
        view: { version: number };
      }
    ).view.version;
    // 原契约是 400 invalid_action；W4 改为不报错、降级观战（第三人=看客）。
    const fallback = await instance.fetch(
      post("/join", { participantHash: STRANGER }, { "x-game-viewer-hash": STRANGER }),
    );
    expect(fallback.status).toBe(200);
    const payload = (await httpJson(fallback)) as { role: string; spectatorFallback?: boolean };
    expect(payload.role).toBe("spectator");
    expect(payload.spectatorFallback).toBe(true);
    const after = (
      (await instance.fetch(get("/state", { "x-game-viewer-hash": HOST })).then(httpJson)) as {
        view: { version: number };
      }
    ).view.version;
    expect(after).toBe(before);
  });

  it("非房主开局被拒（not_host）", async () => {
    const { instance } = makeDO();
    await instance.fetch(
      post(
        "/create",
        { gameType: "stub-guess", roomId: "room_6", host: { participantHash: HOST } },
        { "x-game-viewer-hash": HOST },
      ),
    );
    await instance.fetch(post("/join", { participantHash: GUEST }, { "x-game-viewer-hash": GUEST }));
    const rejected = await instance.fetch(post("/start", { participantHash: GUEST }));
    expect(rejected.status).toBe(400);
    expect((await httpJson(rejected)).code).toBe("not_host");
  });
});

describe("GameRoomDO 动作协议（version / actionId 幂等）", () => {
  it("动作接受后 version 单调递增，局面推进", async () => {
    // makeStartedRoom 终点 version=5（create1/join2/ready3/ready4/start5）。
    const room = await makeStartedRoom();
    const first = await room.instance.fetch(
      post("/action", { actionId: "a1", participantHash: HOST, action: "move", payload: { value: 1 } }),
    );
    expect(first.status).toBe(200);
    const payload = await httpJson(first);
    expect(payload.version).toBe(6);
    const state = await room.instance.fetch(get("/state", { "x-game-viewer-hash": HOST })).then(httpJson);
    expect((state.view as { version: number }).version).toBe(6);
    const stored = room.fake.peek("room") as GameRoomState;
    expect((stored.engineState as { movesTotal: number }).movesTotal).toBe(1);
  });

  it("重复 actionId 原样重放，只结算一次（去重表在 DO storage）", async () => {
    const { instance, fake } = await makeStartedRoom();
    const first = await instance.fetch(
      post("/action", { actionId: "same-id", participantHash: HOST, action: "move", payload: { value: 2 } }),
    );
    expect(first.status).toBe(200);
    const firstPayload = await httpJson(first);
    expect(firstPayload.version).toBe(6);
    const replay = await instance.fetch(
      post("/action", { actionId: "same-id", participantHash: HOST, action: "move", payload: { value: 2 } }),
    );
    const replayPayload = await httpJson(replay);
    expect(replayPayload.duplicate).toBe(true);
    expect(replayPayload.version).toBe(6); // 不再 +1
    // 引擎只被结算了一次：累计步数没有翻倍。
    const stored = fake.peek("room") as GameRoomState;
    expect((stored.engineState as { movesTotal: number }).movesTotal).toBe(1);
    const record = fake.peek("act:same-id") as GameActionRecord;
    expect(record.accepted).toBe(true);
  });

  it("被拒绝的动作也进去重表：重放同码拿到同样语义，不会二次生效", async () => {
    const { instance, fake } = await makeStartedRoom();
    // 观战者（非玩家）发动作 → not_a_player。
    const first = await instance.fetch(
      post("/action", { actionId: "bad-id", participantHash: STRANGER, action: "move", payload: { value: 1 } }),
    );
    expect(first.status).toBe(403);
    expect((await httpJson(first)).code).toBe("not_a_player");
    const replay = await instance.fetch(
      post("/action", { actionId: "bad-id", participantHash: STRANGER, action: "move", payload: { value: 1 } }),
    );
    const replayPayload = await httpJson(replay);
    expect(replayPayload.duplicate).toBe(true);
    expect(replayPayload.accepted).toBe(false);
    expect(replayPayload.code).toBe("not_a_player");
    const stored = fake.peek("room") as GameRoomState;
    expect(stored.version).toBe(5); // 拒绝不推版本
  });

  it("baseVersion 落后返回 stale_action（防旧状态覆盖），version 不动", async () => {
    const { instance, fake } = await makeStartedRoom();
    const stale = await instance.fetch(
      post("/action", {
        actionId: "old-1",
        participantHash: HOST,
        action: "move",
        payload: { value: 1 },
        baseVersion: 1,
      }),
    );
    expect(stale.status).toBe(409);
    expect((await httpJson(stale)).code).toBe("stale_action");
    const stored = fake.peek("room") as GameRoomState;
    expect(stored.version).toBe(5);
    // 拒绝也记录：重放拿到同样的 stale_action 语义。
    const record = fake.peek("act:old-1") as GameActionRecord;
    expect(record.accepted).toBe(false);
    expect(record.errorCode).toBe("stale_action");
  });

  it("满 3 步触发结算：status=settled、快照入库、终态保留", async () => {
    const { instance, fake } = await makeStartedRoom();
    for (let i = 0; i < 3; i += 1) {
      await instance.fetch(
        post("/action", { actionId: `m${i}`, participantHash: HOST, action: "move", payload: { value: i + 1 } }),
      );
    }
    const stored = fake.peek("room") as GameRoomState;
    expect(stored.status).toBe("settled");
    const settlement = fake.peek("settlement") as { result: string; version: number };
    expect(settlement.result).toBe("draw");
    expect(settlement.version).toBe(stored.version);
  });

  it("每步棋不触 D1：DO 实例上没有任何 D1/KV 绑定调用面（纯 storage）", async () => {
    // 静态断言：GameRoomDO 的实现文件不允许 import D1/KV 相关服务。
    // 这里用运行时事实兜底——假 ctx 不含 DB，任何 D1 调用都会抛错；
    // 走一遍完整对局无异常即为通过。
    const { instance } = await makeStartedRoom();
    for (let i = 0; i < 3; i += 1) {
      await instance.fetch(
        post("/action", { actionId: `p${i}`, participantHash: HOST, action: "move", payload: { value: 1 } }),
      );
    }
    expect(true).toBe(true);
  });
});

describe("GameRoomDO 视图裁剪（协议不变量三）", () => {
  it("玩家视图只含自己的私密字段，绝不泄露他人 secret", async () => {
    const { instance } = await makeStartedRoom();
    const hostView = await instance.fetch(get("/state", { "x-game-viewer-hash": HOST })).then(httpJson);
    const serialized = JSON.stringify(hostView.view);
    expect((hostView.view as { view: { mySecret: string } }).view.mySecret).toBe(`secret-of-${HOST}`);
    expect(serialized).not.toContain(`secret-of-${GUEST}`);
    const guestView = await instance.fetch(get("/state", { "x-game-viewer-hash": GUEST })).then(httpJson);
    expect((guestView.view as { view: { mySecret: string } }).view.mySecret).toBe(`secret-of-${GUEST}`);
    expect(JSON.stringify(guestView.view)).not.toContain(`secret-of-${HOST}`);
  });

  it("陌生人与观战者拿到公开视图，无任何 secret", async () => {
    const { instance } = await makeStartedRoom();
    const publicView = await instance.fetch(get("/state", { "x-game-viewer-hash": STRANGER })).then(httpJson);
    expect(publicView.role).toBe("spectator");
    expect(JSON.stringify(publicView.view)).not.toContain("secret-of-");
  });

  it("加入响应携带按人裁剪的视图（REST 只透传 view，不透传裸 state 给客户端）", async () => {
    const { instance } = makeDO();
    await instance.fetch(
      post(
        "/create",
        { gameType: "stub-guess", roomId: "room_7", host: { participantHash: HOST } },
        { "x-game-viewer-hash": HOST },
      ),
    );
    const join = await instance
      .fetch(post("/join", { participantHash: GUEST }, { "x-game-viewer-hash": GUEST }))
      .then(httpJson);
    expect((join.view as { view: { mySecret: string } }).view.mySecret).toBe(`secret-of-${GUEST}`);
    expect(JSON.stringify(join.view)).not.toContain(`secret-of-${HOST}`);
  });

  it("第三人进入满员房间：不报错、降级观战（spectatorFallback），不占座位", async () => {
    const { instance, fake } = await makeStartedRoom(); // 双方已在座
    const before = fake.peek("room") as GameRoomState;
    const response = await instance.fetch(
      post("/join", { participantHash: STRANGER, displayName: "路人" }, { "x-game-viewer-hash": STRANGER }),
    );
    expect(response.status).toBe(200);
    const payload = await httpJson(response);
    expect(payload.ok).toBe(true);
    expect(payload.role).toBe("spectator");
    expect(payload.spectatorFallback).toBe(true);
    // 公开视图（没有玩家私密信息），房间座位与 version 原样不动。
    expect(JSON.stringify(payload.view)).not.toContain("secret-of-");
    expect(payload.view).not.toHaveProperty("state");
    const after = fake.peek("room") as GameRoomState;
    expect(after.players).toHaveLength(2);
    expect(after.version).toBe(before.version);
    expect(after.players.some((p) => p.participantHash === STRANGER)).toBe(false);
  });

  it("对局中的第三人 join 同样降级观战；仍坐着的玩家 join 失败不静默降级", async () => {
    const { instance } = await makeStartedRoom(); // status=playing
    const stranger = await instance
      .fetch(post("/join", { participantHash: STRANGER }, { "x-game-viewer-hash": STRANGER }))
      .then(httpJson);
    expect(stranger.role).toBe("spectator");
    expect(stranger.spectatorFallback).toBe(true);
    // 已坐着的玩家重入走幂等分支（rejoined），永远不该看到 fallback。
    const rejoin = await instance
      .fetch(post("/join", { participantHash: HOST }, { "x-game-viewer-hash": HOST }))
      .then(httpJson);
    expect(rejoin.rejoined).toBe(true);
    expect(rejoin.spectatorFallback).toBeUndefined();
  });

  it("对局中离席（引擎不支持 resign 的玩法）：退回默认 leave，不报错", async () => {
    const { instance, fake } = await makeStartedRoom();
    const before = fake.peek("room") as GameRoomState;
    const response = await instance.fetch(post("/leave", { participantHash: GUEST }, { "x-game-viewer-hash": GUEST }));
    expect(response.status).toBe(200);
    const after = fake.peek("room") as GameRoomState;
    expect(after.players.find((p) => p.participantHash === GUEST)?.leftAt).not.toBeNull();
    expect(after.version).toBe(before.version + 1);
    // 桩引擎没有 resign 动作：房间不结算，保持 playing（默认实现语义）。
    expect(after.status).toBe("playing");
  });
});

describe("GameRoomDO WebSocket Hibernation", () => {
  it("无身份头的升级请求被拒 401（Worker 层鉴权的防御位）", async () => {
    const { instance } = await makeStartedRoom();
    const response = await instance.fetch(get("/ws", { Upgrade: "websocket" }));
    expect(response.status).toBe(401);
  });

  it("玩家连接挂 player tag、首推玩家视图；观战连接挂 spectator tag、首推公开视图", async () => {
    const { instance, fake } = await makeStartedRoom();
    const hostSocket = fakeSocket();
    await (
      instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
    ).registerSocket(hostSocket, HOST, fake.peek("room") as GameRoomState);
    expect(hostSocket.tags).toEqual(["player"]);
    // 首帧 state + 聊天历史（房间聊天批次：空历史也是一帧）+ presence 广播。
    expect(hostSocket.sent).toHaveLength(3);
    expect(hostSocket.sent[0]!.type).toBe("state");
    expect((hostSocket.sent[0] as { role: string }).role).toBe("player");
    expect((hostSocket.sent[0] as { view: { view: { mySecret: string } } }).view.view.mySecret).toBe(
      `secret-of-${HOST}`,
    );
    expect(hostSocket.sent[1]).toEqual({ type: "chat_history", messages: [] });
    expect(hostSocket.sent[2]).toEqual({ type: "presence", onlinePlayers: 1, onlineSpectators: 0 });

    const spectatorSocket = fakeSocket();
    await (
      instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
    ).registerSocket(spectatorSocket, STRANGER, fake.peek("room") as GameRoomState);
    expect(spectatorSocket.tags).toEqual(["spectator"]);
    expect((spectatorSocket.sent[0] as { view: { view: Record<string, unknown> } }).view.view).not.toHaveProperty(
      "mySecret",
    );
    // tag 分流：玩家/观战连接可以分别取到。
    expect(fake.getWebSockets("player")).toHaveLength(1);
    expect(fake.getWebSockets("spectator")).toHaveLength(1);
  });

  it("WS 消息走同一分发器：ready→start→action 全链路推进，广播是按人裁剪的", async () => {
    const { instance, fake } = makeDO();
    await instance.fetch(
      post(
        "/create",
        { gameType: "stub-guess", roomId: "room_10", host: { participantHash: HOST } },
        { "x-game-viewer-hash": HOST },
      ),
    );
    await instance.fetch(post("/join", { participantHash: GUEST }, { "x-game-viewer-hash": GUEST }));
    const hostSocket = fakeSocket();
    const guestSocket = fakeSocket();
    const register = (
      instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
    ).registerSocket.bind(instance);
    await register(hostSocket, HOST, fake.peek("room") as GameRoomState);
    await register(guestSocket, GUEST, fake.peek("room") as GameRoomState);

    hostSocket.sent.length = 0;
    guestSocket.sent.length = 0;
    // 房主经 WS 开局（lobby → playing）。
    await instance.webSocketMessage(hostSocket as unknown as WebSocket, JSON.stringify({ type: "start" }));
    const startResults = hostSocket.sent.filter((m) => m.type === "action_result");
    expect(startResults).toHaveLength(1);
    expect((startResults[0] as { ok: boolean }).ok).toBe(true);
    // 全房间各收一帧，且各自视图只含自己的 secret。
    expect(guestSocket.sent.length).toBeGreaterThan(0);
    const guestLast = guestSocket.sent[guestSocket.sent.length - 1]!;
    expect(JSON.stringify(guestLast)).toContain(`secret-of-${GUEST}`);
    expect(JSON.stringify(guestLast)).not.toContain(`secret-of-${HOST}`);

    hostSocket.sent.length = 0;
    guestSocket.sent.length = 0;
    await instance.webSocketMessage(
      hostSocket as unknown as WebSocket,
      JSON.stringify({ type: "action", actionId: "ws-1", action: "move", payload: { value: 1 } }),
    );
    const results = hostSocket.sent.filter((m) => m.type === "action_result");
    expect(results).toHaveLength(1);
    expect((results[0] as { ok: boolean; actionId: string }).ok).toBe(true);
    expect(JSON.stringify(guestSocket.sent[guestSocket.sent.length - 1])).not.toContain(`secret-of-${HOST}`);
  });

  it("WS 消息的幂等同样生效：同一 actionId 二次投递只结算一次", async () => {
    const { instance, fake } = await makeStartedRoom();
    const hostSocket = fakeSocket();
    await (
      instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
    ).registerSocket(hostSocket, HOST, fake.peek("room") as GameRoomState);
    const message = JSON.stringify({ type: "action", actionId: "dup-1", action: "move", payload: { value: 1 } });
    await instance.webSocketMessage(hostSocket as unknown as WebSocket, message);
    await instance.webSocketMessage(hostSocket as unknown as WebSocket, message);
    const stored = fake.peek("room") as GameRoomState;
    expect((stored.engineState as { movesTotal: number }).movesTotal).toBe(1);
    const versions = hostSocket.sent
      .filter((m) => m.type === "action_result")
      .map((m) => (m as { version?: number }).version);
    expect(new Set(versions).size).toBe(1); // 两次回报的 version 相同
  });

  it("被拒动作的 WS 幂等重放仍是 ok:false（重放同码，不被压成成功）", async () => {
    const { instance, fake } = await makeStartedRoom();
    const hostSocket = fakeSocket();
    await (
      instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
    ).registerSocket(hostSocket, HOST, fake.peek("room") as GameRoomState);
    // 观战者身份经 WS 发动作：引擎拒绝 not_a_player 并进去重表。
    const strangerSocket = fakeSocket();
    await (
      instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
    ).registerSocket(strangerSocket, STRANGER, fake.peek("room") as GameRoomState);
    const message = JSON.stringify({ type: "action", actionId: "ws-bad-1", action: "move", payload: { value: 1 } });
    await instance.webSocketMessage(strangerSocket as unknown as WebSocket, message);
    await instance.webSocketMessage(strangerSocket as unknown as WebSocket, message); // 同 actionId 重试
    const results = strangerSocket.sent.filter((m) => m.type === "action_result") as Array<{
      ok: boolean;
      error?: { code: string };
    }>;
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("not_a_player");
    }
    // 拒绝从未生效：version 不动。
    const stored = fake.peek("room") as GameRoomState;
    expect(stored.version).toBe(5);
  });

  it("非 JSON 消息回 error 帧而不是炸掉连接", async () => {
    const { instance, fake } = await makeStartedRoom();
    const hostSocket = fakeSocket();
    await (
      instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
    ).registerSocket(hostSocket, HOST, fake.peek("room") as GameRoomState);
    hostSocket.sent.length = 0;
    await instance.webSocketMessage(hostSocket as unknown as WebSocket, "not-json");
    expect(hostSocket.sent[0]!.type).toBe("error");
    expect((hostSocket.sent[0] as { code: string }).code).toBe("invalid_payload");
  });

  it("最后一条连接断开后，lobby 房间重新计空房回收倒计时", async () => {
    const { instance, fake } = await makeStartedRoom();
    // 开局中的房间无回收时间（由 deadline 驱动）；回退到 lobby 场景验证。
    const room = fake.peek("room") as GameRoomState;
    const lobby: GameRoomState = { ...room, status: "lobby", deadlineAt: null };
    await fake.storage.put("room", lobby);
    const socket = fakeSocket();
    await (
      instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
    ).registerSocket(socket, HOST, lobby);
    const occupied = fake.peek("room") as GameRoomState;
    expect(occupied.recycleAt).toBeNull(); // 有人在线 = 不回收
    await instance.webSocketClose(socket as unknown as WebSocket);
    const afterClose = fake.peek("room") as GameRoomState;
    expect(afterClose.recycleAt).not.toBeNull();
    expect(await fake.storage.getAlarm()).not.toBeNull();
  });

  it("presence：连接落地/断开都推送按身份去重的在线人数（掉线提示的信号源）", async () => {
    const { instance, fake } = await makeStartedRoom();
    const hostSocket = fakeSocket();
    await (
      instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
    ).registerSocket(hostSocket, HOST, fake.peek("room") as GameRoomState);
    hostSocket.sent.length = 0; // 自己落地时的 presence 已在上一个用例覆盖
    const spectatorSocket = fakeSocket();
    await (
      instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
    ).registerSocket(spectatorSocket, STRANGER, fake.peek("room") as GameRoomState);
    // 观战连接落地时，先到的玩家连接收到 presence：1 玩家 + 1 观战。
    const presenceToHost = hostSocket.sent.at(-1);
    expect(presenceToHost).toEqual({ type: "presence", onlinePlayers: 1, onlineSpectators: 1 });

    hostSocket.sent.length = 0;
    await instance.webSocketClose(hostSocket as unknown as WebSocket);
    // 断开事件的连接不计入：剩下的观战者看到玩家清零。
    const presenceAfterClose = spectatorSocket.sent.at(-1);
    expect(presenceAfterClose).toEqual({ type: "presence", onlinePlayers: 0, onlineSpectators: 1 });

    // 同一身份两条连接只算一个人（重连期新旧并存）。
    const secondHost = fakeSocket();
    await (
      instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
    ).registerSocket(secondHost, HOST, fake.peek("room") as GameRoomState);
    const deduped = spectatorSocket.sent.at(-1);
    expect(deduped).toEqual({ type: "presence", onlinePlayers: 1, onlineSpectators: 1 });
  });
});

describe("GameRoomDO alarm（倒计时 / 超时 / 回收）", () => {
  it("对局超时：alarm 触发 handleTimeout → checkGameOver → 统一结算", async () => {
    const { instance, fake } = await makeStartedRoom();
    const room = fake.peek("room") as GameRoomState;
    // 把截止时间拨到过去，模拟倒计时走完。
    await fake.storage.put("room", { ...room, deadlineAt: Date.now() - 1_000 });
    await fake.storage.setAlarm(Date.now() - 1);

    await instance.alarm();

    const stored = fake.peek("room") as GameRoomState;
    expect(stored.status).toBe("settled");
    expect((stored.engineState as { timedOut?: boolean }).timedOut ?? false).toBe(true);
    const settlement = fake.peek("settlement") as { result: string };
    expect(settlement.result).toBe("timeout");
  });

  it("终态房间到期被整体回收（deleteAll），回收后不再续闹", async () => {
    const { instance, fake } = await makeStartedRoom();
    const room = fake.peek("room") as GameRoomState;
    await fake.storage.put("room", { ...room, status: "settled", recycleAt: Date.now() - 1 });
    await fake.storage.setAlarm(Date.now() - 1);

    await instance.alarm();

    expect(fake.peek("room")).toBeUndefined();
    expect(fake.peek("settlement")).toBeUndefined();
    expect(await fake.storage.getAlarm()).toBeNull();
  });

  it("对局中还有剩余倒计时时，alarm 保持武装且不早于截止点触发", async () => {
    const { instance, fake } = await makeStartedRoom();
    const future = Date.now() + 45_000;
    const room = fake.peek("room") as GameRoomState;
    await fake.storage.put("room", { ...room, deadlineAt: future });
    await fake.storage.setAlarm(Date.now() - 1);

    await instance.alarm();

    // 已设的更早闹钟不动（soonest wins）；到点后由下一轮 alarm 重查再续。
    const armed = await fake.storage.getAlarm();
    expect(armed).not.toBeNull();
    expect(armed as number).toBeLessThanOrEqual(future);
    expect(fake.peek("room")).toBeDefined();
  });

  it("无任何等待点的房间不留下常驻心跳（deleteAlarm 收灯）", async () => {
    const { instance, fake } = await makeStartedRoom();
    const room = fake.peek("room") as GameRoomState;
    // 模拟"有玩家在线的 lobby"：recycleAt 为空、不在对局。
    await fake.storage.put("room", { ...room, status: "lobby", recycleAt: null, deadlineAt: null });
    await fake.storage.setAlarm(Date.now() - 1);

    await instance.alarm();

    expect(await fake.storage.getAlarm()).toBeNull();
    expect(fake.peek("room")).toBeDefined();
  });

  it("storage 为空（异常态）时 alarm 直接清场", async () => {
    const { instance, fake } = makeDO();
    await fake.storage.setAlarm(Date.now() - 1);
    await instance.alarm();
    expect(fake.peek("room")).toBeUndefined();
  });
});
