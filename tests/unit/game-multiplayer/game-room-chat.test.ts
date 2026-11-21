import { beforeEach, describe, expect, it } from "vitest";

import { GameRoomDO } from "../../../src/durable-objects/game-room";
import { clearGameEnginesForTest, registerGameEngine } from "../../../src/game/multiplayer/engine-registry";
import {
  CHAT_HISTORY_LIMIT,
  type GameChatMessage,
  type GameRoomState,
} from "../../../src/game/multiplayer/engine-types";
import type { MultiplayerGameEngine } from "../../../src/game/multiplayer/engine-types";
import { stubEngine } from "../../helpers/game-engine-stub";

/**
 * GameRoomDO 房间内聊天集成单测（批次：房间实时讨论）。
 *
 * 构造方式沿用 game-room-do.test.ts 的先例（map-backed 假 storage + 假
 * Hibernation 面，vitest 造不了 101，直接驱动 registerSocket）。
 * 覆盖：频道裁剪（wolves 非狼不可见的泄漏断言）、环形上限 50、大小/速率
 * 限制与错误码、settle/close/回收三条即焚路径、语音图片不落盘。
 */

/** 狼人桩引擎：房主是狼人（chatMembership 钩子只给 isWolf，不标死亡）。 */
const WOLF_ENGINE: MultiplayerGameEngine = {
  ...stubEngine,
  gameType: "stub-wolf",
  label: "狼人协议桩",
  chatMembership: (_state, participantHash) => ({ isWolf: participantHash === HOST, isDead: false }),
};

/** 假 WebSocket：记录 send 的消息与 attachment，供断言。 */
function fakeSocket() {
  const sent: GameServerMessageRecord[] = [];
  let attachment: unknown;
  return {
    tags: null as string[] | null,
    sent,
    send: (message: string) => {
      sent.push(JSON.parse(message) as GameServerMessageRecord);
    },
    serializeAttachment: (value: unknown) => {
      attachment = value;
    },
    deserializeAttachment: () => attachment,
  };
}

type FakeSocket = ReturnType<typeof fakeSocket>;
type GameServerMessageRecord = Record<string, unknown> & { type?: string };

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
        const limit = options?.limit ?? Number.POSITIVE_INFINITY;
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

async function registerSocket(
  instance: GameRoomDO,
  fake: ReturnType<typeof fakeCtx>,
  hash: string,
): Promise<FakeSocket> {
  const socket = fakeSocket();
  await (
    instance as unknown as { registerSocket(ws: FakeSocket, hash: string, room: GameRoomState): Promise<void> }
  ).registerSocket(socket, hash, fake.peek("room") as GameRoomState);
  return socket;
}

/** 经 WS 发一条聊天信封（fire-and-forget；回显落在 socket.sent 里）。 */
async function sendChat(instance: GameRoomDO, socket: FakeSocket, message: Record<string, unknown>): Promise<void> {
  await instance.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(message));
}

function chatFrames(socket: FakeSocket): GameChatMessage[] {
  return socket.sent.filter((frame) => frame.type === "chat").map((frame) => frame.message as GameChatMessage);
}

function historyOf(socket: FakeSocket): GameChatMessage[] {
  const frame = socket.sent.find((item) => item.type === "chat_history");
  return frame ? (frame.messages as GameChatMessage[]) : [];
}

const HOST = "hash-host"; // 房主兼狼人
const GUEST = "hash-guest";
const STRANGER = "hash-stranger";

/** 标准房间：建房（狼人桩）+ 客人加入，未开局。 */
async function makeRoom() {
  const { instance, fake } = makeDO();
  await instance.fetch(
    post(
      "/create",
      { gameType: "stub-wolf", roomId: "room_77", host: { participantHash: HOST, displayName: "狼哥" } },
      { "x-game-viewer-hash": HOST },
    ),
  );
  await instance.fetch(post("/join", { participantHash: GUEST, displayName: "客人" }, { "x-game-viewer-hash": GUEST }));
  return { instance, fake };
}

/** 标准开局（lobby → playing），供对局中聊天与 settle 即焚用例。 */
async function makeStartedRoom() {
  const room = await makeRoom();
  await room.instance.fetch(post("/ready", { participantHash: HOST, ready: true }));
  await room.instance.fetch(post("/ready", { participantHash: GUEST, ready: true }));
  await room.instance.fetch(post("/start", { participantHash: HOST }));
  return room;
}

const textSend = (channel: string, text: string) => ({ type: "chat_text", channel, text, clientId: `c-${text}` });

beforeEach(() => {
  clearGameEnginesForTest();
  registerGameEngine(WOLF_ENGINE);
});

// ---------------------------------------------------------------------------
// 中继与回显
// ---------------------------------------------------------------------------

describe("聊天中继（收到即广播）", () => {
  it("all 频道：发送者拿回显，其余成员收到中继；消息只含座位昵称与内容（无 IP/UA 字段）", async () => {
    const { instance, fake } = await makeRoom();
    const hostSocket = await registerSocket(instance, fake, HOST);
    const guestSocket = await registerSocket(instance, fake, GUEST);
    const spectatorSocket = await registerSocket(instance, fake, STRANGER);
    hostSocket.sent.length = 0;
    guestSocket.sent.length = 0;
    spectatorSocket.sent.length = 0;

    await sendChat(instance, hostSocket, textSend("all", "晚上好"));

    // 回显恰好一份（广播排除发送者连接）。
    expect(chatFrames(hostSocket)).toHaveLength(1);
    const message = chatFrames(hostSocket)[0]!;
    expect(message).toMatchObject({
      seq: 1,
      channel: "all",
      kind: "text",
      from: "狼哥",
      fromHash: HOST,
      text: "晚上好",
    });
    expect(Object.keys(message).sort()).toEqual([
      "at",
      "channel",
      "clientId",
      "from",
      "fromHash",
      "kind",
      "seq",
      "text",
    ]);
    // 其他成员各收一份。
    expect(chatFrames(guestSocket).map((m) => m.text)).toEqual(["晚上好"]);
    expect(chatFrames(spectatorSocket).map((m) => m.text)).toEqual(["晚上好"]);
  });

  it("对局中聊天照常（lobby/playing 都放行）", async () => {
    const { instance, fake } = await makeStartedRoom();
    const hostSocket = await registerSocket(instance, fake, HOST);
    hostSocket.sent.length = 0;
    await sendChat(instance, hostSocket, textSend("all", "开始吧"));
    expect(chatFrames(hostSocket)).toHaveLength(1);
  });

  it("结算后的房间拒收新消息（game_over）", async () => {
    const { instance, fake } = await makeStartedRoom();
    const hostSocket = await registerSocket(instance, fake, HOST);
    for (let i = 0; i < 3; i += 1) {
      await instance.fetch(
        post("/action", { actionId: `m${i}`, participantHash: HOST, action: "move", payload: { value: i + 1 } }),
      );
    }
    hostSocket.sent.length = 0;
    await sendChat(instance, hostSocket, textSend("all", "再聊两句"));
    const error = hostSocket.sent[0]! as { type: string; code: string };
    expect(error.type).toBe("error");
    expect(error.code).toBe("game_over");
  });
});

// ---------------------------------------------------------------------------
// 频道裁剪（泄漏断言）
// ---------------------------------------------------------------------------

describe("wolves 频道裁剪（非狼不可见的泄漏断言）", () => {
  it("狼人发 wolves：只有狼人自己收到；非狼玩家与观战的连接上没有任何 wolves 内容", async () => {
    const { instance, fake } = await makeRoom();
    const hostSocket = await registerSocket(instance, fake, HOST);
    const guestSocket = await registerSocket(instance, fake, GUEST);
    const spectatorSocket = await registerSocket(instance, fake, STRANGER);
    hostSocket.sent.length = 0;
    guestSocket.sent.length = 0;
    spectatorSocket.sent.length = 0;

    await sendChat(instance, hostSocket, textSend("wolves", "今晚刀谁"));

    expect(chatFrames(hostSocket).map((m) => m.channel)).toEqual(["wolves"]);
    // 泄漏断言：非狼连接的整条发送记录里不得出现 wolves 内容。
    expect(chatFrames(guestSocket)).toHaveLength(0);
    expect(chatFrames(spectatorSocket)).toHaveLength(0);
    expect(JSON.stringify(guestSocket.sent)).not.toContain("今晚刀谁");
    expect(JSON.stringify(spectatorSocket.sent)).not.toContain("今晚刀谁");
  });

  it("非狼发 wolves / 观战发 wolves：一律 chat_channel_forbidden", async () => {
    const { instance, fake } = await makeRoom();
    const guestSocket = await registerSocket(instance, fake, GUEST);
    const spectatorSocket = await registerSocket(instance, fake, STRANGER);
    guestSocket.sent.length = 0;
    spectatorSocket.sent.length = 0;

    await sendChat(instance, guestSocket, textSend("wolves", "我也是狼"));
    await sendChat(instance, spectatorSocket, textSend("wolves", "我在偷听"));

    for (const socket of [guestSocket, spectatorSocket]) {
      const error = socket.sent[0]! as { type: string; code: string };
      expect(error).toMatchObject({ type: "error", code: "chat_channel_forbidden" });
      expect(chatFrames(socket)).toHaveLength(0);
    }
  });

  it("历史同样裁剪：非狼重连拿到的 chat_history 里没有 wolves 内容（历史泄漏断言）", async () => {
    const { instance, fake } = await makeRoom();
    const hostSocket = await registerSocket(instance, fake, HOST);
    await sendChat(instance, hostSocket, textSend("all", "大家好"));
    await sendChat(instance, hostSocket, textSend("wolves", "狼队暗号"));

    const guestReconnect = await registerSocket(instance, fake, GUEST);
    const spectatorReconnect = await registerSocket(instance, fake, STRANGER);
    const guestHistory = historyOf(guestReconnect);
    expect(guestHistory.map((m) => m.channel)).toEqual(["all"]);
    expect(JSON.stringify(guestHistory)).not.toContain("狼队暗号");
    expect(historyOf(spectatorReconnect).map((m) => m.channel)).toEqual(["all"]);

    // 狼人重连能看到 wolves 历史。
    const wolfReconnect = await registerSocket(instance, fake, HOST);
    expect(
      historyOf(wolfReconnect)
        .map((m) => m.channel)
        .sort(),
    ).toEqual(["all", "wolves"]);
  });
});

describe("dead 频道（死亡与观战）", () => {
  it("观战者发 dead：观战之间可见，在座玩家收不到；在座玩家发 dead 被拒", async () => {
    const { instance, fake } = await makeRoom();
    const spectatorSocket = await registerSocket(instance, fake, STRANGER);
    const spectator2 = await registerSocket(instance, fake, "hash-spec2");
    const guestSocket = await registerSocket(instance, fake, GUEST);
    spectatorSocket.sent.length = 0;
    spectator2.sent.length = 0;
    guestSocket.sent.length = 0;

    await sendChat(instance, spectatorSocket, textSend("dead", "这局有点悬"));

    expect(chatFrames(spectator2).map((m) => m.text)).toEqual(["这局有点悬"]);
    expect(chatFrames(guestSocket)).toHaveLength(0);
    expect(JSON.stringify(guestSocket.sent)).not.toContain("这局有点悬");

    guestSocket.sent.length = 0;
    await sendChat(instance, guestSocket, textSend("dead", "活人插一句"));
    expect(guestSocket.sent[0]).toMatchObject({ type: "error", code: "chat_channel_forbidden" });
  });

  it("离席玩家重连按观战处理：可以发/收 dead", async () => {
    const { instance, fake } = await makeRoom();
    await instance.fetch(post("/leave", { participantHash: GUEST }, { "x-game-viewer-hash": GUEST }));
    const guestSocket = await registerSocket(instance, fake, GUEST);
    guestSocket.sent.length = 0;
    await sendChat(instance, guestSocket, textSend("dead", "我走了还唠两句"));
    expect(chatFrames(guestSocket).map((m) => m.text)).toEqual(["我走了还唠两句"]);
  });
});

// ---------------------------------------------------------------------------
// 限制与错误码
// ---------------------------------------------------------------------------

describe("大小限制与错误码", () => {
  it("501 字拒绝 chat_too_long；空串拒绝 invalid_payload", async () => {
    const { instance, fake } = await makeRoom();
    const hostSocket = await registerSocket(instance, fake, HOST);
    hostSocket.sent.length = 0;
    await sendChat(instance, hostSocket, textSend("all", "长".repeat(501)));
    expect(hostSocket.sent[0]).toMatchObject({ type: "error", code: "chat_too_long" });

    await sendChat(instance, hostSocket, textSend("all", "   "));
    expect(hostSocket.sent[1]).toMatchObject({ type: "error", code: "invalid_payload" });
  });

  it("接入仓库现有词表审核：命中敏感词拒绝 chat_content_rejected", async () => {
    const { instance, fake } = await makeRoom();
    const hostSocket = await registerSocket(instance, fake, HOST);
    hostSocket.sent.length = 0;
    await sendChat(instance, hostSocket, textSend("all", "进刷单群找我"));
    expect(hostSocket.sent[0]).toMatchObject({ type: "error", code: "chat_content_rejected" });
  });

  it("语音/图片超 300KB 拒绝 chat_payload_too_large；时长与形状非法拒绝 invalid_payload", async () => {
    const { instance, fake } = await makeRoom();
    const hostSocket = await registerSocket(instance, fake, HOST);
    hostSocket.sent.length = 0;
    const bigBase64 = "A".repeat(300 * 1024 + 1);
    await sendChat(instance, hostSocket, {
      type: "chat_voice",
      channel: "all",
      audioBase64: bigBase64,
      durationMs: 1_000,
      mimeType: "audio/webm",
      clientId: "v1",
    });
    expect(hostSocket.sent[0]).toMatchObject({ type: "error", code: "chat_payload_too_large" });

    await sendChat(instance, hostSocket, {
      type: "chat_voice",
      channel: "all",
      audioBase64: "AAAA",
      durationMs: 120_000, // 超卫生上限
      mimeType: "audio/webm",
      clientId: "v2",
    });
    expect(hostSocket.sent[1]).toMatchObject({ type: "error", code: "invalid_payload" });

    await sendChat(instance, hostSocket, {
      type: "chat_image",
      channel: "all",
      dataUrl: "data:text/html;base64,AAAA",
      clientId: "i1",
    });
    expect(hostSocket.sent[2]).toMatchObject({ type: "error", code: "invalid_payload" });

    await sendChat(instance, hostSocket, {
      type: "chat_image",
      channel: "all",
      dataUrl: `data:image/jpeg;base64,${bigBase64}`,
      clientId: "i2",
    });
    expect(hostSocket.sent[3]).toMatchObject({ type: "error", code: "chat_payload_too_large" });
  });

  it("语音/图片合法载荷照常中继，但绝不落盘（storage 无 chat:m: 残留）", async () => {
    const { instance, fake } = await makeRoom();
    const hostSocket = await registerSocket(instance, fake, HOST);
    const guestSocket = await registerSocket(instance, fake, GUEST);
    hostSocket.sent.length = 0;
    guestSocket.sent.length = 0;

    await sendChat(instance, hostSocket, {
      type: "chat_voice",
      channel: "all",
      audioBase64: "AAAA",
      durationMs: 2_000,
      mimeType: "audio/webm",
      clientId: "v-ok",
    });
    await sendChat(instance, hostSocket, {
      type: "chat_image",
      channel: "all",
      dataUrl: "data:image/png;base64,AAAA",
      clientId: "i-ok",
    });

    // 发送者拿到两类回显，对端拿到两类中继。
    expect(chatFrames(hostSocket).map((m) => m.kind)).toEqual(["voice", "image"]);
    expect(chatFrames(guestSocket).map((m) => m.kind)).toEqual(["voice", "image"]);
    // 不落盘：文字暂存前缀零残留（seq 计数器在动，但消息键不存在）。
    const storedMessages = await fake.storage.list({ prefix: "chat:m:" });
    expect(storedMessages.size).toBe(0);
    expect(await fake.storage.get<number>("chat:seq")).toBe(2);
  });
});

describe("速率窗口（每参与者 10 条/分钟，房内计数）", () => {
  it("第 11 条被拒 chat_rate_limited；窗口滑过后放行", async () => {
    const { instance, fake } = await makeRoom();
    const hostSocket = await registerSocket(instance, fake, HOST);
    hostSocket.sent.length = 0;
    for (let i = 0; i < 10; i += 1) {
      await sendChat(instance, hostSocket, textSend("all", `m${i}`));
    }
    expect(hostSocket.sent.filter((frame) => frame.type === "chat")).toHaveLength(10);
    await sendChat(instance, hostSocket, textSend("all", "超了"));
    expect(hostSocket.sent.at(-1)).toMatchObject({ type: "error", code: "chat_rate_limited" });

    // 把窗口拨回 61s 前（滑动窗口剪掉旧记录）→ 放行。
    const rateKey = "chat:rate:" + HOST;
    const stale = [Date.now() - 61_000];
    await fake.storage.put(rateKey, stale);
    hostSocket.sent.length = 0;
    await sendChat(instance, hostSocket, textSend("all", "缓过来了"));
    expect(chatFrames(hostSocket).map((m) => m.text)).toEqual(["缓过来了"]);
  });

  it("速率按参与者隔离：A 被限流不影响 B（观战者与玩家同一套规则）", async () => {
    const { instance, fake } = await makeRoom();
    const hostSocket = await registerSocket(instance, fake, HOST);
    const guestSocket = await registerSocket(instance, fake, GUEST);
    for (let i = 0; i < 10; i += 1) {
      await sendChat(instance, hostSocket, textSend("all", `h${i}`));
    }
    hostSocket.sent.length = 0;
    await sendChat(instance, hostSocket, textSend("all", "host-blocked"));
    expect(hostSocket.sent.at(-1)).toMatchObject({ code: "chat_rate_limited" });
    guestSocket.sent.length = 0;
    await sendChat(instance, guestSocket, textSend("all", "guest-fine"));
    expect(chatFrames(guestSocket).map((m) => m.text)).toEqual(["guest-fine"]);
  });
});

// ---------------------------------------------------------------------------
// 环形上限（文字 50 条）
// ---------------------------------------------------------------------------

describe("环形上限 50（文字暂存）", () => {
  it("60 条文字后暂存只剩最近 50 条；重连历史 = 最近 50 条且序号连续", async () => {
    const { instance, fake } = await makeRoom();
    // 10 个身份 × 6 条 = 60 条（每人 6 < 10 限流），两玩家 + 八观战。
    const identities = [HOST, GUEST, ...Array.from({ length: 8 }, (_, i) => `hash-spec${i}`)];
    const sockets = new Map<string, FakeSocket>();
    for (const hash of identities) sockets.set(hash, await registerSocket(instance, fake, hash));
    let seq = 0;
    for (let round = 0; round < 6; round += 1) {
      for (const hash of identities) {
        seq += 1;
        await sendChat(instance, sockets.get(hash)!, textSend("all", `msg-${seq}`));
      }
    }
    const stored = await fake.storage.list<GameChatMessage>({ prefix: "chat:m:" });
    expect(stored.size).toBe(CHAT_HISTORY_LIMIT);
    const keys = [...stored.keys()].sort();
    expect(keys[0]).toBe("chat:m:000000000011"); // 前 10 条被环形淘汰
    expect(keys[keys.length - 1]).toBe("chat:m:000000000060");

    const reconnect = await registerSocket(instance, fake, STRANGER);
    const history = historyOf(reconnect);
    expect(history).toHaveLength(CHAT_HISTORY_LIMIT);
    expect(history[0]!.text).toBe("msg-11");
    expect(history[history.length - 1]!.text).toBe("msg-60");
    expect(JSON.stringify(history)).not.toContain('msg-1"'); // msg-1 已焚（含 msg-10 前缀防误配）
  });
});

// ---------------------------------------------------------------------------
// 即焚：settle / close / 回收 三条路径
// ---------------------------------------------------------------------------

describe("即焚（对局结束即焚，绝不残留）", () => {
  it("结算（settle）：chat:* 全部清空——文字暂存、速率窗口、序号一并消失", async () => {
    const { instance, fake } = await makeStartedRoom();
    const hostSocket = await registerSocket(instance, fake, HOST);
    await sendChat(instance, hostSocket, textSend("all", "对局中的话"));
    expect(await fake.storage.get<number>("chat:seq")).toBe(1);

    for (let i = 0; i < 3; i += 1) {
      await instance.fetch(
        post("/action", { actionId: `m${i}`, participantHash: HOST, action: "move", payload: { value: i + 1 } }),
      );
    }
    expect((fake.peek("room") as GameRoomState).status).toBe("settled");
    const chatKeys = [...(await fake.storage.list({ prefix: "chat:" })).keys()];
    expect(chatKeys).toEqual([]);
  });

  it("房主关闭（close）：聊天同步焚毁", async () => {
    const { instance, fake } = await makeStartedRoom();
    await sendChat(instance, await registerSocket(instance, fake, HOST), textSend("all", "还没关闭"));
    await instance.fetch(post("/close", { participantHash: HOST }));
    expect((fake.peek("room") as GameRoomState).status).toBe("closed");
    expect([...(await fake.storage.list({ prefix: "chat:" })).keys()]).toEqual([]);
  });

  it("空房回收（alarm → deleteAll）：聊天随整个实例消失，不再续闹", async () => {
    const { instance, fake } = await makeRoom();
    await sendChat(instance, await registerSocket(instance, fake, HOST), textSend("all", "留不住的话"));
    const room = fake.peek("room") as GameRoomState;
    await fake.storage.put("room", { ...room, recycleAt: Date.now() - 1 });
    await fake.storage.setAlarm(Date.now() - 1);

    await instance.alarm();

    expect(fake.peek("room")).toBeUndefined();
    expect([...(await fake.storage.list({ prefix: "chat:" })).keys()]).toEqual([]);
    expect(await fake.storage.getAlarm()).toBeNull();
  });

  it("全员离席关闭（leaveRoomDefault → closed）：同样焚毁", async () => {
    const { instance, fake } = await makeRoom();
    await instance.fetch(post("/leave", { participantHash: HOST }, { "x-game-viewer-hash": HOST }));
    await instance.fetch(post("/leave", { participantHash: GUEST }, { "x-game-viewer-hash": GUEST }));
    expect((fake.peek("room") as GameRoomState).status).toBe("closed");
    expect([...(await fake.storage.list({ prefix: "chat:" })).keys()]).toEqual([]);
  });
});
