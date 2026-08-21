import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ launch: vi.fn(), screenshot: vi.fn(), pdf: vi.fn(), closePage: vi.fn(), viewportDpr: 2, pageCount: 1 }));

vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: mocks.launch } }));

import { renderResponseReport, type ResponseReport } from "../../../src/services/response-report.service";

function source(): ResponseReport {
  return { surveyTitle: "完整答卷", responseNumber: 1, status: "已完成", respondent: "Tester", startedAt: "start", completedAt: "end", items: [{ questionId: 1, number: 1, type: "text", title: "问题", required: true, answered: true, answerId: 1, answer: "完整答案", rawAnswer: "完整答案", options: [], questionMedia: [], answerMedia: [] }] };
}

beforeEach(() => {
  mocks.screenshot.mockReset(); mocks.pdf.mockReset(); mocks.closePage.mockReset(); mocks.launch.mockReset(); mocks.viewportDpr = 2; mocks.pageCount = 1;
  const page = {
    setViewport: vi.fn(async (viewport: { deviceScaleFactor: number }) => { mocks.viewportDpr = viewport.deviceScaleFactor; }),
    setContent: vi.fn(async (html: string) => { mocks.pageCount = html.match(/class="page"/g)?.length ?? 1; }),
    evaluate: vi.fn(async (script: string) => {
      if (script.includes("const isOverflowing")) {
        new Function(script);
        return mocks.pageCount;
      }
      return script.includes("querySelectorAll('.page')") ? null : undefined;
    }),
    screenshot: mocks.screenshot,
    pdf: mocks.pdf,
  };
  mocks.launch.mockResolvedValue({ newPage: vi.fn(async () => ({ ...page, close: mocks.closePage })), close: vi.fn() });
});

describe("complete response artifact rendering", () => {
  it("renders PNG at resource-safe DPR without dropping the page", async () => {
    mocks.screenshot.mockResolvedValue(new Uint8Array(4 * 1024 * 1024));
    const artifact = await renderResponseReport({} as never, source(), "png");
    expect(artifact.format).toBe("png");
    if (artifact.format !== "png") return;
    expect(artifact.pages).toHaveLength(1);
    expect(artifact.pages[0]?.dpr).toBe(1);
    expect(artifact.pages[0]?.byteSize).toBe(4 * 1024 * 1024);
    expect(mocks.screenshot).toHaveBeenCalledWith({
      type: "png",
      clip: { x: 0, y: 0, width: 900, height: 1200 },
      captureBeyondViewport: true,
    });
  });

  it("fails rather than omitting a page above the hard limit", async () => {
    mocks.screenshot.mockResolvedValue(new Uint8Array(11 * 1024 * 1024));
    await expect(renderResponseReport({} as never, source(), "png")).rejects.toThrow(/10 MB hard limit/);
    expect(mocks.screenshot).toHaveBeenCalledTimes(1);
  });

  it("returns PDF size and verified page count", async () => {
    mocks.pdf.mockResolvedValue(new Uint8Array(12345));
    const artifact = await renderResponseReport({} as never, source(), "pdf");
    expect(artifact).toMatchObject({ format: "pdf", byteSize: 12345, pageCount: 1 });
  });

  it("keeps every PNG page when total size exceeds 40 MB", async () => {
    const input = source();
    input.items[0]!.answerMedia = Array.from({ length: 27 }, (_, index) => ({ id: index + 1, role: "answer" as const, label: `图片 ${index + 1}` }));
    const expectedPages = 10;
    const pageBytes = new Uint8Array(4.5 * 1024 * 1024);
    mocks.screenshot.mockResolvedValue(pageBytes);
    const artifact = await renderResponseReport({} as never, input, "png");
    expect(artifact.format).toBe("png");
    if (artifact.format !== "png") return;
    expect(artifact.pages).toHaveLength(expectedPages);
    expect(artifact.targetTotalBytesExceeded).toBe(true);
    expect(artifact.pages.every((page) => page.byteSize === pageBytes.byteLength)).toBe(true);
    expect(mocks.closePage).toHaveBeenCalledTimes(1);
  });

  it("aborts on visual overflow instead of capturing clipped content", async () => {
    const browser = await mocks.launch.mock.results[0]?.value;
    void browser;
    const overflowPage = {
      setViewport: vi.fn(), setContent: vi.fn(), screenshot: vi.fn(), pdf: vi.fn(),
      evaluate: vi.fn(async (script: string) => script.includes("const isOverflowing") ? 1 : script.includes("querySelectorAll('.page')") ? "1" : undefined),
    };
    mocks.launch.mockResolvedValue({ newPage: vi.fn(async () => ({ ...overflowPage, close: vi.fn() })), close: vi.fn() });
    await expect(renderResponseReport({} as never, source(), "png")).rejects.toThrow(/overflows its fixed canvas/);
  });
});
