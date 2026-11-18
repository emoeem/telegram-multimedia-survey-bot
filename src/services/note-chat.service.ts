import { sendMessage as sendTelegramMessage } from "../bot/telegram";
import { loadCoinConfig, coinDayKey } from "./coin/config.service";
import { CoinLedgerError, getCoinAccount, runSpendBatch } from "./coin/ledger.service";
import { telegramUserIdForHash } from "./identity-link.service";
import { NOTE_FILTER_REJECTED, NOTE_FILTER_REJECTED_MESSAGE, findBlockedWord } from "./note-content-filter.service";

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

/* 站内通知（T3 · 复用 0084 notifications 表，零迁移）：铃铛端点
 * GET /api/me/notifications 对 kind 无白名单，新 kind 插行即见。 */
const NOTE_DRAWN_TITLE = "你的纸条被抽中了";
const NOTE_DRAWN_BODY = "有人抽中了你的纸条，去对话页回信吧";
const NOTE_REPLY_TITLE = "收到新的回信";
const NOTE_REPLY_BODY_MAX = 120;

/* TG DM（T2 · G4 可发现性）：铃铛之外对「绑定 TG 的接收方」私聊补一条，
 * 文案复用 plaza-notify.service.ts 的版式（首行动机 + 引用摘要 + 深链），
 * 摘要同款 120 字截断。深链 /notes?thread=X&tab=chat 与 CoinCenter 抽中后的
 * 跳转链接同构（admin/src/survey/CoinCenter.tsx）。 */
export const NOTE_DM_SNIPPET_MAX = 120;

/** DM 上下文（HTTP 层透传）：BOT_TOKEN 是 Env secret（src/index.ts），
 * 缺省（本地 dev 未配）时整个 DM 通道关闭；origin 经 resolvePublicOrigin
 * 解析（plaza-api.ts 先例），threadId 由服务内部补上。 */
export interface NoteDmOptions {
  botToken: string;
  origin: string;
}

/** DM 深链（纯函数，单测锚点）：thread 存在即落 chat 页签（note-tab.ts）。 */
export function noteThreadDeepLink(origin: string, threadId: number): string {
  return `${origin.replace(/\/+$/, "")}/notes?thread=${threadId}&tab=chat`;
}

/** 被抽中 DM 文案（纯函数，单测锚点）：含 /notes?thread=X&tab=chat 深链。 */
export function noteDrawnDmText(origin: string, threadId: number): string {
  return ["💌 你的纸条被抽中了", "", NOTE_DRAWN_BODY, "", noteThreadDeepLink(origin, threadId)].join("\n");
}

/** 回信 DM 文案（纯函数，单测锚点）：摘要超长截断为 120 字 + 「…」。 */
export function noteReplyDmText(body: string, origin: string, threadId: number): string {
  const snippet = body.length > NOTE_DM_SNIPPET_MAX ? `${body.slice(0, NOTE_DM_SNIPPET_MAX)}…` : body;
  return ["💌 收到新的回信", "", `「${snippet}」`, "", noteThreadDeepLink(origin, threadId)].join("\n");
}

interface NoteDmContext extends NoteDmOptions {
  participantHash: string;
  threadId: number;
  kind: "note_drawn" | "note_reply";
  body?: string;
}

/** DM 兜底：接收方解析不到 TG 身份（未认领的 web 匿名 / email / 未知前缀）
 * 静默跳过；发送失败 console.warn 不抛（plaza-notify.service.ts 先例）——
 * DM 是增强，任何失败都不能影响已生效的抽取/消息。 */
async function dispatchNoteDm(db: D1Database, dm: NoteDmContext): Promise<void> {
  try {
    const chatId = await telegramUserIdForHash(db, dm.participantHash);
    if (chatId === null) return;
    const text =
      dm.kind === "note_drawn"
        ? noteDrawnDmText(dm.origin, dm.threadId)
        : noteReplyDmText(dm.body ?? "", dm.origin, dm.threadId);
    await sendTelegramMessage(dm.botToken, chatId, text);
  } catch (error) {
    console.warn("Note DM failed", { kind: dm.kind, threadId: dm.threadId, error });
  }
}

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

/** 抽取池的 WHERE 片段：排除自己、非可抽状态、已经聊过的纸条、以及双向拉黑
 * 的对方（0094 拉黑任一方向即互不可抽）。 */
export function drawPoolWhere(drawerHash: string, nowIso: string): { sql: string; params: string[] } {
  return {
    sql: `status = 'active' AND expires_at > ? AND owner_hash != ?
          AND id NOT IN (SELECT note_id FROM note_threads WHERE drawer_hash = ?)
          AND NOT EXISTS (
            SELECT 1 FROM note_block b
             WHERE (b.blocker_hash = ? AND b.blocked_hash = notes.owner_hash)
                OR (b.blocker_hash = notes.owner_hash AND b.blocked_hash = ?)
          )`,
    params: [nowIso, drawerHash, drawerHash, drawerHash, drawerHash],
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
  // 发布前过滤（UGC 1.2 先审后投）：命中即在校验阶段拒绝，不写任何行。
  if (findBlockedWord(clean.content)) {
    throw noteError(NOTE_FILTER_REJECTED, NOTE_FILTER_REJECTED_MESSAGE);
  }
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

/** 免费额日界（纯函数，单测锚点）：本地日零点换算回 UTC 时刻。
 * note_draws.created_at 是 UTC ISO；本地日的零点要先换算回 UTC 时刻再比较
 * （东八区的"今天 0 点"= 昨天 16:00Z）。直接拿 day 拼 T00:00:00Z 会把
 * 本地日界错当成 UTC 日界，导致当天抽取永远数不到、免费额永远用不完。
 * drawNote 的原子占用守卫（insertFreeDrawAtomically）与当日计数共用同一
 * 时刻切分，避免读判写之间跨日界的口径漂移。 */
export function drawDayCutoffIso(nowMs: number, timezoneOffsetMinutes: number): string {
  const day = coinDayKey(nowMs, timezoneOffsetMinutes);
  return new Date(Date.parse(day + "T00:00:00Z") - timezoneOffsetMinutes * 60_000).toISOString();
}

async function countDrawsToday(db: D1Database, drawerHash: string, cutoffIso: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM note_draws WHERE drawer_hash = ? AND created_at >= ?`)
    .bind(drawerHash, cutoffIso)
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
  /** 幂等重放标记：仅同键重放返回（回放首次抽取结果），首次抽取不带。 */
  duplicate?: true;
}
export type DrawResult = DrawOutcome | DrawHit;

/**
 * 免费额原子占用（B8 · 并发收口）：把「当日已抽次数 < 免费额」的判定下推进
 * 插入语句本体——`INSERT ... SELECT ... WHERE (SELECT COUNT(*) ...) < N` 的
 * 条件与插入同语句求值，D1 对写事务的串行化保证并发双请求最多把免费额吃到
 * 上限（旧的读-判-写两段式会被并发双吃）。守卫未生效（changes=0）说明额度
 * 已被并发用尽，调用方转金币路径。
 * 会话行与抽取行同 batch、以 EXISTS(本次 free 抽取行) 为前提接续——两行
 * 同生共死（真 D1 batch 是事务），不会留下「有抽取没会话」的孤儿。
 */
async function insertFreeDrawAtomically(
  db: D1Database,
  drawerHash: string,
  noteId: number,
  now: string,
  cutoffIso: string,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO note_draws (drawer_hash, note_id, kind, created_at)
         SELECT ?, ?, 'free', ?
         WHERE (SELECT COUNT(*) FROM note_draws WHERE drawer_hash = ? AND created_at >= ?) < ?`,
      )
      .bind(drawerHash, noteId, now, drawerHash, cutoffIso, FREE_DRAWS_PER_DAY),
    db
      .prepare(
        `INSERT INTO note_threads (note_id, drawer_hash, status, created_at)
         SELECT ?, ?, 'active', ?
         WHERE EXISTS (SELECT 1 FROM note_draws
                        WHERE drawer_hash = ? AND note_id = ? AND kind = 'free' AND created_at = ?)
         ON CONFLICT(note_id, drawer_hash) DO NOTHING`,
      )
      .bind(noteId, drawerHash, now, drawerHash, noteId, now),
  ]);
  return Number(results[0]?.meta?.changes ?? 0) > 0;
}

/**
 * 抽纸条。先挑后付：池空不扣任何东西；免费额够走免费（占用原子，见
 * insertFreeDrawAtomically），否则原子扣金币。
 * 幂等键由客户端带来（防双击双扣），格式 `note:<uuid>` 由 HTTP 层校验；
 * 入账前再重组为参与者作用域账本键 `note:<drawerHash>:<uuid>`（对齐
 * checkin.service.ts / challenge.service.ts 的既有前缀模式）——
 * coin_transactions.idempotency_key 是全局 UNIQUE（ledger.service.ts 的查重
 * 是裸键全局查），客户端裸键直接入账会让不同用户持相同 uuid 互撞、
 * 重放回放别人的结果，甚至出现未扣款却 ok 的幽灵返回。
 */
export async function drawNote(
  db: D1Database,
  drawerHash: string,
  userId: number | null,
  idempotencyKey: string,
  dm?: NoteDmOptions,
): Promise<DrawResult> {
  // 需先放入 1 张纸条才能抽取（玩法规则，也保证回信有人收）。
  const mine = await getMyActiveNote(db, drawerHash);
  if (!mine) throw noteError("need_own_note", "先放一张自己的纸条，才能抽别人的");

  // 账本键参与者作用域化：取客户端键的 token 部分（HTTP 层已校验 `note:`
  // 前缀；此处剥前缀兜底），与抽取者 hash 绑定。
  const clientToken = idempotencyKey.startsWith("note:") ? idempotencyKey.slice("note:".length) : idempotencyKey;
  const ledgerKey = `note:${drawerHash}:${clientToken}`;

  // 同键幂等重放：本人已用这个键扣款抽过 → 直接回放首次结果。必须先于
  // 候选重挑——首次抽取的纸条已被会话池排除，重挑要么落空（empty）要么
  // 换张，与首次扣款对不上。免额路径没有账本行，不经过这里。
  const previous = await db
    .prepare(
      `SELECT id, ref_id FROM coin_transactions
        WHERE idempotency_key = ? AND participant_hash = ? AND kind = 'note_draw'`,
    )
    .bind(ledgerKey, drawerHash)
    .first<{ id: number; ref_id: string | null }>();
  const replayed = previous?.ref_id ? await replayDrawHit(db, drawerHash, Number(previous.ref_id)) : null;
  if (replayed) return replayed;

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
  const cutoffIso = drawDayCutoffIso(Date.now(), cfg.timezoneOffsetMinutes);
  const drawsToday = await countDrawsToday(db, drawerHash, cutoffIso);
  const decision = decideDrawKind(drawsToday);

  // 最终生效的抽取种类：免费占用失败转金币时，回执的 kind/freeLeft 必须按
  // 金币口径返回（客户端按它展示扣费），不能沿用预判的 free。
  let appliedKind: "free" | "coin" = decision.kind;
  let appliedFreeLeft = decision.freeLeft;

  // 金币路径（免费额不足/并发被用尽的共用出口）：扣费由 runSpendBatch 的
  // 守卫流水原子完成；抽取行以「本次扣款确实生效」（charged 守卫）为前提，
  // 会话行再以「本次抽取行确实落库」为前提（EXISTS 同人同纸条同刻的 coin
  // 行）——三层递进，余额在预检后、batch 前被并发抽干时三行都不生效，
  // 不会留下「有会话没扣款」的孤儿（B8 修正的旧隐患）。
  // 返回非空 DrawHit = 真并发双提交输家的幂等回放，调用方必须直接返回它。
  const chargeCoinDraw = async (costCoins: number): Promise<DrawHit | null> => {
    const account = await getCoinAccount(db, drawerHash);
    if ((account?.balance ?? 0) < costCoins) {
      throw noteError("insufficient_balance", `金币不足：抽纸条需要 ${costCoins} 金币`);
    }
    const outcome = await runSpendBatch(
      db,
      {
        participantHash: drawerHash,
        userId,
        // runSpendBatch 约定收正数金额（扣款由它内部取负入账）。
        amount: costCoins,
        kind: "note_draw",
        idempotencyKey: ledgerKey,
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
        {
          sql: `INSERT INTO note_threads (note_id, drawer_hash, status, created_at)
                SELECT ?, ?, 'active', ?
                WHERE EXISTS (SELECT 1 FROM note_draws
                               WHERE drawer_hash = ? AND note_id = ? AND kind = 'coin' AND created_at = ?)
                ON CONFLICT(note_id, drawer_hash) DO NOTHING`,
          params: [candidate.id, drawerHash, now, drawerHash, candidate.id, now],
        },
      ],
    );
    if (outcome.duplicate) {
      // 真并发双提交的输家：赢家流水已落库、本批（真 D1 里）整体回滚。
      // 绝不能把自选候选当成功——那会返回幽灵纸条（threadId 0）、给没被抽中
      // 的作者误发「被抽中」通知，构成「未扣款却 ok」。按赢家流水记下的
      // refId 回放，与顶部预检同一出口；回放对不上（异常数据）就报错让
      // 客户端换新键重试，也不走 tail。
      const winner = outcome.transactionId
        ? await db
            .prepare(`SELECT ref_id FROM coin_transactions WHERE id = ?`)
            .bind(outcome.transactionId)
            .first<{ ref_id: string | null }>()
        : null;
      const concurrentReplay = winner?.ref_id ? await replayDrawHit(db, drawerHash, Number(winner.ref_id)) : null;
      if (concurrentReplay) return concurrentReplay;
      throw noteError("draw_replay_failed", "抽取结果回放失败，请重新抽取");
    }
    if (!outcome.applied && !outcome.duplicate) {
      throw noteError("insufficient_balance", `金币不足：抽纸条需要 ${costCoins} 金币`);
    }
    return null;
  };

  if (decision.kind === "free") {
    const freeApplied = await insertFreeDrawAtomically(db, drawerHash, candidate.id, now, cutoffIso);
    if (!freeApplied) {
      // 免费额被并发请求用尽（占用守卫未生效行）：转金币路径扣同一候选，
      // 单价按标准 DRAW_COST_COINS 计（与 decideDrawKind 的 coin 决策等价，
      // 预判的 decision.costCoins 此时是 free 口径的 0）。不重挑候选——
      // 候选查询后池子只可能更小，重挑反而可能把可抽变空池。
      appliedKind = "coin";
      appliedFreeLeft = 0;
      const replay = await chargeCoinDraw(DRAW_COST_COINS);
      if (replay) return replay;
    }
  } else {
    const replay = await chargeCoinDraw(decision.costCoins);
    if (replay) return replay;
  }

  const thread = await db
    .prepare(`SELECT id FROM note_threads WHERE note_id = ? AND drawer_hash = ?`)
    .bind(candidate.id, drawerHash)
    .first<{ id: number }>();
  // 抽中即通知纸条作者（T3）：非池空才走到这里，见 notifyNoteDrawn；
  // 带 DM 上下文时再对绑定 TG 的作者私聊一条（T2），收件人是作者本人。
  await notifyNoteDrawn(db, candidate.ownerHash, now, dm ? { ...dm, threadId: thread?.id ?? 0 } : undefined);
  const balance = (await getCoinAccount(db, drawerHash))?.balance ?? 0;
  return {
    ok: true,
    empty: false,
    kind: appliedKind,
    balance,
    freeLeft: appliedFreeLeft,
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

/**
 * 幂等重放：按首次扣款流水记下的纸条（ref_id）回放会话与纸条卡片。
 * 重放不再通知作者、不再随机挑候选——结果与首次扣款严格一致。
 * 返回 null 表示首次记录对不上（异常数据），调用方照常走新抽取。
 */
async function replayDrawHit(db: D1Database, drawerHash: string, noteId: number): Promise<DrawHit | null> {
  const row = await db
    .prepare(
      `SELECT t.id AS threadId, n.id, n.gender, n.age_band AS ageBand, n.region, n.content,
              n.image_asset_id AS imageAssetId, n.created_at AS createdAt, n.expires_at AS expiresAt
         FROM note_threads t JOIN notes n ON n.id = t.note_id
        WHERE t.note_id = ? AND t.drawer_hash = ?`,
    )
    .bind(noteId, drawerHash)
    .first<{
      threadId: number;
      id: number;
      gender: string;
      ageBand: string;
      region: string;
      content: string;
      imageAssetId: number | null;
      createdAt: string;
      expiresAt: string;
    }>();
  if (!row) return null;
  return {
    ok: true,
    empty: false,
    kind: "coin",
    duplicate: true,
    balance: (await getCoinAccount(db, drawerHash))?.balance ?? 0,
    // 金币路径只在免费额耗尽后发生，重放时免费额必然仍是 0。
    freeLeft: 0,
    threadId: row.threadId,
    note: {
      id: row.id,
      gender: row.gender,
      ageBand: row.ageBand,
      region: row.region,
      content: row.content,
      imageAssetId: row.imageAssetId ?? null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
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

/** 可见会话集合按批圈定的分块尺寸（B8）：会话列表 LIMIT 100，IN 列表留出
 * 余量给其余绑定参数——D1 单语句绑定参数上限 100
 * （media.repository.ts 的 MEDIA_ID_BATCH_SIZE 同款口径）。 */
const NOTE_THREAD_ID_BATCH_SIZE = 90;

/** 会话列表（我是抽中者 or 纸条主人）。未读数在这里搭车算出，不单独轮询。 */
export async function listThreads(db: D1Database, participantHash: string): Promise<ThreadSummary[]> {
  // 主查询（B8 重写，D1_EXPLAIN_AUDIT Q10）：原来的跨表 OR
  // `(t.drawer_hash=? OR n.owner_hash=?)` 无法走索引——SQLite 的 multi-index
  // OR 只适用于同表谓词，审计实测任何索引都救不了（EXP1/EXP2 计划无变化），
  // note_threads 随玩法线性增长时是全表扫描。改为 UNION 两臂（审计 §四 EXP3
  // 验证过的形态）：抽中者臂走 idx_threads_drawer_status，主人臂走
  // idx_notes_owner_hash + 会话唯一索引（0099 补齐两条访问路径）。
  // 用 UNION（去重）而非 UNION ALL：规则变更前的历史自抽 thread 会让两臂
  // 同时命中同一行，UNION 与旧查询的输出严格一致。两臂是同一份投影，结果
  // 列名以第一臂为准；排序键投影成 sortAt 供复合查询的 ORDER BY 引用。
  const result = await db
    .prepare(
      `SELECT t.id AS id, t.note_id AS noteId, t.drawer_hash AS drawerHash, t.status AS threadStatus,
              n.owner_hash AS ownerHash, n.status AS noteStatus,
              n.gender, n.age_band AS ageBand, n.region, n.content, n.image_asset_id AS imageAssetId,
              t.last_message_at AS lastMessageAt, t.message_count AS messageCount,
              COALESCE(r.last_read_message_id, 0) AS readUpTo,
              COALESCE(t.last_message_at, t.created_at) AS sortAt
         FROM note_threads t
         JOIN notes n ON n.id = t.note_id
         LEFT JOIN note_thread_reads r ON r.thread_id = t.id AND r.participant_hash = ?
        WHERE t.drawer_hash = ? AND t.status = 'active'
        UNION
       SELECT t.id AS id, t.note_id AS noteId, t.drawer_hash AS drawerHash, t.status AS threadStatus,
              n.owner_hash AS ownerHash, n.status AS noteStatus,
              n.gender, n.age_band AS ageBand, n.region, n.content, n.image_asset_id AS imageAssetId,
              t.last_message_at AS lastMessageAt, t.message_count AS messageCount,
              COALESCE(r.last_read_message_id, 0) AS readUpTo,
              COALESCE(t.last_message_at, t.created_at) AS sortAt
         FROM notes n
         JOIN note_threads t ON t.note_id = n.id
         LEFT JOIN note_thread_reads r ON r.thread_id = t.id AND r.participant_hash = ?
        WHERE n.owner_hash = ? AND t.status = 'active'
        ORDER BY sortAt DESC
        LIMIT 100`,
    )
    .bind(participantHash, participantHash, participantHash, participantHash)
    .all<{
      id: number;
      noteId: number;
      drawerHash: string;
      ownerHash: string;
      noteStatus: NoteStatus;
      gender: string;
      ageBand: string;
      region: string;
      content: string;
      imageAssetId: number | null;
      lastMessageAt: string | null;
      messageCount: number;
      readUpTo: number;
      sortAt: string;
    }>();
  const rows = result.results ?? [];
  if (rows.length === 0) return [];
  // 拉黑读侧过滤（双向）：我拉黑对方 → 会话从我这里消失；对方拉黑我 → 同样
  // 消失（发消息/看历史都没意义）。一次取出两条方向的行再在内存里判。
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
  // 搭车查询两步化（B8 · D1_EXPLAIN_AUDIT Q11/Q24）：旧实现 lastBodies 对
  // 全库 note_messages 逐线程取 MAX(id)（Q24 全索引扫），未读数把参与者谓词
  // 绑在 join 后（Q11 全索引扫）——都线性于全库消息数。现在以可见会话集合
  // （≤ LIMIT 100）圈定范围、按 thread_id IN 聚合，note_messages 的访问路径
  // 变成 idx_messages_thread 的逐会话范围扫。旧实现对「超出 LIMIT/被拉黑」
  // 的会话也算出的未读数从不展示，两步化只算可见集合，展示口径不变。
  // 全部被拉黑时集合为空，跳过两条聚合（IN () 不是合法 SQL）。
  const threadIds = visibleRows.map((row) => row.id);
  const lastByThread = new Map<number, string>();
  const unreadByThread = new Map<number, number>();
  for (let start = 0; start < threadIds.length; start += NOTE_THREAD_ID_BATCH_SIZE) {
    const ids = threadIds.slice(start, start + NOTE_THREAD_ID_BATCH_SIZE);
    const placeholders = ids.map(() => "?").join(", ");
    // 末条消息：依赖 SQLite bare-MAX 特例（lang_select.html §bareagg）——查询
    // 只有唯一一个聚合 MAX(id) 时，裸列 body 取自 MAX 命中的那一行；id 唯一
    // 无并列，与旧实现「每线程 active 末条 body」逐字段一致。LIMIT ? 按
    // ids 长度绑定，是「结果行数 ≤ 会话数」的显式护栏（GROUP BY 后每会话
    // 至多一行，永不截断）。回归用例逐字段对比见 tests/unit/note-chat.test.ts。
    const lastBodies = await db
      .prepare(
        `SELECT m.thread_id AS threadId, m.body, MAX(m.id) AS lastMessageId
           FROM note_messages m
          WHERE m.thread_id IN (${placeholders}) AND m.status = 'active'
          GROUP BY m.thread_id
          LIMIT ?`,
      )
      .bind(...ids, ids.length)
      .all<{ threadId: number; body: string }>();
    for (const row of lastBodies.results ?? []) lastByThread.set(row.threadId, row.body);
    // 未读数：旧实现里的参与者谓词（跨表 OR）已经由主查询完成圈定，这里
    // 只剩 thread_id IN + 逐行已读水位点查（UNIQUE(thread_id, participant_hash)）。
    const unreadRows = await db
      .prepare(
        `SELECT m.thread_id AS threadId, COUNT(*) AS n FROM note_messages m
          WHERE m.thread_id IN (${placeholders}) AND m.sender_hash != ? AND m.status = 'active'
            AND m.id > COALESCE((SELECT last_read_message_id FROM note_thread_reads r
                                  WHERE r.thread_id = m.thread_id AND r.participant_hash = ?), 0)
          GROUP BY m.thread_id`,
      )
      .bind(...ids, participantHash, participantHash)
      .all<{ threadId: number; n: number }>();
    for (const row of unreadRows.results ?? []) unreadByThread.set(row.threadId, Number(row.n));
  }
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
         FROM note_messages WHERE thread_id = ? AND id > ? AND status = 'active' ORDER BY id ASC LIMIT 200`,
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

/** 双向拉黑判定：任一方向存在拉黑行即 true。PK 前缀查询，同一对值绑四次
 * （不用 ?N 编号占位符：node:sqlite 测试 harness 只支持匿名位置参数）。 */
export async function isBlockedPair(db: D1Database, hashA: string, hashB: string): Promise<boolean> {
  if (hashA === hashB) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS blocked FROM note_block
        WHERE (blocker_hash = ? AND blocked_hash = ?) OR (blocker_hash = ? AND blocked_hash = ?)
        LIMIT 1`,
    )
    .bind(hashA, hashB, hashB, hashA)
    .first();
  return row !== null;
}

/** 会话里「对方」的 hash。参与者校验失败返回 null（与 threadParticipant 同口径）。 */
async function threadPeerHash(db: D1Database, threadId: number, participantHash: string): Promise<string | null> {
  const participant = await threadParticipant(db, threadId, participantHash);
  if (!participant) return null;
  return participant.drawerHash === participantHash ? participant.ownerHash : participant.drawerHash;
}

/** 会话级拉黑（用户看不到裸 hash，入口是会话）：解析对方 hash 后写 note_block。
 * 重复拉黑幂等（PK 冲突 DO NOTHING）。 */
export async function blockThread(db: D1Database, threadId: number, participantHash: string): Promise<boolean> {
  const peerHash = await threadPeerHash(db, threadId, participantHash);
  if (!peerHash) throw noteError("not_participant", "会话不存在");
  await db
    .prepare(
      `INSERT INTO note_block (blocker_hash, blocked_hash, created_at) VALUES (?, ?, ?)
       ON CONFLICT(blocker_hash, blocked_hash) DO NOTHING`,
    )
    .bind(participantHash, peerHash, nowIso())
    .run();
  return true;
}

/** 解除拉黑：只删「我拉黑对方」那一行——对方拉黑我的行不归我管，
 * 解除后是否恢复可见以 isBlockedPair（双向）为准。 */
export async function unblockThread(db: D1Database, threadId: number, participantHash: string): Promise<boolean> {
  const peerHash = await threadPeerHash(db, threadId, participantHash);
  if (!peerHash) throw noteError("not_participant", "会话不存在");
  const result = await db
    .prepare(`DELETE FROM note_block WHERE blocker_hash = ? AND blocked_hash = ?`)
    .bind(participantHash, peerHash)
    .run();
  return Number(result.meta?.changes ?? 0) > 0;
}

/** 抽中通知（note_drawn）：离散事件，有意不折叠——「被抽中」每条都可带抽中
 * 语义，写入量天然有界（抽取受每日免费额 + 金币限流，每抽至多 1 行）。
 * best-effort：通知是增强，失败不回滚已生效的抽取（金币路径钱已扣）。
 * dm（T2 · 可选）：收件人是纸条作者 ownerHash——不是抽取者；解析不到
 * TG 身份（匿名/email）时静默跳过。 */
async function notifyNoteDrawn(
  db: D1Database,
  ownerHash: string,
  at: string,
  dm?: NoteDmOptions & { threadId: number },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO notifications (participant_hash, kind, title, body, link, created_at)
         VALUES (?, 'note_drawn', ?, ?, '/notes', ?)`,
      )
      .bind(ownerHash, NOTE_DRAWN_TITLE, NOTE_DRAWN_BODY, at)
      .run();
  } catch {
    /* 铃铛少一条不影响主流程。 */
  }
  if (dm?.botToken) {
    await dispatchNoteDm(db, {
      participantHash: ownerHash,
      botToken: dm.botToken,
      origin: dm.origin,
      threadId: dm.threadId,
      kind: "note_drawn",
    });
  }
}

/** 回信通知（note_reply）：按参与者折叠——先刷新未读那条的 body/created_at
 * （WHERE 前缀命中 idx_notifications_participant），changes=0 才 INSERT。
 * 同一参与者至多 1 条未读回信通知，写放大被封顶；与 notifySeriesPublish 的
 * 「每发布一行」不同量级，故折叠而非照抄。best-effort：失败不影响已落库的消息。
 * dm（T2 · 可选）：收件人是会话对方 peerHash——不是发消息者；解析不到 TG
 * 身份（匿名/email）时静默跳过。 */
async function notifyNoteReply(
  db: D1Database,
  peerHash: string,
  body: string,
  at: string,
  dm?: NoteDmOptions & { threadId: number },
): Promise<void> {
  try {
    const folded = await db
      .prepare(
        `UPDATE notifications SET body = ?, created_at = ?
          WHERE participant_hash = ? AND kind = 'note_reply' AND read_at IS NULL AND link = '/notes'`,
      )
      .bind(body, at, peerHash)
      .run();
    if (Number(folded.meta?.changes ?? 0) === 0) {
      await db
        .prepare(
          `INSERT INTO notifications (participant_hash, kind, title, body, link, created_at)
           VALUES (?, 'note_reply', ?, ?, '/notes', ?)`,
        )
        .bind(peerHash, NOTE_REPLY_TITLE, body, at)
        .run();
    }
  } catch {
    /* 铃铛少一条不影响主流程。 */
  }
  if (dm?.botToken) {
    await dispatchNoteDm(db, {
      participantHash: peerHash,
      botToken: dm.botToken,
      origin: dm.origin,
      threadId: dm.threadId,
      kind: "note_reply",
      body,
    });
  }
}

export async function sendMessage(
  db: D1Database,
  threadId: number,
  senderHash: string,
  body: string,
  imageAssetId: number | null,
  dm?: NoteDmOptions,
): Promise<ChatMessage> {
  const participant = await threadParticipant(db, threadId, senderHash);
  if (!participant) throw noteError("not_participant", "会话不存在");
  if (participant.status !== "active") throw noteError("thread_closed", "这张纸条已下架，会话只读");
  const peerHash = participant.drawerHash === senderHash ? participant.ownerHash : participant.drawerHash;
  if (await isBlockedPair(db, senderHash, peerHash)) {
    throw noteError("blocked", "你们已互相屏蔽，无法继续会话");
  }
  const text = String(body ?? "").trim();
  if (!text && !imageAssetId) throw noteError("empty_message", "说点什么吧");
  if (text.length > MESSAGE_BODY_MAX) throw noteError("bad_field", `单条消息最多 ${MESSAGE_BODY_MAX} 字`);
  // 与 putNote 同一发布前过滤：命中在校验阶段拒绝，不落行。
  if (findBlockedWord(text)) {
    throw noteError(NOTE_FILTER_REJECTED, NOTE_FILTER_REJECTED_MESSAGE);
  }
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
  // 回信通知（T3）：发给会话对方并折叠，见 notifyNoteReply；纯图片消息用「[图片]」占位。
  // 带 DM 上下文时再对绑定 TG 的对方私聊一条（T2），收件人是对方本人。
  await notifyNoteReply(
    db,
    peerHash,
    text ? text.slice(0, NOTE_REPLY_BODY_MAX) : "[图片]",
    created,
    dm ? { ...dm, threadId } : undefined,
  );
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

/** 举报会话消息：同一人对同一条消息只计一次（0094 UNIQUE 兜底，同人重复举报
 * 幂等返回当前计数）。与 reportNote 不同——消息不设自动隐藏阈值，隐藏由管理端
 * 复核处置（POST /api/note/admin/messages/:id/status）承担。 */
export async function reportMessage(
  db: D1Database,
  threadId: number,
  messageId: number,
  reporterHash: string,
  reason: string,
): Promise<{ reportCount: number }> {
  const participant = await threadParticipant(db, threadId, reporterHash);
  if (!participant) throw noteError("not_participant", "会话不存在");
  const message = await db
    .prepare(`SELECT id FROM note_messages WHERE id = ? AND thread_id = ?`)
    .bind(messageId, threadId)
    .first<{ id: number }>();
  if (!message) throw noteError("not_found", "消息不存在");
  try {
    await db
      .prepare(
        `INSERT INTO note_message_reports (message_id, thread_id, reporter_hash, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(messageId, threadId, reporterHash, String(reason ?? "").slice(0, 200), nowIso())
      .run();
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String((error as Error)?.message ?? ""))) {
      return { reportCount: await countMessageReports(db, messageId) };
    }
    throw error;
  }
  return { reportCount: await countMessageReports(db, messageId) };
}

/** 消息当前举报数。UNIQUE(message_id, reporter_hash) 索引以 message_id 为前缀，计数走它。 */
async function countMessageReports(db: D1Database, messageId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM note_message_reports WHERE message_id = ?`)
    .bind(messageId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
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
