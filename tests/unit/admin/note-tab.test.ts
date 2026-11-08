import { describe, expect, it } from "vitest";

import { initialNoteTab, threadIdFromSearch } from "../../../admin/src/survey/note-tab";

/**
 * 纸条页初始页签推导（T2 · G4 深链修正）：?thread= 存在即落 chat。
 * 此前 thread 参数只在 ChatTab 挂载后才读、页签默认 mine，CoinCenter 抽中后的
 * /notes?thread=X 深链会落在「我的纸条」页。
 */
describe("纸条页签推导（note-tab）", () => {
  it("?thread= 有合法值即落 chat——即便没带 tab 参数（此前落空的形态）", () => {
    expect(initialNoteTab("?thread=12")).toBe("chat");
    expect(initialNoteTab("?thread=12&tab=chat")).toBe("chat");
    expect(initialNoteTab("?thread=12&tab=mine")).toBe("chat"); // thread 优先
  });

  it("thread 非法（0/负数/非数字/空值）不算深链，退回 tab 参数，默认 mine", () => {
    expect(initialNoteTab("?thread=0")).toBe("mine");
    expect(initialNoteTab("?thread=-3")).toBe("mine");
    expect(initialNoteTab("?thread=abc")).toBe("mine");
    expect(initialNoteTab("?thread=")).toBe("mine");
    expect(initialNoteTab("?tab=chat")).toBe("chat");
    expect(initialNoteTab("")).toBe("mine");
  });

  it("threadIdFromSearch 与页签推导同一口径（ChatTab 打开深链会话用）", () => {
    expect(threadIdFromSearch("?thread=12")).toBe(12);
    expect(threadIdFromSearch("?thread=12&tab=chat")).toBe(12);
    expect(threadIdFromSearch("?thread=0")).toBeNull();
    expect(threadIdFromSearch("?thread=abc")).toBeNull();
    expect(threadIdFromSearch("?thread=")).toBeNull();
    expect(threadIdFromSearch("")).toBeNull();
  });
});
