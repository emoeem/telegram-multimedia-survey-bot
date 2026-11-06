import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isAutomationEnvironment,
  markOnboardingComplete,
  onboardingStepTarget,
  ONBOARDING_COMPLETE_KEY,
  ONBOARDING_STEPS,
  resetForReplay,
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
