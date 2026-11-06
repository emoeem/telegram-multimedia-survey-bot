import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isPendingTemplateFresh,
  parsePendingTemplate,
  PENDING_TEMPLATE_KEY,
  PENDING_TEMPLATE_TTL_MS,
  setPendingTemplate,
  takePendingTemplate,
} from "../../../admin/src/editor/pending-template";
import { TEMPLATE_OPTIONS } from "../../../admin/src/editor/templates";

/**
 * 「从模板开始」的跨页交接槽位（admin/src/editor/pending-template.ts，T4）：
 * SurveysPage 创建问卷后写入模板 id，EditorShell 挂载时取走并一次性插入骨架。
 * 这里钉住的是取值 / 消费 / 过期三段语义：
 *   - 写入只在带模板创建时发生；空白创建不写（还清旧槽位）；
 *   - take 是「读即取走」——「应用一次后不再应用」靠消费语义兜底，
 *     StrictMode 的 effect 双调用也因此插不出两遍；
 *   - 过期标记按无标记处理，宁可空白画布也不迟到乱插；
 *   - 槽位只归属创建的那份问卷，别的问卷读不到也带不走。
 *
 * 单测环境是 node（无 window/sessionStorage），一律 vi.stubGlobal 注入内存
 * storage（与 onboarding.test.ts / haptics.test.ts 同一做法）；afterEach 统一
 * 还原，防止跨用例串状态。
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

/** 装一个可读写的内存 sessionStorage，返回底下的 Map 供直接断言槽位内容。 */
function installMemoryStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

describe("写入：带模板创建才写标记", () => {
  it("带模板创建写入约定的键，内容是 {surveyId, templateId, at}", () => {
    const store = installMemoryStorage();
    setPendingTemplate(7, "survey", 1_000);
    expect(store.has(PENDING_TEMPLATE_KEY)).toBe(true);
    expect(JSON.parse(store.get(PENDING_TEMPLATE_KEY)!)).toEqual({ surveyId: 7, templateId: "survey", at: 1_000 });
  });

  it("空白模板不写入标记：null 不产生槽位内容", () => {
    const store = installMemoryStorage();
    setPendingTemplate(7, null, 1_000);
    expect(store.has(PENDING_TEMPLATE_KEY)).toBe(false);
  });

  it("空白创建会清掉此前残留的槽位：单槽语义，最新一次创建意图覆盖旧的", () => {
    const store = installMemoryStorage();
    setPendingTemplate(7, "mixed", 1_000);
    expect(store.has(PENDING_TEMPLATE_KEY)).toBe(true);
    setPendingTemplate(8, null, 2_000);
    expect(store.has(PENDING_TEMPLATE_KEY)).toBe(false);
  });

  it("再次带模板创建覆盖旧槽位（同键单槽）", () => {
    const store = installMemoryStorage();
    setPendingTemplate(7, "survey", 1_000);
    setPendingTemplate(9, "single-game", 2_000);
    expect(JSON.parse(store.get(PENDING_TEMPLATE_KEY)!)).toEqual({
      surveyId: 9,
      templateId: "single-game",
      at: 2_000,
    });
  });
});

describe("取值：parse 拒绝一切不属于合法交接的形状", () => {
  it("合法记录原样解析", () => {
    expect(parsePendingTemplate(JSON.stringify({ surveyId: 3, templateId: "mixed", at: 5 }))).toEqual({
      surveyId: 3,
      templateId: "mixed",
      at: 5,
    });
  });

  it("空值 / 非法 JSON / 缺字段 / 模板 id 不在 TEMPLATE_OPTIONS 里 → 一律 null", () => {
    expect(parsePendingTemplate(null)).toBeNull();
    expect(parsePendingTemplate("")).toBeNull();
    expect(parsePendingTemplate("not-json{")).toBeNull();
    expect(parsePendingTemplate(JSON.stringify({ surveyId: 3, at: 5 }))).toBeNull();
    expect(parsePendingTemplate(JSON.stringify({ templateId: "mixed", at: 5 }))).toBeNull();
    expect(parsePendingTemplate(JSON.stringify({ surveyId: 3, templateId: "mixed", at: "later" }))).toBeNull();
    // insertTemplate 对未知 id 会走 else 分支插「混合互动」：解析层必须挡住
    // 被改写 / 旧版本残留的 id，不让它触发一次意外的插入。
    expect(parsePendingTemplate(JSON.stringify({ surveyId: 3, templateId: "blank", at: 5 }))).toBeNull();
    expect(parsePendingTemplate(JSON.stringify({ surveyId: 1.5, templateId: "survey", at: 5 }))).toBeNull();
  });

  it("三套内置模板 id 全部可解析（与 templates.ts 单一数据源）", () => {
    for (const { id } of TEMPLATE_OPTIONS) {
      expect(parsePendingTemplate(JSON.stringify({ surveyId: 1, templateId: id, at: 1 }))).not.toBeNull();
    }
  });
});

describe("消费：应用一次后不再应用", () => {
  it("第一次 take 返回模板 id；第二次 take 为 null——取走即消费", () => {
    installMemoryStorage();
    setPendingTemplate(7, "survey", 1_000);
    expect(takePendingTemplate(7, 1_100)).toBe("survey");
    expect(takePendingTemplate(7, 1_200)).toBeNull();
  });

  it("surveyId 不匹配读不到，也不动别人的待办", () => {
    const store = installMemoryStorage();
    setPendingTemplate(7, "mixed", 1_000);
    expect(takePendingTemplate(8, 1_100)).toBeNull();
    // 问卷 7 的编辑器晚些进来仍能拿到（TTL 内）
    expect(store.get(PENDING_TEMPLATE_KEY)).not.toBeNull();
    expect(takePendingTemplate(7, 1_200)).toBe("mixed");
  });

  it("没有任何标记时 take 静默返回 null", () => {
    installMemoryStorage();
    expect(takePendingTemplate(7, 1_000)).toBeNull();
  });
});

describe("过期：迟到的不应用", () => {
  const AT = 10_000;

  it("TTL 内新鲜；恰好踩线仍算新鲜；超过 TTL 视为陈旧", () => {
    const record = { surveyId: 7, templateId: "survey" as const, at: AT };
    expect(isPendingTemplateFresh(record, AT + PENDING_TEMPLATE_TTL_MS)).toBe(true);
    expect(isPendingTemplateFresh(record, AT + PENDING_TEMPLATE_TTL_MS + 1)).toBe(false);
    expect(isPendingTemplateFresh(record, AT + PENDING_TEMPLATE_TTL_MS * 10)).toBe(false);
  });

  it("过期标记 take 返回 null，且同样被消费掉（不留僵尸槽位）", () => {
    const store = installMemoryStorage();
    setPendingTemplate(7, "survey", AT);
    expect(takePendingTemplate(7, AT + PENDING_TEMPLATE_TTL_MS + 1)).toBeNull();
    expect(store.has(PENDING_TEMPLATE_KEY)).toBe(false);
  });
});

describe("存储不可用：静默降级为「不带模板」", () => {
  it("sessionStorage 完全缺席（node 单测 / 被策略禁用）不抛错，take 按 null 处理", () => {
    // 不注入任何 stub
    expect(() => setPendingTemplate(7, "survey")).not.toThrow();
    expect(takePendingTemplate(7)).toBeNull();
  });

  it("读写抛错（Safari ITP / 隐私模式）同样静默降级", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(() => setPendingTemplate(7, "survey")).not.toThrow();
    expect(() => setPendingTemplate(7, null)).not.toThrow();
    expect(takePendingTemplate(7)).toBeNull();
  });
});
