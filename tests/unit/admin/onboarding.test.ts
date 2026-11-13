import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isAutomationEnvironment,
  markOnboardingComplete,
  onboardingStepTarget,
  ONBOARDING_COMPLETE_KEY,
  ONBOARDING_STEPS,
  ONBOARDING_STEP_KEY,
  pickFirstMyDraft,
  readOnboardingStep,
  resetForReplay,
  saveOnboardingStep,
  shouldShowOnboarding,
} from "../../../admin/src/onboarding";

/**
 * admin 新手引导（admin/src/onboarding.ts）：首次进入的四步入门
 * 「新建问卷 → 预览 → 发布 → 查看报告」。这里钉住的是状态机与数据形状：
 *   - 显示 / 完成 / 重放三个状态只随 localStorage 完成标记迁移；
 *   - localStorage 不可用必须静默降级（宁可多引导一次，不能报错打断页面）；
 *   - 步骤指向的真实路由一旦漂移，浮层的「前往」就会带错路。
 *
 * 单测环境是 node（无 window/localStorage/navigator.webdriver），所以一律
 * vi.stubGlobal 注入假环境（与 haptics.test.ts 同一做法）；afterEach 统一
 * 还原，防止跨用例串状态。
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

/** 装一个可读写的内存 storage，返回底下的 Map 供断言写入内容。 */
function installMemoryStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

describe("完成标记状态机", () => {
  it("首次访问（无标记）→ 显示引导", () => {
    installMemoryStorage();
    expect(shouldShowOnboarding()).toBe(true);
  });

  it('完成 → 不再显示；标记写入约定的键，值为 "1"', () => {
    const store = installMemoryStorage();
    expect(shouldShowOnboarding()).toBe(true);
    markOnboardingComplete();
    expect(store.get(ONBOARDING_COMPLETE_KEY)).toBe("1");
    expect(shouldShowOnboarding()).toBe(false);
  });

  it("重放 → 清掉标记，再显示一次", () => {
    installMemoryStorage();
    markOnboardingComplete();
    expect(shouldShowOnboarding()).toBe(false);
    resetForReplay();
    expect(shouldShowOnboarding()).toBe(true);
    // 重放后再次完成，同样收敛到不显示
    markOnboardingComplete();
    expect(shouldShowOnboarding()).toBe(false);
  });

  it("localStorage 不可用（读写都抛错）时静默降级：不抛错、按未完成处理", () => {
    vi.stubGlobal("localStorage", {
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
    expect(() => shouldShowOnboarding()).not.toThrow();
    expect(shouldShowOnboarding()).toBe(true);
    expect(() => {
      markOnboardingComplete();
      resetForReplay();
    }).not.toThrow();
  });

  it("localStorage 完全缺席（node 单测 / 被策略禁用）同样静默降级", () => {
    // 不注入任何 stub：onboardingStorage() 返回 undefined 也是合法状态
    expect(shouldShowOnboarding()).toBe(true);
    expect(() => {
      markOnboardingComplete();
      resetForReplay();
    }).not.toThrow();
  });

  it('标记值不是 "1"（旧版本 / 被改写）时仍按未完成显示，不误判', () => {
    const store = installMemoryStorage();
    store.set(ONBOARDING_COMPLETE_KEY, "true");
    expect(shouldShowOnboarding()).toBe(true);
  });
});

describe("自动化环境（Playwright 截图矩阵）跳过", () => {
  it("navigator.webdriver === true（Playwright 置位的自动化指纹）→ 一律不显示，即便无完成标记", () => {
    installMemoryStorage();
    vi.stubGlobal("navigator", { webdriver: true });
    expect(isAutomationEnvironment()).toBe(true);
    expect(shouldShowOnboarding()).toBe(false);
  });

  it("webdriver 为 false 或未定义（真实浏览器 / node）→ 不干扰显示逻辑", () => {
    installMemoryStorage();
    vi.stubGlobal("navigator", { webdriver: false });
    expect(isAutomationEnvironment()).toBe(false);
    expect(shouldShowOnboarding()).toBe(true);
    vi.stubGlobal("navigator", {});
    expect(isAutomationEnvironment()).toBe(false);
    expect(shouldShowOnboarding()).toBe(true);
  });
});

describe("步骤定义与目标路由", () => {
  it("四步固定：新建问卷 → 编辑与预览 → 发布 → 查看报告，编号连续且指向真实路由", () => {
    expect(ONBOARDING_STEPS.map((step) => step.number)).toEqual(["1", "2", "3", "4"]);
    expect(ONBOARDING_STEPS.map((step) => step.title)).toEqual(["新建问卷", "编辑与预览", "发布", "查看报告"]);
    // 入口实测核对（SurveysPage 的「新建问卷」、EditorPage 工具栏的
    // 「预览」「发布」、/responses 答卷动态）：2/3 步同指编辑器是事实，
    // 不是笔误——预览和发布按钮都在编辑器工具栏。
    expect(ONBOARDING_STEPS.map((step) => step.to)).toEqual([
      "/surveys",
      "/surveys/:id/editor",
      "/surveys/:id/editor",
      "/responses",
    ]);
    // 每步都有说明与前往按钮文案，浮层不能出现空步骤
    for (const step of ONBOARDING_STEPS) {
      expect(step.hint.trim()).not.toBe("");
      expect(step.cta.trim()).not.toBe("");
    }
  });

  it("onboardingStepTarget：:id 用当前问卷替换；无问卷回退问卷列表；无占位原样返回", () => {
    const editorStep = ONBOARDING_STEPS[1]!;
    expect(onboardingStepTarget(editorStep, 7)).toBe("/surveys/7/editor");
    // 还没有任何问卷时去问卷列表——那里同时是「新建问卷」的入口
    expect(onboardingStepTarget(editorStep, null)).toBe("/surveys");
    expect(onboardingStepTarget(editorStep, undefined)).toBe("/surveys");
    const first = ONBOARDING_STEPS[0]!;
    expect(onboardingStepTarget(first, null)).toBe("/surveys");
    expect(onboardingStepTarget(first, 3)).toBe("/surveys");
  });
});

describe("步骤进度持久化（ONBOARDING_STEP_KEY，批一报告已知问题 #1）", () => {
  it("写入已到达步后读回同一步：刷新/重进不再从第一步重来", () => {
    const store = installMemoryStorage();
    saveOnboardingStep(2);
    expect(store.get(ONBOARDING_STEP_KEY)).toBe("2");
    expect(readOnboardingStep()).toBe(2);
    saveOnboardingStep(3);
    expect(readOnboardingStep()).toBe(3);
  });

  it("无进度（首次访问 / node 环境）回第 0 步", () => {
    installMemoryStorage();
    expect(readOnboardingStep()).toBe(0);
  });

  it("无效与越界值一律回 0：引导只从合法步骤继续", () => {
    const store = installMemoryStorage();
    for (const invalid of ["abc", "", "-1", "4", "10", "1.5"]) {
      store.set(ONBOARDING_STEP_KEY, invalid);
      expect(readOnboardingStep()).toBe(0);
    }
    // 边界：最后一步（下标 3）合法
    store.set(ONBOARDING_STEP_KEY, "3");
    expect(readOnboardingStep()).toBe(3);
  });

  it("localStorage 抛错/缺席时静默降级：读回 0、写入不抛错", () => {
    vi.stubGlobal("localStorage", {
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
    expect(readOnboardingStep()).toBe(0);
    expect(() => saveOnboardingStep(2)).not.toThrow();
    // 完全缺席（不注入 stub）同样是合法状态
    vi.unstubAllGlobals();
    expect(readOnboardingStep()).toBe(0);
    expect(() => saveOnboardingStep(2)).not.toThrow();
  });

  it("完成/跳过清掉进度：完成标记与步骤键一起收敛", () => {
    const store = installMemoryStorage();
    saveOnboardingStep(2);
    markOnboardingComplete();
    expect(store.has(ONBOARDING_STEP_KEY)).toBe(false);
    expect(readOnboardingStep()).toBe(0);
    expect(shouldShowOnboarding()).toBe(false);
  });

  it("重放清掉旧进度：重放是重新走一遍，必须从第一步开始", () => {
    const store = installMemoryStorage();
    saveOnboardingStep(3);
    markOnboardingComplete();
    resetForReplay();
    expect(store.has(ONBOARDING_STEP_KEY)).toBe(false);
    expect(store.has(ONBOARDING_COMPLETE_KEY)).toBe(false);
    expect(readOnboardingStep()).toBe(0);
    expect(shouldShowOnboarding()).toBe(true);
  });

  it("浮层接线（DashboardPage 源码，同 lazy-routes 的静态锚点惯例）：初始步读持久层、CTA 点击同步写当前步、进度在离开前落盘", () => {
    const source = readFileSync(join(process.cwd(), "admin", "src", "routes", "DashboardPage.tsx"), "utf8");
    // 初始步从持久层继续，而不是写死 0
    expect(source).toContain("useState(() => readOnboardingStep())");
    // CTA（<Link>）离开总览前先把已到达步写进 ONBOARDING_STEP_KEY
    expect(source).toContain("onClick={() => saveOnboardingStep(stepIndex)}");
    // 「下一步」推进同样落盘（浮层随时可能因导航卸载）
    expect(source).toContain("saveOnboardingStep(stepIndex + 1)");
    // 落点来自「第一个我的草稿」，不再用 dashboard recentSurveys[0] 解析 :id
    expect(source).toContain("pickFirstMyDraft");
    expect(source).not.toContain("recentSurveys?.[0]?.id");
  });
});

describe("步骤 2/3 落点：第一个我的草稿（批一报告已知问题 #3）", () => {
  it("按 ownerId 过滤出当前用户的草稿，取第一条", () => {
    const drafts = [
      { id: 11, ownerId: 2 },
      { id: 7, ownerId: 1 },
      { id: 3, ownerId: 1 },
    ];
    expect(pickFirstMyDraft(drafts, 1)).toBe(7);
    expect(pickFirstMyDraft(drafts, 2)).toBe(11);
  });

  it("列表里没有我的草稿 → null，调用方经 onboardingStepTarget 兜底 /surveys", () => {
    const drafts = [{ id: 11, ownerId: 2 }];
    const draftId = pickFirstMyDraft(drafts, 1);
    expect(draftId).toBeNull();
    expect(onboardingStepTarget(ONBOARDING_STEPS[1]!, draftId)).toBe("/surveys");
    // 空列表（还没创建过问卷）同样兜底
    expect(onboardingStepTarget(ONBOARDING_STEPS[1]!, pickFirstMyDraft([], 1))).toBe("/surveys");
  });

  it("session userId 读不到（null/undefined）不猜归属：返回 null 而不是拿别人的草稿", () => {
    const drafts = [{ id: 11, ownerId: 2 }];
    expect(pickFirstMyDraft(drafts, null)).toBeNull();
    expect(pickFirstMyDraft(drafts, undefined)).toBeNull();
  });

  it("拿到我的草稿后，步骤 2/3 落到「我的」编辑器而不是最近问卷", () => {
    const drafts = [
      { id: 42, ownerId: 9 },
      { id: 8, ownerId: 1 },
    ];
    const target = onboardingStepTarget(ONBOARDING_STEPS[2]!, pickFirstMyDraft(drafts, 1));
    expect(target).toBe("/surveys/8/editor");
  });
});
