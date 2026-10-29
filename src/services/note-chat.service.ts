import { loadCoinConfig, coinDayKey } from "./coin/config.service";
import { CoinLedgerError, getCoinAccount, runSpendBatch } from "./coin/ledger.service";

/**
 * 纸条聊天 · 核心服务（0089）。
 *
 * 与金币账本的关系（本次需求的重点）：抽取配额 = 每日免费额 + 金币单次付费。
 * - 免费额按「参与者当日已抽次数」判定，日界与签到同一套 coinDayKey（时区一致）；
 * - 金币路径复用 runSpendBatch 的原子扣款（守卫流水 INSERT，余额不足两者都不生效），
 *   幂等键由客户端生成，双击不会双扣；
 * - 抽取顺序是「先挑纸条，再决定收费」：池子为空时免费额与金币都不消耗。
 *
 * 成本纪律（docs/ops/COST-GUARDRAILS.md 的落法）：所有列表/轮询查询都走前缀索引；
 * 消息游标增量；未读数搭车在会话列表里算，不单独轮询；过期下架进每日维护。
 */

export const NOTE_TTL_DAYS = 7;
export const FREE_DRAWS_PER_DAY = 3;
export const DRAW_COST_COINS = 5;
export const REPORT_HIDE_THRESHOLD = 3;
export const NOTE_CONTENT_MAX = 300;
export const NOTE_REGION_MAX = 24;
export const MESSAGE_BODY_MAX = 500;

export const NOTE_GENDERS = new Set(["m", "f", "x"]);
export const NOTE_AGE_BANDS = new Set(["18-24", "25-30", "31-40", "40+"]);

export type NoteStatus = "active" | "hidden" | "withdrawn" | "expired" | "removed";

export interface NoteCard {
  id: number;
  gender: string;
  ageBand: string;
  region: string;
  content: string;
  imageAssetId: number | null;
  createdAt: string;
  expiresAt: string;
}

export interface NoteError extends Error {
  code: string;
}

function noteError(code: string, message: string): NoteError {
  const error = new Error(message) as NoteError;
  error.code = code;
  return error;
}

/* ------------------------------------------------------------------ *
 * 纯函数（单测锚点）
 * ------------------------------------------------------------------ */

export interface NoteDraftInput {
  gender: string;
  ageBand: string;
  region: string;
  content: string;
}

/** 放纸条字段校验：非法即抛 noteError，合法返回裁剪后的值。 */
export function validateNoteDraft(input: NoteDraftInput): Required<NoteDraftInput> {
  const gender = String(input.gender ?? "");
  if (!NOTE_GENDERS.has(gender)) throw noteError("bad_field", "请选择性别");
  const ageBand = String(input.ageBand ?? "");
  if (!NOTE_AGE_BANDS.has(ageBand)) throw noteError("bad_field", "请选择年龄段");
  const region = String(input.region ?? "")
    .trim()
    .slice(0, NOTE_REGION_MAX);
  const content = String(input.content ?? "").trim();
  if (content.length < 1) throw noteError("bad_field", "写点什么再放出去吧");
  if (content.length > NOTE_CONTENT_MAX) throw noteError("bad_field", `内容最多 ${NOTE_CONTENT_MAX} 字`);
  return { gender, ageBand, region, content };
}

export interface DrawQuotaDecision {
  kind: "free" | "coin";
  /** 本次之后今天还剩几次免费额（coin 情况下为 0）。 */
  freeLeft: number;
  costCoins: number;
}

/** 免费额判定：当日已抽次数 < 免费额 → free，否则 coin。 */
export function decideDrawKind(drawsToday: number): DrawQuotaDecision {
  if (drawsToday < FREE_DRAWS_PER_DAY) {
    return { kind: "free", freeLeft: FREE_DRAWS_PER_DAY - drawsToday - 1, costCoins: 0 };
  }
  return { kind: "coin", freeLeft: 0, costCoins: DRAW_COST_COINS };
}

/** 抽取池的 WHERE 片段：排除自己、非可抽状态、以及已经聊过的纸条。 */
export function drawPoolWhere(drawerHash: string, nowIso: string): { sql: string; params: string[] } {
  return {
    sql: `status = 'active' AND expires_at > ? AND owner_hash != ?
          AND id NOT IN (SELECT note_id FROM note_threads WHERE drawer_hash = ?)`,
    params: [nowIso, drawerHash, drawerHash],
  };
}

/* ------------------------------------------------------------------ *
 * 读写
 * ------------------------------------------------------------------ */

function nowIso(): string {
  return new Date().toISOString();
}

export interface NoteEnv {
  DB: D1Database;
}

export async function getMyActiveNote(db: D1Database, ownerHash: string): Promise<NoteCard | null> {
  const row = await db
    .prepare(
      `SELECT id, gender, age_band AS ageBand, region, content, image_asset_id AS imageAssetId,
              created_at AS createdAt, expires_at AS expiresAt
         FROM notes WHERE owner_hash = ? AND status = 'active' LIMIT 1`,
    )
    .bind(ownerHash)
    .first<NoteCard>();
  return row ?? null;
}

/** 放纸条。已有 active 纸条时抛 already_active——「1 人 1 张」由应用层给出友好文案，
 *  数据库部分唯一索引兜底并发。 */
export async function putNote(
  db: D1Database,
  ownerHash: string,
  draft: NoteDraftInput,
  imageAssetId: number | null,
): Promise<NoteCard> {
  const clean = validateNoteDraft(draft);
  const created = nowIso();
  const expires = new Date(Date.now() + NOTE_TTL_DAYS * 86_400_000).toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO notes (owner_hash, gender, age_band, region, content, image_asset_id, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .bind(ownerHash, clean.gender, clean.ageBand, clean.region, clean.content, imageAssetId, created, expires)
      .run();
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String((error as Error)?.message ?? ""))) {
      throw noteError("already_active", "你已经有一张有效纸条了，先下架再放新的");
    }
    throw error;
  }
  const mine = await getMyActiveNote(db, ownerHash);
  if (!mine) throw noteError("internal", "纸条写入失败，请重试");
  return mine;
}

export async function withdrawNote(db: D1Database, ownerHash: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE notes SET status = 'withdrawn' WHERE owner_hash = ? AND status = 'active'`)
    .bind(ownerHash)
    .run();
  return Number(result.meta?.changes ?? 0) > 0;
}

async function countDrawsToday(db: D1Database, drawerHash: string, timezoneOffsetMinutes: number): Promise<number> {
  const day = coinDayKey(Date.now(), timezoneOffsetMinutes);
  // note_draws.created_at 是 UTC ISO；本地日的零点要先换算回 UTC 时刻再比较
  // （东八区的"今天 0 点"= 昨天 16:00Z）。直接拿 day 拼 T00:00:00Z 会把
  // 本地日界错当成 UTC 日界，导致当天抽取永远数不到、免费额永远用不完。
  const cutoff = new Date(Date.parse(day + "T00:00:00Z") - timezoneOffsetMinutes * 60_000).toISOString();
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM note_draws WHERE drawer_hash = ? AND created_at >= ?`)
    .bind(drawerHash, cutoff)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export interface DrawOutcome {
  ok: true;
  empty: true;
}
export interface DrawHit {
  ok: true;
  empty: false;
  kind: "free" | "coin";
  balance: number;
  freeLeft: number;
  threadId: number;
  note: NoteCard;
}
export type DrawResult = DrawOutcome | DrawHit;

/**
 * 抽纸条。先挑后付：池空不扣任何东西；免费额够走免费，否则原子扣金币。
 * 幂等键由客户端带来（防双击双扣），格式 `note:<uuid>` 由 HTTP 层校验。
 */
export async function drawNote(
  db: D1Database,
  drawerHash: string,
  userId: number | null,
  idempotencyKey: string,
): Promise<DrawResult> {
  // 需先放入 1 张纸条才能抽取（玩法规则，也保证回信有人收）。
  const mine = await getMyActiveNote(db, drawerHash);
  if (!mine) throw noteError("need_own_note", "先放一张自己的纸条，才能抽别人的");

  const now = nowIso();
  const pool = drawPoolWhere(drawerHash, now);
  const candidate = await db
    .prepare(
      `SELECT id, owner_hash AS ownerHash, gender, age_band AS ageBand, region, content,
              image_asset_id AS imageAssetId, created_at AS createdAt, expires_at AS expiresAt
         FROM notes WHERE ${pool.sql} ORDER BY RANDOM() LIMIT 1`,
    )
    .bind(...pool.params)
    .first<NoteCard & { ownerHash: string }>();
  if (!candidate) return { ok: true, empty: true };

  const cfg = await loadCoinConfig(db);
  const drawsToday = await countDrawsToday(db, drawerHash, cfg.timezoneOffsetMinutes);
  const decision = decideDrawKind(drawsToday);

  const insertDraw = (kind: "free" | "coin") => ({
    sql: `INSERT INTO note_draws (drawer_hash, note_id, kind, created_at) VALUES (?, ?, ?, ?)`,
    params: [drawerHash, candidate.id, kind, now],
  });
  const insertThread = {
    sql: `INSERT INTO note_threads (note_id, drawer_hash, status, created_at) VALUES (?, ?, 'active', ?)
          ON CONFLICT(note_id, drawer_hash) DO NOTHING`,
    params: [candidate.id, drawerHash, now],
  };

  if (decision.kind === "free") {
    await db.batch([
      db.prepare(insertDraw("free").sql).bind(...insertDraw("free").params),
      db.prepare(insertThread.sql).bind(...insertThread.params),
    ]);
  } else {
    const account = await getCoinAccount(db, drawerHash);
    if ((account?.balance ?? 0) < decision.costCoins) {
      throw noteError("insufficient_balance", `金币不足：抽纸条需要 ${decision.costCoins} 金币`);
    }
    const outcome = await runSpendBatch(
      db,
      {
        participantHash: drawerHash,
        userId,
        // runSpendBatch 约定收正数金额（扣款由它内部取负入账）。
        amount: decision.costCoins,
        kind: "note_draw",
        idempotencyKey,
        refType: "note",
        refId: String(candidate.id),
        note: "抽纸条",
        createdBy: "note_chat",
      },
      (charged) => [
        {
          sql: `INSERT INTO note_draws (drawer_hash, note_id, kind, created_at)
                SELECT ?, ?, 'coin', ? WHERE ${charged.sql}`,
          params: [drawerHash, candidate.id, now, ...charged.params],
        },
        insertThread,
      ],
    );
    if (!outcome.applied && !outcome.duplicate) {
      throw noteError("insufficient_balance", `金币不足：抽纸条需要 ${decision.costCoins} 金币`);
    }
  }

  const thread = await db
    .prepare(`SELECT id FROM note_threads WHERE note_id = ? AND drawer_hash = ?`)
    .bind(candidate.id, drawerHash)
    .first<{ id: number }>();
  const balance = (await getCoinAccount(db, drawerHash))?.balance ?? 0;
  return {
    ok: true,
    empty: false,
    kind: decision.kind,
    balance,
    freeLeft: decision.freeLeft,
    threadId: thread?.id ?? 0,
    note: {
      id: candidate.id,
      gender: candidate.gender,
      ageBand: candidate.ageBand,
      region: candidate.region,
      content: candidate.content,
      imageAssetId: candidate.imageAssetId ?? null,
      createdAt: candidate.createdAt,
      expiresAt: candidate.expiresAt,
    },
  };
}

/** 会话里「我」这一侧的身份：抽中者，或纸条主人。status 取纸条状态——
 * 会话本身恒为 active，纸条下架/过期/隐藏才是「只读」的判据。 */
async function threadParticipant(
  db: D1Database,
  threadId: number,
  participantHash: string,
): Promise<{ threadId: number; noteId: number; ownerHash: string; drawerHash: string; status: string } | null> {
  return (
    (await db
      .prepare(
        `SELECT t.id AS threadId, t.note_id AS noteId, n.owner_hash AS ownerHash,
                t.drawer_hash AS drawerHash, n.status AS status
           FROM note_threads t JOIN notes n ON n.id = t.note_id
          WHERE t.id = ? AND (t.drawer_hash = ? OR n.owner_hash = ?) LIMIT 1`,
      )
      .bind(threadId, participantHash, participantHash)
      .first()) ?? null
  );
}

export interface ThreadSummary {
  id: number;
  noteId: number;
  role: "drawer" | "owner";
  peerNote: Pick<NoteCard, "id" | "gender" | "ageBand" | "region" | "content" | "imageAssetId"> | null;
  noteStatus: NoteStatus;
  lastBody: string | null;
  lastMessageAt: string | null;
  unread: number;
  messageCount: number;
}

/** 会话列表（我是抽中者 or 纸条主人）。未读数在这里搭车算出，不单独轮询。 */
export async function listThreads(db: D1Database, participantHash: string): Promise<ThreadSummary[]> {
  const result = await db
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
    .all<{
      id: number;
      noteId: number;
      drawerHash: string;
      noteStatus: NoteStatus;
      gender: string;
      ageBand: string;
      region: string;
      content: string;
      imageAssetId: number | null;
      lastMessageAt: string | null;
      messageCount: number;
      readUpTo: number;
    }>();
  const rows = result.results ?? [];
  if (rows.length === 0) return [];
  const lastBodies = await db
    .prepare(
      `SELECT m.thread_id AS threadId, m.body FROM note_messages m
        WHERE m.id IN (SELECT MAX(id) FROM note_messages GROUP BY thread_id)`,
    )
    .all<{ threadId: number; body: string }>();
  const lastByThread = new Map((lastBodies.results ?? []).map((row) => [row.threadId, row.body]));
  const unreadRows = await db
    .prepare(
      `SELECT m.thread_id AS threadId, COUNT(*) AS n FROM note_messages m
         JOIN note_threads t ON t.id = m.thread_id
         JOIN notes n ON n.id = t.note_id
        WHERE (t.drawer_hash = ?1 OR n.owner_hash = ?1) AND m.sender_hash != ?1
          AND m.id > COALESCE((SELECT last_read_message_id FROM note_thread_reads r
                                WHERE r.thread_id = m.thread_id AND r.participant_hash = ?1), 0)
        GROUP BY m.thread_id`,
    )
    .bind(participantHash)
    .all<{ threadId: number; n: number }>();
  const unreadByThread = new Map((unreadRows.results ?? []).map((row) => [row.threadId, Number(row.n)]));
  return rows.map((row) => ({
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

export interface ChatMessage {
  id: number;
  mine: boolean;
  body: string;
  imageAssetId: number | null;
  createdAt: string;
}

export async function listMessages(
  db: D1Database,
  threadId: number,
  participantHash: string,
  afterId: number,
): Promise<{ messages: ChatMessage[]; peerGone: boolean } | null> {
  const participant = await threadParticipant(db, threadId, participantHash);
  if (!participant) return null;
  const result = await db
    .prepare(
      `SELECT id, sender_hash AS senderHash, body, image_asset_id AS imageAssetId, created_at AS createdAt
         FROM note_messages WHERE thread_id = ? AND id > ? ORDER BY id ASC LIMIT 200`,
    )
    .bind(threadId, afterId)
    .all<{ id: number; senderHash: string; body: string; imageAssetId: number | null; createdAt: string }>();
  // 读水位搭车推进：拉取即已读。
  const maxId = (result.results ?? []).reduce((max, row) => Math.max(max, row.id), afterId);
  await db
    .prepare(
      `INSERT INTO note_thread_reads (thread_id, participant_hash, last_read_message_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id, participant_hash)
       DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id), updated_at = excluded.updated_at`,
    )
    .bind(threadId, participantHash, maxId, nowIso())
    .run();
  return {
    messages: (result.results ?? []).map((row) => ({
      id: row.id,
      mine: row.senderHash === participantHash,
      body: row.body,
      imageAssetId: row.imageAssetId ?? null,
      createdAt: row.createdAt,
    })),
    // 纸条被下架/过期/移除后会话只读——前端据此置灰输入框。
    peerGone: participant.status !== "active",
  };
}

export async function sendMessage(
  db: D1Database,
  threadId: number,
  senderHash: string,
  body: string,
  imageAssetId: number | null,
): Promise<ChatMessage> {
  const participant = await threadParticipant(db, threadId, senderHash);
  if (!participant) throw noteError("not_participant", "会话不存在");
  if (participant.status !== "active") throw noteError("thread_closed", "这张纸条已下架，会话只读");
  const text = String(body ?? "").trim();
  if (!text && !imageAssetId) throw noteError("empty_message", "说点什么吧");
  if (text.length > MESSAGE_BODY_MAX) throw noteError("bad_field", `单条消息最多 ${MESSAGE_BODY_MAX} 字`);
  const created = nowIso();
  const insert = await db
    .prepare(
      `INSERT INTO note_messages (thread_id, sender_hash, body, image_asset_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(threadId, senderHash, text, imageAssetId, created)
    .run();
  await db
    .prepare(`UPDATE note_threads SET last_message_at = ?, message_count = message_count + 1 WHERE id = ?`)
    .bind(created, threadId)
    .run();
  return {
    id: Number(insert.meta?.last_row_id ?? 0),
    mine: true,
    body: text,
    imageAssetId: imageAssetId ?? null,
    createdAt: created,
  };
}

/** 举报：同一人对同一张纸条只计一次；达到阈值自动暂隐（管理员可复核恢复）。 */
export async function reportNote(
  db: D1Database,
  noteId: number,
  reporterHash: string,
  reason: string,
): Promise<{ hidden: boolean; reportCount: number }> {
  const note = await db
    .prepare(`SELECT id, report_count AS reportCount, status FROM notes WHERE id = ? AND status IN ('active','hidden')`)
    .bind(noteId)
    .first<{ id: number; reportCount: number; status: NoteStatus }>();
  if (!note) throw noteError("not_found", "纸条不存在或已下架");
  try {
    await db
      .prepare(`INSERT INTO note_reports (note_id, reporter_hash, reason, created_at) VALUES (?, ?, ?, ?)`)
      .bind(noteId, reporterHash, String(reason ?? "").slice(0, 200), nowIso())
      .run();
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String((error as Error)?.message ?? ""))) {
      return { hidden: note.status === "hidden", reportCount: Number(note.reportCount ?? 0) };
    }
    throw error;
  }
  const count = Number(note.reportCount ?? 0) + 1;
  const hidden = count >= REPORT_HIDE_THRESHOLD;
  await db
    .prepare(`UPDATE notes SET report_count = ?, status = CASE WHEN ? THEN 'hidden' ELSE status END WHERE id = ?`)
    .bind(count, hidden ? 1 : 0, noteId)
    .run();
  return { hidden, reportCount: count };
}

/** 每日维护：到期纸条下架。走 idx_notes_pool 前缀，行数 = 当日到期数。 */
export async function expireDueNotes(db: D1Database): Promise<number> {
  const result = await db
    .prepare(`UPDATE notes SET status = 'expired' WHERE status = 'active' AND expires_at <= ?`)
    .bind(nowIso())
    .run();
  return Number(result.meta?.changes ?? 0);
}

export { CoinLedgerError };
