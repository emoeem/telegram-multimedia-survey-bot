import { GAME_PLUGIN_HOST_API, type ConfigIssue, type GamePluginManifest, type GamePluginServer } from "./types";
import { defaultConfig as buildDefaultConfig, normalizeConfig, validateWithSchema } from "./props";

/**
 * 错误信息里只回显截断后的安全片段。
 *
 * id 可能来自 task_packs.game_type（后台可写），直接拼进 Error 会让换行/
 * 控制字符混入日志行。这里只保留字母数字与连字符并截到 40 字符——报错该
 * 说清"哪个 id 不认识"，但不该把原始输入原样搬进日志。
 */
function safeIdForMessage(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "?").slice(0, 40);
  return cleaned || "（空）";
}

/**
 * 插件注册中心。
 *
 * 做成 class + 显式 register 而不是模块副作用的三个理由：
 *  1. 测试之间可以 reset() 隔离，不用反复 import 不同模块图；
 *  2. 注册顺序不影响检索（Map + 排序输出），不会出现"谁先 import 谁优先"；
 *  3. 启动期就能炸掉非法插件（hostApi 不匹配 / id 重复），而不是等玩家打开。
 */
export class GamePluginRegistry {
  private readonly plugins = new Map<string, GamePluginServer>();

  register(plugin: GamePluginServer): void {
    const { manifest } = plugin;
    if (manifest.hostApi !== GAME_PLUGIN_HOST_API) {
      throw new Error(
        `游戏插件 ${safeIdForMessage(manifest.id)} 的 hostApi=${String(manifest.hostApi)}，当前宿主只支持 ${GAME_PLUGIN_HOST_API}`,
      );
    }
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(manifest.id)) {
      throw new Error(`游戏插件 id 不合法（小写字母开头，允许数字与连字符）：${safeIdForMessage(manifest.id)}`);
    }
    if (this.plugins.has(manifest.id)) {
      throw new Error(`游戏插件 id 重复：${safeIdForMessage(manifest.id)}`);
    }
    this.plugins.set(manifest.id, plugin);
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }

  get(id: string): GamePluginServer | undefined {
    return this.plugins.get(id);
  }

  /** 未知 id 直接抛：调用方通常已校验过，这里是防御性断言。 */
  require(id: string): GamePluginServer {
    const found = this.plugins.get(id);
    if (!found) throw new Error(`未注册的游戏玩法：${safeIdForMessage(id)}`);
    return found;
  }

  list(): GamePluginManifest[] {
    return [...this.plugins.values()].map((plugin) => plugin.manifest).sort((a, b) => a.id.localeCompare(b.id));
  }

  byCategory(): Map<string, GamePluginManifest[]> {
    const groups = new Map<string, GamePluginManifest[]>();
    for (const manifest of this.list()) {
      const list = groups.get(manifest.category) ?? [];
      list.push(manifest);
      groups.set(manifest.category, list);
    }
    return groups;
  }

  /**
   * 保存任务包前的统一闸门：先按 Schema 归一化（丢弃越界键、夹取值域），
   * 再跑结构校验。返回的 config 就是应当落库的 settings_json。
   */
  validateConfig(id: string, raw: unknown): { config: Record<string, unknown>; issues: ConfigIssue[] } {
    const plugin = this.require(id);
    const config = normalizeConfig(plugin.props, raw);
    return { config, issues: validateWithSchema(plugin.props, config) };
  }

  defaultConfig(id: string): Record<string, unknown> {
    return buildDefaultConfig(this.require(id).props);
  }

  /** 仅测试用：隔离单例状态。 */
  reset(): void {
    this.plugins.clear();
  }
}

export const gamePluginRegistry = new GamePluginRegistry();

/** 一行注册：server-plugins.ts 里每个新玩法加一个参数。 */
export function registerGamePlugins(...plugins: GamePluginServer[]): void {
  for (const plugin of plugins) gamePluginRegistry.register(plugin);
}
