import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GamePluginRegistry, gamePluginRegistry } from "../../../src/game-plugin/registry";
import type { GamePluginServer } from "../../../src/game-plugin/types";
// 副作用导入：一致性守卫要检查"真实注册后"的集合。
import "../../../src/game-plugin/server-plugins";

const props = [{ key: "name", label: "名称", kind: "text", default: "", required: true }] as const;

function plugin(id: string, overrides: Partial<GamePluginServer["manifest"]> = {}): GamePluginServer {
  return {
    manifest: {
      id,
      name: id,
      title: id,
      icon: "Box",
      description: "d",
      category: "quiz",
      version: "1.0.0",
      author: "t",
      hostApi: 1,
      capabilities: {},
      ...overrides,
    },
    props,
    engine: {
      createRun: () => ({ state: {}, view: { status: "active", score: 0, maxScore: 1, step: 1, total: 1, payload: {} } }),
      apply: <S,>({ state, view }: { state: S; view: { status: "active"; score: number; maxScore: number; step: number; total: number; payload: Record<string, unknown> } }) => ({ state, view, finished: false }),
      grade: () => ({ grade: "C", maxScore: 1 }),
      view: () => ({ status: "active", score: 0, maxScore: 1, step: 1, total: 1, payload: {} }),
      isAction: (): boolean => true,
    },
  } as unknown as GamePluginServer;
}

describe("GamePluginRegistry", () => {
  it("注册后可按 id 取回并列出", () => {
    const registry = new GamePluginRegistry();
    registry.register(plugin("alpha"));
    expect(registry.has("alpha")).toBe(true);
    expect(registry.list().map((m) => m.id)).toEqual(["alpha"]);
  });

  it("重复 id 直接抛（启动期暴露而不是运行期打架）", () => {
    const registry = new GamePluginRegistry();
    registry.register(plugin("dup"));
    expect(() => registry.register(plugin("dup"))).toThrow(/重复/);
  });

  it("hostApi 不匹配拒绝注册", () => {
    const registry = new GamePluginRegistry();
    expect(() => registry.register(plugin("old", { hostApi: 99 as unknown as 1 }))).toThrow(/hostApi/);
  });

  it("非法 id 拒绝注册", () => {
    const registry = new GamePluginRegistry();
    expect(() => registry.register(plugin("Bad_ID"))).toThrow(/id 不合法/);
    expect(() => registry.register(plugin("a"))).toThrow(/id 不合法/);
  });

  it("require 未知 id 抛错，get 返回 undefined", () => {
    const registry = new GamePluginRegistry();
    expect(() => registry.require("nope")).toThrow(/未注册/);
    expect(registry.get("nope")).toBeUndefined();
  });

  it("validateConfig 归一化 + 报错；defaultConfig 来自 Schema", () => {
    const registry = new GamePluginRegistry();
    registry.register(plugin("alpha"));
    const { config, issues } = registry.validateConfig("alpha", { name: "ok", junk: 1 });
    expect(config).toEqual({ name: "ok" });
    expect(issues).toEqual([]);
    const bad = registry.validateConfig("alpha", { name: "" });
    expect(bad.issues.some((issue) => issue.severity === "error")).toBe(true);
    expect(registry.defaultConfig("alpha")).toEqual({ name: "" });
  });

  it("按分类分组", () => {
    const registry = new GamePluginRegistry();
    registry.register(plugin("alpha", { category: "quiz" }));
    registry.register(plugin("beta", { category: "story" }));
    const groups = registry.byCategory();
    expect([...groups.keys()].sort()).toEqual(["quiz", "story"]);
  });
});

/**
 * 目录 / 注册一致性守卫：新增插件目录却忘了在 server-plugins.ts 登记时，
 * 玩家会看到一个打不开的玩法。这里把三方对齐：服务端注册、插件目录、
 * 客户端实现目录。
 */
describe("插件注册一致性", () => {
  const serverDir = "src/game-plugin/plugins";
  const clientDir = "admin/src/game-plugins/plugins";
  const pluginDirs = (root: string) =>
    existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "manifest.ts")))
          .map((entry) => entry.name)
          .sort()
      : [];

  it("服务端注册集合 === 插件目录集合", () => {
    const registered = gamePluginRegistry.list().map((manifest) => manifest.id).sort();
    expect(registered).toEqual(pluginDirs(serverDir));
  });

  it("每个服务端插件都有客户端实现目录", () => {
    const serverIds = pluginDirs(serverDir);
    const clientDirs = existsSync(clientDir)
      ? readdirSync(clientDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && existsSync(join(clientDir, entry.name, "index.tsx")))
          .map((entry) => entry.name)
          .sort()
      : [];
    expect(clientDirs).toEqual(serverIds);
  });

  it("插件的 manifest.id 与目录名一致，默认配置能通过自身校验", () => {
    for (const dir of pluginDirs(serverDir)) {
      const plugin = gamePluginRegistry.require(dir);
      expect(plugin.manifest.id).toBe(dir);
      // 默认配置允许"未填内容"这类 error（新包就是空的），但不能崩。
      expect(() => gamePluginRegistry.validateConfig(dir, {})).not.toThrow();
    }
  });
});
