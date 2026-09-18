/**
 * Telegram webhook update idempotency.
 *
 * Telegram redelivers an update when the webhook did not answer in time (slow
 * D1, a deploy, a network blip). Because every handler here ends in a 200 so
 * that Telegram stops retrying, a redelivery before that ack used to run the
 * whole action a second time: a second "publish" snapshot, a second plaza
 * card, a second render job, a double reward. `update_id` is unique per bot
 * and identical across redeliveries, so it is the natural idempotency key.
 *
 * The flow is claim → handle → complete:
 *   * the claim is one INSERT ... ON CONFLICT DO UPDATE ... WHERE (one write,
 *     no read) that also atomically takes over a stale in-flight claim;
 *   * a redelivery of a *completed* update is skipped;
 *   * a failure releases the claim so a genuine Telegram retry can re-run it;
 *   * a Worker eviction between claim and completion leaves a `processing`
 *     row that a later redelivery may reclaim after STALE_CLAIM_MS, so a
 *     crashed attempt can never permanently swallow the update.
 *
 * Storage is deliberately optional: when migration 0052 has not been applied
 * yet, every call fails open (the update is processed) instead of dropping
 * user actions.
 */

/** How long a completed (or abandoned) claim row is kept before pruning. */
export const UPDATE_DEDUP_RETENTION_DAYS = 7;

/**
 * How long a `processing` claim may sit untouched before a redelivery is
 * allowed to take it over. Telegram redelivers within minutes, so anything
 * older than this is a dead attempt rather than a concurrent one.
 */
export const STALE_CLAIM_MS = 5 * 60 * 1000;

export interface UpdateDedupStore {
  /** Atomically claims an update. Returns false when it was already claimed. */
  claim(updateId: number): Promise<boolean>;
  /** Marks a claimed update as successfully handled. */
  complete(updateId: number): Promise<void>;
  /** Drops a claim after a failure so a Telegram retry can re-run the update. */
  release(updateId: number): Promise<void>;
}

function isValidUpdateId(updateId: number): boolean {
  return Number.isInteger(updateId) && updateId > 0;
}

/**
 * Builds a D1-backed idempotency store.
 *
 * A successful update costs two statements: the claim and the `status = 'done'`
 * update. The row doubles as the dedup record that the daily maintenance sweep
 * prunes after {@link UPDATE_DEDUP_RETENTION_DAYS}.
 */
export function createUpdateDedupStore(db: D1Database, now: () => string = () => new Date().toISOString()): UpdateDedupStore {
  // Flipped off the first time the 0053 `status` column turns out to be
  // missing, so a Worker deployed before its migration neither logs nor pays
  // for a failing statement on every update.
  let hasStatusColumn = true;

  return {
    async claim(updateId: number): Promise<boolean> {
      if (!isValidUpdateId(updateId)) return true;
      const receivedAt = now();
      const staleCutoff = new Date(Date.parse(receivedAt) - STALE_CLAIM_MS).toISOString();
      if (hasStatusColumn) {
        try {
          const result = await db
            .prepare(
              `INSERT INTO telegram_update_dedup (update_id, received_at, status)
               VALUES (?1, ?2, 'processing')
               ON CONFLICT(update_id) DO UPDATE SET received_at = ?2, status = 'processing'
               WHERE telegram_update_dedup.status <> 'done'
                 AND telegram_update_dedup.received_at <= ?3`,
            )
            .bind(updateId, receivedAt, staleCutoff)
            .run();
          return (result.meta?.changes ?? 0) > 0;
        } catch (error) {
          // The status column arrived in migration 0053. Until it is applied,
          // fall back to the 0052 claim so dedup keeps working across a deploy
          // that ships the Worker before the migration.
          hasStatusColumn = false;
          console.warn("Update dedup status column unavailable; using legacy claim", { error });
        }
      }
      try {
        const legacy = await db
          .prepare(
            `INSERT INTO telegram_update_dedup (update_id, received_at)
             VALUES (?, ?)
             ON CONFLICT(update_id) DO NOTHING`,
          )
          .bind(updateId, receivedAt)
          .run();
        return (legacy.meta?.changes ?? 0) > 0;
      } catch (error) {
        // Fail open: a missing table (migration pending) or a transient D1
        // problem must not swallow the user's action.
        console.warn("Update dedup claim failed; processing anyway", { updateId, error });
        return true;
      }
    },
    async complete(updateId: number): Promise<void> {
      if (!isValidUpdateId(updateId)) return;
      // With the 0052 schema alone the claim row is already the handled marker.
      if (!hasStatusColumn) return;
      try {
        await db
          .prepare(
            `UPDATE telegram_update_dedup
             SET status = 'done', received_at = ?
             WHERE update_id = ? AND status <> 'done'`,
          )
          .bind(now(), updateId)
          .run();
      } catch (error) {
        // A missing status column (0053 pending) still leaves the 0052 claim
        // row in place, which is the previous "handled" marker. Never let a
        // completion bookkeeping failure surface as a failed user action.
        console.warn("Update dedup complete failed", { updateId, error });
      }
    },
    async release(updateId: number): Promise<void> {
      if (!isValidUpdateId(updateId)) return;
      if (!hasStatusColumn) {
        try {
          await db.prepare("DELETE FROM telegram_update_dedup WHERE update_id = ?").bind(updateId).run();
        } catch (error) {
          console.warn("Update dedup release failed", { updateId, error });
        }
        return;
      }
      try {
        await db
          .prepare("DELETE FROM telegram_update_dedup WHERE update_id = ? AND status <> 'done'")
          .bind(updateId)
          .run();
      } catch (error) {
        hasStatusColumn = false;
        try {
          await db.prepare("DELETE FROM telegram_update_dedup WHERE update_id = ?").bind(updateId).run();
        } catch (legacyError) {
          console.warn("Update dedup release failed", { updateId, error, legacyError });
        }
      }
    },
  };
}

/**
 * In-memory store used by tests and by callers that have no D1 handle.
 * Single-isolate only, which is fine for local development.
 */
export function createMemoryUpdateDedupStore(): UpdateDedupStore {
  const claimed = new Map<number, "processing" | "done">();
  return {
    async claim(updateId: number): Promise<boolean> {
      if (!isValidUpdateId(updateId)) return true;
      if (claimed.has(updateId)) return false;
      claimed.set(updateId, "processing");
      return true;
    },
    async complete(updateId: number): Promise<void> {
      if (!isValidUpdateId(updateId)) return;
      claimed.set(updateId, "done");
    },
    async release(updateId: number): Promise<void> {
      if (claimed.get(updateId) !== "done") claimed.delete(updateId);
    },
  };
}

/** Deletes dedup rows older than the retention window (daily maintenance). */
export function telegramUpdateDedupCutoff(days = UPDATE_DEDUP_RETENTION_DAYS, now = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString();
}
