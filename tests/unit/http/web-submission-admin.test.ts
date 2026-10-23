import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../../src/index";
import {
  handleWebSubmissionAdmin,
  isWebSubmissionAdminPath,
  WEB_SUBMISSION_PREFIX,
} from "../../../src/http/admin/web-submission";

/**
 * 后台审核网页投稿的代理层。
 *
 * 它存在的意义是**两把钥匙分开**：浏览器只持管理员会话，投稿机器人只认
 * 共享密钥。所以这里要钉住的不是"能不能转发"，而是几条边界：
 *
 *  - 没配密钥时不能退化成"不带头也转发"（那等于把对方的审核接口挂在一个
 *    只靠本站会话保护的位置上）；
 *  - 只有管理员能走（创作者试用会话看得见 /admin，但不该能往公开频道发帖）；
 *  - 路径必须走白名单，不能把用户给的 suffix 直接拼到上游（`../webhook/<secret>`
 *    这类会打到别的地方）。
 */

function ctx(isAdmin = true) {
  return {
    isAdmin,
    fail: (status: number, code: string, message: string) => Response.json({ code, message }, { status }),
    json: (body: unknown) => Response.json(body),
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUBMISSION_BOT_API_ORIGIN: "https://bot.example.com",
    WEB_REVIEW_SECRET: "shared-secret",
    ...overrides,
  } as Env;
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://site.example${path}`, init);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("路径归属", () => {
  it("认得自己的前缀和子路径", () => {
    expect(WEB_SUBMISSION_PREFIX).toBe("/api/admin/web-submissions");
    expect(isWebSubmissionAdminPath("/api/admin/web-submissions")).toBe(true);
    expect(isWebSubmissionAdminPath("/api/admin/web-submissions/list")).toBe(true);
  });

  it("不吞金币投稿（/api/admin/submissions）", () => {
    /* 只差一个 web-：那条属于本站 D1，被代理走会让「金币经济 · 投稿管理」失效。 */
    expect(isWebSubmissionAdminPath("/api/admin/submissions")).toBe(false);
    expect(isWebSubmissionAdminPath("/api/admin/submissions/12")).toBe(false);
  });
});

describe("鉴权与 fail-closed", () => {
  it("非管理员直接 403，不发起任何上游请求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const url = new URL("https://site.example/api/admin/web-submissions/list");
    const response = await handleWebSubmissionAdmin(req(url.pathname), url, makeEnv(), ctx(false));
    expect(response?.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("没配 WEB_REVIEW_SECRET 时 503，而不是放行", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const url = new URL("https://site.example/api/admin/web-submissions/list");
    const response = await handleWebSubmissionAdmin(
      req(url.pathname),
      url,
      makeEnv({ WEB_REVIEW_SECRET: "" }),
      ctx(),
    );
    expect(response?.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("没配投稿机器人源站时 503", async () => {
    const url = new URL("https://site.example/api/admin/web-submissions/list");
    const response = await handleWebSubmissionAdmin(
      req(url.pathname),
      url,
      makeEnv({ SUBMISSION_BOT_API_ORIGIN: "" }),
      ctx(),
    );
    expect(response?.status).toBe(503);
  });
});

describe("路径白名单", () => {
  it("未知动作 404", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const url = new URL("https://site.example/api/admin/web-submissions/drop-tables");
    const response = await handleWebSubmissionAdmin(req(url.pathname), url, makeEnv(), ctx());
    expect(response?.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("路径穿越在 URL 规范化阶段就被消掉，根本进不了本模块", async () => {
    /* 这里有两层，缺一不可：
     *   1) `new URL()` 把 `/api/admin/web-submissions/../webhook/abc` 规范化成
     *      `/api/admin/webhook/abc`，所以 `isWebSubmissionAdminPath` 直接不认；
     *   2) 就算它认了，upstreamPath() 用的是白名单，不会把 suffix 拼过去。
     *
     * 第 2 层是真正兜底的那层 —— `Wrangler` 在某些配置下会把原始路径放进
     * `request.url`，那时第 1 层不一定发生。所以两层都要留着。 */
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const url = new URL("https://site.example/api/admin/web-submissions/../webhook/abc");
    expect(url.pathname).toBe("/api/admin/webhook/abc");
    const response = await handleWebSubmissionAdmin(req(url.pathname), url, makeEnv(), ctx());
    expect(response).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("同前缀但不在白名单里的动作仍然 404（第二层兜底）", async () => {
    /* 直接构造一个"规范化后仍是本模块前缀、但动作非法"的路径，验证白名单
     * 本身在工作 —— 不依赖 URL 规范化那一层。 */
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const url = new URL("https://site.example/api/admin/web-submissions/webhook/abc");
    const response = await handleWebSubmissionAdmin(req(url.pathname), url, makeEnv(), ctx());
    expect(response?.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("前缀本身（没有动作）也是 404", async () => {
    const url = new URL("https://site.example/api/admin/web-submissions");
    const response = await handleWebSubmissionAdmin(req(url.pathname), url, makeEnv(), ctx());
    expect(response?.status).toBe(404);
  });
});

describe("转发行为", () => {
  it("带上共享密钥、转发访客 IP，但绝不透传 cookie", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        captured = { url: String(input), init };
        return Response.json({ ok: true, items: [] });
      }),
    );

    const url = new URL("https://site.example/api/admin/web-submissions/list?status=pending&limit=20");
    const response = await handleWebSubmissionAdmin(
      req(url.pathname + url.search, {
        headers: {
          cookie: "admin_session=should-not-leak",
          "cf-connecting-ip": "203.0.113.9",
        },
      }),
      url,
      makeEnv(),
      ctx(),
    );

    expect(response?.status).toBe(200);
    expect(captured).not.toBeNull();
    const { url: upstreamUrl, init } = captured!;
    expect(upstreamUrl).toBe("https://bot.example.com/api/admin/review/list?status=pending&limit=20");

    const headers = init.headers as Headers;
    expect(headers.get("x-review-secret")).toBe("shared-secret");
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(headers.get("cookie")).toBeNull();
  });

  it("POST 的动作带 body 转发过去", async () => {
    let method = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string, init: RequestInit) => {
        method = String(init.method);
        return Response.json({ ok: true });
      }),
    );
    const url = new URL("https://site.example/api/admin/web-submissions/approve");
    const response = await handleWebSubmissionAdmin(
      req(url.pathname, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: 12 }),
      }),
      url,
      makeEnv(),
      ctx(),
    );
    expect(response?.status).toBe(200);
    expect(method).toBe("POST");
  });

  it("上游不可达时 502，不把异常抛给调用方", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const url = new URL("https://site.example/api/admin/web-submissions/list");
    const response = await handleWebSubmissionAdmin(req(url.pathname), url, makeEnv(), ctx());
    expect(response?.status).toBe(502);
  });

  it("上游返回 HTML 错误页时转成结构化 502，而不是让它去炸 JSON.parse", async () => {
    /* Cloudflare 的 5xx 拦截页就是 HTML。原样透传的话前端 response.json()
     * 会抛 SyntaxError，界面只剩「加载失败」，看不到任何可行动的信息。 */
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>bad gateway</html>", { headers: { "content-type": "text/html" } })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const url = new URL("https://site.example/api/admin/web-submissions/list");
    const response = await handleWebSubmissionAdmin(req(url.pathname), url, makeEnv(), ctx());
    expect(response?.status).toBe(502);
    const body = (await response!.json()) as { code: string };
    expect(body.code).toBe("review_service_bad_response");
  });

  it("附件字节原样透传，不会被「非 JSON 一律转错误」那条规则吃掉", async () => {
    /* 这条最容易写错：图片本来就不是 JSON。如果 media 落进下面那个归一化分支，
     * 每一次缩略图请求都会变成 502，前端只能显示「预览失败」。 */
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        capturedUrl = String(input);
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(bytes.length),
            "x-content-type-options": "nosniff",
          },
        });
      }),
    );

    const url = new URL("https://site.example/api/admin/web-submissions/media?submission=24&index=0");
    const response = await handleWebSubmissionAdmin(req(url.pathname + url.search), url, makeEnv(), ctx());

    expect(capturedUrl).toBe("https://bot.example.com/api/admin/review/media?submission=24&index=0");
    expect(response?.status).toBe(200);
    expect(response!.headers.get("content-type")).toBe("image/jpeg");
    expect(response!.headers.get("content-length")).toBe(String(bytes.length));
    expect(response!.headers.get("x-content-type-options")).toBe("nosniff");
    const received = new Uint8Array(await response!.arrayBuffer());
    expect(Array.from(received)).toEqual(Array.from(bytes));
  });

  it("附件绝不能被共享缓存：上游声明 private，转发层也不许改回 public", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2]), {
            status: 200,
            headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000" },
          }),
      ),
    );
    const url = new URL("https://site.example/api/admin/web-submissions/media?submission=24&index=1");
    const response = await handleWebSubmissionAdmin(req(url.pathname + url.search), url, makeEnv(), ctx());
    expect(response!.headers.get("cache-control")).toBe("private, max-age=300");
  });

  it("附件上游失败时把它的诊断带出来，而不是统一 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: "附件超过 20MB，后台预览不了，请到审核群查看" }), {
            status: 413,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const url = new URL("https://site.example/api/admin/web-submissions/media?submission=24&index=0");
    const response = await handleWebSubmissionAdmin(req(url.pathname + url.search), url, makeEnv(), ctx());
    expect(response?.status).toBe(413);
    const body = (await response!.json()) as { message: string };
    expect(body.message).toContain("审核群");
  });

  it("不属于本模块的路径返回 null，交回给后续路由", async () => {
    const url = new URL("https://site.example/api/admin/coins/overview");
    const response = await handleWebSubmissionAdmin(req(url.pathname), url, makeEnv(), ctx());
    expect(response).toBeNull();
  });
});
