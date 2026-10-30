import { describe, expect, it, vi } from "vitest";
import {
  CERT_SHARE_LEGACY_CONSENT_HEADER,
  CERT_SHARE_ORIGIN_HEADER,
  CERT_SHARE_ORIGIN_VALUE,
  CERT_SHARE_PATH,
  certShareChannel,
  handleCertShare,
  resolveCertShareChannel,
  type CertShareEnv,
  type CertShareSender,
} from "../../../src/http/cert-share";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];

function imageBytes(head: number[], size = 128): Uint8Array {
  const out = new Uint8Array(size);
  out.set(head);
  return out;
}

function fakeCache(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

interface Recorded {
  albums: Array<{ chatId: number; photos: Array<{ bytes: Uint8Array; caption?: string; type?: string }> }>;
  singles: Array<{ chatId: number; bytes: Uint8Array; caption?: string; type?: string }>;
}

function fakeSender(recorded: Recorded, failure?: Error): CertShareSender {
  return {
    async album(chatId, photos) {
      if (failure) throw failure;
      recorded.albums.push({ chatId, photos });
    },
    async single(chatId, bytes, caption, type) {
      if (failure) throw failure;
      /* exactOptionalPropertyTypes: 缺省时不能显式写 undefined */
      recorded.singles.push({
        chatId,
        bytes,
        ...(caption === undefined ? {} : { caption }),
        ...(type === undefined ? {} : { type }),
      });
    },
  };
}

/** noUncheckedIndexedAccess 下取首元素不能直接下标 */
function first<T>(list: T[]): T {
  const value = list[0];
  if (value === undefined) throw new Error("期望至少有一个元素");
  return value;
}

/**
 * 每个测试要独立一份 CACHE：限流计数器是按 IP 分桶存在 KV 里的，
 * 共用一份会让前面的用例把后面的用例挡在 429 里（这就是第一版踩到的坑）。
 */
function enabledEnv(): CertShareEnv {
  return { BOT_TOKEN: "test-token", CACHE: fakeCache(), REPORT_CHANNEL_ID: "-1004489719605" };
}

function buildForm(options: { card?: Uint8Array | null; sources?: Uint8Array[]; meta?: unknown } = {}) {
  const form = new FormData();
  const card = options.card === null ? undefined : (options.card ?? imageBytes(PNG_HEAD));
  if (card) form.append("card", new File([card], "card.png", { type: "image/png" }));
  (options.sources ?? []).forEach((bytes, index) => {
    form.append(`source${index}`, new File([bytes], `source-${index}.png`, { type: "image/png" }));
  });
  if (options.meta !== undefined) form.append("meta", JSON.stringify(options.meta));
  return form;
}

type OriginHeader = "app" | "legacy" | "none";

function postRequest(form: FormData, origin: OriginHeader = "app"): Request {
  const headers: Record<string, string> =
    origin === "app"
      ? { [CERT_SHARE_ORIGIN_HEADER]: CERT_SHARE_ORIGIN_VALUE }
      : origin === "legacy"
        ? { [CERT_SHARE_LEGACY_CONSENT_HEADER]: "yes" }
        : {};
  return new Request(`https://example.test${CERT_SHARE_PATH}`, {
    method: "POST",
    headers,
    body: form,
  });
}

const CLIENT = { clientKey: "203.0.113.7" };

describe("certShareChannel", () => {
  it("未配置任何频道时关闭", () => {
    expect(certShareChannel({})).toBeNull();
    expect(certShareChannel({ REPORT_CHANNEL_ID: "  " })).toBeNull();
  });

  it("CERT_SHARE_DISABLED=true 优先于已配置的频道", () => {
    expect(
      certShareChannel({
        CERT_SHARE_CHANNEL: "-1001",
        REPORT_CHANNEL_ID: "-1002",
        CERT_SHARE_DISABLED: "true",
      }),
    ).toBeNull();
  });

  it("专用频道优先于回落频道", () => {
    expect(certShareChannel({ CERT_SHARE_CHANNEL: "-1001", REPORT_CHANNEL_ID: "-1002" })).toBe(-1001);
    expect(certShareChannel({ REPORT_CHANNEL_ID: "-1002" })).toBe(-1002);
  });

  it("拒绝无法转成安全整数的频道标识（如 @username）", () => {
    expect(certShareChannel({ CERT_SHARE_CHANNEL: "@my_channel" })).toBeNull();
    expect(certShareChannel({ CERT_SHARE_CHANNEL: "0" })).toBeNull();
  });
});

/**
 * 只实现 resolveReportChannel / resolveCertShareChannel 需要的那一条查询：
 * `SELECT value FROM system_settings WHERE key = ? LIMIT 1`。
 * 不实现完整 D1 —— 这里要验证的是解析优先级，不是 SQL 引擎。
 */
function fakeDb(settings: Record<string, string>): D1Database {
  return {
    prepare() {
      return {
        bind(...args: unknown[]) {
          const key = String(args[0]);
          return {
            async first() {
              return key in settings ? { value: settings[key] } : null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("resolveCertShareChannel", () => {
  it("什么都没配时关闭", async () => {
    expect(await resolveCertShareChannel({ DB: fakeDb({}) })).toBeNull();
  });

  it("系统设置 cert_share_channel_id 优先于环境变量与归档频道", async () => {
    const resolved = await resolveCertShareChannel({
      DB: fakeDb({ cert_share_channel_id: "-1009", report_channel_id: "-1008" }),
      CERT_SHARE_CHANNEL: "-1001",
    });
    expect(resolved).toEqual({ chatId: -1009, source: "settings" });
  });

  it("未单独配置时继承报告归档频道（这就是 -1004489719605 那一档）", async () => {
    const resolved = await resolveCertShareChannel({
      DB: fakeDb({ report_channel_id: "-1004489719605" }),
    });
    expect(resolved).toEqual({ chatId: -1004489719605, source: "archive" });
  });

  it("环境变量 CERT_SHARE_CHANNEL 优先于归档频道", async () => {
    const resolved = await resolveCertShareChannel({
      DB: fakeDb({ report_channel_id: "-1008" }),
      CERT_SHARE_CHANNEL: "-1001",
    });
    expect(resolved).toEqual({ chatId: -1001, source: "env" });
  });

  it("归档频道走 KV 缓存时同样能回落（/set_report_channel 写的就是它）", async () => {
    const cache = fakeCache();
    await cache.put("report-channel:v1", "-1004489719605");
    const resolved = await resolveCertShareChannel({ DB: fakeDb({}), CACHE: cache });
    expect(resolved).toEqual({ chatId: -1004489719605, source: "archive" });
  });

  it("cert_share_channel_id 被清空（空串）后回到继承归档频道", async () => {
    // 控制中心的「恢复继承归档频道」按钮就是把该键写空串，这里锁住它的语义。
    const resolved = await resolveCertShareChannel({
      DB: fakeDb({ cert_share_channel_id: "", report_channel_id: "-1008" }),
    });
    expect(resolved).toEqual({ chatId: -1008, source: "archive" });
  });

  it("CERT_SHARE_DISABLED=true 凌驾于系统设置", async () => {
    const resolved = await resolveCertShareChannel({
      DB: fakeDb({ cert_share_channel_id: "-1009" }),
      CERT_SHARE_DISABLED: "true",
    });
    expect(resolved).toBeNull();
  });

  it("没有 DB 时退化为环境变量解析，不会静默关闭", async () => {
    expect(await resolveCertShareChannel({ CERT_SHARE_CHANNEL: "-1001" })).toEqual({
      chatId: -1001,
      source: "env",
    });
    expect(await resolveCertShareChannel({})).toBeNull();
  });
});

describe("handleCertShare GET", () => {
  it("配置齐备时报告 enabled，并如实给出频道来源", async () => {
    const res = await handleCertShare(new Request(`https://example.test${CERT_SHARE_PATH}`), enabledEnv(), CLIENT);
    await expect(res.json()).resolves.toEqual({ ok: true, enabled: true, channelSource: "env" });
  });

  it("继承归档频道时 channelSource 为 archive", async () => {
    const env: CertShareEnv = {
      BOT_TOKEN: "test-token",
      CACHE: fakeCache(),
      DB: fakeDb({ report_channel_id: "-1004489719605" }),
    };
    const res = await handleCertShare(new Request(`https://example.test${CERT_SHARE_PATH}`), env, CLIENT);
    await expect(res.json()).resolves.toEqual({ ok: true, enabled: true, channelSource: "archive" });
  });

  it("缺 BOT_TOKEN 时报告未启用，但仍如实给出已解析的频道来源", async () => {
    const env: CertShareEnv = { CACHE: fakeCache(), REPORT_CHANNEL_ID: "-1004489719605" };
    const res = await handleCertShare(new Request(`https://example.test${CERT_SHARE_PATH}`), env, CLIENT);
    await expect(res.json()).resolves.toEqual({ ok: true, enabled: false, channelSource: "env" });
  });

  it("频道未配置时报告未启用", async () => {
    const env: CertShareEnv = { BOT_TOKEN: "test-token", CACHE: fakeCache() };
    const res = await handleCertShare(new Request(`https://example.test${CERT_SHARE_PATH}`), env, CLIENT);
    await expect(res.json()).resolves.toEqual({ ok: true, enabled: false });
  });
});

describe("handleCertShare POST 守卫", () => {
  it("未带来源头的跨站表单 403，且不产生任何发送", async () => {
    const recorded: Recorded = { albums: [], singles: [] };
    const res = await handleCertShare(postRequest(buildForm(), "none"), enabledEnv(), {
      ...CLIENT,
      sender: fakeSender(recorded),
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: "missing_origin" });
    expect(recorded.singles).toHaveLength(0);
    expect(recorded.albums).toHaveLength(0);
  });

  it("来源头取值错误同样 403（不是有头就放行）", async () => {
    const form = buildForm();
    const res = await handleCertShare(
      new Request(`https://example.test${CERT_SHARE_PATH}`, {
        method: "POST",
        headers: { [CERT_SHARE_ORIGIN_HEADER]: "some-other-app" },
        body: form,
      }),
      enabledEnv(),
      { ...CLIENT, sender: fakeSender({ albums: [], singles: [] }) },
    );
    expect(res.status).toBe(403);
  });

  it("兼容期内的旧同意头仍被接受（缓存里的旧 app.js 不至于静默失败）", async () => {
    const recorded: Recorded = { albums: [], singles: [] };
    const res = await handleCertShare(postRequest(buildForm(), "legacy"), enabledEnv(), {
      ...CLIENT,
      sender: fakeSender(recorded),
    });
    expect(res.status).toBe(200);
    expect(recorded.albums.length + recorded.singles.length).toBeGreaterThan(0);
  });

  it("未配置频道时 404", async () => {
    const res = await handleCertShare(
      postRequest(buildForm()),
      { BOT_TOKEN: "test-token", CACHE: fakeCache() },
      { ...CLIENT, sender: fakeSender({ albums: [], singles: [] }) },
    );
    expect(res.status).toBe(404);
  });

  it("缺少成品图时 400", async () => {
    const res = await handleCertShare(postRequest(buildForm({ card: null })), enabledEnv(), {
      ...CLIENT,
      sender: fakeSender({ albums: [], singles: [] }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "missing_card" });
  });

  it("成品图不是图片时 400（只信 magic bytes）", async () => {
    const notImage = new Uint8Array([0x3c, 0x21, 0x2d, 0x2d, 0x20, 0x68, 0x74, 0x6d, 0x6c]);
    const res = await handleCertShare(postRequest(buildForm({ card: notImage })), enabledEnv(), {
      ...CLIENT,
      sender: fakeSender({ albums: [], singles: [] }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "bad_card" });
  });

  it("原图不是图片时 400 且不发送任何消息", async () => {
    const recorded: Recorded = { albums: [], singles: [] };
    const res = await handleCertShare(
      postRequest(buildForm({ sources: [new Uint8Array([0x25, 0x50, 0x44, 0x46])] })),
      enabledEnv(),
      { ...CLIENT, sender: fakeSender(recorded) },
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "bad_source" });
    expect(recorded.singles).toHaveLength(0);
  });

  it("超过限流窗口后 429", async () => {
    const env: CertShareEnv = { ...enabledEnv(), CACHE: fakeCache() };
    const sender = fakeSender({ albums: [], singles: [] });
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      const res = await handleCertShare(postRequest(buildForm()), env, { ...CLIENT, sender });
      statuses.push(res.status);
    }
    /* 窗口是 20 次；第 21、22 次被挡 */
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(statuses[21]).toBe(429);
  });
});

describe("handleCertShare POST 发送", () => {
  it("只有成品时走单张，caption 说明未上传原图", async () => {
    const recorded: Recorded = { albums: [], singles: [] };
    const res = await handleCertShare(
      postRequest(buildForm({ meta: { style: "身份证", ratio: "4:5", theme: "极简" } })),
      enabledEnv(),
      { ...CLIENT, sender: fakeSender(recorded) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, photos: 1 });
    expect(String(body.fingerprint)).toMatch(/^[0-9A-F]{6}$/);
    expect(recorded.albums).toHaveLength(0);
    expect(recorded.singles).toHaveLength(1);
    expect(first(recorded.singles).chatId).toBe(-1004489719605);
    expect(first(recorded.singles).caption).toContain("身份证｜画幅 4:5");
    expect(first(recorded.singles).caption).toContain("主题：极简");
    expect(first(recorded.singles).caption).toContain("成品 1 张（未上传原图）");
    /* 没填署名时也要明写"未填写"，否则频道里分不清是漏了还是没人填 */
    expect(first(recorded.singles).caption).toContain("署名：（未填写）");
  });

  it("caption 带上署名、卡片姓名、标签、指纹与北京时间", async () => {
    const recorded: Recorded = { albums: [], singles: [] };
    const res = await handleCertShare(
      postRequest(
        buildForm({
          meta: {
            style: "神父风",
            ratio: "3:4",
            theme: "血族",
            signer: "小满",
            name: "张三",
            tags: ["反差", "女大", "文爱"],
          },
        }),
      ),
      enabledEnv(),
      { ...CLIENT, sender: fakeSender(recorded) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const caption = first(recorded.singles).caption ?? "";
    expect(caption).toContain("🎴 认证卡生成器 · 新作品");
    expect(caption).toContain("署名：小满");
    expect(caption).toContain("姓名：张三");
    expect(caption).toContain("标签：#反差 #女大 #文爱");
    expect(caption).toContain("(UTC+8)");
    /* 指纹同时出现在 caption 和响应里，且两者一致 */
    expect(caption).toContain(`指纹 ${String(body.fingerprint)}`);
    expect(caption).toContain(String(body.fingerprint));
  });

  it("标签去重、超长丢弃、含空格转下划线、最多 8 个", async () => {
    const recorded: Recorded = { albums: [], singles: [] };
    await handleCertShare(
      postRequest(
        buildForm({
          meta: {
            tags: [
              "反差",
              "反差",
              "#女大",
              "带 空格",
              "A".repeat(20),
              "t1",
              "t2",
              "t3",
              "t4",
              "t5",
              "t6",
              "t7",
              "t8",
              "t9",
            ],
          },
        }),
      ),
      enabledEnv(),
      { ...CLIENT, sender: fakeSender(recorded) },
    );
    const caption = first(recorded.singles).caption ?? "";
    expect(caption).toContain("#反差 ");
    expect(caption).not.toContain("#反差 #反差");
    expect(caption).toContain("#女大");
    expect(caption).toContain("#带_空格");
    expect(caption).not.toContain("A".repeat(20));
    /* 8 个上限：t1..t8 里只会留下排在前面的那些，t9 一定不在 */
    expect(caption).not.toContain("#t9");
  });

  it("同一张成品两次上传指纹相同，不同成品指纹不同", async () => {
    const digests: string[] = [];
    for (const bytes of [imageBytes(PNG_HEAD), imageBytes(PNG_HEAD), imageBytes(JPEG_HEAD)]) {
      const recorded: Recorded = { albums: [], singles: [] };
      const res = await handleCertShare(
        postRequest(buildForm({ card: bytes })),
        { ...enabledEnv(), CACHE: fakeCache() },
        { ...CLIENT, sender: fakeSender(recorded) },
      );
      const body = (await res.json()) as Record<string, unknown>;
      digests.push(String(body.fingerprint));
    }
    expect(digests[0]).toBe(digests[1]);
    expect(digests[0]).not.toBe(digests[2]);
  });

  it("成品 + 2 张原图走相册，成品排第一且只有它带 caption", async () => {
    const recorded: Recorded = { albums: [], singles: [] };
    const res = await handleCertShare(
      postRequest(buildForm({ sources: [imageBytes(PNG_HEAD), imageBytes(JPEG_HEAD)] })),
      enabledEnv(),
      { ...CLIENT, sender: fakeSender(recorded) },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, photos: 3 });
    expect(recorded.singles).toHaveLength(0);
    expect(recorded.albums).toHaveLength(1);
    const album = first(recorded.albums);
    expect(album.chatId).toBe(-1004489719605);
    expect(album.photos).toHaveLength(3);
    expect(first(album.photos).caption).toContain("认证卡生成器");
    expect(album.photos.slice(1).every((p) => p.caption === undefined)).toBe(true);
    /* 第一张必须是成品：字节和 card 完全一致 */
    expect(Array.from(first(album.photos).bytes)).toEqual(Array.from(imageBytes(PNG_HEAD)));
  });

  it("JPEG 与 WebP 成品都接受", async () => {
    for (const head of [JPEG_HEAD, [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]]) {
      const recorded: Recorded = { albums: [], singles: [] };
      const res = await handleCertShare(
        postRequest(buildForm({ card: imageBytes(head) })),
        { ...enabledEnv(), CACHE: fakeCache() },
        { ...CLIENT, sender: fakeSender(recorded) },
      );
      expect(res.status).toBe(200);
      expect(recorded.singles).toHaveLength(1);
    }
  });

  it("sender 收到与字节一致的 mime——WebP 成品不得声明成 PNG（TG 按声明选解码管线，错配会发成灰块）", async () => {
    const WEBP_HEAD = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
    const recorded: Recorded = { albums: [], singles: [] };
    const res = await handleCertShare(
      postRequest(buildForm({ card: imageBytes(WEBP_HEAD), sources: [imageBytes(JPEG_HEAD), imageBytes(JPEG_HEAD)] })),
      { ...enabledEnv(), CACHE: fakeCache() },
      { ...CLIENT, sender: fakeSender(recorded) },
    );
    expect(res.status).toBe(200);
    // 有原图走相册：成品第一张带 caption，全部携带真实 mime。
    expect(recorded.albums).toHaveLength(1);
    const photos = first(recorded.albums).photos;
    expect(photos[0]?.type).toBe("image/webp");
    expect(photos[1]?.type).toBe("image/jpeg");
    expect(photos[2]?.type).toBe("image/jpeg");
    // 无原图的单张路径同样携带真实 mime。
    const singleRecorded: Recorded = { albums: [], singles: [] };
    await handleCertShare(
      postRequest(buildForm({ card: imageBytes(WEBP_HEAD) })),
      { ...enabledEnv(), CACHE: fakeCache() },
      { ...CLIENT, sender: fakeSender(singleRecorded) },
    );
    expect(first(singleRecorded.singles).type).toBe("image/webp");
  });

  it("Telegram 发送失败时 502，且不回传原始错误", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handleCertShare(postRequest(buildForm()), enabledEnv(), {
      ...CLIENT,
      sender: fakeSender({ albums: [], singles: [] }, new Error("Bad Request: chat not found -1004489719605")),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ ok: false, code: "delivery_failed" });
    expect(JSON.stringify(body)).not.toContain("-1004489719605");
    warn.mockRestore();
  });

  it("meta 里的换行与超长内容被清洗进 caption", async () => {
    const recorded: Recorded = { albums: [], singles: [] };
    const longName = "A".repeat(200);
    await handleCertShare(
      postRequest(buildForm({ meta: { style: `证件\n伪造\t注入`, theme: longName } })),
      enabledEnv(),
      { ...CLIENT, sender: fakeSender(recorded) },
    );
    const caption = first(recorded.singles).caption ?? "";
    expect(caption).not.toContain("\n伪造");
    expect(caption.length).toBeLessThan(longName.length + 80);
  });
});
