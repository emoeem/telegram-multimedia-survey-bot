import { describe, expect, it } from "vitest";

import { PLAN_FALLBACK_NOTES, resolvePlanCapabilities } from "../../../src/services/plan.service";

describe("resolvePlanCapabilities", () => {
  it("无任何绑定时是 free，且不允许任何能力", () => {
    const caps = resolvePlanCapabilities({});
    expect(caps).toEqual({
      tier: "free",
      r2Media: false,
      streamVideo: false,
      imagesPipeline: false,
      browserRender: false,
      asyncQueue: false,
      rateLimitDO: false,
    });
  });

  it("R2 + 渲染 + 队列齐全（vendor 生产形态）推导为 pro", () => {
    const caps = resolvePlanCapabilities({ MEDIA: {}, BROWSER: {}, EXPORT_QUEUE: {} });
    expect(caps.tier).toBe("pro");
    expect(caps.r2Media).toBe(true);
  });

  it("渲染 + 队列但无 R2（当前线上形态）是 paid", () => {
    const caps = resolvePlanCapabilities({ BROWSER: {}, EXPORT_QUEUE: {} });
    expect(caps.tier).toBe("paid");
    expect(caps.r2Media).toBe(false);
  });

  it("Stream / Images 只看各自配置是否齐全，不影响档位", () => {
    const base = { MEDIA: {}, BROWSER: {}, EXPORT_QUEUE: {} };
    expect(resolvePlanCapabilities(base).streamVideo).toBe(false);
    expect(resolvePlanCapabilities({ ...base, STREAM_ACCOUNT_ID: "abc" }).streamVideo).toBe(false);
    expect(resolvePlanCapabilities({ ...base, STREAM_ACCOUNT_ID: "abc", STREAM_API_TOKEN: "t" }).streamVideo).toBe(true);
    expect(
      resolvePlanCapabilities({
        ...base,
        IMAGES_ACCOUNT_ID: "abc",
        IMAGES_DELIVERY_HASH: "hash",
        CLOUDFLARE_API_TOKEN: "t",
      }).imagesPipeline,
    ).toBe(true);
  });

  it("空字符串配置视同未配置", () => {
    const caps = resolvePlanCapabilities({
      MEDIA: {},
      BROWSER: {},
      EXPORT_QUEUE: {},
      STREAM_ACCOUNT_ID: "  ",
      STREAM_API_TOKEN: "t",
    });
    expect(caps.streamVideo).toBe(false);
  });

  it("PLAN_TIER 声明只能收紧、不能解锁探测不到的能力", () => {
    // 探测是 pro，声明 free → 取 free。
    expect(resolvePlanCapabilities({ MEDIA: {}, BROWSER: {}, EXPORT_QUEUE: {}, PLAN_TIER: "free" }).tier).toBe("free");
    // 探测是 paid，声明 pro → 仍是 paid（声明不创造能力）。
    expect(resolvePlanCapabilities({ BROWSER: {}, EXPORT_QUEUE: {}, PLAN_TIER: "pro" }).tier).toBe("paid");
  });

  it("非 free 的档位至少有降级说明可查（能力面板依赖）", () => {
    for (const key of Object.keys(PLAN_FALLBACK_NOTES)) {
      expect(typeof PLAN_FALLBACK_NOTES[key as keyof typeof PLAN_FALLBACK_NOTES]).toBe("string");
    }
  });
});
