import { describe, expect, it } from "vitest";

import {
  extractPlazaTopic,
  normalizePlazaTopic,
  PLAZA_TOPIC_MAX_LENGTH,
  resolvePlazaTopic,
} from "../../../src/services/plaza-topic.service";

describe("plaza topic parsing", () => {
  it("normalizes explicit topics and rejects unusable ones", () => {
    expect(normalizePlazaTopic("  #夜话# ")).toBe("夜话");
    expect(normalizePlazaTopic("#树洞")).toBe("树洞");
    expect(normalizePlazaTopic("夜 话")).toBeNull();
    expect(normalizePlazaTopic("#")).toBeNull();
    expect(normalizePlazaTopic("")).toBeNull();
    expect(normalizePlazaTopic(undefined)).toBeNull();
    expect(normalizePlazaTopic("x".repeat(PLAZA_TOPIC_MAX_LENGTH + 1))).toBeNull();
    expect(normalizePlazaTopic("x".repeat(PLAZA_TOPIC_MAX_LENGTH))).toBe("x".repeat(PLAZA_TOPIC_MAX_LENGTH));
  });

  it("extracts the first #话题# from the body", () => {
    expect(extractPlazaTopic("今天有点累 #夜话# 想说说话")).toBe("夜话");
    expect(extractPlazaTopic("只有 # 一个井号")).toBeNull();
    expect(extractPlazaTopic("没有话题的一行字")).toBeNull();
    // 两个话题只取第一个，避免一条帖子同时挂在两个筛选条下。
    expect(extractPlazaTopic("#第一个# 然后 #第二个#")).toBe("第一个");
  });

  it("prefers an explicit topic over the body", () => {
    expect(resolvePlazaTopic("正文 #正文话题#", "显式")).toBe("显式");
    expect(resolvePlazaTopic("正文 #正文话题#", null)).toBe("正文话题");
    expect(resolvePlazaTopic("正文", "  ")).toBeNull();
  });
});
