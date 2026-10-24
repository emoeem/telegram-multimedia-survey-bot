import { afterEach, describe, expect, it, vi } from "vitest";

import {
  preloadSubmitForm,
  resetSubmitFormPreload,
  type SubmitFormDto,
} from "../../../admin/src/survey/submit-form-preload";

/** 一份最小可用的表单 DTO：字段齐但值最短，断言只关心身份复用。 */
function makeForm(): SubmitFormDto {
  return {
    title: "📮 投稿",
    intro: "intro",
    captcha: false,
    maxFiles: 1,
    maxFileMb: 5,
    submitUrl: "/api/submit",
    captchaUrl: "/api/submit/captcha",
    inboxUrl: "/submit/inbox",
    mainGroupUrl: null,
    steps: [],
  };
}

function mockFetchJson(payload: unknown, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }),
  );
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetSubmitFormPreload();
  vi.restoreAllMocks();
});

/**
 * 投稿中心的加载链把 form 的 fetch 从 SubmitScreen 挂载提前到 hub 挂载，
 * 两处靠这份模块级缓存衔接。这里的两条行为是它不出错的前提：
 * 同一页面加载内绝不重复请求，以及失败的缓存必须自清（否则「重试」按钮
 * 永远拿到同一个 rejected promise，看起来像网络死了）。
 */
describe("免登录投稿表单预取", () => {
  it("两次调用复用同一份请求（只 fetch 一次）", async () => {
    const fetchMock = mockFetchJson({ ok: true, form: makeForm() });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const [first, second] = await Promise.all([preloadSubmitForm(), preloadSubmitForm()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("失败后缓存自清，重试会真的重新发起请求", async () => {
    const failing = mockFetchJson({ ok: false, error: "后端升级中" });
    globalThis.fetch = failing as unknown as typeof fetch;
    await expect(preloadSubmitForm()).rejects.toThrow("后端升级中");

    const succeeding = mockFetchJson({ ok: true, form: makeForm() });
    globalThis.fetch = succeeding as unknown as typeof fetch;
    const form = await preloadSubmitForm();
    expect(form.title).toBe("📮 投稿");
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("ok=false 的 200 响应按失败处理（错误文案透传）", async () => {
    globalThis.fetch = mockFetchJson({ ok: false, error: "表单未配置" }) as unknown as typeof fetch;
    await expect(preloadSubmitForm()).rejects.toThrow("表单未配置");
  });

  it("缺 form 字段的成功响应回落到通用错误文案", async () => {
    globalThis.fetch = mockFetchJson({ ok: true }) as unknown as typeof fetch;
    await expect(preloadSubmitForm()).rejects.toThrow("表单加载失败");
  });
});
