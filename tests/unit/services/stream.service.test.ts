import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStreamDirectUpload,
  deleteStreamVideo,
  getStreamVideoStatus,
  streamConfigured,
  sweepStaleStreamUploads,
} from "../../../src/services/media/stream.service";

const ENV = { STREAM_ACCOUNT_ID: "acct", STREAM_API_TOKEN: "tok" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamConfigured", () => {
  it("账号与令牌齐备才视为已配置", () => {
    expect(streamConfigured(ENV)).toBe(true);
    expect(streamConfigured({ STREAM_ACCOUNT_ID: "acct" })).toBe(false);
    expect(streamConfigured({ STREAM_ACCOUNT_ID: " ", STREAM_API_TOKEN: "t" })).toBe(false);
  });
});

describe("createStreamDirectUpload", () => {
  it("创建直传凭证并返回 uploadURL/uid", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { success: true, result: { uploadURL: "https://upload.example/x", uid: "uid-1" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ticket = await createStreamDirectUpload(ENV, { metaName: "resp-1-video" });
    expect(ticket).toEqual({ videoUid: "uid-1", uploadUrl: "https://upload.example/x" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/accounts/acct/stream/direct-upload");
    expect(JSON.parse(String(init.body))).toMatchObject({ maxDurationSeconds: 900 });
  });

  it("API 报错时抛出带消息的异常", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { success: false, errors: [{ message: "bad token" }] })),
    );
    await expect(createStreamDirectUpload(ENV, { metaName: "x" })).rejects.toThrow("bad token");
  });
});

describe("getStreamVideoStatus", () => {
  it("readyToStream → ready + hls/thumbnail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          success: true,
          result: {
            readyToStream: true,
            status: "ready",
            playback: { hls: "https://customer-x.cloudflarestream.com/uid/manifest/video.m3u8" },
            thumbnail: "https://customer-x.cloudflarestream.com/uid/thumbnails/thumb.jpg",
          },
        }),
      ),
    );
    expect(await getStreamVideoStatus(ENV, "uid")).toEqual({
      state: "ready",
      hlsUrl: "https://customer-x.cloudflarestream.com/uid/manifest/video.m3u8",
      thumbnailUrl: "https://customer-x.cloudflarestream.com/uid/thumbnails/thumb.jpg",
    });
  });

  it("404 → not_found；转码中 → processing；errored → errored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nf", { status: 404 })));
    expect((await getStreamVideoStatus(ENV, "uid")).state).toBe("not_found");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { success: true, result: { readyToStream: false, status: "in_progress" } })),
    );
    expect((await getStreamVideoStatus(ENV, "uid")).state).toBe("processing");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { success: true, result: { readyToStream: false, status: "errored" } })),
    );
    expect((await getStreamVideoStatus(ENV, "uid")).state).toBe("errored");
  });
});

describe("deleteStreamVideo", () => {
  it("404 视为已删除，不抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nf", { status: 404 })));
    await expect(deleteStreamVideo(ENV, "uid")).resolves.toBeUndefined();
  });
});

describe("sweepStaleStreamUploads", () => {
  it("删除过期凭证的 Stream 对象并失效行；失败计数不中断", async () => {
    const updates: number[] = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith("SELECT")) {
          return {
            bind: () => ({
              all: async () => ({
                results: [
                  { id: 7, storage_key: "stream:91:uid-ok" },
                  { id: 8, storage_key: "stream:91:uid-fail" },
                ],
              }),
            }),
          };
        }
        return {
          bind: (_a: unknown, _b: unknown, id: number) => ({
            run: async () => {
              updates.push(id);
              return { success: true };
            },
          }),
        };
      }),
    } as unknown as D1Database;

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === "DELETE" && String(_url).includes("uid-fail")
        ? new Response("boom", { status: 500 })
        : new Response("nf", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const summary = await sweepStaleStreamUploads(db, ENV);
    expect(summary).toEqual({ deleted: 1, failed: 1 });
    expect(updates).toEqual([7]);
  });
});
