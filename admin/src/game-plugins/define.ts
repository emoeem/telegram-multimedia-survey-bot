import type { ConfigIssue, ConfigOf, PropField } from "../../../src/game-plugin/types";
import { defaultConfig as buildDefaultConfig, normalizeConfig } from "../../../src/game-plugin/props";
import type { GamePluginClient } from "./types";

/**
 * 定义客户端插件：类型推导 + 冻结。
 *
 * 冻结是为了让"插件定义"在运行期不可变——编辑器会把同一个对象同时交给
 * 物料区、属性面板和答题端，任何一处改写 manifest 都会污染其它入口。
 */
export function defineGamePlugin<P extends readonly PropField[], C = ConfigOf<P>>(
  plugin: GamePluginClient<P, C>,
): GamePluginClient<P, C> {
  return Object.freeze({
    ...plugin,
    manifest: Object.freeze({ ...plugin.manifest }),
    props: Object.freeze([...plugin.props]) as unknown as P,
  }) as GamePluginClient<P, C>;
}

/** 客户端默认配置（与服务工作区同一套归一化逻辑，避免两端各写一份）。 */
export function defaultPluginConfig(props: readonly PropField[]): Record<string, unknown> {
  return buildDefaultConfig(props);
}

/**
 * 归一化 + 插件自定义校验，编辑器保存前的一道闸。
 * 归一化的输出就是 schema 承诺的形状，这里断言成插件配置类型是唯一的边界转换。
 */
export function validatePluginConfig(
  plugin: Pick<GamePluginClient<readonly PropField[], unknown>, "props" | "validate">,
  raw: unknown,
): { config: Record<string, unknown>; issues: ConfigIssue[] } {
  const config = normalizeConfig(plugin.props, raw);
  const issues: ConfigIssue[] = plugin.validate ? [...plugin.validate(config)] : [];
  return { config, issues };
}
