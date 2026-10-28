import { lazy, type ComponentType } from "react";
import type { GamePluginClient, GameEditViewProps, GamePlayViewProps } from "./types";

/**
 * 客户端插件自动发现（零注册）。
 *
 * Vite 的 import.meta.glob 在构建期把 plugins/<id>/index.tsx 生成静态映射：
 * 新增一个玩法目录后重新构建，物料区自动多一张卡片、答题端自动能渲染，
 * 主程序不用改任何一行。每个插件是独立 chunk（lazy），只有真正被用到才下载。
 *
 * 服务端对应的是 src/game-plugin/server-plugins.ts（没有 glob 可用，显式一行）；
 * tests/unit/game-plugin/registry.test.ts 断言两边目录集合一致。
 *
 * 组件对外暴露成 `Record<string, unknown>` 配置的形态：宿主不知道具体插件的
 * 配置类型（那是插件的私有契约），归一化在保存入口已完成。
 */
type AnyPlayView = ComponentType<GamePlayViewProps<Record<string, unknown>>>;
type AnyEditView = ComponentType<GameEditViewProps<Record<string, unknown>>>;

const modules = import.meta.glob<{ default: GamePluginClient<never> }>("./plugins/*/index.tsx");

export function hasClientPlugin(id: string): boolean {
  return Boolean(modules[`./plugins/${id}/index.tsx`]);
}

export function listClientPluginIds(): string[] {
  return Object.keys(modules)
    .map((path) => path.replace(/^\.\/plugins\//, "").replace(/\/index\.tsx$/, ""))
    .sort();
}

/** 取插件默认导出（已 defineGamePlugin 冻结）。 */
export async function loadClientPlugin(id: string): Promise<GamePluginClient<never>> {
  const load = modules[`./plugins/${id}/index.tsx`];
  if (!load) throw new Error(`未找到游戏插件客户端实现：${id}`);
  const mod = await load();
  return mod.default;
}

/** 给 React.lazy 用的组件加载器（编辑态/答题态分开懒加载）。 */
export function lazyEditView(id: string): AnyEditView {
  return lazy(async () => {
    const plugin = await loadClientPlugin(id);
    return { default: plugin.EditView as unknown as AnyEditView };
  });
}

export function lazyPlayView(id: string): AnyPlayView {
  return lazy(async () => {
    const plugin = await loadClientPlugin(id);
    return { default: plugin.PlayView as unknown as AnyPlayView };
  });
}
