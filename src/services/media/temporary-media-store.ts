import type { MediaStorageKind } from "../../db/schema";

export interface TemporaryMediaPutInput {
  storageKey: string;
  bytes: Uint8Array;
  contentType: string;
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
    await this.kv.put(input.storageKey, input.bytes);
  }

  async get(storageKey: string): Promise<Uint8Array | null> {
    const value = await this.kv.get(storageKey, "arrayBuffer");
    return value === null ? null : new Uint8Array(value);
  }

  async delete(storageKey: string): Promise<void> {
    await this.kv.delete(storageKey);
  }
}
