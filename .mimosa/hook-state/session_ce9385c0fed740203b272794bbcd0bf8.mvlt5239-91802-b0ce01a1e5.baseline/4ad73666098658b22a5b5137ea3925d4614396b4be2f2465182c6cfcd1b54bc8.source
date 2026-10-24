/**
 * 控制中心「Telegram Publication Targets」的三种目标 —— 公开群 / 归档频道 /
 * 认证卡作品频道 —— 都由同一组接口对外暴露。
 *
 * 这里只锁两件在重构中真正会断的事：
 *   1. GET 必须同时返回 archive 与 certShare，且 certShare 在未单独配置时
 *      如实报告 source = "archive"（这就是「默认发到 -1004489719605」的实现）；
 *   2. PUT cert-share 既能落库覆盖，也能用空串把配置还原成「继承归档频道」。
 *
 * 用内存假 D1 而不是 miniflare：这条路径只碰 system_settings 与
 * publication_targets 两张表，起一整个 Worker 环境对验证优先级没有增益。
 */

import { describe, expect, it } from "vitest";
import { handleControlApiRequest } from "../../../src/http/control-api";

const ARCHIVE_ID = "-1004489719605";

interface FakeDb {
  db: D1Database;
  settings: Map<string, string>;
}

/**
 * 只实现控制中心这几条路由会用到的语句；未识别的 SQL 一律返回空结果，
 * 让 publication_targets 的列表投影退化成空数组（本轮不测它的增删改）。
 */
function fakeDb(initial: Record<string, string> = {}): FakeDb {
  const settings = new Map(Object.entries(initial));
  const rows = (sql: string) => !sql.includes("publication_targets");
  const db = {
    prepare(sql: string) {
      const single = rows(sql);
      const run = async () => ({ success: true, meta: { changes: 1 } });
      const statement = {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (/FROM system_settings WHERE key/.test(sql)) {
                const key = String(args[0]);
                return settings.has(key) ? { value: settings.get(key) } : null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (/INSERT INTO system_settings/.test(sql)) {
                settings.set(String(args[0]), String(args[1]));
              }
              return run();
            },
          };
        },
        async first() {
          return single ? null : null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return run();
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, settings };
}

function envFor(fake: FakeDb) {
  // isLicenseCenter 要求两道条件同时成立：DEPLOYMENT_ROLE 不是 customer，
  // 且配了 LICENSE_ADMIN_TOKEN。只给角色不给 token 会一律 403。
  return { DB: fake.db, DEPLOYMENT_ROLE: "vendor", LICENSE_ADMIN_TOKEN: "test-vendor-token" };
}

const ADMIN_AUTH = { isAdmin: true, userId: 1 };

function get(env: ReturnType<typeof envFor>) {
  return handleControlApiRequest(new Request("https://example.test/api/control/publication-targets"), env, ADMIN_AUTH);
}

function putCertShare(chatId: string, env: ReturnType<typeof envFor>) {
  return handleControlApiRequest(
    new Request("https://example.test/api/control/publication-targets/cert-share", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId }),
    }),
    env,
    ADMIN_AUTH,
  );
}

describe("GET /api/control/publication-targets", () => {
  it("同时返回 archive 与 certShare，且未单独配置时 certShare 继承归档频道", async () => {
    const env = envFor(fakeDb({ report_channel_id: ARCHIVE_ID }));
    const res = await get(env);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      archive: { chatId: string; source: string } | null;
      certShare: { chatId: string; source: string } | null;
    };
    expect(body.archive).toEqual({ name: "报告归档频道", chatId: ARCHIVE_ID, source: "settings" });
    // 这一条就是需求「发到 -1004489719605 这里」的机读断言。
    expect(body.certShare).toEqual({ name: "认证卡作品频道", chatId: ARCHIVE_ID, source: "archive" });
  });

  it("单独配置过 cert_share_channel_id 时，certShare 与 archive 可以指向不同频道", async () => {
    const env = envFor(fakeDb({ report_channel_id: ARCHIVE_ID, cert_share_channel_id: "-1007777777777" }));
    const res = await get(env);
    const body = (await res?.json()) as {
      archive: { chatId: string } | null;
      certShare: { chatId: string; source: string } | null;
    };
    expect(body.archive?.chatId).toBe(ARCHIVE_ID);
    expect(body.certShare).toEqual({ name: "认证卡作品频道", chatId: "-1007777777777", source: "settings" });
  });

  it("两者都未配置时 certShare 为 null（前端显示「未配置」而不是假的频道号）", async () => {
    const env = envFor(fakeDb());
    const res = await get(env);
    const body = (await res?.json()) as { archive: unknown; certShare: unknown };
    expect(body.archive).toBeNull();
    expect(body.certShare).toBeNull();
  });
});

describe("PUT /api/control/publication-targets/cert-share", () => {
  it("写入后落进 cert_share_channel_id，并回报 source=settings", async () => {
    const fake = fakeDb({ report_channel_id: ARCHIVE_ID });
    const env = envFor(fake);
    const res = await putCertShare("-1007777777777", env);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { certShare: { chatId: string; source: string } };
    expect(body.certShare).toEqual({ name: "认证卡作品频道", chatId: "-1007777777777", source: "settings" });
    expect(fake.settings.get("cert_share_channel_id")).toBe("-1007777777777");
  });

  it("传空串清除覆盖，回到继承归档频道（「恢复继承」按钮的语义）", async () => {
    const fake = fakeDb({ report_channel_id: ARCHIVE_ID, cert_share_channel_id: "-1007777777777" });
    const env = envFor(fake);
    const res = await putCertShare("", env);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { certShare: { chatId: string; source: string } };
    expect(body.certShare).toEqual({ name: "认证卡作品频道", chatId: ARCHIVE_ID, source: "archive" });
    expect(fake.settings.get("cert_share_channel_id")).toBe("");
  });

  it("拒绝非整数频道号", async () => {
    const env = envFor(fakeDb());
    const res = await putCertShare("@some_channel", env);
    expect(res?.status).toBe(400);
  });

  it("非授权中心（客户部署）一律 403，不能改本机认证卡目标", async () => {
    const env = { ...envFor(fakeDb()), DEPLOYMENT_ROLE: "customer" };
    const res = await putCertShare("-1007777777777", env);
    expect(res?.status).toBe(403);
  });
});
