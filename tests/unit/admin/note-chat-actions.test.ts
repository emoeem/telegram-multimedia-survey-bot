import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  blockThreadPartner,
  reportThreadMessage,
  unblockThreadPartner,
  type NoteApiError,
} from "../../../admin/src/survey/note-api";
import { REPORT_REASON_MAX, chatInputGate, validateReportReason } from "../../../admin/src/survey/note-chat-actions";

/**
 * 纸条会话用户端动作（T1，0094 收尾）：服务端 block/report 路由早已齐备
 * （src/http/note-api.ts 的 blockMatch / messageReportMatch），此前前端零调用。
 * 这里锁三件事——三个 API 包装的 URL/方法/体（fetch 用 vi.stubGlobal 注入，
 * 单测环境是 node、无 window/sessionStorage，getTelegramInitData 一并 stub 掉
 * window）、理由空/超长校验分支、blocked 态输入条只读判定。DOM 交互
 * （长按菜单/弹层/toast）仓库无 @testing-library，不虚装 DOM 断言，由
 * pnpm build:admin + 人工验证兜底。
 */

/** request() 只看 response.ok 与 response.json()，用最小假对象即可。 */
function jsonResponse(payload: Record<string, unknown>, ok = true) {
  return { ok, json: async () => payload };
}

describe("纸条会话动作 API 包装", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    // getTelegramInitData 走 window.Telegram.WebApp.initData；node 环境给个空壳，
    // 让身份头落到 x-participant-key 分支（本测试只关心 URL/方法/体）。
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reportThreadMessage：POST /api/note/threads/:id/messages/:mid/report，体带 reason", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ ok: true, reportCount: 3 }));
    const result = await reportThreadMessage(7, 42, "辱骂骚扰");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/note/threads/7/messages/42/report");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ reason: "辱骂骚扰" });
    expect(result).toEqual({ ok: true, reportCount: 3 });
  });

  it("blockThreadPartner：POST /api/note/threads/:id/block，无请求体", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ ok: true, blocked: true }));
    const result = await blockThreadPartner(9);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/note/threads/9/block");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(result).toEqual({ ok: true, blocked: true });
  });

  it("unblockThreadPartner：DELETE 同一路径，无请求体", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ ok: true, blocked: false }));
    const result = await unblockThreadPartner(9);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/note/threads/9/block");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(result).toEqual({ ok: true, blocked: false });
  });

  it("服务端失败时抛 NoteApiError 并带 code（错误文案驱动 UI 分支的契约）", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ code: "rate_limited", message: "操作太频繁" }, false));
    const error = await blockThreadPartner(9).catch((err: NoteApiError) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as NoteApiError).code).toBe("rate_limited");
    expect((error as NoteApiError).message).toBe("操作太频繁");
  });
});

describe("validateReportReason（举报理由校验）", () => {
  it("空理由与纯空白理由 → empty", () => {
    expect(validateReportReason("")).toBe("empty");
    expect(validateReportReason("   ")).toBe("empty");
    expect(validateReportReason("\n\t ")).toBe("empty");
  });

  it(`超过 ${REPORT_REASON_MAX} 字（按 trim 后计）→ too_long`, () => {
    expect(validateReportReason("a".repeat(REPORT_REASON_MAX + 1))).toBe("too_long");
    // 首尾空白不算长度：trim 后恰好 200 字合法。
    expect(validateReportReason(`  ${"a".repeat(REPORT_REASON_MAX)}  `)).toBeNull();
  });

  it("合法理由 → null", () => {
    expect(validateReportReason("辱骂骚扰")).toBeNull();
    expect(validateReportReason("a".repeat(REPORT_REASON_MAX))).toBeNull();
  });
});

describe("chatInputGate（blocked 态输入条只读判定）", () => {
  it("正常会话：可输入", () => {
    expect(chatInputGate({ blocked: false, peerGone: false })).toEqual({
      readonly: false,
      reason: null,
      unblockable: false,
    });
  });

  it("本地 blocked → 只读且可解除拉黑；叠加 peerGone 仍允许解除", () => {
    expect(chatInputGate({ blocked: true, peerGone: false })).toEqual({
      readonly: true,
      reason: "blocked",
      unblockable: true,
    });
    expect(chatInputGate({ blocked: true, peerGone: true })).toEqual({
      readonly: true,
      reason: "blocked",
      unblockable: true,
    });
  });

  it("纸条下架（peerGone）→ 只读、无解除动作", () => {
    expect(chatInputGate({ blocked: false, peerGone: true })).toEqual({
      readonly: true,
      reason: "peer-gone",
      unblockable: false,
    });
  });
});
