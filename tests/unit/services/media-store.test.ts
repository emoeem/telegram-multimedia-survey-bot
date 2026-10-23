import { describe, expect, it } from "vitest";

import {
  createMediaStore,
  KVMediaStore,
  R2MediaStore,
  TieredMediaStore,
  type TemporaryMediaPutInput,
  type TemporaryMediaStore,
} from "../../../src/services/media/temporary-media-store";

function kvStub() {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    get: async (key: string, type: "arrayBuffer") => (map.has(key) ? (map.get(key) as Uint8Array).buffer : null),
    put: async (key: string, value: Uint8Array) => void map.set(key, value),
    delete: async (key: string) => void map.delete(key),
  } as unknown as KVNamespace & { map: Map<string, Uint8Array> };
}

function r2Stub() {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    get: async (key: string) => {
      const bytes = map.get(key);
      return bytes ? { arrayBuffer: async () => bytes.buffer } : null;
    },
    put: async (key: string, value: Uint8Array) => void map.set(key, value),
    delete: async (key: string) => void map.delete(key),
  } as unknown as R2Bucket & { map: Map<string, Uint8Array> };
}

const blob = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

async function put(store: TemporaryMediaStore, key: string, text: string): Promise<TemporaryMediaPutInput> {
  const input: TemporaryMediaPutInput = { storageKey: key, bytes: blob(text), contentType: "image/png" };
  await store.put(input);
  return input;
}

describe("createMediaStore", () => {
  it("未绑定 R2 时返回纯 KV store（免费部署行为不变）", async () => {
    const kv = kvStub();
    const store = createMediaStore({ MEDIA_KV: kv });
    expect(store).toBeInstanceOf(KVMediaStore);
    expect(store.kind).toBe("temporary");
    await put(store, "media:temp:1:a", "kv");
    expect(kv.map.has("media:temp:1:a")).toBe(true);
    expect(new TextDecoder().decode((await store.get("media:temp:1:a")) as Uint8Array)).toBe("kv");
  });

  it("绑定 R2 时返回分层 store：写入进 R2，读取 R2 未命中回落 KV", async () => {
    const kv = kvStub();
    const r2 = r2Stub();
    const store = createMediaStore({ MEDIA: r2, MEDIA_KV: kv });
    expect(store).toBeInstanceOf(TieredMediaStore);
    // 行上永远写 storage_kind='temporary'（多个仓储查询按它筛选，见模块注释）。
    expect(store.kind).toBe("temporary");

    await put(store, "media:temp:2:b", "r2-new");
    expect(r2.map.has("media:temp:2:b")).toBe(true);
    expect(kv.map.has("media:temp:2:b")).toBe(false);

    // 旧数据留在 KV：迁移后依然可读（自愈式后端切换）。
    kv.map.set("media:temp:3:c", blob("kv-legacy"));
    expect(new TextDecoder().decode((await store.get("media:temp:3:c")) as Uint8Array)).toBe("kv-legacy");
    expect(new TextDecoder().decode((await store.get("media:temp:2:b")) as Uint8Array)).toBe("r2-new");
  });

  it("分层删除清空两个后端（混合年代数据都能清掉）", async () => {
    const kv = kvStub();
    const r2 = r2Stub();
    const store = createMediaStore({ MEDIA: r2, MEDIA_KV: kv });
    kv.map.set("k-old", blob("x"));
    await put(store, "k-new", "y");
    await store.delete("k-old");
    await store.delete("k-new");
    expect(kv.map.has("k-old")).toBe(false);
    expect(r2.map.has("k-new")).toBe(false);
  });

  it("R2MediaStore 可独立使用", async () => {
    const r2 = r2Stub();
    const store = new R2MediaStore(r2);
    await put(store, "a", "b");
    expect(new TextDecoder().decode((await store.get("a")) as Uint8Array)).toBe("b");
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
  });
});
