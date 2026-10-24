import { nowIso } from "../db/client";
import { bindAll, describeEarnStatements, isDuplicateTransactionError } from "./coin/ledger.service";

/**
 * 身份统一（0082）：participant_hash 映射与读侧并集。
 *
 * participant_hash 是明文前缀串（`user_{id}` / `email_{id}` / `web_{key}`），
 * 全部历史数据以它为键。统一不搬数据：映射表把 source hash 指向 canonical，
 * 写侧归一（resolveParticipant 返回 canonical）、读侧并集（hashesFor）。
 *
 * canonical 只能是人：`user_{users.id}`，或尚未绑定 user 的 `email_{accountId}`。
 * `web_*` 匿名 key 永远是 source。
 */

export type IdentityLinkMethod = "email_claim" | "tg_deep_link" | "admin";

export interface HashLinkRow {
  sourceHash: string;
  canonicalHash: string;
  method: string;
}

/** `user_*` 前缀本身就是人，映射表里永远不会作为 source 出现——零查询直通。 */
export function isCanonicalOnlyHash(hash: string): boolean {
  return hash.startsWith("user_");
}

/**
 * canonical 化：web/email hash 查映射（KV 负缓存 5 分钟——resolveParticipant
 * 在每个请求上运行，未绑定用户的稳态成本必须是一次 KV 读而不是一次 D1 读）。
 */
export async function canonicalizeHash(db: D1Database, cache: KVNamespace | undefined, hash: string): Promise<string> {
  if (isCanonicalOnlyHash(hash)) return hash;
  const cacheKey = `idlink:v1:${hash}`;
  if (cache) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) return cached === "-" ? hash : cached;
    } catch {
      // 缓存读失败按未命中处理。
    }
  }
  const row = await db
    .prepare("SELECT canonical_hash FROM participant_hash_links WHERE source_hash = ? LIMIT 1")
    .bind(hash)
    .first<{ canonical_hash: string }>();
  const canonical = row?.canonical_hash ?? null;
  if (cache) {
    try {
      await cache.put(cacheKey, canonical ?? "-", { expirationTtl: 300 });
    } catch {
      // 缓存写失败只影响接下来的几秒钟。
    }
  }
  return canonical ?? hash;
}

/**
 * 读侧并集：canonical + 指向它的全部 source。历史行原地不动，
 * `WHERE participant_hash IN (...)` 一次覆盖绑定前后的全部数据。
 */
export async function hashesFor(db: D1Database, hash: string): Promise<string[]> {
  if (isCanonicalOnlyHash(hash)) {
    const rows = await db
      .prepare("SELECT source_hash FROM participant_hash_links WHERE canonical_hash = ?")
      .bind(hash)
      .all<{ source_hash: string }>();
    return [hash, ...(rows.results ?? []).map((row) => row.source_hash)];
  }
  // hash 本身是 source：映射到 canonical 后再展开。
  const row = await db
    .prepare("SELECT canonical_hash FROM participant_hash_links WHERE source_hash = ? LIMIT 1")
    .bind(hash)
    .first<{ canonical_hash: string }>();
  if (!row) return [hash];
  const rows = await db
    .prepare("SELECT source_hash FROM participant_hash_links WHERE canonical_hash = ?")
    .bind(row.canonical_hash)
    .all<{ source_hash: string }>();
  return [row.canonical_hash, ...(rows.results ?? []).map((r) => r.source_hash)];
}

/**
 * 应用层并集：hashesFor 的占位符形态，给无法用 HASH_SET_SQL 子查询的调用方
 * （需要先知道集合大小做分页/聚合的查询）。
 */
export async function hashSetFor(db: D1Database, hash: string): Promise<{ sql: string; params: string[] }> {
  const hashes = await hashesFor(db, hash);
  return { sql: `IN (${hashes.map(() => "?").join(",")})`, params: hashes };
}

/**
 * SQL 侧并集片段：`participant_hash <fragment>` 直接在原查询里覆盖
 * canonical + 全部 source——归属检查不加往返（折叠路径的关键约束），
 * D1 侧多读的只是 0-2 行映射。用法：
 *   `WHERE survey_id = ? AND participant_hash ${hashSetSql} ` + bind(canonical, canonical)
 */
export const HASH_SET_SQL =
  "IN (SELECT source_hash FROM participant_hash_links WHERE canonical_hash = ? UNION SELECT ?)";

function invalidateLinkCache(cache: KVNamespace | undefined, sourceHash: string): void {
  if (!cache) return;
  cache.delete(`idlink:v1:${sourceHash}`).catch(() => undefined);
}

/**
 * 建立映射。已存在的同 source 映射会被覆盖（例如邮箱账户后来绑定了 user，
 * canonical 从 `email_{id}` 升级为 `user_{id}` 时，老映射整体重指向）。
 * 禁止把 `user_*` 设为 source，禁止自映射。
 */
export async function linkHash(
  db: D1Database,
  cache: KVNamespace | undefined,
  input: { sourceHash: string; canonicalHash: string; method: IdentityLinkMethod },
): Promise<void> {
  if (isCanonicalOnlyHash(input.sourceHash)) {
    throw new Error("user_* hashes are canonical and cannot be linked as a source");
  }
  if (input.sourceHash === input.canonicalHash) return;
  const timestamp = nowIso();
  await db
    .prepare(
      `INSERT INTO participant_hash_links (source_hash, canonical_hash, method, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_hash) DO UPDATE SET
         canonical_hash = excluded.canonical_hash,
         method = excluded.method,
         updated_at = excluded.updated_at`,
    )
    .bind(input.sourceHash, input.canonicalHash, input.method, timestamp, timestamp)
    .run();
  invalidateLinkCache(cache, input.sourceHash);
}

export async function unlinkHash(db: D1Database, cache: KVNamespace | undefined, sourceHash: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM participant_hash_links WHERE source_hash = ?").bind(sourceHash).run();
  invalidateLinkCache(cache, sourceHash);
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * 认领：把一个匿名浏览器 key 并入某个 canonical（邮箱登录自动认领 / bot
 * 深链认领共用）。映射 + 金币合并两步；金币合并有幂等键保护，重复调用安全。
 */
export async function claimParticipantKey(
  db: D1Database,
  cache: KVNamespace | undefined,
  input: { participantKey: string; canonicalHash: string; userId: number | null; method: IdentityLinkMethod },
): Promise<void> {
  const sourceHash = `web_${input.participantKey}`;
  if (sourceHash === input.canonicalHash) return;
  await linkHash(db, cache, { sourceHash, canonicalHash: input.canonicalHash, method: input.method });
  await mergeCoinAccount(db, { sourceHash, canonicalHash: input.canonicalHash, userId: input.userId });
  // 年龄确认跟着人走：匿名时确认过、认领后不再重复弹门（canonical 已有自己的
  // 确认时不动；source 的行删除，数据归一到 canonical 视图）。
  await db
    .prepare(
      `UPDATE participant_preferences SET participant_hash = ?, updated_at = ?
       WHERE participant_hash = ?
         AND NOT EXISTS (SELECT 1 FROM participant_preferences WHERE participant_hash = ?)`,
    )
    .bind(input.canonicalHash, nowIso(), sourceHash, input.canonicalHash)
    .run()
    .catch(() => undefined);
}

/**
 * 邮箱账号 ↔ users 行（Web 原生身份的地基）。
 *
 * 树洞发帖、挑战排行榜等一切按 users.id 归属的功能都要求真实用户行；邮箱
 * 注册时同步创建（合成 telegram id 段 10^12+accountId，与真实 TG id 段隔离），
 * 并把 email_{accountId} 映射到 user_{id}——0082 之后三种身份的 canonical
 * 由此统一为「人」。幂等：已有 user 行的账号只补映射行。
 */
export async function ensureEmailAccountUser(
  db: D1Database,
  cache: KVNamespace | undefined,
  account: { id: number; userId: number | null },
): Promise<number> {
  const emailHash = `email_${account.id}`;
  if (account.userId !== null) {
    await linkHash(db, cache, {
      sourceHash: emailHash,
      canonicalHash: `user_${account.userId}`,
      method: "email_claim",
    }).catch(() => undefined);
    return account.userId;
  }
  const { upsertUser } = await import("../db/repositories/user.repository");
  const { bindEmailAccountUser } = await import("../db/repositories/email-account.repository");
  const user = await upsertUser(db, {
    telegramUserId: 1_000_000_000_000 + account.id,
    firstName: null,
    systemRole: "participant",
  });
  await bindEmailAccountUser(db, account.id, user.id);
  await linkHash(db, cache, {
    sourceHash: emailHash,
    canonicalHash: `user_${user.id}`,
    method: "email_claim",
  }).catch(() => undefined);
  return user.id;
}

/** 某个 canonical（或其视角）名下的全部已链接 source 数。 */
export async function countLinkedSources(db: D1Database, canonicalHash: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM participant_hash_links WHERE canonical_hash = ?")
    .bind(canonicalHash)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * 金币合并：把 source 账户的余额整笔搬进 canonical，作为一笔幂等 merge 交易。
 *
 * - 流水不搬：coin_transactions 是 append-only 事实源，两边的历史流水保持原位，
 *   余额与 total_earned 的变动由这一笔 merge_in 流水表达。
 * - 幂等键 `merge:{sourceHash}`：同一 source 只被吸收一次。解绑后重新绑定不再
 *   触发转移（重复键整批回滚，捕获后按已合并处理）——余额不能靠反复绑定刷出来。
 * - 原子性：source 清零（带余额守卫）与 canonical 入账在同一个 D1 batch 里，
 *   要么同时生效要么同时回滚。
 *
 * 返回 transferred 金币数（0 表示没有账户/余额为零/重复合并）。
 */
export async function mergeCoinAccount(
  db: D1Database,
  input: { sourceHash: string; canonicalHash: string; userId: number | null },
): Promise<{ transferred: number; duplicate: boolean }> {
  const { sourceHash, canonicalHash } = input;
  if (sourceHash === canonicalHash) return { transferred: 0, duplicate: false };
  const source = await db
    .prepare("SELECT balance FROM coin_accounts WHERE participant_hash = ?")
    .bind(sourceHash)
    .first<{ balance: number }>();
  const amount = Math.floor(Number(source?.balance ?? 0));
  const now = new Date().toISOString();
  const idempotencyKey = `merge:${sourceHash}`;
  const statements: D1PreparedStatement[] = [];
  if (amount > 0) {
    statements.push(
      db
        .prepare(
          `UPDATE coin_accounts SET balance = 0, updated_at = ?
           WHERE participant_hash = ? AND balance = ?`,
        )
        .bind(now, sourceHash, amount),
    );
  }
  if (amount > 0) {
    statements.push(
      ...bindAll(
        db,
        describeEarnStatements(
          {
            participantHash: canonicalHash,
            userId: input.userId,
            amount,
            kind: "merge_in",
            idempotencyKey,
            refType: "identity_merge",
            refId: sourceHash,
            note: `身份合并：${sourceHash} → ${canonicalHash}`,
          },
          now,
        ),
      ),
    );
  } else {
    // 余额为零也要留一行 merge 流水占住幂等键，防止将来 source 又有进账时
    // 重新绑定把那笔钱吸走（应留在原视图，由并集查询呈现）。
    statements.push(
      db
        .prepare(
          `INSERT INTO coin_accounts (participant_hash, user_id, balance, total_earned, total_spent, created_at, updated_at)
           VALUES (?, ?, 0, 0, 0, ?, ?) ON CONFLICT(participant_hash) DO NOTHING`,
        )
        .bind(canonicalHash, input.userId, now, now),
      db
        .prepare(
          `INSERT INTO coin_transactions
             (participant_hash, amount, balance_after, kind, ref_type, ref_id, idempotency_key, note, created_by, created_at)
           VALUES (?, 0, (SELECT COALESCE(balance, 0) FROM coin_accounts WHERE participant_hash = ?),
                   'merge_in', 'identity_merge', ?, ?, ?, 'system', ?)`,
        )
        .bind(canonicalHash, canonicalHash, sourceHash, idempotencyKey, `身份合并（零余额）：${sourceHash}`, now),
    );
  }
  try {
    await db.batch(statements);
  } catch (error) {
    if (isDuplicateTransactionError(error)) {
      return { transferred: 0, duplicate: true };
    }
    throw error;
  }
  return { transferred: amount, duplicate: false };
}
