import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { createSqliteD1, sqliteD1Available } from "../helpers/sqlite-d1";
import {
  blockThread,
  decideDrawKind,
  DRAW_COST_COINS,
  drawDayCutoffIso,
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

/* ------------------------------------------------------------------ *
 * 免费额原子化（B8 · 并发收口）。
 * 旧实现「SELECT COUNT → 内存判定 → 无条件 INSERT」是读-判-写两段式，
 * 并发双请求会各自读到同一计数、双双吃掉免费额。现在判定下推进插入本体
 * （INSERT ... SELECT ... WHERE (SELECT COUNT(*)) < 3），条件与插入同语句
 * 求值、由 D1 写事务串行化兜底。会话行以 EXISTS(本次 free 抽取行) 接续，
 * 金币路径同样把会话行挂在「抽取行确实落库」上——修掉「扣款没生效却留下
 * 会话行」的旧隐患。
 * ------------------------------------------------------------------ */

describe.skipIf(!sqliteD1Available)("纸条抽取 · 免费额原子化（B8）", () => {
  function makeDrawDb(): D1Database {
    return createSqliteD1(`PRAGMA foreign_keys = ON;\n${NOTE_SCHEMA}\n${COIN_ACCOUNTS_DDL}\n${IDENTITY_DDL}`);
  }

  async function putNoteOk(db: D1Database, ownerHash: string, content: string): Promise<void> {
    await putNote(db, ownerHash, { gender: "x", ageBand: "25-30", region: "", content }, null);
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

  async function countDrawsByKind(db: D1Database, drawerHash: string): Promise<{ free: number; coin: number }> {
    const rows = await db
      .prepare(`SELECT kind, COUNT(*) AS n FROM note_draws WHERE drawer_hash = ? GROUP BY kind`)
      .bind(drawerHash)
      .all<{ kind: string; n: number }>();
    const byKind = new Map((rows.results ?? []).map((row) => [row.kind, Number(row.n)]));
    return { free: byKind.get("free") ?? 0, coin: byKind.get("coin") ?? 0 };
  }

  it("drawDayCutoffIso（纯函数）：本地日零点换算回 UTC 时刻，正负时区都对", () => {
    // 东八区（480）：2026-11-19T10:00Z 是本地 11-19 18:00 → 零点是 11-18T16:00Z。
    expect(drawDayCutoffIso(Date.parse("2026-11-19T10:00:00Z"), 480)).toBe("2026-11-18T16:00:00.000Z");
    // UTC-5（-300）：2026-11-19T02:00Z 是本地 11-18 21:00 → 零点是 11-18T05:00Z。
    expect(drawDayCutoffIso(Date.parse("2026-11-19T02:00:00Z"), -300)).toBe("2026-11-18T05:00:00.000Z");
    // 恰好压在本地日界的零点本身。
    expect(drawDayCutoffIso(Date.parse("2026-11-18T16:00:00Z"), 480)).toBe("2026-11-18T16:00:00.000Z");
  });

  it("免费额还剩 1 次时本次抽取 free 且占满第 3 次；下一次转 coin", async () => {
    const db = makeDrawDb();
    await putNoteOk(db, "hash_a", "A 的纸条");
    await putNoteOk(db, "hash_c", "C 的纸条");
    await putNoteOk(db, "hash_b", "B 的纸条");
    await seedBalance(db, "hash_b", 100);
    // 直接预插 2 条当日 free 抽取行（note_draws 无 note_id 外键，1 号纸条必存在）。
    for (let i = 0; i < 2; i += 1) {
      await db
        .prepare(`INSERT INTO note_draws (drawer_hash, note_id, kind, created_at) VALUES ('hash_b', 1, 'free', ?)`)
        .bind(new Date().toISOString())
        .run();
    }
    const third = await drawNote(db, "hash_b", null, "note:quota-3");
    expect(third).toMatchObject({ ok: true, empty: false, kind: "free" });
    expect(await countDrawsByKind(db, "hash_b")).toEqual({ free: 3, coin: 0 });

    // 第 4 次：池里只剩最后一张候选纸条，判定转 coin 并正常扣款。
    const fourth = await drawNote(db, "hash_b", null, "note:quota-4");
    expect(fourth).toMatchObject({ ok: true, empty: false, kind: "coin" });
    expect(await countDrawsByKind(db, "hash_b")).toEqual({ free: 3, coin: 1 });
  });

  it("并发 20 次抽取：免费次数不超 3，超额走 coin 且扣费与账本一致", async () => {
    const db = makeDrawDb();
    // 6 张他人纸条进池，抽取者自己的纸条满足「先放后抽」。
    for (const owner of ["hash_a", "hash_c", "hash_d", "hash_e", "hash_f", "hash_g"]) {
      await putNoteOk(db, owner, `${owner} 的纸条`);
    }
    await putNoteOk(db, "hash_b", "B 的纸条");
    await seedBalance(db, "hash_b", 1000);

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        drawNote(db, "hash_b", null, `note:race-${i}`).then(
          (value) => ({ ok: true as const, value }),
          (error) => ({ ok: false as const, error }),
        ),
      ),
    );
    // 任何一次都不该失败：免费额被并发用尽的请求要落到金币路径，而不是抛错。
    const failures = outcomes.filter((outcome) => !outcome.ok);
    expect(failures.map((outcome) => (outcome.ok ? "" : String(outcome.error)))).toEqual([]);
    expect(outcomes.every((outcome) => outcome.ok && outcome.value.ok)).toBe(true);

    const draws = await countDrawsByKind(db, "hash_b");
    // 核心断言：无论读写怎么交错，免费额都不会被并发双吃；同时至少一次
    // free 占额成功（首个到达占用语句的请求必然 count<3），证明本用例真的
    // 踩到了免费路径而不是全员金币的空转。
    expect(draws.free).toBeGreaterThanOrEqual(1);
    expect(draws.free).toBeLessThanOrEqual(FREE_DRAWS_PER_DAY);

    // 非免费路径扣费与账本一致：每笔 coin 抽取恰有一笔流水，余额差额吻合。
    const txns = await db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM coin_transactions WHERE participant_hash = ?`,
      )
      .bind("hash_b")
      .first<{ n: number; total: number }>();
    expect(Number(txns?.n ?? 0)).toBe(draws.coin);
    expect(Number(txns?.total ?? 0)).toBe(-DRAW_COST_COINS * draws.coin);
    const account = await db
      .prepare(`SELECT balance FROM coin_accounts WHERE participant_hash = ?`)
      .bind("hash_b")
      .first<{ balance: number }>();
    expect(Number(account?.balance ?? 0)).toBe(1000 - DRAW_COST_COINS * draws.coin);

    // 会话行完备性：每个会话都有对应的抽取行（不存在没扣款/没占额的孤儿会话）。
    const orphanThreads = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM note_threads t
          WHERE t.drawer_hash = 'hash_b'
            AND NOT EXISTS (SELECT 1 FROM note_draws d
                             WHERE d.drawer_hash = 'hash_b' AND d.note_id = t.note_id)`,
      )
      .first<{ n: number }>();
    expect(Number(orphanThreads?.n ?? 0)).toBe(0);
  });

  it("余额在预检后、batch 前被并发抽干：insufficient_balance 且不留孤儿会话（B8 前的旧隐患）", async () => {
    const base = makeDrawDb();
    await putNoteOk(base, "hash_a", "A 的纸条");
    await putNoteOk(base, "hash_b", "B 的纸条");
    // 免费额已耗尽（3 行）→ 本次抽取走金币路径。
    for (let i = 0; i < FREE_DRAWS_PER_DAY; i += 1) {
      await base
        .prepare(`INSERT INTO note_draws (drawer_hash, note_id, kind, created_at) VALUES ('hash_b', 1, 'free', ?)`)
        .bind(new Date().toISOString())
        .run();
    }
    // 余额恰好够一次：预检通过；batch 钩子在扣款前把余额抽干（模拟并发扣款）。
    await seedBalance(base, "hash_b", DRAW_COST_COINS);
    const drainedDb: D1Database = {
      prepare: (sql: string) => base.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        await base.prepare(`UPDATE coin_accounts SET balance = 0 WHERE participant_hash = 'hash_b'`).run();
        return base.batch(statements);
      },
    } as unknown as D1Database;

    await expect(drawNote(drainedDb, "hash_b", null, "note:drained")).rejects.toMatchObject({
      code: "insufficient_balance",
    });
    // 修复前：守卫流水没生效，但无条件挂载的会话行会留下「有会话没扣款」
    // 的孤儿。修复后：会话行以 EXISTS(本次 coin 抽取行) 为前提，零残留。
    const threads = await base
      .prepare(`SELECT COUNT(*) AS n FROM note_threads WHERE drawer_hash = 'hash_b'`)
      .first<{ n: number }>();
    expect(Number(threads?.n ?? 0)).toBe(0);
    const coinDraws = await base
      .prepare(`SELECT COUNT(*) AS n FROM note_draws WHERE drawer_hash = 'hash_b' AND kind = 'coin'`)
      .first<{ n: number }>();
    expect(Number(coinDraws?.n ?? 0)).toBe(0);
    const txns = await base.prepare(`SELECT COUNT(*) AS n FROM coin_transactions`).first<{ n: number }>();
    expect(Number(txns?.n ?? 0)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * listThreads · UNION 改写回归（B8）。
 * 逐字段对比基准：把改写前的三条查询（跨表 OR 主查询 / 全库 MAX(id)
 * lastBodies / join 后谓词的未读数）原样内联在测试里跑同一份数据，再与
 * 改写后的服务输出做全字段对比——包括排序。自抽 thread（规则变更前的
 * 历史数据）会让 UNION 两臂同时命中同一行，用 UNION 去重才能与旧查询
 * 一致；>90 个会话的用例覆盖 IN 分块。
 * ------------------------------------------------------------------ */

type LegacyThreadRow = {
  id: number;
  noteId: number;
  drawerHash: string;
  ownerHash: string;
  noteStatus: string;
  gender: string;
  ageBand: string;
  region: string;
  content: string;
  imageAssetId: number | null;
  lastMessageAt: string | null;
  messageCount: number;
  readUpTo: number;
};

describe.skipIf(!sqliteD1Available)("listThreads · UNION 改写回归（B8）", () => {
  function makeThreadDb(): D1Database {
    // drawNote 的幂等预检会摸 coin_transactions，账本最小 DDL 一并带上。
    return createSqliteD1(`PRAGMA foreign_keys = ON;\n${NOTE_SCHEMA}\n${COIN_ACCOUNTS_DDL}`);
  }

  async function putNoteOk(db: D1Database, ownerHash: string, content: string): Promise<void> {
    await putNote(db, ownerHash, { gender: "x", ageBand: "25-30", region: "", content }, null);
  }

  /** 改写前的 listThreads（三条旧查询 + 旧装配逻辑，逐字对齐旧实现）。 */
  async function legacyListThreads(db: D1Database, participantHash: string): Promise<ThreadSummaryLike[]> {
    const main = await db
      .prepare(
        `SELECT t.id, t.note_id AS noteId, t.drawer_hash AS drawerHash, t.status AS threadStatus,
              n.owner_hash AS ownerHash, n.status AS noteStatus,
              n.gender, n.age_band AS ageBand, n.region, n.content, n.image_asset_id AS imageAssetId,
              t.last_message_at AS lastMessageAt, t.message_count AS messageCount,
              COALESCE(r.last_read_message_id, 0) AS readUpTo
         FROM note_threads t
         JOIN notes n ON n.id = t.note_id
         LEFT JOIN note_thread_reads r ON r.thread_id = t.id AND r.participant_hash = ?
        WHERE (t.drawer_hash = ? OR n.owner_hash = ?) AND t.status = 'active'
        ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
        LIMIT 100`,
      )
      .bind(participantHash, participantHash, participantHash)
      .all<LegacyThreadRow>();
    const rows = main.results ?? [];
    const blockRows = await db
      .prepare(
        `SELECT blocker_hash AS blockerHash, blocked_hash AS blockedHash FROM note_block
        WHERE blocker_hash = ? OR blocked_hash = ?`,
      )
      .bind(participantHash, participantHash)
      .all<{ blockerHash: string; blockedHash: string }>();
    const blockedPeers = new Set<string>();
    for (const block of blockRows.results ?? []) {
      blockedPeers.add(block.blockerHash === participantHash ? block.blockedHash : block.blockerHash);
    }
    const visibleRows =
      blockedPeers.size > 0
        ? rows.filter((row) => {
            const peerHash = row.drawerHash === participantHash ? row.ownerHash : row.drawerHash;
            return !blockedPeers.has(peerHash);
          })
        : rows;
    const lastBodies = await db
      .prepare(
        `SELECT m.thread_id AS threadId, m.body FROM note_messages m
        WHERE m.id IN (SELECT MAX(id) FROM note_messages WHERE status = 'active' GROUP BY thread_id)`,
      )
      .all<{ threadId: number; body: string }>();
    const lastByThread = new Map((lastBodies.results ?? []).map((row) => [row.threadId, row.body]));
    const unreadRows = await db
      .prepare(
        `SELECT m.thread_id AS threadId, COUNT(*) AS n FROM note_messages m
         JOIN note_threads t ON t.id = m.thread_id
         JOIN notes n ON n.id = t.note_id
        WHERE (t.drawer_hash = ? OR n.owner_hash = ?) AND m.sender_hash != ? AND m.status = 'active'
          AND m.id > COALESCE((SELECT last_read_message_id FROM note_thread_reads r
                                WHERE r.thread_id = m.thread_id AND r.participant_hash = ?), 0)
        GROUP BY m.thread_id`,
      )
      .bind(participantHash, participantHash, participantHash, participantHash)
      .all<{ threadId: number; n: number }>();
    const unreadByThread = new Map((unreadRows.results ?? []).map((row) => [row.threadId, Number(row.n)]));
    return visibleRows.map((row) => ({
      id: row.id,
      noteId: row.noteId,
      role: row.drawerHash === participantHash ? "drawer" : "owner",
      peerNote:
        row.drawerHash === participantHash
          ? {
              id: row.noteId,
              gender: row.gender,
              ageBand: row.ageBand,
              region: row.region,
              content: row.content,
              imageAssetId: row.imageAssetId ?? null,
            }
          : null,
      noteStatus: row.noteStatus,
      lastBody: lastByThread.get(row.id) ?? null,
      lastMessageAt: row.lastMessageAt,
      unread: unreadByThread.get(row.id) ?? 0,
      messageCount: Number(row.messageCount ?? 0),
    }));
  }

  interface ThreadSummaryLike {
    id: number;
    noteId: number;
    role: string;
    peerNote: Record<string, unknown> | null;
    noteStatus: string;
    lastBody: string | null;
    lastMessageAt: string | null;
    unread: number;
    messageCount: number;
  }

  it("与改写前三条查询逐字段一致（含排序、hidden 末条、已读水位、双向拉黑）", async () => {
    const db = makeThreadDb();
    await putNoteOk(db, "hash_a", "A 的纸条");
    await putNoteOk(db, "hash_b", "B 的纸条");
    // 候选唯一化，保证抽取目标确定：B 的池里只有 A 的纸条（T1：drawer=B,
    // owner=A）；随后 A 的池里只剩 C 的纸条（T2：drawer=A, owner=C）。同一
    // 参与者在两条会话里分别是 drawer 与 owner，UNION 两臂都被踩到。
    const draw1 = await drawNote(db, "hash_b", null, "note:parity-1");
    expect(draw1).toMatchObject({ ok: true, empty: false });
    const thread1 = draw1 && "threadId" in draw1 ? draw1.threadId : 0;
    await putNoteOk(db, "hash_c", "C 的纸条");
    await withdrawNote(db, "hash_b");
    const draw2 = await drawNote(db, "hash_a", null, "note:parity-2");
    expect(draw2).toMatchObject({ ok: true, empty: false });
    const thread2 = draw2 && "threadId" in draw2 ? draw2.threadId : 0;
    // 排序基准固定：两线程的 created_at / last_message_at 各不相同，避免
    // 相同 sortAt 下新旧实现对并列键的排序歧义（二者都不承诺次级排序键）。
    await db
      .prepare(`UPDATE note_threads SET created_at = '2026-11-18T09:00:00.000Z' WHERE id = ?`)
      .bind(thread1)
      .run();
    await db
      .prepare(`UPDATE note_threads SET created_at = '2026-11-18T10:00:00.000Z' WHERE id != ?`)
      .bind(thread1)
      .run();

    await sendMessage(db, thread1, "hash_b", "T1 第一条", null);
    await sendMessage(db, thread1, "hash_b", "T1 第二条（将被隐藏）", null);
    const rows = await db.prepare(`SELECT id, body FROM note_messages ORDER BY id`).all<{ id: number; body: string }>();
    const hidden = (rows.results ?? []).find((row) => row.body.includes("将被隐藏"));
    await db.prepare(`UPDATE note_messages SET status = 'hidden' WHERE id = ?`).bind(hidden?.id).run();
    // 末条 hidden 后，lastBody 必须退回第一条；未读数也不计 hidden。
    await sendMessage(db, thread2, "hash_c", "T2 唯一一条", null);
    // 水位：A 已读 T1 至第一条可见消息（T2 全部未读）。
    await db
      .prepare(
        `INSERT INTO note_thread_reads (thread_id, participant_hash, last_read_message_id, updated_at)
         VALUES (?, 'hash_a', ?, '2026-11-18T12:00:00.000Z')
         ON CONFLICT(thread_id, participant_hash) DO UPDATE SET last_read_message_id = excluded.last_read_message_id`,
      )
      .bind(thread1, Number(rows.results?.[0]?.id ?? 0))
      .run();
    // 固定两条会话的 last_message_at，排序逐字段可比。
    await db
      .prepare(`UPDATE note_threads SET last_message_at = '2026-11-19T08:00:00.000Z' WHERE id = ?`)
      .bind(thread1)
      .run();
    await db
      .prepare(`UPDATE note_threads SET last_message_at = '2026-11-19T09:00:00.000Z' WHERE id = ?`)
      .bind(thread2)
      .run();

    for (const participant of ["hash_a", "hash_b", "hash_c"]) {
      const legacy = await legacyListThreads(db, participant);
      const current = await listThreads(db, participant);
      expect(current).toEqual(legacy);
    }

    // 双向拉黑后再比一轮：B 拉黑 A，A/B 的列表都该清空（两实现一致）。
    await blockThread(db, thread1, "hash_b");
    for (const participant of ["hash_a", "hash_b", "hash_c"]) {
      const legacy = await legacyListThreads(db, participant);
      const current = await listThreads(db, participant);
      expect(current).toEqual(legacy);
    }
    await unblockThread(db, thread1, "hash_b");

    // 规则变更前的历史脏数据：自抽 thread（drawer = owner）会让 UNION 两臂
    // 同时命中同一行——UNION（去重）下两实现都只显示一次。
    await putNoteOk(db, "hash_e", "E 的纸条");
    await db
      .prepare(
        `INSERT INTO note_threads (note_id, drawer_hash, status, created_at)
         SELECT id, owner_hash, 'active', '2026-11-18T11:00:00.000Z' FROM notes WHERE owner_hash = 'hash_e'`,
      )
      .run();
    const legacySelf = await legacyListThreads(db, "hash_e");
    const currentSelf = await listThreads(db, "hash_e");
    expect(currentSelf).toEqual(legacySelf);
    expect(currentSelf).toHaveLength(1);
    expect(currentSelf[0]?.role).toBe("drawer");
  });

  it("会话数超过 90 时按批圈定聚合：每批的 lastBody / 未读数都与逐行口径一致", async () => {
    const db = makeThreadDb();
    // 直接造 120 个「hash_x 抽中 own_i」的会话：主查询 LIMIT 100 圈出可见
    // 集合（100 条）→ IN 分块跑两轮（90 + 10）。
    const noteStmts: D1PreparedStatement[] = [];
    const threadStmts: D1PreparedStatement[] = [];
    const messageStmts: D1PreparedStatement[] = [];
    for (let i = 1; i <= 120; i += 1) {
      noteStmts.push(
        db
          .prepare(
            `INSERT INTO notes (owner_hash, gender, age_band, region, content, status, created_at, expires_at)
             VALUES (?, 'x', '25-30', '', ?, 'active', ?, '2026-12-30T00:00:00.000Z')`,
          )
          .bind(`own_${i}`, `纸条 ${i}`, "2026-11-01T00:00:00.000Z"),
      );
    }
    await db.batch(noteStmts);
    for (let i = 1; i <= 120; i += 1) {
      // created_at 递增：LIMIT 100 稳定取 newest 100（thread id 21..120）。
      threadStmts.push(
        db
          .prepare(
            `INSERT INTO note_threads (note_id, drawer_hash, status, created_at)
             VALUES (?, 'hash_x', 'active', ?)`,
          )
          .bind(i, new Date(Date.parse("2026-11-18T00:00:00.000Z") + i * 60_000).toISOString()),
      );
    }
    await db.batch(threadStmts);
    const threadRows = await db
      .prepare(`SELECT id, note_id AS noteId FROM note_threads ORDER BY id`)
      .all<{ id: number; noteId: number }>();
    for (const thread of threadRows.results ?? []) {
      messageStmts.push(
        db
          .prepare(`INSERT INTO note_messages (thread_id, sender_hash, body, created_at) VALUES (?, ?, ?, ?)`)
          .bind(thread.id, `own_${thread.noteId}`, `msg-${thread.noteId}`, "2026-11-18T12:00:00.000Z"),
      );
    }
    await db.batch(messageStmts);

    const threads = await listThreads(db, "hash_x");
    expect(threads).toHaveLength(100);
    // 全部可见会话（含第二批的）都要有正确的 lastBody 与未读数——这只有在
    // 分块聚合把 100 个会话都覆盖到时才成立。
    for (const thread of threads) {
      expect(thread.lastBody).toBe(`msg-${thread.noteId}`);
      expect(thread.unread).toBe(1);
      expect(thread.role).toBe("drawer");
    }
    // 排序：created_at 递增 → 列表按 sortAt DESC，首条是最新会话。
    expect(threads[0]?.noteId).toBe(120);
    expect(threads[99]?.noteId).toBe(21);
  });
});
