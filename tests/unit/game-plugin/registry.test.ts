import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GamePluginRegistry, gamePluginRegistry } from "../../../src/game-plugin/registry";
import type { GamePluginServer } from "../../../src/game-plugin/types";
import { gameTypeLabels, listGameTypes } from "../../../src/trial/engine-registry";
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
      createRun: () => ({
        state: {},
        view: { status: "active", score: 0, maxScore: 1, step: 1, total: 1, payload: {} },
      }),
      apply: <S>({
        state,
        view,
      }: {
        state: S;
        view: {
          status: "active";
          score: number;
          maxScore: number;
          step: number;
          total: number;
          payload: Record<string, unknown>;
        };
      }) => ({ state, view, finished: false }),
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

const serverDir = "src/game-plugin/plugins";
const clientDir = "admin/src/game-plugins/plugins";
const pluginDirs = (root: string) =>
  existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "manifest.ts")))
        .map((entry) => entry.name)
        .sort()
    : [];

/**
 * 目录 / 注册一致性守卫：新增插件目录却忘了在 server-plugins.ts 登记时，
 * 玩家会看到一个打不开的玩法。这里把三方对齐：服务端注册、插件目录、
 * 客户端实现目录。
 */
describe("插件注册一致性", () => {
  it("服务端注册集合 === 插件目录集合", () => {
    const registered = gamePluginRegistry
      .list()
      .map((manifest) => manifest.id)
      .sort();
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

/**
 * 标签唯一源 + 依赖边守卫（零迁移）。
 *
 * - 展示名只存在于 src/trial/engine-registry.ts（tower 常量 + 插件 manifest.title）；
 *   admin TaskPacksPage 曾自带第三副本（「新玩法在此补一行」），这里断言它不再回来。
 * - TaskPacksPage 跨目录 import engine-registry，而 engine-registry 第 1 行副作用
 *   导入 server-plugins，会把全部 engine 拉进 admin bundle——所以每个 engine.ts 的
 *   import 边必须显式申报在白名单里：未来任一 engine 引入 server-only 依赖会在 CI
 *   直接红，而不是等到 admin build 才炸。
 */
describe("标签唯一源与依赖边守卫", () => {
  it("每个 gameType（含 tower）都有非空标签，且全量映射与清单同集", () => {
    const types = listGameTypes();
    expect(types.map((type) => type.id)).toContain("tower");
    for (const type of types) {
      expect(type.label.trim().length, `gameType ${type.id} 的标签为空`).toBeGreaterThan(0);
    }
    expect(Object.keys(gameTypeLabels()).sort()).toEqual(types.map((type) => type.id).sort());
  });

  it("admin TaskPacksPage 不再自带展示名第三副本（标签改从 engine-registry 跨目录导入）", () => {
    const page = readFileSync(join("admin", "src", "routes", "TaskPacksPage.tsx"), "utf8");
    expect(page).not.toContain("GAME_TYPE_LABELS");
    expect(page).not.toContain("function gameTypeLabel");
    expect(page).toContain('from "../../../src/trial/engine-registry"');
  });

  it("engine.ts 的 import 边必须显式申报（engine 会经由 engine-registry 进 admin bundle）", () => {
    const allowlist: Record<string, readonly string[]> = {
      draw: ["../../types", "./manifest"],
      "flip-card": ["../../types", "./manifest"],
      quest: ["../../types", "./manifest", "./content"],
      guess: ["../../types", "./manifest"],
      "memory-chain": ["../../types", "./manifest"],
      "high-low": ["../../types", "./manifest"],
    };
    const dirs = pluginDirs(serverDir);
    // 新插件目录必须同时在这里申报依赖边：漏申报先在这里红，而不是 admin build 时才炸。
    expect(Object.keys(allowlist).sort()).toEqual(dirs);
    for (const [dir, allowed] of Object.entries(allowlist)) {
      const source = readFileSync(join(serverDir, dir, "engine.ts"), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      expect(
        [...imports].sort(),
        `${dir}/engine.ts 的 import 必须都在白名单（${allowed.join("、")}）内：engine 会经由 engine-registry 进 admin bundle，server-only 依赖会打断 admin build`,
      ).toEqual([...allowed].sort());
    }
  });
});
