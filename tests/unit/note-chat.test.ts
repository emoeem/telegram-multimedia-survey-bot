import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createSqliteD1, sqliteD1Available } from "../helpers/sqlite-d1";
import {
  blockThread,
  decideDrawKind,
  drawNote,
  drawPoolWhere,
  isBlockedPair,
  listMessages,
  listThreads,
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
});

/* ------------------------------------------------------------------ *
 * DB 行为（0094 安全层）——用 sqlite-d1 harness 跑真迁移 + 真服务 SQL。
 * ------------------------------------------------------------------ */

const NOTE_SCHEMA = ["0084_follows_notifications.sql", "0089_note_chat.sql", "0094_note_chat_safety.sql"]
  .map((file) => readFileSync(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"))
  .join("\n");

// drawNote 成功后要读余额（getCoinAccount）。测试只走免费抽取路径，
// 手写最小 coin_accounts（plaza-post.repository.test.ts 同款做法），
// 免去引入整条金币迁移链。
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
`;

describe.skipIf(!sqliteD1Available)("纸条聊天 · DB 行为（0094 安全层）", () => {
  function makeDb(): D1Database {
    // D1 默认开外键，迁移整体一次执行（与 wrangler d1 migrations apply 同语义）。
    return createSqliteD1(`PRAGMA foreign_keys = ON;\n${NOTE_SCHEMA}\n${COIN_ACCOUNTS_DDL}`);
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
});
