import { beforeEach, describe, expect, it } from "vitest";

import { GameRoomDO } from "../../../src/durable-objects/game-room";
import { registerBuiltinMultiplayerEngines } from "../../../src/game/multiplayer/server-engines";
import type { GameRoomState, GameServerMessage } from "../../../src/game/multiplayer/engine-types";

/**
 * 凭证泄漏断言（修复 1，坐实的 HIGH：participantHash = `web_<participantKey>`
 * 原文，拿到即可冒充身份）。
 *
 * 把 GameRoomDO 产生的**全部**对外载荷——REST 响应（信封 players + 玩法视图
 * + youSeatToken）、WS 帧（state/chat/chat_history/presence）、结算快照——
 * JSON.stringify 后断言不含任何玩家的身份凭证字样：
 * - 字面量键名 "participantHash" / "participantKey"；
 * - 测试玩家哈希原文（hash-*）与 "web_" 前缀（participantHashForKey 的产物）。
 * 覆盖五个真实引擎各一局（gomoku/xiangqi/doudizhu/ludo/werewolf，全部打到
 * settled 产生结算快照）+ 观战视角 + 房间聊天帧。
 *
 * 对位不回退的同场断言：信封 players 与引擎座位共用同一组 seatToken
 * （doudizhuSeatName / wolfMates UI 对位的数据源），youSeatToken 是查看者
 * 自己的令牌。
 */

/** 假 WebSocket：记录 send 的消息与 attachment，供断言。 */
function fakeSocket() {
  const sent: GameServerMessage[] = [];
  let attachment: unknown;
  return {
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
      list: async <T>(options?: { prefix?: string }) => {
        const prefix = options?.prefix ?? "";
        const out = new Map<string, T>();
        for (const [key, value] of data) {
          if (key.startsWith(prefix)) out.set(key, value as T);
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

async function httpJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** 参与者哈希原文（测试内永不希望出现在任何对外载荷里）。 */
const H = ["hash-host", "hash-p2", "hash-p3", "hash-p4", "hash-p5", "hash-p6", "hash-stranger"];
const CREDENTIAL_MARKS = ["participantHash", "participantKey", "web_", ...H];

/** 一段对外载荷的泄漏断言（键名字样 + 哈希原文全查）。 */
function expectNoCredentials(serialized: string, where: string): void {
  for (const mark of CREDENTIAL_MARKS) {
    expect(serialized, `${where} 泄漏了凭证字样 ${mark}`).not.toContain(mark);
  }
}

async function createAndSeat(
  instance: GameRoomDO,
  gameType: string,
  roomId: string,
  seatCount: number,
  config: Record<string, unknown> = {},
): Promise<void> {
  const create = await httpJson(
    await instance.fetch(
      post(
        "/create",
        { gameType, roomId, config, host: { participantHash: H[0]!, displayName: "房主" } },
        { "x-game-viewer-hash": H[0]! },
      ),
    ),
  );
  expect(create.ok).toBe(true);
  for (let i = 1; i < seatCount; i += 1) {
    const join = await httpJson(
      await instance.fetch(
        post("/join", { participantHash: H[i], displayName: `玩家${i + 1}` }, { "x-game-viewer-hash": H[i]! }),
      ),
    );
    expect(join.ok).toBe(true);
  }
  for (let i = 0; i < seatCount; i += 1) {
    await instance.fetch(post("/ready", { participantHash: H[i], ready: true }));
  }
  const start = await httpJson(await instance.fetch(post("/start", { participantHash: H[0]! })));
  expect(start.ok).toBe(true);
}

/** 轮询 alarm 把对局推进到 settled（werewolf 托管链；其余玩法一轮即终）。 */
async function driveToSettled(instance: GameRoomDO, fake: ReturnType<typeof fakeCtx>): Promise<void> {
  for (let round = 0; round < 60; round += 1) {
    const room = fake.peek("room") as GameRoomState;
    if (!room || room.status !== "playing") return;
    if (room.deadlineAt === null) return;
    await fake.storage.put("room", { ...room, deadlineAt: Date.now() - 1_000 });
    await fake.storage.setAlarm(Date.now() - 1);
    await instance.alarm();
  }
}

beforeEach(() => {
  registerBuiltinMultiplayerEngines();
});

describe("修复 1：对外载荷零凭证泄漏（五引擎全流程 + 观战 + 聊天）", () => {
  it("gomoku：建房→加入→对局→结算，玩家/观战响应与结算全部无凭证", async () => {
    const { instance, fake } = makeDO();
    await createAndSeat(instance, "gomoku", "room_101", 2);
    // 房主连五获胜：黑棋 (7,7..11)，白棋穿插 (0,0..3)。
    const moves = ["a1", "b1", "a2", "b2", "a3", "b3", "a4", "b4", "a5"];
    let turn = 0;
    for (const actionId of moves) {
      const host = turn % 2 === 0;
      const col = host ? 7 + Math.floor(turn / 2) : Math.floor(turn / 2);
      const move = await instance.fetch(
        post("/action", {
          actionId,
          participantHash: host ? H[0]! : H[1]!,
          action: "move",
          payload: { row: host ? 7 : 0, col },
        }),
      );
      expect((await httpJson(move)).ok).toBe(true);
      turn += 1;
    }
    expect((fake.peek("room") as GameRoomState).status).toBe("settled");

    const playerPayload = await httpJson(await instance.fetch(get("/state", { "x-game-viewer-hash": H[0]! })));
    const spectatorPayload = await httpJson(await instance.fetch(get("/state", { "x-game-viewer-hash": H[6]! })));
    const settlement = fake.peek("settlement");
    const playerJson = JSON.stringify(playerPayload);
    const spectatorJson = JSON.stringify(spectatorPayload);
    const settlementJson = JSON.stringify(settlement);
    expectNoCredentials(playerJson, "gomoku 玩家响应");
    expectNoCredentials(spectatorJson, "gomoku 观战响应");
    expectNoCredentials(settlementJson, "gomoku 结算");

    // 对位不回退：信封 players 与引擎座位共用同一组 seatToken；
    // youSeatToken 是查看者自己的令牌、观战者为 null。
    const players = playerPayload.view as {
      players: Array<{ seatToken: string }>;
      view: { players: Array<{ seatToken: string }> };
    };
    expect(players.players).toHaveLength(2);
    expect(players.view.players.map((seat) => seat.seatToken).sort()).toEqual(
      players.players.map((player) => player.seatToken).sort(),
    );
    expect(playerPayload.youSeatToken).toMatch(/^[0-9a-f]{32}$/);
    expect((spectatorPayload.youSeatToken as string | null) ?? null).toBeNull();
  });

  it("xiangqi：离席认输结算，玩家/观战/结算零凭证，胜者以座位令牌对位", async () => {
    const { instance, fake } = makeDO();
    await createAndSeat(instance, "xiangqi", "room_102", 2);
    const resign = await httpJson(
      await instance.fetch(post("/action", { actionId: "r1", participantHash: H[1]!, action: "resign" })),
    );
    expect(resign.ok).toBe(true);
    const room = fake.peek("room") as GameRoomState;
    expect(room.status).toBe("settled");

    const settlement = fake.peek("settlement") as { winnerSeatToken: string | null };
    const hostToken = room.players.find((p) => p.participantHash === H[0]!)?.seatToken;
    expect(settlement.winnerSeatToken).toBe(hostToken);
    expectNoCredentials(JSON.stringify(settlement), "xiangqi 结算");
    for (const viewer of [H[0]!, H[1]!, H[6]!]) {
      const payload = await httpJson(await instance.fetch(get("/state", { "x-game-viewer-hash": viewer })));
      expectNoCredentials(JSON.stringify(payload), `xiangqi 视角 ${viewer === H[6]! ? "观战" : "玩家"}`);
    }
  });

  it("doudizhu：座位投影改 seatToken 后昵称对位不回退；认输终局零凭证", async () => {
    const { instance, fake } = makeDO();
    await createAndSeat(instance, "doudizhu", "room_103", 3);
    // 进行中视图：座位载荷的 seatToken 与信封 players 完全同组（doudizhuSeatName
    // 的对位数据源），且不含 participantHash 字样。
    const mid = await httpJson(await instance.fetch(get("/state", { "x-game-viewer-hash": H[1]! })));
    const midView = mid.view as {
      players: Array<{ seatToken: string }>;
      view: { seats: Array<{ seatIndex: number; seatToken: string; handCount: number }> };
    };
    expectNoCredentials(JSON.stringify(mid), "doudizhu 进行中响应");
    expect(midView.view.seats.map((seat) => seat.seatToken).sort()).toEqual(
      midView.players.map((player) => player.seatToken).sort(),
    );
    // 两家认输 → 在座不足两人 → 终局中止并结算。
    for (const [i, actionId] of ["r1", "r2"].entries()) {
      const resign = await instance.fetch(post("/action", { actionId, participantHash: H[i + 1]!, action: "resign" }));
      expect((await httpJson(resign)).ok).toBe(true);
    }
    expect((fake.peek("room") as GameRoomState).status).toBe("settled");
    const settlement = fake.peek("settlement");
    expectNoCredentials(JSON.stringify(settlement), "doudizhu 结算");
    for (const viewer of [H[0]!, H[6]!]) {
      const payload = await httpJson(await instance.fetch(get("/state", { "x-game-viewer-hash": viewer })));
      expectNoCredentials(JSON.stringify(payload), `doudizhu 终态视角 ${viewer === H[6]! ? "观战" : "玩家"}`);
    }
  });

  it("ludo：三家认输后最后在场者胜，结算 ranking/座位以 seatToken 对位", async () => {
    const { instance, fake } = makeDO();
    await createAndSeat(instance, "ludo", "room_104", 4);
    for (const [i, actionId] of ["r1", "r2", "r3"].entries()) {
      const resign = await instance.fetch(post("/action", { actionId, participantHash: H[i + 1]!, action: "resign" }));
      expect((await httpJson(resign)).ok).toBe(true);
    }
    expect((fake.peek("room") as GameRoomState).status).toBe("settled");
    const settlement = fake.peek("settlement") as {
      summary: { ranking: Array<{ seatToken: string }>; seats: Array<{ seatToken: string }> };
    };
    expectNoCredentials(JSON.stringify(settlement), "ludo 结算");
    expect(settlement.summary.ranking[0]!.seatToken).toMatch(/^[0-9a-f]{32}$/);
    const room = fake.peek("room") as GameRoomState;
    const tokens = room.players.filter((p) => p.leftAt === null).map((p) => p.seatToken);
    expect(settlement.summary.seats.every((seat) => tokens.includes(seat.seatToken))).toBe(true);
    for (const viewer of [H[0]!, H[6]!]) {
      const payload = await httpJson(await instance.fetch(get("/state", { "x-game-viewer-hash": viewer })));
      expectNoCredentials(JSON.stringify(payload), `ludo 视角 ${viewer === H[6]! ? "观战" : "玩家"}`);
    }
  });

  it("werewolf：身份洗牌后一路托管到终局，玩家/狼队友座位/观战/结算零凭证", async () => {
    const { instance, fake } = makeDO();
    await createAndSeat(instance, "werewolf", "room_105", 6);
    // 全员连上（拿玩家私有视图），再托管推进：夜刀自动、发言/投票超时托管。
    const sockets: FakeSocket[] = [];
    for (let i = 0; i < 6; i += 1) {
      const socket = fakeSocket();
      await (
        instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
      ).registerSocket(socket, H[i]!, fake.peek("room") as GameRoomState);
      sockets.push(socket);
    }
    const spectator = fakeSocket();
    await (
      instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
    ).registerSocket(spectator, H[6]!, fake.peek("room") as GameRoomState);
    sockets.push(spectator);
    await driveToSettled(instance, fake);
    expect((fake.peek("room") as GameRoomState).status).toBe("settled");

    for (const [i, socket] of sockets.entries()) {
      const frames = JSON.stringify(socket.sent);
      expectNoCredentials(frames, `werewolf ${i === 6 ? "观战" : `玩家${i + 1}`} WS 帧`);
    }
    for (const viewer of [H[0]!, H[6]!]) {
      const payload = await httpJson(await instance.fetch(get("/state", { "x-game-viewer-hash": viewer })));
      expectNoCredentials(JSON.stringify(payload), `werewolf 终态视角 ${viewer === H[6]! ? "观战" : "玩家"}`);
    }
    const settlement = fake.peek("settlement");
    expectNoCredentials(JSON.stringify(settlement), "werewolf 结算（含复盘身份板）");
  });

  it("聊天帧只带座位署名：fromSeat 是 32 位 hex 令牌，绝不带任何玩家哈希", async () => {
    const { instance, fake } = makeDO();
    await createAndSeat(instance, "gomoku", "room_106", 2);
    const hostSocket = fakeSocket();
    const guestSocket = fakeSocket();
    const spectatorSocket = fakeSocket();
    const register = (
      instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
    ).registerSocket.bind(instance);
    await register(hostSocket, H[0]!, fake.peek("room") as GameRoomState);
    await register(guestSocket, H[1]!, fake.peek("room") as GameRoomState);
    await register(spectatorSocket, H[6]!, fake.peek("room") as GameRoomState);
    hostSocket.sent.length = 0;
    guestSocket.sent.length = 0;
    spectatorSocket.sent.length = 0;

    const send = await instance.webSocketMessage(
      hostSocket as unknown as WebSocket,
      JSON.stringify({ type: "chat_text", channel: "all", text: "晚上好", clientId: "c-1" }),
    );
    void send;
    // 发送者回显 + 其余成员中继：所有帧都是房主那条消息，署名 = 房主座位令牌。
    const room = fake.peek("room") as GameRoomState;
    const hostToken = room.players.find((p) => p.participantHash === H[0]!)?.seatToken ?? "";
    for (const socket of [hostSocket, guestSocket, spectatorSocket]) {
      const chats = socket.sent.filter((frame) => frame.type === "chat");
      expect(chats).toHaveLength(1);
      const message = (chats[0] as { message: { fromSeat: string; from: string } }).message;
      expect(message.from).toBe("房主");
      expect(message.fromSeat).toBe(hostToken);
      expectNoCredentials(JSON.stringify(socket.sent), "聊天帧");
    }
    // 观战者发言：无座位，署名为空串（不携带其 participantHash）。
    guestSocket.sent.length = 0;
    hostSocket.sent.length = 0;
    spectatorSocket.sent.length = 0;
    await instance.webSocketMessage(
      spectatorSocket as unknown as WebSocket,
      JSON.stringify({ type: "chat_text", channel: "all", text: "围观", clientId: "c-2" }),
    );
    const spectatorChat = (
      spectatorSocket.sent.find((frame) => frame.type === "chat") as {
        message: { fromSeat: string; from: string };
      }
    ).message;
    expect(spectatorChat.from).toBe("观战者");
    expect(spectatorChat.fromSeat).toBe("");
    expectNoCredentials(JSON.stringify(hostSocket.sent), "观战发言中继帧");

    // 存量兜底：旧部署写入的暂存消息签名是 fromHash（participantHash），重连
    // 补发前必须清洗成 fromSeat（玩家）或空串（观战/座位缺失）。
    await fake.storage.put("chat:m:1", {
      seq: 1,
      channel: "all",
      kind: "text",
      from: "房主",
      fromHash: H[0]!,
      at: Date.now(),
      clientId: "legacy-1",
      text: "历史消息",
    });
    const reconnect = fakeSocket();
    await (
      instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
    ).registerSocket(reconnect, H[1]!, fake.peek("room") as GameRoomState);
    const historyFrame = reconnect.sent.find((frame) => frame.type === "chat_history") as unknown as {
      messages: Array<Record<string, unknown>>;
    };
    const legacyEntry = historyFrame.messages.find((message) => message.clientId === "legacy-1");
    expect(legacyEntry).toBeDefined();
    expect(legacyEntry).not.toHaveProperty("fromHash");
    expect(legacyEntry!.fromSeat).toMatch(/^[0-9a-f]{32}$/);
    expectNoCredentials(JSON.stringify(reconnect.sent), "存量聊天历史补发帧");
  });
});

describe("修复 1/2：seatToken 与 rngNonce 的铸造纪律", () => {
  it("重入沿用同一 seatToken；同 roomId 两间房 rngNonce 互不相同且不进任何对外载荷", async () => {
    const first = makeDO();
    await createAndSeat(first.instance, "gomoku", "room_201", 2);
    const storedFirst = first.fake.peek("room") as GameRoomState;
    // 重入（刷新/断线重连）不改座位令牌。
    await first.instance.fetch(post("/join", { participantHash: H[1]! }, { "x-game-viewer-hash": H[1]! }));
    const afterRejoin = first.fake.peek("room") as GameRoomState;
    expect(afterRejoin.players.find((p) => p.participantHash === H[1]!)?.seatToken).toBe(
      storedFirst.players.find((p) => p.participantHash === H[1]!)?.seatToken,
    );

    // 同 roomId、不同 DO 实例：rngNonce 各自随机铸造（修复 2 的防复现根基）。
    const second = makeDO();
    await createAndSeat(second.instance, "gomoku", "room_201", 2);
    const storedSecond = second.fake.peek("room") as GameRoomState;
    expect(storedFirst.rngNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(storedSecond.rngNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(storedFirst.rngNonce).not.toBe(storedSecond.rngNonce);

    // nonce/seatToken 只存 DO storage：两间房的全部响应都查不到它们的值。
    const responseFirst = await httpJson(await first.instance.fetch(get("/state", { "x-game-viewer-hash": H[0]! })));
    const responseSecond = await httpJson(await second.instance.fetch(get("/state", { "x-game-viewer-hash": H[0]! })));
    expect(JSON.stringify(responseFirst)).not.toContain(storedFirst.rngNonce);
    expect(JSON.stringify(responseFirst)).not.toContain("rngNonce");
    expect(JSON.stringify(responseSecond)).not.toContain(storedSecond.rngNonce);
    for (const token of storedFirst.players.map((p) => p.seatToken)) {
      expect(JSON.stringify(responseFirst)).not.toContain(`"participantHash":"${token}`);
    }
  });
});
