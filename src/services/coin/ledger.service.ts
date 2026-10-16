import type { Env } from "../../index";

/**
 * 金币权威账本。
 *
 * 规则（对应需求 3.1 / 3.2）：
 * - coin_transactions 是唯一事实来源；balance_after 由同一事务内的子查询
 *   读取（D1 batch 顺序执行、整体原子），并发下也能记准。
 * - 所有入账/扣款语句由调用方与业务写语句放进同一个 batch：业务记录
 *   （解锁、抽取、签到……）与账本变动要么同时生效要么同时回滚。
 * - 幂等：idempotency_key 唯一约束。重复提交时整批回滚，调用方捕获
 *   UniqueConflict 后按既有记录返回幂等结果。
 * - 扣款语句带 `AND balance >= ?` 守卫，changes=0 即余额不足，整批回滚，
 *   余额永远不为负。
 * - 普通代码不提供修改/删除流水的接口；纠错只能走带原因的 admin_adjust
 *   反向流水（见 admin 端点 + 审计日志）。
 */

export type CoinTxnKind =
  | "checkin"
  | "challenge"
  | "submission_reward"
  | "survey_unlock"
  | "gacha_pull"
  | "admin_adjust"
  /** 0082 身份合并：source 账户余额整笔搬入 canonical 的那笔流水。 */
  | "merge_in";

export interface CoinLedgerEnv {
  DB: D1Database;
}

export class CoinLedgerError extends Error {
  readonly code: "insufficient_funds" | "duplicate" | "invalid_amount";

  constructor(code: "insufficient_funds" | "duplicate" | "invalid_amount", message: string) {
    super(message);
    this.name = "CoinLedgerError";
    this.code = code;
  }
}

export interface CoinAccount {
  participantHash: string;
  userId: number | null;
  balance: number;
  totalEarned: number;
  totalSpent: number;
}

interface AccountRow {
  participant_hash: string;
  user_id: number | null;
  balance: number;
  total_earned: number;
  total_spent: number;
}

function rowToAccount(row: AccountRow): CoinAccount {
  return {
    participantHash: row.participant_hash,
    userId: row.user_id,
    balance: Number(row.balance),
    totalEarned: Number(row.total_earned),
    totalSpent: Number(row.total_spent),
  };
}

export async function getCoinAccount(db: D1Database, participantHash: string): Promise<CoinAccount | null> {
  const row = await db
    .prepare(
      `SELECT participant_hash, user_id, balance, total_earned, total_spent
       FROM coin_accounts WHERE participant_hash = ?`,
    )
    .bind(participantHash)
    .first<AccountRow>();
  return row ? rowToAccount(row) : null;
}

export async function getCoinAccountOrCreate(db: D1Database, participantHash: string, userId: number | null): Promise<CoinAccount> {
  await db
    .prepare(
      `INSERT INTO coin_accounts (participant_hash, user_id, balance, total_earned, total_spent, created_at, updated_at)
       VALUES (?, ?, 0, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(participant_hash) DO NOTHING`,
    )
    .bind(participantHash, userId)
    .run();
  const account = await getCoinAccount(db, participantHash);
  if (!account) throw new Error("coin account missing after upsert");
  return account;
}

export interface LedgerEntryInput {
  participantHash: string;
  /** Telegram 关联用户（可空）。仅在账户首次创建时写入。 */
  userId?: number | null;
  amount: number;
  kind: CoinTxnKind;
  idempotencyKey: string;
  refType?: string | null;
  refId?: string | null;
  note?: string | null;
  createdBy?: string;
}

function assertAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount === 0) {
    throw new CoinLedgerError("invalid_amount", "金币变动必须是整数且不为 0");
  }
}

export interface PreparedStatement {
  sql: string;
  params: unknown[];
}
export function describeEarnStatements(input: LedgerEntryInput, now: string): PreparedStatement[] {
  assertAmount(input.amount);
  if (input.amount < 0) throw new CoinLedgerError("invalid_amount", "earn 的金额必须为正");
  const statements: PreparedStatement[] = [];
  if (input.userId != null) {
    statements.push({
      sql: `INSERT INTO coin_accounts (participant_hash, user_id, balance, total_earned, total_spent, created_at, updated_at)
            VALUES (?, ?, 0, 0, 0, ?, ?)
            ON CONFLICT(participant_hash) DO NOTHING`,
      params: [input.participantHash, input.userId, now, now],
    });
  } else {
    statements.push({
      sql: `INSERT INTO coin_accounts (participant_hash, balance, total_earned, total_spent, created_at, updated_at)
            VALUES (?, 0, 0, 0, ?, ?)
            ON CONFLICT(participant_hash) DO NOTHING`,
      params: [input.participantHash, now, now],
    });
  }
  statements.push({
    sql: `UPDATE coin_accounts
          SET balance = balance + ?, total_earned = total_earned + ?, updated_at = ?
          WHERE participant_hash = ?`,
    params: [input.amount, input.amount, now, input.participantHash],
  });
  statements.push({
    sql: `INSERT INTO coin_transactions
            (participant_hash, amount, balance_after, kind, ref_type, ref_id, idempotency_key, note, created_by, created_at)
          VALUES
            (?, ?, (SELECT balance FROM coin_accounts WHERE participant_hash = ?), ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      input.participantHash,
      input.amount,
      input.participantHash,
      input.kind,
      input.refType ?? null,
      input.refId ?? null,
      input.idempotencyKey,
      input.note ?? null,
      input.createdBy ?? "system",
      now,
    ],
  });
  return statements;
}

/** 扣款语句：余额守卫在 UPDATE 上，changes=0 即余额不足。 */
/**
 * 扣款语句组：两条语句都以"扣款前余额充足"为前置条件（INSERT..SELECT WHERE
 * / UPDATE WHERE）。D1 batch 在单写者事务内顺序执行：余额充足 → 流水行与
 * 余额扣减同时生效；不足 → 两条都是 0 行，batch 结果里第二条的 meta.changes
 * 为 0，调用方据此返回"余额不足"，不会有半笔账。balance_after 用
 * `balance - amount` 直接算出扣款后的值。
 */
export function describeSpendStatements(input: LedgerEntryInput, now: string): PreparedStatement[] {
  assertAmount(input.amount);
  if (input.amount <= 0) throw new CoinLedgerError("invalid_amount", "spend 的金额必须为正");
  const guardParams = [input.participantHash, input.amount];
  return [
    {
      sql: `INSERT INTO coin_accounts (participant_hash, user_id, balance, total_earned, total_spent, created_at, updated_at)
            VALUES (?, ?, 0, 0, 0, ?, ?)
            ON CONFLICT(participant_hash) DO NOTHING`,
      params: [input.participantHash, input.userId ?? null, now, now],
    },
    {
      sql: `INSERT INTO coin_transactions
              (participant_hash, amount, balance_after, kind, ref_type, ref_id, idempotency_key, note, created_by, created_at)
            SELECT
              ?, -?, (SELECT balance - ? FROM coin_accounts WHERE participant_hash = ?),
              ?, ?, ?, ?, ?, ?, ?
            WHERE (SELECT COALESCE(balance, -1) FROM coin_accounts WHERE participant_hash = ?) >= ?`,
      params: [
        input.participantHash,
        input.amount,
        input.amount,
        input.participantHash,
        input.kind,
        input.refType ?? null,
        input.refId ?? null,
        input.idempotencyKey,
        input.note ?? null,
        input.createdBy ?? "system",
        now,
        ...guardParams,
      ],
    },
    {
      sql: `UPDATE coin_accounts
            SET balance = balance - ?, total_spent = total_spent + ?, updated_at = ?
            WHERE participant_hash = ? AND balance >= ?`,
      params: [input.amount, input.amount, now, ...guardParams],
    },
  ];
}

/**
 * 管理员调账语句：允许正负金额，但不允许把余额打成负数（调用方已先行
 * 校验；UPDATE 仍带守卫兜底）。原因与操作者写入流水与审计日志。
 */
export function describeAdjustStatements(input: LedgerEntryInput, now: string): PreparedStatement[] {
  assertAmount(input.amount);
  const guarded = input.amount < 0
    ? `AND balance >= ${Math.abs(input.amount)}`
    : "";
  return [
    {
      sql: `INSERT INTO coin_accounts (participant_hash, user_id, balance, total_earned, total_spent, created_at, updated_at)
            VALUES (?, ?, 0, 0, 0, ?, ?)
            ON CONFLICT(participant_hash) DO NOTHING`,
      params: [input.participantHash, input.userId ?? null, now, now],
    },
    {
      sql: `UPDATE coin_accounts
            SET balance = balance + ?,
                total_earned = total_earned + MAX(?, 0),
                total_spent = total_spent + MAX(-?, 0),
                updated_at = ?
            WHERE participant_hash = ? ${guarded}`,
      params: [input.amount, input.amount, input.amount, now, input.participantHash],
    },
    {
      sql: `INSERT INTO coin_transactions
              (participant_hash, amount, balance_after, kind, ref_type, ref_id, idempotency_key, note, created_by, created_at)
            SELECT
              ?, ?, (SELECT balance + ? FROM coin_accounts WHERE participant_hash = ?),
              ?, ?, ?, ?, ?, ?, ?
            WHERE (SELECT COUNT(*) FROM coin_accounts WHERE participant_hash = ?) > 0`,
      params: [
        input.participantHash,
        input.amount,
        input.amount,
        input.participantHash,
        input.kind,
        input.refType ?? null,
        input.refId ?? null,
        input.idempotencyKey,
        input.note ?? null,
        input.createdBy ?? "system",
        now,
        input.participantHash,
      ],
    },
  ];
}

function bindAll(db: D1Database, prepared: PreparedStatement[]): D1PreparedStatement[] {
  return prepared.map((statement) => statement.sql ? db.prepare(statement.sql).bind(...statement.params) : null as never);
}

/**
 * 原子扣款 + 业务写入：`buildDependent` 生成的业务语句（解锁行、抽取记录…）
 * 都以"本批扣款流水已写入"为前置条件（EXISTS 幂等键），任何余额不足都会让
 * 业务行一起落空。返回 applied=false 表示余额不足（账面未动）。
 */
export async function runSpendBatch(
  db: D1Database,
  entry: LedgerEntryInput,
  buildDependent: (charged: PreparedStatement) => PreparedStatement[],
): Promise<{ applied: boolean; duplicate: boolean; balance: number; transactionId: number | null }> {
  const now = new Date().toISOString();
  const spend = describeSpendStatements(entry, now);
  const charged: PreparedStatement = {
    sql: `(SELECT COUNT(*) FROM coin_transactions WHERE idempotency_key = ?) > 0`,
    params: [entry.idempotencyKey],
  };
  const dependent = buildDependent(charged);
  const all = [...spend, ...dependent];
  let results: Array<{ meta?: { changes?: number } }>;
  try {
    results = (await db.batch(bindAll(db, all))) as Array<{ meta?: { changes?: number } }>;
  } catch (error) {
    if (isDuplicateTransactionError(error)) {
      const existing = await findTransactionByIdempotencyKey(db, entry.idempotencyKey);
      const account = await getCoinAccount(db, entry.participantHash);
      return { applied: true, duplicate: true, balance: account?.balance ?? 0, transactionId: existing?.id ?? null };
    }
    throw error;
  }
  // spend[1]（受守卫的流水 INSERT）生效行数即"余额充足且已扣款"。
  const applied = Number(results[1]?.meta?.changes ?? 0) > 0;
  const account = await getCoinAccount(db, entry.participantHash);
  return { applied, duplicate: false, balance: account?.balance ?? 0, transactionId: null };
}

/** 判断 batch 失败是否由幂等键唯一约束导致（重复请求）。 */
export function isDuplicateTransactionError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error ?? "");
  return /UNIQUE constraint failed.*idempotency_key|constraint failed.*coin_transactions/i.test(message);
}

/** 按幂等键查既有流水（重复请求的幂等返回依据）。 */
export async function findTransactionByIdempotencyKey(
  db: D1Database,
  idempotencyKey: string,
): Promise<{ id: number; amount: number; balance_after: number; created_at: string } | null> {
  return db
    .prepare(`SELECT id, amount, balance_after, created_at FROM coin_transactions WHERE idempotency_key = ?`)
    .bind(idempotencyKey)
    .first();
}

/** 独立入账（签到/挑战奖励等没有额外业务行的场景）。 */
export async function earnCoins(
  db: D1Database,
  input: LedgerEntryInput,
): Promise<{ transactionId: number; balance: number; duplicate: boolean }> {
  const now = new Date().toISOString();
  const statements = bindAll(db, describeEarnStatements(input, now));
  try {
    await db.batch(statements);
  } catch (error) {
    if (isDuplicateTransactionError(error)) {
      const existing = await findTransactionByIdempotencyKey(db, input.idempotencyKey);
      if (existing) {
        const account = await getCoinAccount(db, input.participantHash);
        return {
          transactionId: existing.id,
          balance: account?.balance ?? Number(existing.balance_after),
          duplicate: true,
        };
      }
    }
    throw error;
  }
  const existing = await findTransactionByIdempotencyKey(db, input.idempotencyKey);
  const account = await getCoinAccount(db, input.participantHash);
  return { transactionId: existing?.id ?? 0, balance: account?.balance ?? 0, duplicate: false };
}

export { bindAll };
