/**
 * Atomic fixed-window rate limiting.
 *
 * Why this exists: the KV-backed limiter in `services/rate-limit.service.ts`
 * reads a counter, increments it in the Worker, then writes it back. KV allows
 * only ONE write per key per second, so two requests arriving together both
 * read the same value and both write the same increment — one of them is lost.
 * Under the email-auth flow that is not theoretical: a single login issues two
 * limiter writes (per-email and per-IP), and the per-IP key is shared by
 * everyone behind that address.
 *
 * A Durable Object serialises every request through one instance, so the
 * read-increment-write below cannot interleave. That is the entire point of
 * moving it here; the KV write-quota saving is a side effect.
 *
 * Sharding: the caller passes a `scope` (e.g. `register`, `email-auth-ip`) and
 * we derive the instance name from it. Two different scopes never contend with
 * each other, and a given scope always lands on the same instance — which is
 * exactly the consistency guarantee the counter needs, no more.
 */
import { DurableObject } from "cloudflare:workers";

/** A single limiter subject's window state. */
interface WindowCounter {
  count: number;
  /** Epoch ms at which the current fixed window started. */
  windowStart: number;
}

export interface RateLimitRequest {
  /**
   * Allow-listed bucket label (`register`, `reset`, `email-auth-ip`, …).
   * Included in the storage key, not just the shard name: correctness must not
   * depend on two scopes happening to land on different instances.
   */
  scope: string;
  /** Already-hashed subject: the DO must never see a raw email or IP. */
  subject: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  count: number;
  /** Seconds until the window rolls over, for Retry-After. */
  retryAfterSeconds: number;
}

const COUNTER_PREFIX = "rl:";
/** How long a stale counter is kept before the alarm sweeps it. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export class RateLimitDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let body: RateLimitRequest;
    try {
      body = (await request.json()) as RateLimitRequest;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const { scope, subject, limit, windowSeconds } = body;
    if (typeof scope !== "string" || !scope || typeof subject !== "string" || !subject) {
      return Response.json({ error: "invalid_params" }, { status: 400 });
    }
    if (limit <= 0 || windowSeconds <= 0) {
      return Response.json({ error: "invalid_params" }, { status: 400 });
    }

    const decision = await this.consume(scope, subject, limit, windowSeconds);
    return Response.json(decision);
  }

  /**
   * The critical section. Durable Object requests are strictly serialised by
   * the runtime, so the read and the write below cannot be interleaved by a
   * concurrent request — which is the whole reason this lives in a DO.
   */
  private async consume(
    scope: string,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));

    const storageKey = `${COUNTER_PREFIX}${scope}:${subject}`;
    const existing = await this.ctx.storage.get<WindowCounter>(storageKey);

    // A counter from an earlier window is simply replaced: this is a fixed
    // window, not a sliding one, so the reset is intentional.
    const count = existing && existing.windowStart === windowStart ? existing.count + 1 : 1;
    const allowed = count <= limit;

    // Even a rejected request persists its counter, so a caller hammering past
    // the limit cannot reset their own window by being refused.
    await this.ctx.storage.put(storageKey, { count, windowStart } satisfies WindowCounter);
    await this.ensureSweep();

    return { allowed, count, retryAfterSeconds };
  }

  /** Arm the sweeper once; repeated calls within the interval are no-ops. */
  private async ensureSweep(): Promise<void> {
    const next = await this.ctx.storage.getAlarm();
    if (next === null) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }

  /**
   * Drop counters whose window has long passed. Without this the instance's
   * storage would grow with one entry per distinct subject forever.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    const stale: string[] = [];
    // 24h is comfortably longer than any window we use (1h max), so anything
    // older is definitively dead.
    const cutoff = now - 24 * 60 * 60 * 1000;

    for (const [key, value] of await this.ctx.storage.list<WindowCounter>({ prefix: COUNTER_PREFIX })) {
      if (!value || typeof value.windowStart !== "number" || value.windowStart < cutoff) {
        stale.push(key);
      }
    }

    if (stale.length > 0) {
      await this.ctx.storage.delete(stale);
    }

    // Re-arm only while there is still something to sweep; an idle instance
    // should not keep waking up forever.
    const remaining = await this.ctx.storage.list({ prefix: COUNTER_PREFIX, limit: 1 });
    if (remaining.size > 0) {
      await this.ctx.storage.setAlarm(now + SWEEP_INTERVAL_MS);
    }
  }
}
