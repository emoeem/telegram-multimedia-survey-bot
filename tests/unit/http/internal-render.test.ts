import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publishPublicResponseReport: vi.fn(async () => ({ delivered: true })),
}));

vi.mock("../../../src/services/public-report.service", () => ({
  publishPublicResponseReport: mocks.publishPublicResponseReport,
}));

import { handleInternalRenderRequest } from "../../../src/http/internal-render";

function env() {
  return { WEBHOOK_SECRET: "secret" } as never;
}

describe("internal public report render id validation", () => {
  it("rejects an unsafe integer before touching the renderer", async () => {
    const request = new Request(
      "https://example.test/internal/render-public-report/9007199254740992",
      { method: "POST", headers: { "x-internal-token": "secret" } },
    );

    const response = await handleInternalRenderRequest(request, env());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "invalid_response_id" });
    expect(mocks.publishPublicResponseReport).not.toHaveBeenCalled();
  });

  it("passes a safe integer to the renderer", async () => {
    const request = new Request(
      "https://example.test/internal/render-public-report/42",
      { method: "POST", headers: { "x-internal-token": "secret" } },
    );

    const response = await handleInternalRenderRequest(request, env());

    expect(response.status).toBe(200);
    expect(mocks.publishPublicResponseReport).toHaveBeenCalledWith(expect.anything(), 42);
  });
});
