import { describe, expect, it } from "vitest";
import { collectedFields, defaultConfig, normalizeConfig, validateWithSchema } from "../../../src/game-plugin/props";
import type { PropField } from "../../../src/game-plugin/types";

const fields = [
  { key: "title", label: "标题", kind: "text", default: "默认标题", maxLength: 5, required: true, collects: true },
  { key: "count", label: "数量", kind: "number", default: 3, min: 1, max: 10, integer: true },
  { key: "enabled", label: "启用", kind: "boolean", default: true },
  { key: "mode", label: "模式", kind: "select", default: "a", options: [{ value: "a", label: "A" }] },
  { key: "cover", label: "封面", kind: "media", accept: "image", default: null },
  {
    key: "items",
    label: "条目",
    kind: "list",
    default: [],
    maxItems: 2,
    required: true,
    itemLabel: (item, index) => String(item.name || `第 ${index + 1} 条`),
    itemFields: [{ key: "name", label: "名称", kind: "text", default: "", required: true, maxLength: 10 }],
  },
] as const satisfies readonly PropField[];

describe("defaultConfig", () => {
  it("按 Schema 生成默认值（列表/媒体为空）", () => {
    expect(defaultConfig(fields)).toEqual({
      title: "默认标题",
      count: 3,
      enabled: true,
      mode: "a",
      cover: null,
      items: [],
    });
  });
});

describe("normalizeConfig", () => {
  it("只保留 Schema 声明的键", () => {
    const out = normalizeConfig(fields, { title: "x", evil: "<script>", __proto__: { polluted: 1 } });
    expect(Object.keys(out).sort()).toEqual(["count", "cover", "enabled", "items", "mode", "title"]);
    expect(out.evil).toBeUndefined();
  });

  it("类型不对回落默认值，数字夹到区间内并取整", () => {
    const out = normalizeConfig(fields, { title: 42, count: 999, enabled: "yes", mode: "zzz", cover: "abc" });
    expect(out.title).toBe("默认标题");
    expect(out.count).toBe(10);
    expect(out.enabled).toBe(true);
    expect(out.mode).toBe("a");
    expect(out.cover).toBeNull();
    expect(normalizeConfig(fields, { count: -5 }).count).toBe(1);
    expect(normalizeConfig(fields, { count: 4.6 }).count).toBe(5);
  });

  it("字符串按 maxLength 截断，越界的整份输入被忽略", () => {
    expect(normalizeConfig(fields, { title: "abcdefgh" }).title).toBe("abcde");
    const out = normalizeConfig(fields, "not-an-object");
    expect(out.title).toBe("默认标题");
    expect(out.items).toEqual([]);
  });

  it("列表只保留对象项，子字段同样走白名单，并截到 maxItems", () => {
    const out = normalizeConfig(fields, {
      items: [{ name: "a", junk: 1 }, "bad", { name: "b" }, { name: "c" }],
    });
    expect(out.items).toEqual([{ name: "a" }, { name: "b" }]);
  });
});

describe("validateWithSchema", () => {
  it("必填为空 → error", () => {
    const issues = validateWithSchema(fields, { ...defaultConfig(fields), title: "" });
    expect(issues.some((issue) => issue.key === "title" && issue.severity === "error")).toBe(true);
  });

  it("列表必填与上限", () => {
    const empty = validateWithSchema(fields, { ...defaultConfig(fields), items: [] });
    expect(empty.some((issue) => issue.key === "items")).toBe(true);
    const tooMany = validateWithSchema(fields, {
      ...defaultConfig(fields),
      items: [{ name: "a" }, { name: "b" }, { name: "c" }],
    });
    expect(tooMany.some((issue) => issue.key === "items" && issue.message.includes("最多"))).toBe(true);
  });

  it("列表子字段的错误带定位标签", () => {
    const issues = validateWithSchema(fields, {
      ...defaultConfig(fields),
      items: [{ name: "" }],
    });
    expect(issues.some((issue) => issue.message.includes("第 1 条") && issue.message.includes("名称"))).toBe(true);
  });

  it("合法配置没有任何问题", () => {
    expect(validateWithSchema(fields, { ...defaultConfig(fields), items: [{ name: "ok" }] })).toEqual([]);
  });
});

describe("collectedFields", () => {
  it("只挑 collects 标记的字段（作答数据定义）", () => {
    expect(collectedFields(fields)).toEqual(["title"]);
  });
});
