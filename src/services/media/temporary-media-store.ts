import type { MediaStorageKind } from "../../db/schema";

export interface TemporaryMediaPutInput {
  storageKey: string;
  bytes: Uint8Array;
  contentType: string;
  /** KV TTL in seconds. Unset means "keep until explicitly deleted". */
  expirationTtl?: number;
}

/**
 * Storage seam for transient response media. Business code depends on this
 * interface only; the concrete provider (KV today, R2 later) is injected.
 */
export interface TemporaryMediaStore {
  readonly kind: MediaStorageKind;
  put(input: TemporaryMediaPutInput): Promise<void>;
  get(storageKey: string): Promise<Uint8Array | null>;
  delete(storageKey: string): Promise<void>;
}

export class KVMediaStore implements TemporaryMediaStore {
  readonly kind = "temporary" as const;

  constructor(private readonly kv: KVNamespace) {}

  async put(input: TemporaryMediaPutInput): Promise<void> {
    await this.kv.put(input.storageKey, input.bytes, {
      ...(input.expirationTtl !== undefined ? { expirationTtl: input.expirationTtl } : {}),
    });
  }

  async get(storageKey: string): Promise<Uint8Array | null> {
    const value = await this.kv.get(storageKey, "arrayBuffer");
    return value === null ? null : new Uint8Array(value);
  }

  async delete(storageKey: string): Promise<void> {
    await this.kv.delete(storageKey);
  }
}

/**
 * R2 backends carry no per-object TTL, so the expiry contract is different
 * from KV: temporary blobs rely on (a) D1 `expires_at` semantics and the daily
 * cleanup sweep, plus (b) an optional bucket lifecycle rule on the
 * `media:temp/` prefix as the orphan backstop KV gets natively. Both live in
 * operations config, not in this class.
 */
export class R2MediaStore implements TemporaryMediaStore {
  readonly kind = "temporary" as const;

  constructor(private readonly bucket: R2Bucket) {}

  async put(input: TemporaryMediaPutInput): Promise<void> {
    await this.bucket.put(input.storageKey, input.bytes);
  }

  async get(storageKey: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(storageKey);
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
  }

  async delete(storageKey: string): Promise<void> {
    await this.bucket.delete(storageKey);
  }
}

/**
 * R2 primary with KV fallback for reads and deletes.
 *
 * `kind` stays "temporary" on purpose: survey rows keep `storage_kind
 * = 'temporary'` and several repository queries hard-code that value for the
 * retention/promotion sweeps — introducing an "r2" row kind would silently
 * hide blobs from them. The tiering also makes backend migration self-healing:
 * a deployment that binds R2 later still reads its old KV blobs, and promotion
 * (read → put durable key → delete temp) moves blobs across backends via the
 * same two calls it already makes.
 */
export class TieredMediaStore implements TemporaryMediaStore {
  readonly kind = "temporary" as const;

  constructor(
    private readonly primary: TemporaryMediaStore,
    private readonly fallback: TemporaryMediaStore,
  ) {}

  async put(input: TemporaryMediaPutInput): Promise<void> {
    await this.primary.put(input);
  }

  async get(storageKey: string): Promise<Uint8Array | null> {
    return (await this.primary.get(storageKey)) ?? (await this.fallback.get(storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    // Mixed-era keys can live in either backend; clear both, best effort.
    await Promise.allSettled([this.primary.delete(storageKey), this.fallback.delete(storageKey)]);
  }
}

/** Minimal env slice so the factory stays testable without the full Env type. */
export interface MediaStoreEnvSlice {
  MEDIA?: R2Bucket | undefined;
  MEDIA_KV?: KVNamespace | undefined;
}

/**
 * The one constructor business code should call: R2-tiered when the MEDIA
 * binding exists, plain KV otherwise (free deployments, unchanged behavior).
 */
export function createMediaStore(env: MediaStoreEnvSlice): TemporaryMediaStore {
  if (env.MEDIA) {
    return new TieredMediaStore(new R2MediaStore(env.MEDIA), new KVMediaStore(env.MEDIA_KV as KVNamespace));
  }
  return new KVMediaStore(env.MEDIA_KV as KVNamespace);
}
