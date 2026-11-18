import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { createSqliteD1, sqliteD1Available } from "../helpers/sqlite-d1";
import {
  blockThread,
  decideDrawKind,
  DRAW_COST_COINS,
  drawNote,
  drawPoolWhere,
  FREE_DRAWS_PER_DAY,
  isBlockedPair,
  listMessages,
  listThreads,
  noteDrawnDmText,
  noteReplyDmText,
  putNote,
  reportMessage,
  sendMessage,
  unblockThread,
  validateNoteDraft,
  withdrawNote,
  type NoteError,
} from "../../src/services/note-chat.service";
import { markNotificationsSeen } from "../../src/services/series-follow.service";
import { findBlockedWord, isNoteContentAllowed } from "../../src/services/note-content-filter.service";

/* T2 · 纸条 DM：bot/telegram 打桩——服务内部经 sendMessage 私聊，
 * mock 只在 dm 上下文传入时被触达（存量用例不传 dm，行为不变）。 */
const telegramMocks = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("../../src/bot/telegram", () => ({ sendMessage: telegramMocks.sendMessage }));

describe("纸条聊天 · 纯规则", () => {
  describe("decideDrawKind（免费额 → 金币）", () => {
    it("当日未抽/未满免费额时走 free 并递减剩余次数", () => {
      expect(decideDrawKind(0)).toEqual({ kind: "free", freeLeft: 2, costCoins: 0 });
      expect(decideDrawKind(2)).toEqual({ kind: "free", freeLeft: 0, costCoins: 0 });
    });
    it("免费额用完即转 coin，不再有剩余免费额", () => {
      const decision = decideDrawKind(3);
      expect(decision.kind).toBe("coin");
      expect(decision.freeLeft).toBe(0);
      expect(decision.costCoins).toBeGreaterThan(0);
    });
    it("超额计数（防御性）也稳定落在 coin", () => {
      expect(decideDrawKind(99).kind).toBe("coin");
    });
  });

  describe("validateNoteDraft", () => {
    it("合法草稿通过并裁剪地区空白", () => {
      const clean = validateNoteDraft({ gender: "f", ageBand: "25-30", region: "  上海  ", content: "  你好呀  " });
      expect(clean).toEqual({ gender: "f", ageBand: "25-30", region: "上海", content: "你好呀" });
    });
    it("非法性别/年龄段被拒", () => {
      expect(() => validateNoteDraft({ gender: "robot", ageBand: "25-30", region: "", content: "hi" })).toThrowError(
        /性别/,
      );
      expect(() => validateNoteDraft({ gender: "m", ageBand: "under-18", region: "", content: "hi" })).toThrowError(
        /年龄段/,
      );
    });
    it("空内容与超长内容被拒", () => {
      expect(() => validateNoteDraft({ gender: "m", ageBand: "18-24", region: "", content: "   " })).toThrowError();
      expect(() =>
        validateNoteDraft({ gender: "m", ageBand: "18-24", region: "", content: "字".repeat(301) }),
      ).toThrowError(/300/);
    });
  });

  describe("drawPoolWhere（抽取池边界）", () => {
    it("排除自己、非可抽状态、已聊过的纸条、双向拉黑的对方，并以当前时刻为界", () => {
      const { sql, params } = drawPoolWhere("hash_a", "2026-10-24T00:00:00Z");
      expect(sql).toContain("owner_hash != ?");
      expect(sql).toContain("status = 'active'");
      expect(sql).toContain("expires_at > ?");
      expect(sql).toContain("id NOT IN (SELECT note_id FROM note_threads WHERE drawer_hash = ?)");
      // 0094 拉黑：两个方向都要排除（blocker→blocked 与 blocked→blocker）。
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toContain("b.blocker_hash = ? AND b.blocked_hash = notes.owner_hash");
      expect(sql).toContain("b.blocker_hash = notes.owner_hash AND b.blocked_hash = ?");
      expect(params).toEqual(["2026-10-24T00:00:00Z", "hash_a", "hash_a", "hash_a", "hash_a"]);
    });
  });

  describe("note-content-filter（发布前过滤词表）", () => {
    it("命中词表词（含大小写与空格插花变体）", () => {
      expect(findBlockedWord("来约炮吗")).toBe("约炮");
      expect(findBlockedWord("加我, 一起 刷 单")).toBe("刷单");
      expect(findBlockedWord("买点K粉")).toBe("k粉");
    });
    it("正常内容与边缘日常词放行（词表刻意保守）", () => {
      expect(isNoteContentAllowed("今天路过公园，看到一只很胖的橘猫")).toBe(true);
      expect(isNoteContentAllowed("我不喜欢赌博")).toBe(true);
      expect(isNoteContentAllowed("")).toBe(true);
    });
  });

  describe("DM 文案（T2 · 纯函数）", () => {
    it("被抽中文案含 /notes?thread=X&tab=chat 深链，origin 尾斜杠被剥掉", () => {
      const text = noteDrawnDmText("https://o.test/", 42);
      expect(text).toContain("https://o.test/notes?thread=42&tab=chat");
      expect(text).toContain("你的纸条被抽中了");
    });
    it("回信摘要 ≤120 字原样引用；超长截断为 120 字 + …，深链同构", () => {
      const short = noteReplyDmText("你好呀", "https://o.test", 7);
      expect(short).toContain("「你好呀」");
      expect(short).toContain("https://o.test/notes?thread=7&tab=chat");
      const long = noteReplyDmText("字".repeat(121), "https://o.test", 7);
      expect(long).toContain(`「${"字".repeat(120)}…」`);
      expect(long).not.toContain("字".repeat(121));
    });
  });
});

/* ------------------------------------------------------------------ *
 * DB 行为（0094 安全层）——用 sqlite-d1 harness 跑真迁移 + 真服务 SQL。
 * ------------------------------------------------------------------ */

const NOTE_SCHEMA = ["0084_follows_notifications.sql", "0089_note_chat.sql", "0094_note_chat_safety.sql"]
  .map((file) => readFileSync(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"))
  .join("\n");

// drawNote 要读余额（getCoinAccount），且幂等重放预检查 coin_transactions
// （0089 之后 drawNote 每次抽取都会摸这张表）。手写最小两张账本表
//（plaza-post.repository.test.ts 同款做法），免引入整条金币迁移链；
// coin_transactions 与 0078 同列同约束（idempotency_key 全局 UNIQUE）。
const COIN_ACCOUNTS_DDL = `
CREATE TABLE IF NOT EXISTS coin_accounts (
  participant_hash TEXT NOT NULL PRIMARY KEY,
  user_id INTEGER,
  balance INTEGER NOT NULL DEFAULT 0,
  total_earned INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS coin_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_hash TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  note TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);
`;

// T2 · DM 反查的收件人侧：user_ 直查 users、web_ 经 participant_links（0001/0044
// 最小 DDL）；不传 dm 的存量用例碰不到这两张表。
const IDENTITY_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  system_role TEXT NOT NULL DEFAULT 'participant',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS participant_links (
  participant_key TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL
);
`;

describe.skipIf(!sqliteD1Available)("纸条聊天 · DB 行为（0094 安全层）", () => {
  function makeDb(): D1Database {
    // D1 默认开外键，迁移整体一次执行（与 wrangler d1 migrations apply 同语义）。
    return createSqliteD1(`PRAGMA foreign_keys = ON;\n${NOTE_SCHEMA}\n${COIN_ACCOUNTS_DDL}\n${IDENTITY_DDL}`);
  }

  async function putNoteOk(db: D1Database, ownerHash: string, content: string): Promise<void> {
    await putNote(db, ownerHash, { gender: "x", ageBand: "25-30", region: "", content }, null);
  }

  async function countRows(db: D1Database, table: string): Promise<number> {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  /** 建一条「B 抽中 A」的会话，返回 threadId。 */
  async function makeThread(db: D1Database): Promise<number> {
    await putNoteOk(db, "hash_a", "A 的纸条");
    await putNoteOk(db, "hash_b", "B 的纸条");
    const draw = await drawNote(db, "hash_b", null, "note:test-1");
    expect(draw).toMatchObject({ ok: true, empty: false });
    return "threadId" in draw ? draw.threadId : 0;
  }

  /** 按 id 升序读全量通知（participant_hash 归一为 participantHash 便于断言）。 */
  async function listNotificationRows(db: D1Database) {
    const rows = await db
      .prepare(
        `SELECT id, participant_hash AS participantHash, kind, title, body, link, read_at AS readAt
           FROM notifications ORDER BY id`,
      )
      .all<{
        id: number;
        participantHash: string;
        kind: string;
        title: string;
        body: string;
        link: string;
        readAt: string | null;
      }>();
    return rows.results ?? [];
  }

  it("过滤命中 → 校验阶段拒绝（note_filter_rejected），notes 零新行", async () => {
    const db = makeDb();
    await expect(putNoteOk(db, "hash_a", "打个广告：兼职刷单日结")).rejects.toMatchObject({
      code: "note_filter_rejected",
    });
    expect(await countRows(db, "notes")).toBe(0);
    await putNoteOk(db, "hash_a", "正常的纸条内容");
    // 有 active 纸条后再发敏感词：过滤在校验阶段先于「1 人 1 张」判断，仍拒收。
    await expect(putNoteOk(db, "hash_a", "再来一条带大麻的")).rejects.toMatchObject({
      code: "note_filter_rejected",
    });
    // 正常纸条恰好 1 行，被拒的两条都没落库。
    expect(await countRows(db, "notes")).toBe(1);
    // 消息同样拒收：B 放纸条并抽中 A，建一条会话再发。
    await putNoteOk(db, "hash_b", "B 的纸条");
    const draw = await drawNote(db, "hash_b", null, "note:test-1");
    expect(draw).toMatchObject({ ok: true, empty: false });
    const threadId = "threadId" in draw ? draw.threadId : 0;
    await expect(sendMessage(db, threadId, "hash_b", "顺便卖点海洛因", null)).rejects.toMatchObject({
      code: "note_filter_rejected",
    });
    expect(await countRows(db, "note_messages")).toBe(0);
  });

  it("拉黑（双向）后 sendMessage 报 blocked；解 block 只删自己的那一行", async () => {
    const db = makeDb();
    const threadId = await makeThread(db);
    // B 经会话入口拉黑 A，重复拉黑幂等。
    await expect(blockThread(db, threadId, "hash_b")).resolves.toBe(true);
    await expect(blockThread(db, threadId, "hash_b")).resolves.toBe(true);
    expect(await isBlockedPair(db, "hash_a", "hash_b")).toBe(true);
    // 双方都不能再发消息（任一方向存在拉黑行即 blocked）。
    await expect(sendMessage(db, threadId, "hash_b", "还在吗", null)).rejects.toMatchObject({ code: "blocked" });
    await expect(sendMessage(db, threadId, "hash_a", "在的", null)).rejects.toMatchObject({ code: "blocked" });

    // B 解除拉黑：只删 (B→A) 一行；A 从未拉黑 B，重复解除返回 false。
    await expect(unblockThread(db, threadId, "hash_b")).resolves.toBe(true);
    await expect(unblockThread(db, threadId, "hash_b")).resolves.toBe(false);
    await expect(unblockThread(db, threadId, "hash_a")).resolves.toBe(false);
    await expect(sendMessage(db, threadId, "hash_b", "还在吗", null)).resolves.toMatchObject({ mine: true });

    // 反向：A 拉黑 B，B 发消息被拒；A 解除后恢复。
    await expect(blockThread(db, threadId, "hash_a")).resolves.toBe(true);
    await expect(sendMessage(db, threadId, "hash_b", "还在吗", null)).rejects.toMatchObject({ code: "blocked" });
    await expect(unblockThread(db, threadId, "hash_a")).resolves.toBe(true);
    await expect(sendMessage(db, threadId, "hash_a", "在的", null)).resolves.toMatchObject({ mine: true });
  });

  it("抽取池排除双向拉黑的对方（drawNote 端到端）", async () => {
    const db = makeDb();
    const threadId = await makeThread(db);
    // B 已与 A 的第一张纸条聊过；A 下架重放，新纸条成为 B 池中唯一候选。
    await withdrawNote(db, "hash_a");
    await putNoteOk(db, "hash_a", "A 的新纸条");
    // 拉黑生效：唯一候选被排除 → 空池（免费额与金币都不消耗）。
    await blockThread(db, threadId, "hash_b");
    await expect(drawNote(db, "hash_b", null, "note:test-blocked")).resolves.toMatchObject({ ok: true, empty: true });
    // B 解除后同一张纸条立刻可抽。
    await unblockThread(db, threadId, "hash_b");
    const second = await drawNote(db, "hash_b", null, "note:test-unblocked");
    expect(second).toMatchObject({ ok: true, empty: false });
    const threadId2 = "threadId" in second ? second.threadId : 0;
    // 反向：A 拉黑 B 后，A 的新纸条再次被排除。
    await blockThread(db, threadId2, "hash_a");
    await withdrawNote(db, "hash_a");
    await putNoteOk(db, "hash_a", "A 的第三张纸条");
    await expect(drawNote(db, "hash_b", null, "note:test-reverse")).resolves.toMatchObject({ ok: true, empty: true });
  });

  it("listMessages 过滤 hidden，listThreads 末条预览与未读数同口径", async () => {
    const db = makeDb();
    const threadId = await makeThread(db);
    await sendMessage(db, threadId, "hash_b", "第 1 条", null);
    await sendMessage(db, threadId, "hash_b", "第 2 条（将被隐藏）", null);
    await sendMessage(db, threadId, "hash_b", "第 3 条", null);
    const rows = await db.prepare(`SELECT id, body FROM note_messages ORDER BY id`).all<{ id: number; body: string }>();
    const hidden = (rows.results ?? []).find((row) => row.body.includes("将被隐藏"));
    await db.prepare(`UPDATE note_messages SET status = 'hidden' WHERE id = ?`).bind(hidden?.id).run();

    // 读侧（A 视角）：拉取时被隐藏那条不可见。
    const mine = await listMessages(db, threadId, "hash_a", 0);
    expect(mine?.messages.map((message) => message.body)).toEqual(["第 1 条", "第 3 条"]);

    // 未读数同口径：把 A 的水位拨回 0，未读只数 active 两条。
    await db.prepare(`UPDATE note_thread_reads SET last_read_message_id = 0`).run();
    const threads = await listThreads(db, "hash_a");
    expect(threads).toHaveLength(1);
    expect(threads[0]?.unread).toBe(2);
    expect(threads[0]?.lastBody).toBe("第 3 条");
    // B 视角：自己的消息不算未读。
    const threadsB = await listThreads(db, "hash_b");
    expect(threadsB[0]?.unread).toBe(0);
    // message_count 保持原始计数（3 条都计入，软删不改写）。
    const threadRow = await db
      .prepare(`SELECT message_count AS n FROM note_threads WHERE id = ?`)
      .bind(threadId)
      .first<{ n: number }>();
    expect(Number(threadRow?.n ?? 0)).toBe(3);
  });

  it("listThreads 读侧过滤双向拉黑的会话", async () => {
    const db = makeDb();
    const threadId = await makeThread(db);
    await sendMessage(db, threadId, "hash_b", "先聊一句", null);
    await blockThread(db, threadId, "hash_a");
    expect(await listThreads(db, "hash_a")).toHaveLength(0);
    expect(await listThreads(db, "hash_b")).toHaveLength(0);
    await unblockThread(db, threadId, "hash_a");
    expect(await listThreads(db, "hash_a")).toHaveLength(1);
    expect(await listThreads(db, "hash_b")).toHaveLength(1);
  });

  it("消息举报同人去重、参与者校验、消息归属校验", async () => {
    const db = makeDb();
    const threadId = await makeThread(db);
    await sendMessage(db, threadId, "hash_b", "擦边内容", null);
    await sendMessage(db, threadId, "hash_b", "第二条", null);
    const rows = await db.prepare(`SELECT id FROM note_messages ORDER BY id`).all<{ id: number }>();
    const messageId = Number(rows.results?.[0]?.id);
    const secondId = Number(rows.results?.[1]?.id);

    await expect(reportMessage(db, threadId, messageId, "hash_a", "不适内容")).resolves.toEqual({ reportCount: 1 });
    // 同人重复举报：幂等，计数不涨。
    await expect(reportMessage(db, threadId, messageId, "hash_a", "再报一次")).resolves.toEqual({ reportCount: 1 });
    // 另一人举报同一消息：计数 +1（同人去重不跨人）。
    await expect(reportMessage(db, threadId, messageId, "hash_b", "")).resolves.toEqual({ reportCount: 2 });
    // 另一条消息单独计数，互不串。
    await expect(reportMessage(db, threadId, secondId, "hash_a", "")).resolves.toEqual({ reportCount: 1 });
    // 非会话参与者不能举报。
    await expect(reportMessage(db, threadId, messageId, "hash_c", "")).rejects.toMatchObject({
      code: "not_participant",
    });
    // 会话里不存在的消息 id 拒绝。
    await expect(reportMessage(db, threadId, 99999, "hash_a", "")).rejects.toMatchObject({ code: "not_found" });
    expect(await countRows(db, "note_message_reports")).toBe(3);
  });

  it("站内通知：抽中为作者写一条 note_drawn；池空不写（T3）", async () => {
    const db = makeDb();
    await putNoteOk(db, "hash_a", "A 的纸条");
    await putNoteOk(db, "hash_b", "B 的纸条");
    // A 下架 → B 的池子空（唯一候选没了）→ empty 且零通知。
    await withdrawNote(db, "hash_a");
    await expect(drawNote(db, "hash_b", null, "note:empty")).resolves.toMatchObject({ ok: true, empty: true });
    expect(await countRows(db, "notifications")).toBe(0);

    // A 重放 → B 抽中 → 作者 A 收到一条未读 note_drawn（离散事件，不折叠）。
    await putNoteOk(db, "hash_a", "A 的新纸条");
    await expect(drawNote(db, "hash_b", null, "note:hit")).resolves.toMatchObject({ ok: true, empty: false });
    const rows = await listNotificationRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      participantHash: "hash_a",
      kind: "note_drawn",
      link: "/notes",
      readAt: null,
    });
  });

  it("站内通知：note_reply 折叠——未读只保一条（UPDATE 命中不新增行），已读后再来才 INSERT（T3）", async () => {
    const db = makeDb();
    const threadId = await makeThread(db);
    // makeThread 的抽取会先给作者 A 落一条 note_drawn；以下断言只看 note_reply。
    // B 连发两条：第二条折叠进同一条未读通知（body 刷成最新一条），不新增行。
    await sendMessage(db, threadId, "hash_b", "第一条回信", null);
    await sendMessage(db, threadId, "hash_b", "第二条回信", null);
    let replies = (await listNotificationRows(db)).filter((row) => row.kind === "note_reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      participantHash: "hash_a",
      body: "第二条回信",
      link: "/notes",
      readAt: null,
    });

    // A 已读（铃铛 seen）后再来一条：折叠 UPDATE 不命中（read_at 非空）→ 新 INSERT。
    await markNotificationsSeen(db, "hash_a");
    await sendMessage(db, threadId, "hash_b", "第三条回信", null);
    replies = (await listNotificationRows(db)).filter((row) => row.kind === "note_reply");
    expect(replies).toHaveLength(2);
    expect(replies[0]?.readAt).not.toBeNull(); // 首条保持已读，不被复用折叠
    expect(replies[1]).toMatchObject({
      participantHash: "hash_a",
      body: "第三条回信",
      readAt: null,
    });

    // 反向：A 回信，B 有自己独立的一条，互不串。
    await sendMessage(db, threadId, "hash_a", "收到啦", null);
    const forB = (await listNotificationRows(db)).filter(
      (row) => row.kind === "note_reply" && row.participantHash === "hash_b",
    );
    expect(forB).toHaveLength(1);
    expect(forB[0]).toMatchObject({ body: "收到啦", readAt: null });
  });

  /* ---------------- T2 · TG DM（收件人=接收方反查） ---------------- */

  function seedUser(db: D1Database, id: number, telegramUserId: number): Promise<void> {
    return db
      .prepare(
        `INSERT INTO users (id, telegram_user_id, created_at, updated_at) VALUES (?, ?, '2026-11-08T00:00:00Z', '2026-11-08T00:00:00Z')`,
      )
      .bind(id, telegramUserId)
      .run()
      .then(() => undefined);
  }

  function seedParticipantLink(db: D1Database, key: string, userId: number): Promise<void> {
    return db
      .prepare(
        `INSERT INTO participant_links (participant_key, user_id, linked_at) VALUES (?, ?, '2026-11-08T00:00:00Z')`,
      )
      .bind(key, userId)
      .run()
      .then(() => undefined);
  }

  it("被抽中 DM：user_ 作者直查 users，收件人是作者本人而非抽取者（T2）", async () => {
    telegramMocks.sendMessage.mockClear();
    telegramMocks.sendMessage.mockResolvedValue(new Response("{}"));
    const db = makeDb();
    await seedUser(db, 1, 700); // 作者 A = user_1 → TG 700
    await putNoteOk(db, "user_1", "A 的纸条");
    await putNoteOk(db, "web_drawer", "抽中者的纸条");
    const draw = await drawNote(db, "web_drawer", null, "note:dm-drawn", {
      botToken: "TOKEN",
      origin: "https://o.test",
    });
    expect(draw).toMatchObject({ ok: true, empty: false });
    const threadId = "threadId" in draw ? draw.threadId : 0;
    expect(telegramMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendMessage).toHaveBeenCalledWith(
      "TOKEN",
      700,
      expect.stringContaining(`https://o.test/notes?thread=${threadId}&tab=chat`),
    );
  });

  it("被抽中 DM：web_ 作者经 participant_links 反查；未认领/email 作者静默跳过（T2）", async () => {
    telegramMocks.sendMessage.mockClear();
    telegramMocks.sendMessage.mockResolvedValue(new Response("{}"));
    const db = makeDb();
    await seedUser(db, 3, 703);
    await seedParticipantLink(db, "key1", 3); // 作者 web_key1 已认领 → TG 703
    await putNoteOk(db, "web_key1", "已认领作者的纸条");
    await putNoteOk(db, "user_1", "抽中者的纸条");
    await drawNote(db, "user_1", null, "note:dm-web", { botToken: "TOKEN", origin: "https://o.test" });
    expect(telegramMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendMessage).toHaveBeenCalledWith("TOKEN", 703, expect.stringContaining("/notes?thread="));

    // 未认领的 web_ 作者：解析不到 TG，静默跳过（不抛错）。
    // 同一张纸条可被不同抽取者再抽（thread 唯一键是 note_id+drawer_hash），
    // 旧纸条要一并撤掉，池子里只剩 web_ghost 一张，抽取目标才确定。
    telegramMocks.sendMessage.mockClear();
    await withdrawNote(db, "user_1");
    await withdrawNote(db, "web_key1");
    await putNoteOk(db, "web_ghost", "未认领作者的纸条");
    await putNoteOk(db, "user_9", "再抽一次的纸条");
    const second = await drawNote(db, "user_9", null, "note:dm-ghost", {
      botToken: "TOKEN",
      origin: "https://o.test",
    });
    expect(second).toMatchObject({ ok: true, empty: false });
    expect(telegramMocks.sendMessage).not.toHaveBeenCalled();

    // email_ 作者：最小集不发 DM（deferred），同样静默。
    // 同理清空其余纸条，池子里只剩 email_5 一张。
    telegramMocks.sendMessage.mockClear();
    await withdrawNote(db, "user_9");
    await withdrawNote(db, "web_ghost");
    await putNoteOk(db, "email_5", "email 作者的纸条");
    await putNoteOk(db, "user_10", "第三次抽取者的纸条");
    const third = await drawNote(db, "user_10", null, "note:dm-email", {
      botToken: "TOKEN",
      origin: "https://o.test",
    });
    expect(third).toMatchObject({ ok: true, empty: false });
    expect(telegramMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("回信 DM：收件人是会话对方；发送失败不抛、抽取/消息照常（T2）", async () => {
    telegramMocks.sendMessage.mockClear();
    telegramMocks.sendMessage.mockResolvedValue(new Response("{}"));
    const db = makeDb();
    await seedUser(db, 1, 700);
    await seedUser(db, 2, 702);
    await putNoteOk(db, "user_1", "A 的纸条");
    await putNoteOk(db, "user_2", "B 的纸条");
    const draw = await drawNote(db, "user_2", null, "note:dm-thread", { botToken: "TOKEN", origin: "https://o.test" });
    const threadId = draw && "threadId" in draw ? draw.threadId : 0;
    telegramMocks.sendMessage.mockClear();

    // B 回信 → 对方（作者 A=user_1，TG 700）收到 DM，摘要是消息原文；
    // 抽取时的被抽中 DM 已 mockClear，这里只应有回信这一条。
    await sendMessage(db, threadId, "user_2", "一条会话消息", null, { botToken: "TOKEN", origin: "https://o.test" });
    expect(telegramMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendMessage).toHaveBeenCalledWith("TOKEN", 700, expect.stringContaining("「一条会话消息」"));

    // 发送失败：console.warn 不抛，消息照常返回（DM 是增强）。
    telegramMocks.sendMessage.mockClear();
    telegramMocks.sendMessage.mockRejectedValue(new Error("telegram down"));
    const sent = await sendMessage(db, threadId, "user_2", "第二条消息", null, {
      botToken: "TOKEN",
      origin: "https://o.test",
    });
    expect(sent).toMatchObject({ mine: true, body: "第二条消息" });
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM note_messages`).first<{ n: number }>();
    expect(Number(row?.n ?? 0)).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * 抽取幂等（金币路径）——账本键参与者作用域化（通宵批次 B7）。
 * coin_transactions.idempotency_key 是全局 UNIQUE（ledger.service.ts 的查重
 * 是裸键全局查），drawNote 必须把客户端键重组为 note:<drawerHash>:<token>
 * 再入账：同用户重放撞 UNIQUE → 幂等返回不重复扣款；不同用户持相同 uuid
 * 各自扣款、各自抽纸条。并发语义由 UNIQUE 承担，两个分支都要到得了：
 * 先后重放（第二次调用时赢家已提交）走顶部预检回放；并发输家分支
 * （预检后、扣款 batch 撞 UNIQUE）由下方 raceDb 用 batch 钩子模拟
 * 「预检与扣款之间赢家提交」的窗口专项覆盖——不靠等价假设。
 * ------------------------------------------------------------------ */

/** 两个用户「恰好」生成的同一个客户端 uuid（同 uuid 撞键的并发场景）。 */
const SHARED_UUID = "11111111-2222-3333-4444-555555555555";

describe.skipIf(!sqliteD1Available)("纸条抽取幂等 · 金币路径（参与者作用域键）", () => {
  function makeCoinDb(): D1Database {
    return createSqliteD1(`PRAGMA foreign_keys = ON;\n${NOTE_SCHEMA}\n${COIN_ACCOUNTS_DDL}\n${IDENTITY_DDL}`);
  }

  async function putNoteOk(db: D1Database, ownerHash: string, content: string): Promise<void> {
    await putNote(db, ownerHash, { gender: "x", ageBand: "25-30", region: "", content }, null);
  }

  /** 直接插满当日免费额（绕开真实抽取，把下一次抽取推到金币路径）。 */
  async function exhaustFreeDraws(db: D1Database, drawerHash: string): Promise<void> {
    for (let i = 0; i < FREE_DRAWS_PER_DAY; i += 1) {
      await db
        .prepare(`INSERT INTO note_draws (drawer_hash, note_id, kind, created_at) VALUES (?, 1, 'free', ?)`)
        .bind(drawerHash, new Date().toISOString())
        .run();
    }
  }

  async function seedBalance(db: D1Database, participantHash: string, balance: number): Promise<void> {
    await db
      .prepare(
        `INSERT INTO coin_accounts (participant_hash, user_id, balance, total_earned, total_spent, created_at, updated_at)
         VALUES (?, NULL, ?, 0, 0, ?, ?)`,
      )
      .bind(participantHash, balance, new Date().toISOString(), new Date().toISOString())
      .run();
  }

  async function countTxns(db: D1Database, participantHash: string): Promise<number> {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM coin_transactions WHERE participant_hash = ?`)
      .bind(participantHash)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  it("金币抽取扣款：账本键是 note:<drawerHash>:<token>，不是客户端裸键", async () => {
    const db = makeCoinDb();
    await putNoteOk(db, "hash_a", "A 的纸条");
    await putNoteOk(db, "hash_b", "B 的纸条");
    await exhaustFreeDraws(db, "hash_b");
    await seedBalance(db, "hash_b", 100);

    const draw = await drawNote(db, "hash_b", null, `note:${SHARED_UUID}`);
    expect(draw).toMatchObject({ ok: true, empty: false, kind: "coin" });
    const txn = await db
      .prepare(`SELECT participant_hash, amount, idempotency_key FROM coin_transactions LIMIT 1`)
      .first<{ participant_hash: string; amount: number; idempotency_key: string }>();
    expect(txn?.participant_hash).toBe("hash_b");
    expect(txn?.amount).toBe(-DRAW_COST_COINS);
    expect(txn?.idempotency_key).toBe(`note:hash_b:${SHARED_UUID}`);
    expect("balance" in draw ? draw.balance : -1).toBe(100 - DRAW_COST_COINS);
  });

  it("同用户同键重放：得 duplicate、回放首次结果、不重复扣款", async () => {
    const db = makeCoinDb();
    await putNoteOk(db, "hash_a", "A 的纸条");
    await putNoteOk(db, "hash_b", "B 的纸条");
    await exhaustFreeDraws(db, "hash_b");
    await seedBalance(db, "hash_b", 100);

    const first = await drawNote(db, "hash_b", null, `note:${SHARED_UUID}`);
    expect(first).toMatchObject({ ok: true, empty: false, kind: "coin" });
    const replay = await drawNote(db, "hash_b", null, `note:${SHARED_UUID}`);
    // 重放带 duplicate 标记，回放的是首次抽取的会话与纸条（双击/超时不重抽）。
    expect(replay).toMatchObject({ ok: true, empty: false, kind: "coin", duplicate: true });
    expect("threadId" in replay ? replay.threadId : -1).toBe("threadId" in first ? first.threadId : -2);
    expect("note" in replay ? replay.note.id : -1).toBe("note" in first ? first.note.id : -2);
    // 只有一笔扣款流水，余额只扣一次。
    expect(await countTxns(db, "hash_b")).toBe(1);
    expect("balance" in replay ? replay.balance : -1).toBe(100 - DRAW_COST_COINS);
    // 换一个新键是全新抽取（不是重放）。
    const fresh = await drawNote(db, "hash_b", null, "note:22222222-3333-4444-5555-666666666666");
    expect("duplicate" in fresh ? (fresh.duplicate ?? false) : false).toBe(false);
  });

  it("两个用户持相同 uuid：各自扣款、各自抽纸条，互不干扰（旧实现全局裸键会幽灵互撞）", async () => {
    const db = makeCoinDb();
    await putNoteOk(db, "hash_a", "A 的纸条");
    await putNoteOk(db, "hash_b", "B 的纸条");
    await exhaustFreeDraws(db, "hash_b");
    await exhaustFreeDraws(db, "hash_a");
    await seedBalance(db, "hash_b", 100);
    await seedBalance(db, "hash_a", 100);

    const bDraw = await drawNote(db, "hash_b", null, `note:${SHARED_UUID}`);
    expect(bDraw).toMatchObject({ ok: true, empty: false, kind: "coin" });

    // A 用完全相同的 uuid 抽：必须成功并扣自己的钱。全局裸键下 A 会撞
    // UNIQUE、被当成 duplicate 白拿一次抽取结果——未扣款却 ok 的幽灵。
    const aDraw = await drawNote(db, "hash_a", null, `note:${SHARED_UUID}`);
    expect(aDraw).toMatchObject({ ok: true, empty: false, kind: "coin" });
    expect("balance" in aDraw ? aDraw.balance : -1).toBe(100 - DRAW_COST_COINS);
    expect("balance" in bDraw ? bDraw.balance : -1).toBe(100 - DRAW_COST_COINS);

    // 两笔独立流水（键各自作用域）、两条会话（各抽到对方的纸条）。
    const txns = await db
      .prepare(`SELECT participant_hash, idempotency_key FROM coin_transactions ORDER BY id`)
      .all<{ participant_hash: string; idempotency_key: string }>();
    expect((txns.results ?? []).map((row) => row.idempotency_key)).toEqual([
      `note:hash_b:${SHARED_UUID}`,
      `note:hash_a:${SHARED_UUID}`,
    ]);
    const threads = await db.prepare(`SELECT drawer_hash FROM note_threads ORDER BY id`).all<{ drawer_hash: string }>();
    expect((threads.results ?? []).map((row) => row.drawer_hash)).toEqual(["hash_b", "hash_a"]);
  });

  it("真并发双提交的输家：batch 撞 UNIQUE 后回放赢家结果，不给未抽中的作者误发通知", async () => {
    const base = createSqliteD1(`PRAGMA foreign_keys = ON;\n${NOTE_SCHEMA}\n${COIN_ACCOUNTS_DDL}\n${IDENTITY_DDL}`);
    // 竞态窗口模拟（「预检后、扣款 batch 提交冲突前赢家落库」）：
    // - 调用前插赢家**会话+抽取行**（不插流水）→ 输家预检放过，候选池只剩 C；
    // - batch 钩子里补插赢家**流水** → 输家的流水 INSERT 撞 UNIQUE →
    //   runSpendBatch duplicate → 必须按赢家 refId 回放，绝不把自选候选
    //   （C）当成功。真 D1 下输家的整批语句原子回滚，shim 不回滚留下的
    //   输家抽取/会话脏行是假象，本测试不断言它们。
    const now = new Date().toISOString();
    await putNoteOk(base, "hash_a", "A 的纸条");
    await putNoteOk(base, "hash_c", "C 的纸条");
    await putNoteOk(base, "hash_b", "B 的纸条");
    await exhaustFreeDraws(base, "hash_b");
    await seedBalance(base, "hash_b", 100);

    // 赢家产物中先可见的部分：会话+抽取行（不插流水）→ 输家预检放过、候选池只剩 C。
    await base
      .prepare(`INSERT INTO note_threads (note_id, drawer_hash, status, created_at) VALUES (1, 'hash_b', 'active', ?)`)
      .bind(now)
      .run();
    await base
      .prepare(`INSERT INTO note_draws (drawer_hash, note_id, kind, created_at) VALUES ('hash_b', 1, 'coin', ?)`)
      .bind(now)
      .run();

    const raceDb: D1Database = {
      prepare: (sql: string) => base.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        await base
          .prepare(
            `INSERT INTO coin_transactions
               (participant_hash, amount, balance_after, kind, ref_type, ref_id, idempotency_key, note, created_by, created_at)
             VALUES ('hash_b', -5, 95, 'note_draw', 'note', '1', ?, '抽纸条', 'note_chat', ?)`,
          )
          .bind(`note:hash_b:${SHARED_UUID}`, now)
          .run();
        return base.batch(statements);
      },
    } as unknown as D1Database;

    const loser = await drawNote(raceDb, "hash_b", null, `note:${SHARED_UUID}`);
    // 输家拿到的是赢家那次抽取的回放（A 的纸条、A 的会话），带 duplicate 标记。
    const winnerThreadId = Number(
      (
        await base
          .prepare(`SELECT id FROM note_threads WHERE note_id = 1 AND drawer_hash = 'hash_b'`)
          .first<{ id: number }>()
      )?.id ?? 0,
    );
    expect(loser).toMatchObject({ ok: true, empty: false, kind: "coin", duplicate: true });
    expect("note" in loser ? loser.note.id : -1).toBe(1);
    expect("threadId" in loser ? loser.threadId : -1).toBe(winnerThreadId);
    expect("balance" in loser ? loser.balance : -1).toBe(95);

    // 未扣款的幽灵被钉死：流水只有赢家一笔；输家自选的 C 的作者没有
    // 被误发「被抽中」通知（修复前 tail 会给 hash_c 误发 + 返回 threadId 0）。
    const txns = await base
      .prepare(`SELECT COUNT(*) AS n FROM coin_transactions WHERE idempotency_key = ?`)
      .bind(`note:hash_b:${SHARED_UUID}`)
      .first<{ n: number }>();
    expect(Number(txns?.n ?? 0)).toBe(1);
    const notifications = await base.prepare(`SELECT COUNT(*) AS n FROM notifications`).first<{ n: number }>();
    expect(Number(notifications?.n ?? 0)).toBe(0);
  });
});
